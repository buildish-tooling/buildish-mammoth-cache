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

import { timed, timingDecision } from '../../util/timing';
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
import type { HandoffEntry } from './lifecycle-handoff';
import {
  hasPotentialOverlayChanges,
  projectOverlay,
  retireOverlay,
  verifyOverlay,
  withinOverlay,
} from './overlay';

export interface BasePostRequest extends LifecycleOptions {
  readonly anchor: InvocationAnchor;
  readonly cacheBackend: () => Promise<BaseCacheBackend>;
  /** Known hook removal only, before observation timestamps/native evidence freeze. */
  readonly removeHooks: (store: OwnedStore) => Promise<void>;
  readonly summaries?: PartitionSummaries;
  readonly required?: boolean;
  readonly onCaptureInfo?: (message: string) => void;
  readonly onWarning?: (message: string) => void;
}

export interface BasePostResult {
  readonly outcome:
    'published' | 'no-change' | 'skipped-not-quiescent' | 'feature-unavailable' | 'abandoned';
  readonly key: string | null;
  readonly message?: string;
}

const same = (a: Value, b: Value) => encodeRecord(a).equals(encodeRecord(b));
function reusablePin(entry: HandoffEntry) {
  const pin = entry[3]?.[0] === 'pinned-partition-metadata' ? entry[3] : null,
    descriptor = entry[4];
  const compatible =
    !descriptor ||
    (descriptor[4][0] === 'base' && pin !== null && same(descriptor[4][1], pin[7])) ||
    (descriptor[4][0] === 'empty' && descriptor[4][1] === 'generation' && pin?.[7] === null);
  return pin && compatible && same(pin[8], metadataSummaryProfile()) ? pin : null;
}

async function unchangedOverlay(attempt: PostAttempt, options: LifecycleOptions): Promise<boolean> {
  const {
    store,
    generation,
    handoff: { header, entries },
  } = attempt;
  const overlay = header[13];
  if (
    !overlay ||
    header[14] !== 'pristine' ||
    header[11] ||
    !generation ||
    generation[5] !== lineageId(header[2]) ||
    entries.some((entry) => !reusablePin(entry))
  ) {
    return false;
  }
  const target = overlay[10];
  if (
    target &&
    (entries.some((entry) => entry[1] !== target && reusablePin(entry)?.[7] !== null) ||
      (await hasPotentialOverlayChanges(store, store.root.path, '', options, target)))
  ) {
    return false;
  }
  return !(await hasPotentialOverlayChanges(
    store,
    store.root.resolve(overlay[2] + '/upper'),
    target,
    options,
  ));
}

