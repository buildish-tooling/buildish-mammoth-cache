/*
 * Copyright 2026 The Buildish Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Value } from './encoding';
import { OpenedInvocation, type InvocationAnchor } from './invocation';
import type { LifecycleOptions } from './lifecycle-options';
import { PostAttempt } from './lifecycle-attempt';
import { ExclusiveWindow } from './quiescence';
import { captureObservations } from './observation-capture';
import type { ObservationIndex } from './observation-index';
import { GcSurvivorOwner } from './gc-execute';
import { MetadataPublicationSource, MetadataPublicationSet } from './metadata-publication-source';
import { MetadataSnapshot } from './metadata-snapshot';
import { publishMetadataBase, type MetadataPublicationChoice } from './metadata-publication';
import { metadataSummaryProfile } from './partition-metadata';
import { H, encodeRecord } from './encoding';
import { ownsLocalSnapshot, lineageId } from './model';
import { policyId } from './local-schema';
import { settleNativeCleanup } from './native-operation';
import type { BaseCacheBackend } from '../backend';
import type { PartitionSummaries } from './partition-summaries';
import type { OwnedStore } from './owned-store';

export interface BasePostRequest extends LifecycleOptions {
  readonly anchor: InvocationAnchor;
  readonly cacheBackend: () => Promise<BaseCacheBackend>;
  /** Known hook removal only, before observation timestamps/native evidence freeze. */
  readonly removeHooks: (store: OwnedStore) => Promise<void>;
  readonly summaries?: PartitionSummaries;
  readonly required?: boolean;
  readonly onWarning?: (message: string) => void;
}
export interface BasePostResult {
  readonly outcome:
    'published' | 'no-change' | 'skipped-not-quiescent' | 'feature-unavailable' | 'abandoned';
  readonly key: string | null;
  readonly message?: string;
}
const same = (a: Value, b: Value) => encodeRecord(a).equals(encodeRecord(b));
/** Fresh post consumes the successful compact handoff and the actual GC survivor owner. */
export async function postStreamingBase(input: BasePostRequest): Promise<BasePostResult> {
  const opened = await OpenedInvocation.open(input.anchor, input.budget, input.cleanupSignal),
    request = Object.freeze({ ...input, maxDirectoryEntries: opened.bindings[8][9] }),
    attempt = await PostAttempt.open(opened, request),
    store = attempt.store;
  let window: ExclusiveWindow | undefined,
    captured: ObservationIndex | undefined,
    owner: GcSurvivorOwner | undefined;
  const sources: MetadataPublicationSource[] = [],
    snapshots: MetadataSnapshot[] = [];
  let failure: unknown, answer: BasePostResult | undefined;
  try {
    const { role, access, model, invocation } = store.codec.options;
    if (access !== 'writable' || role === 'distributed-worker')
      throw new Error('Base post requires writable base role.');
    if (attempt.state[4] === 'completed') {
      const terminal = attempt.state[7]!;
      if (
        ![
          'published',
          'no-change',
          'skipped-not-quiescent',
          'feature-unavailable',
          'abandoned',
        ].includes(terminal[1])
      )
        throw new Error('Invalid base completion.');
      await attempt.guard();
      answer = { outcome: terminal[1] as BasePostResult['outcome'], key: terminal[2] };
    } else {
      const gate = await ExclusiveWindow.establish(store, request.budget, request);
      if (gate.status !== 'ready') {
        if (request.required || role === 'distributed-aggregator')
          throw new Error('Required base post is not quiescent: ' + gate.message);
        const retained = [
          ...attempt.handoff.entries
            .filter((entry) => entry[4] !== null)
            .map((entry) => store.root.resolve(entry[4]![1])),
          store.root.resolve(attempt.handoff.header[9][2]),
        ];
        const message =
          'Cache save skipped: ' +
          gate.message +
          (retained.length
            ? '; owned snapshots/activity retained for manual handling: ' + retained.join(', ')
            : '');
        if (retained.length) request.onWarning?.(message);
        await attempt.finish(['outcome', 'skipped-not-quiescent', null, null, null]);
        answer = { outcome: 'skipped-not-quiescent', key: null, message };
      } else {
        window = gate.window;
        attempt.attachWindow(window);
        const options = {
          ...request,
          signal: attempt.signal,
          assertCurrent: () => {
            attempt.assert();
            return undefined;
          },
          attempt,
        };
        await request.removeHooks(store);
        await attempt.guard();
        const observation = await captureObservations(store, {
          ...options,
          retainIndex: true,
          summaries: request.summaries,
          purgeWindow: attempt.handoff.header[6] === 'enabled' ? window.purgeWindow : undefined,
        });
        captured = observation.index!;
        // Provider/confirmation admission precedes actual GC, source plans and evacuation.
        let backend: BaseCacheBackend | undefined,
          confirmation = true,
          available = false;
        try {
          backend = await request.cacheBackend();
          confirmation = backend.canConfirmSave?.() !== false;
          available =
            backend.isFeatureAvailable() &&
            backend.capabilities.supportsExplicitSave &&
            confirmation;
        } catch {
          confirmation = false;
        }
        if (!available) {
          const outcome =
            role === 'standalone' && !request.required && confirmation
              ? 'feature-unavailable'
              : 'abandoned';
          request.onWarning?.(
            outcome === 'feature-unavailable'
              ? 'Cache save skipped: cache backend is unavailable.'
              : 'Cache publication abandoned: outgoing cache confirmation unavailable.',
          );
          for (const entry of attempt.handoff.entries)
            if (entry[4]) await MetadataSnapshot.retireHandoff(store, entry[4], options);
          await captured.dispose();
          captured = undefined;
          await attempt.finish(['outcome', outcome, null, null, null]);
          answer = { outcome, key: null };
        } else {
          owner = await GcSurvivorOwner.execute(captured, options);
          captured = undefined;
          const live = await MetadataPublicationSource.survivors(owner);
          sources.push(live);
          const overrides: [string, MetadataPublicationSource][] = [];
          for (const entry of attempt.handoff.entries)
            if (entry[4]) {
              const partition = model.partitions.find((p) => p[0] === entry[1])!;
              if (
                partition[3] !== 'single-writer' ||
                ownsLocalSnapshot(partition, store.codec.options)
              )
                throw new Error('Unexpected retained snapshot source selection.');
              const snapshot = await MetadataSnapshot.admit(store, entry[4], options);
              snapshots.push(snapshot);
              const source = await MetadataPublicationSource.snapshot(snapshot);
              sources.push(source);
              overrides.push([entry[1], source]);
            }
          for (const partition of model.partitions)
            if (
              partition[3] === 'single-writer' &&
              !ownsLocalSnapshot(partition, store.codec.options) &&
              !overrides.some(([p]) => p === partition[0])
            )
              throw new Error('Missing independent authoritative snapshot root.');
          let set = MetadataPublicationSet.select(live, overrides);
          const choices: MetadataPublicationChoice[] = [];
          for (const entry of attempt.handoff.entries) {
            const partition = entry[1],
              summary = set.summary(partition),
              pin = entry[3],
              descriptor = entry[4];
            const compatibleOrigin =
              !descriptor ||
              (descriptor[4][0] === 'base' && pin !== null && same(descriptor[4][1], pin[7])) ||
              (descriptor[4][0] === 'empty' &&
                descriptor[4][1] === 'generation' &&
                pin?.[7] === null);
            const reuse =
              pin !== null &&
              compatibleOrigin &&
              same(pin[8], metadataSummaryProfile()) &&
              same(pin[9], summary);
            if (reuse)
              choices.push(pin[7] === null ? ['empty', partition] : ['reuse', partition, pin[7]]);
            else
              choices.push(
                summary[3] === 0 && summary[4] === 0 ? ['empty', partition] : ['new', partition],
              );
          }
          for (const choice of choices) request.summaries?.choice(choice[1], choice[0]);
          const prior = attempt.generation,
            entries = choices.map((choice) =>
              choice[0] === 'reuse' ? ['object', choice[1], choice[2]] : choice,
            );
          const unchanged = prior !== null && same(entries, prior[8]),
            lineage = lineageId(attempt.handoff.header[2]);
          // This exit precedes candidate groups/root plans/layouts/generation and output-only copies.
          if (unchanged && prior[5] === lineage) answer = { outcome: 'no-change', key: prior[11] };
          else {
            for (const choice of choices)
              if (choice[0] === 'new') {
                const partition = model.partitions.find((p) => p[0] === choice[1])!;
                if (ownsLocalSnapshot(partition, store.codec.options)) {
                  const snapshot = await MetadataSnapshot.copy(
                    live,
                    partition[0],
                    ['local', invocation],
                    options,
                  );
                  snapshots.push(snapshot);
                  const source = await MetadataPublicationSource.snapshot(snapshot);
                  sources.push(source);
                  overrides.push([partition[0], source]);
                }
              }
            set = MetadataPublicationSet.select(live, overrides);
            const result = await publishMetadataBase(set, backend!, {
              lineage,
              writer: invocation,
              decision: H('metadata-publication', [
                invocation,
                model.id,
                model.family,
                policyId(attempt.bindings[8]),
                choices,
              ]),
              choices,
              summaries: request.summaries,
              ...(unchanged && prior ? { groups: prior[9] } : {}),
              onWarning: request.onWarning,
            });
            answer = { outcome: result.outcome, key: result.generation?.[11] ?? null };
          }
          await settleNativeCleanup([
            ...sources
              .splice(0)
              .reverse()
              .map((source) => () => source.dispose()),
            ...snapshots.splice(0).map((snapshot) => () => snapshot.retire()),
            () => owner?.dispose(),
          ]);
          owner = undefined;
          await attempt.finish(['outcome', answer.outcome, answer.key, null, null]);
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await settleNativeCleanup(
      [
        ...sources.reverse().map((source) => () => source.dispose()),
        ...snapshots.map((snapshot) => () => snapshot.dispose()),
        () => owner?.dispose(),
        () => captured?.dispose(),
      ],
      failure,
    );
  } finally {
    window?.close();
    attempt.close();
  }
  if (failure !== undefined) throw failure;
  return answer!;
}
