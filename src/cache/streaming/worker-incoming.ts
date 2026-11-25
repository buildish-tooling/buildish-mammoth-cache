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

import { timed, type TimingOptions } from '../../util/timing';
import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { add, equal, tuple } from './encoding';
import { ordinaryOrder } from './reduction';
import { claimCompletedWorkerInputs, type WorkerMergeResult } from './worker-merge';
import { writeSelectedActivity } from './worker-activity-union';
import { WorkerNativeIndex } from './worker-native';
import { MetadataSnapshot } from './metadata-snapshot';
import { MetadataInstallContext, type IndexedMetadataInput } from './metadata-install-context';
import { freezeMetadataInstallPlan } from './install-plan';
import { executeInstall } from './install-execute';

export interface AcceptedWorkerMerge {
  dispose(): Promise<void>;
  readonly incoming: readonly IndexedMetadataInput[];
  readonly snapshots: readonly MetadataSnapshot[];
  readonly activity: Reference;
  readonly work: Readonly<{
    snapshotCopyBytes: number;
    activityDirectoryListings: number;
    activityIndexDirectories: number;
  }>;
}

const accepted = new WeakMap<
  object,
  { store: OwnedStore; max: number; context: MetadataInstallContext }
>();
// Protocol: docs/dev/cache-protocol.md#complete-unit-and-final-acceptance.
// No incoming partition escapes until ALL archives, activity and native staging have
// completed. V4a retains exclusive responsibility for current/preimage/backup/install.
export async function acceptWorkerMerge(
  store: OwnedStore,
  result: WorkerMergeResult,
  budget: WorkingBudget,
  signal = new AbortController().signal,
  timing?: TimingOptions['timing'],
): Promise<AcceptedWorkerMerge> {
  if (result.stage.budget !== budget) {
    throw new Error('Worker acceptance requires the shared working budget.');
  }
  const options = { timing, signal };
  const input = claimCompletedWorkerInputs(store, result),
    copies: MetadataSnapshot[] = [],
    snapshots: MetadataSnapshot[] = [...result.inheritedSnapshots];
  let snapshotCopyBytes = 0,
    nativeIndex: WorkerNativeIndex | undefined,
    context: MetadataInstallContext | undefined;
  try {
    await store.assertNoIntents();
    const state = tuple(await store.state()),
      bindings = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      ),
      policy = bindings[8];
    equal(
      [policy[8], policy[9], ordinaryOrder(policy[10])],
      [input.policy, input.max, input.order],
      'worker selection policy',
    );
    const published = await timed(options, 'worker staging publication', () =>
      result.stage.publish('install', signal),
    );
    nativeIndex = await timed(options, 'worker native validation and index construction', () =>
      WorkerNativeIndex.capture(store, published, budget, signal, input.max),
    );
    // Independent bytes precede authority/consumption and use the original selected hierarchy.
    for (const partition of result.selectedSnapshots) {
      const origin = result.snapshotOrigins.find((row) => row.partition === partition);
      if (!origin) {
        throw new Error('Missing selected snapshot origin.');
      }
      const copy = await timed(options, `worker snapshot copy [partition=${partition}]`, () =>
        MetadataSnapshot.copy(nativeIndex!, partition, ['worker', origin.producerId], {
          budget,
          signal,
          maxDirectoryEntries: input.max,
        }),
      );
      copies.push(copy);
      snapshots.push(copy);
      snapshotCopyBytes = add(snapshotCopyBytes, copy.bytes);
    }
    const activityWork = { listings: 0, indexDirectories: 0 };
    const activity = Object.freeze(
      await timed(options, 'worker selected activity preparation', () =>
        writeSelectedActivity(
          store,
          result.activity,
          nativeIndex!,
          budget,
          signal,
          input.max,
          activityWork,
        ),
      ),
    ) as Reference;
    for (const snapshot of result.inheritedSnapshots) {
      await timed(
        options,
        `worker inherited snapshot verification [partition=${snapshot.partition}]`,
        () => snapshot.verify(signal, budget, input.max),
      );
    }
    // Every archive/loser/seal/EOF, activity and snapshot gate completed before this transfer.
    context = MetadataInstallContext.fromWorkerNative(store, nativeIndex, result, {
      budget,
      signal,
      maxDirectoryEntries: input.max,
    });
    const incoming = published.map((part) => context!.source(part.partition)!);
    signal.throwIfAborted();
    result.stage.adopt();
    await timed(options, 'worker merge retirement', () => result.dispose());
    signal.throwIfAborted();
    const value: AcceptedWorkerMerge = Object.freeze({
      dispose: async () => {
        accepted.delete(value);
        const results = await Promise.allSettled([
          context!.dispose(),
          ...copies.map((copy) => copy.dispose()),
        ]);
        const failed = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed.length) {
          throw new AggregateError(
            failed.map((result) => result.reason),
            'Worker accepted owners cleanup failed.',
          );
        }
      },
      incoming: Object.freeze(incoming),
      snapshots: Object.freeze(snapshots),
      activity,
      work: Object.freeze({
        snapshotCopyBytes,
        activityDirectoryListings: activityWork.listings,
        activityIndexDirectories: activityWork.indexDirectories,
      }),
    });
    accepted.set(value, { store, max: input.max, context });
    if (!incoming.length) {
      await context.dispose();
    }
    return value;
  } catch (error) {
    const settled = await timed(
        options,
        'worker acceptance failure cleanup',
        () =>
          Promise.allSettled([
            context?.dispose(),
            nativeIndex?.dispose(),
            result.dispose(),
            ...copies.map((c) => c.retire()),
          ]),
        (outcomes) =>
          outcomes.some((result) => result.status === 'rejected') ? 'failed' : 'success',
      ),
      failures = settled
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
    if (failures.length) {
      throw new AggregateError(
        [error, ...failures],
        'Worker acceptance failed; owned cleanup blocked.',
        { cause: error },
      );
    }
    throw error;
  }
}
/** One install attempt; the running installer owns partial native cleanup. */
export async function installWorkerMerge(
  store: OwnedStore,
  result: AcceptedWorkerMerge,
  budget: WorkingBudget,
  signal = new AbortController().signal,
  beforeInstall?: () => Promise<void>,
): Promise<void> {
  const binding = accepted.get(result);
  if (!binding || binding.store !== store) {
    throw new Error('Unbound accepted worker merge.');
  }
  const plan = await freezeMetadataInstallPlan(store, binding.context, budget, {
    signal,
    maxDirectoryEntries: binding.max,
  });
  await beforeInstall?.();
  return executeInstall(store, plan, budget, {
    signal,
  });
}