/** Fresh post consumes the successful compact handoff and the actual GC survivor owner. */
export async function postStreamingBase(input: BasePostRequest): Promise<BasePostResult> {
  const opened = await OpenedInvocation.open(input.anchor, input.budget, input.cleanupSignal),
    request = Object.freeze({ ...input, maxDirectoryEntries: opened.bindings[8][9] }),
    attempt = await PostAttempt.open(opened, request),
    store = attempt.store;
  let window: ExclusiveWindow | undefined,
    captured: ObservationIndex | undefined,
    owner: GcSurvivorOwner | undefined;
  const overlay = attempt.handoff.header[13];
  let clearProjection: (() => void) | undefined;
  let retirementStarted = false,
    overlayRetired = false;
  const retireMount = async () => {
    clearProjection?.();
    clearProjection = undefined;
    if (overlay) {
      retirementStarted = true;
      await store.assertNoIntents();
      await retireOverlay(store, overlay, request.overlayMount!);
      overlayRetired = true;
    }
  };
  const finish = async (result: BasePostResult) => {
    await retireMount();
    await attempt.finish(['outcome', result.outcome, result.key, null, null]);
  };
  const sources: MetadataPublicationSource[] = [],
    snapshots: MetadataSnapshot[] = [];
  let failure: unknown, answer: BasePostResult | undefined;
  try {
    const { role, access, model, invocation } = store.codec.options;
    if (access !== 'writable' || role === 'distributed-worker') {
      throw new Error('Base post requires writable base role.');
    }
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
      ) {
        throw new Error('Invalid base completion.');
      }
      await attempt.guard();
      answer = { outcome: terminal[1] as BasePostResult['outcome'], key: terminal[2] };
    } else {
      if (overlay) {
        if (!request.overlayMount) {
          throw new Error('OverlayFS mount driver unavailable in post.');
        }
        await verifyOverlay(store, overlay, request.overlayMount);
      }
      const gate = await timed(
        request,
        'required quiescence',
        () => ExclusiveWindow.establish(store, request.budget, request),
        (r) => r.status,
      );
      if (gate.status !== 'ready') {
        if (overlay || request.required || role === 'distributed-aggregator') {
          throw new Error('Required base post is not quiescent: ' + gate.message);
        }
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
        if (retained.length) {
          request.onWarning?.(message);
        }
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
        if (overlay) {
          await verifyOverlay(store, overlay, request.overlayMount!);
        }
        const provenUnchanged = overlay && (await unchangedOverlay(attempt, options));
        if (!provenUnchanged) {
          if (overlay) {
            clearProjection = projectOverlay(store, overlay, (relative) =>
              withinOverlay(overlay[10], relative),
            );
          }
          const observation = await timed(
            options,
            'observation capture and index construction',
            () =>
              captureObservations(store, {
                ...options,
                retainIndex: true,
                summaries: request.summaries,
                purgeWindow:
                  attempt.handoff.header[6] === 'enabled' ? window!.purgeWindow : undefined,
              }),
          );
          captured = observation.index!;
        }
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
          for (const entry of attempt.handoff.entries) {
            if (entry[4]) {
              await MetadataSnapshot.retireHandoff(store, entry[4], options);
            }
          }
          await captured?.dispose();
          captured = undefined;
          answer = { outcome, key: null };
          await finish(answer);
        } else if (provenUnchanged) {
          for (const entry of attempt.handoff.entries) {
            const reused = reusablePin(entry)![7] === null ? 'empty' : 'reuse';
            request.summaries?.choice(entry[1], reused);
            timingDecision(options, `partition publication [partition=${entry[1]}]`, reused);
            if (entry[4]) {
              await MetadataSnapshot.retireHandoff(store, entry[4], options);
            }
          }
          answer = { outcome: 'no-change', key: attempt.generation![11] };
          await finish(answer);
        } else {
          owner = await timed(options, 'GC', () => GcSurvivorOwner.execute(captured!, options));
          captured = undefined;
          const live = await MetadataPublicationSource.survivors(owner);
          sources.push(live);
          const overrides: [string, MetadataPublicationSource][] = [];
          for (const entry of attempt.handoff.entries) {
            if (entry[4]) {
              const partition = model.partitions.find((p) => p[0] === entry[1])!;
              if (
                partition[3] !== 'single-writer' ||
                ownsLocalSnapshot(partition, store.codec.options)
              ) {
                throw new Error('Unexpected retained snapshot source selection.');
              }
              const snapshot = await MetadataSnapshot.admit(store, entry[4], options);
              snapshots.push(snapshot);
              const source = await MetadataPublicationSource.snapshot(snapshot);
              sources.push(source);
              overrides.push([entry[1], source]);
            }
          }
          for (const partition of model.partitions) {
            if (
              partition[3] === 'single-writer' &&
              !ownsLocalSnapshot(partition, store.codec.options) &&
              !overrides.some(([p]) => p === partition[0])
            ) {
              throw new Error('Missing independent authoritative snapshot root.');
            }
          }
          let set = MetadataPublicationSet.select(live, overrides);
          const choices = await timed(options, 'partition reuse planning', async () => {
            const choices: MetadataPublicationChoice[] = [];
            for (const entry of attempt.handoff.entries) {
              const partition = entry[1],
                summary = set.summary(partition),
                pin = reusablePin(entry);
              const reuse = pin !== null && same(pin[9], summary);
              if (reuse) {
                choices.push(pin[7] === null ? ['empty', partition] : ['reuse', partition, pin[7]]);
              } else {
                choices.push(
                  summary[3] === 0 && summary[4] === 0 ? ['empty', partition] : ['new', partition],
                );
              }
            }
            for (const choice of choices) {
              request.summaries?.choice(choice[1], choice[0]);
              timingDecision(options, `partition publication [partition=${choice[1]}]`, choice[0]);
            }
            return choices;
          });
          const prior = attempt.generation,
            entries = choices.map((choice) =>
              choice[0] === 'reuse' ? ['object', choice[1], choice[2]] : choice,
            );
          const unchanged = prior !== null && same(entries, prior[8]),
            lineage = lineageId(attempt.handoff.header[2]);
          // This exit precedes candidate groups/root plans/layouts/generation and output-only copies.
          if (unchanged && prior[5] === lineage) {
            answer = { outcome: 'no-change', key: prior[11] };
          } else {
            const staged: [string, MetadataPublicationSource][] = [];
            for (const choice of choices) {
              if (choice[0] === 'new') {
                const partition = model.partitions.find((p) => p[0] === choice[1])!;
                if (overlay && !overrides.some(([id]) => id === partition[0])) {
                  const copy = await MetadataSnapshot.stageOverlay(live, partition[0], options);
                  snapshots.push(copy);
                  const source = await MetadataPublicationSource.snapshot(copy);
                  sources.push(source);
                  staged.push([partition[0], source]);
                } else if (ownsLocalSnapshot(partition, store.codec.options)) {
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
            }
            set = MetadataPublicationSet.select(live, overrides, staged);
            const result = await timed(
              options,
              'base publication',
              () =>
                publishMetadataBase(set, backend!, {
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
                }),
              (r) => r.outcome,
            );
            answer = { outcome: result.outcome, key: result.generation?.[11] ?? null };
          }
          await timed(request, 'cleanup and retirement', () =>
            settleNativeCleanup([
              ...sources
                .splice(0)
                .reverse()
                .map((source) => () => source.dispose()),
              ...snapshots.splice(0).map((snapshot) => () => snapshot.retire()),
              () => owner?.dispose(),
            ]),
          );
          owner = undefined;
          await finish(answer);
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await timed(request, 'cleanup and retirement', () =>
      settleNativeCleanup(
        [
          ...sources.reverse().map((source) => () => source.dispose()),
          ...snapshots.map((snapshot) => () => snapshot.dispose()),
          () => owner?.dispose(),
          () => captured?.dispose(),
        ],
        failure,
      ),
    );
    if (failure !== undefined && overlay && window && !retirementStarted) {
      await retireMount();
    }
  } catch (cleanup) {
    failure =
      failure === undefined
        ? cleanup
        : new AggregateError([failure, cleanup], 'Base post cleanup failed.');
  } finally {
    clearProjection?.();
    try {
      if (failure !== undefined && overlay && !overlayRetired) {
        request.onWarning?.('OverlayFS state retained at ' + store.root.resolve(overlay[2]));
      }
    } catch (report) {
      failure = new AggregateError([failure, report], 'OverlayFS retention reporting failed.');
    } finally {
      window?.close();
      attempt.close();
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return answer!;
}
