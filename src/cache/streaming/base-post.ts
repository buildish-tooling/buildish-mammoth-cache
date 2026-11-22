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

import type { ObservationIndex } from './observation-index';
import { OpenedInvocation, type InvocationAnchor } from './invocation';
import { reconcileInvocation, type RecoveryOptions } from './recovery';
import { PrepareFacts, type PrepareBindings } from './prepare-state';
import { ExclusiveWindow } from './quiescence';
import { assertLifecycleWindow } from './post-admission';
import { BaselineMetadata, type BaseMetadata } from './baseline-metadata';
import { baselineGeneration } from './base-publication';
import { captureObservations } from './observation-capture';
import { LiveBaseInputs } from './live-base-inputs';
import { FrozenMovingPublication } from './base-moving-publication';
import { MovingBasePublication } from './moving-publication';
import type { BaseCacheBackend } from '../backend';
import type { PartitionSummaries } from './partition-summaries';
import type { OwnedStore } from './owned-store';

export interface BasePostRequest extends RecoveryOptions {
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
async function completed(
  store: OwnedStore,
  bindings: PrepareBindings,
  options: RecoveryOptions,
  outcome: 'published' | 'no-change' | 'skipped-not-quiescent' | 'feature-unavailable',
) {
  await store.assertNoIntents();
  await assertLifecycleWindow(store, bindings, options);
  const state = store.codec.schemas.documents['local-state'].parse(await store.state());
  state[3]++;
  state[4] = 'completed';
  state[14] = outcome;
  await store.updateState(state);
  await assertLifecycleWindow(store, bindings, options);
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#moving-source-publication-handoff.
// Provider factories are deferred until recovery, exclusivity and observation freeze.
export async function postStreamingBase(input: BasePostRequest): Promise<BasePostResult> {
  const caller = Object.freeze({ ...input }),
    opened = await OpenedInvocation.open(caller.anchor, caller.budget, caller.cleanupSignal),
    request = Object.freeze({ ...caller, maxDirectoryEntries: opened.bindings[8][9] }),
    store = await reconcileInvocation(opened, 'resume', request),
    facts = await PrepareFacts.open(store, request);
  let capturedIndex: ObservationIndex | undefined;
  let window: ExclusiveWindow | undefined,
    live: LiveBaseInputs | undefined,
    frozen: FrozenMovingPublication | undefined,
    publisher: MovingBasePublication | undefined;
  let failure: unknown, result: BasePostResult | undefined;
  try {
    try {
      const { role, access } = store.codec.options;
      if (access !== 'writable' || role === 'distributed-worker')
        throw new Error('Base post requires writable base role.');
      if (!facts.selection) throw new Error('Missing frozen prepare selection.');
      if (facts.state[4] === 'completed') {
        const outcome = facts.state[14];
        if (
          ![
            'published',
            'no-change',
            'skipped-not-quiescent',
            'feature-unavailable',
            'abandoned',
          ].includes(outcome!)
        )
          throw new Error('Invalid base completion.');
        await assertLifecycleWindow(store, facts.bindings, request);
        const publication = facts.state[8]
          ? store.codec.schemas.documents.publication.parse(
              await store.readDocument(facts.state[8], 'publication'),
            )
          : null;
        await assertLifecycleWindow(store, facts.bindings, request);
        return {
          outcome: outcome as BasePostResult['outcome'],
          key: outcome === 'no-change' ? facts.bindings[9]![1] : (publication?.[8] ?? null),
        };
      }
      if (facts.state[4] === 'prepare-pending') {
        await reconcileInvocation(
          await OpenedInvocation.open(request.anchor, request.budget),
          'abandon',
          request,
        );
        throw new Error('Base post cannot publish failed prepare.');
      }
      const gate = await ExclusiveWindow.establish(store, request.budget, request);
      if (gate.status !== 'ready') {
        if (facts.state[6] || request.required || role === 'distributed-aggregator')
          throw new Error('Required base post is not quiescent: ' + gate.message);
        await completed(store, facts.bindings, request, 'skipped-not-quiescent');
        return { outcome: gate.status, key: null, message: gate.message };
      }
      window = gate.window;
      const options = { ...request, signal: window.signal, assertCurrent: window.assertCurrent };
      let baseline: readonly BaseMetadata[] | undefined;
      const getBaseline = async () => {
        if (baseline) return baseline;
        const prior = await baselineGeneration(store, facts.bindings),
          rows: BaseMetadata[] = [],
          cold = new Set(facts.selection![7] ?? []);
        for (const e of prior?.[8] ?? [])
          if (e[0] === 'object' && !cold.has(e[1]))
            rows.push(await BaselineMetadata.open(store, e[2], options));
        return (baseline = Object.freeze(rows));
      };
      if (!facts.state[6]) {
        await request.removeHooks(store);
        await assertLifecycleWindow(store, facts.bindings, options);
        const captured = await captureObservations(store, {
          retainIndex: true,
          ...options,
          baseline: await getBaseline(),
          summaries: request.summaries,
          purgeWindow: facts.selection[4][4] === 'enabled' ? window.purgeWindow : undefined,
        });
        capturedIndex = captured.index;
      }
      await assertLifecycleWindow(store, facts.bindings, options);
      let state = store.codec.schemas.documents['local-state'].parse(await store.state());
      // No backend or source traversal until a frozen observation has been committed.
      const backend = await request.cacheBackend();
      if (!backend.isFeatureAvailable()) {
        // Only optional, pre-publication work may finish without a cache receipt.
        if (
          role === 'standalone' &&
          !request.required &&
          ['observations-frozen', 'gc-complete'].includes(state[4]) &&
          state[8] === null
        ) {
          await completed(store, facts.bindings, options, 'feature-unavailable');
          return { outcome: 'feature-unavailable', key: null };
        }
        throw new Error('Native base backend cannot publish.');
      }
      if (!backend.capabilities.supportsExplicitSave)
        throw new Error('Native base backend cannot publish.');
      if (['observations-frozen', 'gc-complete'].includes(state[4])) {
        live = await LiveBaseInputs.capture(store, options, facts, capturedIndex);
        capturedIndex = undefined;
        await assertLifecycleWindow(store, facts.bindings, options);
        frozen = await FrozenMovingPublication.freeze(
          live,
          facts.selection[2],
          await getBaseline(),
          request.summaries,
        );
      } else frozen = await FrozenMovingPublication.resume(store, options);
      publisher = MovingBasePublication.open(frozen, { cleanupSignal: request.cleanupSignal });
      await assertLifecycleWindow(store, facts.bindings, options);
      await publisher.saveObjects(backend);
      await assertLifecycleWindow(store, facts.bindings, options);
      if (await publisher.verifyUnchanged())
        result = { outcome: 'no-change', key: facts.bindings[9]![1] };
      else {
        await publisher.publish(backend);
        result = { outcome: 'published', key: frozen.generation[11] };
      }
      // Close readers before terminal state; source return never depends on foreground cancellation.
      await publisher.close();
      publisher = undefined;
      frozen.dispose();
      frozen = undefined;
      await live?.dispose();
      live = undefined;
      await completed(
        store,
        facts.bindings,
        options,
        result.outcome === 'published' ? 'published' : 'no-change',
      );
    } catch (e) {
      failure = e;
    }
    const errors: unknown[] = failure === undefined ? [] : [failure];
    for (const close of [
      () => publisher?.close(),
      () => frozen?.dispose(),
      () => live?.dispose(),
      () => {
        const held = capturedIndex;
        capturedIndex = undefined;
        return held?.dispose();
      },
    ])
      try {
        await close();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Base post cleanup failed.');
    return result!;
  } finally {
    try {
      await capturedIndex?.dispose();
    } finally {
      window?.close();
      facts.close();
    }
  }
}
