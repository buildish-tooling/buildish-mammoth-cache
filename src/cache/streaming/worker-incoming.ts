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

import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { add, equal, tuple } from './encoding';
import { ordinaryOrder } from './reduction';
import {
  assertCompletedWorkerInputs,
  claimCompletedWorkerInputs,
  type WorkerMergeResult,
} from './worker-merge';
import { writeSelectedActivity } from './worker-activity-union';
import { copyWorkerSnapshot, writeWorkerNativeEvidence } from './worker-native';
import { PreparedWorkerSnapshot } from './worker-snapshot';
import { VerifiedIncoming } from './install-evidence';
import { freezeInstallPlan } from './install-plan';
import { executeInstall, recoverInstall } from './install-execute';
import type { WorkerStage } from './worker-stage';

export interface AcceptedWorkerMerge {
  readonly incoming: readonly VerifiedIncoming[];
  readonly snapshots: readonly PreparedWorkerSnapshot[];
  readonly activity: Reference;
  readonly work: Readonly<{ snapshotCopyBytes: number; activityDirectoryListings: number }>;
}
const accepted = new WeakMap<object, { store: OwnedStore; max: number }>();
// Protocol: docs/dev/cache-protocol.md#complete-unit-and-final-acceptance.
// No incoming partition escapes until ALL archives, activity and native staging have
// completed. V4a retains exclusive responsibility for current/preimage/backup/install.
export async function acceptWorkerMerge(
  store: OwnedStore,
  result: WorkerMergeResult,
  budget: WorkingBudget,
  signal = new AbortController().signal,
): Promise<AcceptedWorkerMerge> {
  if (result.stage.budget !== budget)
    throw new Error('Worker acceptance requires the shared working budget.');
  const input = claimCompletedWorkerInputs(store, result),
    copies: WorkerStage[] = [],
    snapshots: PreparedWorkerSnapshot[] = [...result.inheritedSnapshots];
  let snapshotCopyBytes = 0;
  try {
    await recoverInstall(store, budget, signal);
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
    const activityWork = { listings: 0 };
    const activity = Object.freeze(
      await writeSelectedActivity(
        store,
        result.activity,
        result.partitions,
        budget,
        signal,
        input.max,
        activityWork,
      ),
    ) as Reference;
    // Selected-only independent snapshot copies precede consumption of the install copy.
    for (const partition of result.selectedSnapshots) {
      const part = result.partitions.find((p) => p.partition === partition);
      if (!part) throw new Error('Missing selected snapshot staging.');
      const copy = await copyWorkerSnapshot(store, part, budget, signal, input.max);
      copies.push(copy.stage);
      snapshotCopyBytes = add(snapshotCopyBytes, copy.readBytes);
      const [retained] = await copy.stage.publish('snapshot', signal),
        evidence = await writeWorkerNativeEvidence(
          store,
          retained,
          budget,
          signal,
          input.max,
          true,
        ),
        provenance = result.snapshotOrigins.find((p) => p.partition === partition)!.producerId;
      snapshots.push(
        await PreparedWorkerSnapshot.verify(
          store,
          {
            partition,
            nativeRoot: retained.nativeRoot,
            evidence,
            provenance,
            origin: 'worker-writer',
            finishVerification: async (binding) => {
              assertCompletedWorkerInputs(store, result);
              return binding;
            },
          },
          budget,
          { signal, maxDirectoryEntries: input.max },
        ),
      );
    }
    const published = await result.stage.publish('install', signal),
      evidence: { partition: string; nativeRoot: string; reference: Reference }[] = [];
    for (const part of published)
      evidence.push({
        partition: part.partition,
        nativeRoot: part.nativeRoot,
        reference: await writeWorkerNativeEvidence(store, part, budget, signal, input.max, true),
      });
    for (const snapshot of result.inheritedSnapshots)
      await snapshot.verify(signal, budget, input.max);
    // Every source/evidence gate above is common to every receipt below. Each V4a
    // verifier then checks the sealed Q against its actual final native namespace.
    const incoming: VerifiedIncoming[] = [];
    for (const part of evidence)
      incoming.push(
        await VerifiedIncoming.verify(
          store,
          {
            partition: part.partition,
            nativeRoot: part.nativeRoot,
            evidence: part.reference,
            origin: 'worker',
            finishVerification: async (binding) => {
              assertCompletedWorkerInputs(store, result);
              return binding;
            },
          },
          { budget, signal, maxDirectoryEntries: input.max },
        ),
      );
    signal.throwIfAborted();
    result.stage.adopt();
    for (const copy of copies) copy.adopt();
    await result.dispose();
    for (const copy of copies) await copy.dispose();
    signal.throwIfAborted();
    const value: AcceptedWorkerMerge = Object.freeze({
      incoming: Object.freeze(incoming),
      snapshots: Object.freeze(snapshots),
      activity,
      work: Object.freeze({ snapshotCopyBytes, activityDirectoryListings: activityWork.listings }),
    });
    accepted.set(value, { store, max: input.max });
    return value;
  } catch (error) {
    const settled = await Promise.allSettled([result.dispose(), ...copies.map((c) => c.dispose())]),
      failures = settled
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'Worker acceptance failed; owned cleanup blocked.',
        { cause: error },
      );
    throw error;
  }
}
/** One V4a install attempt; interrupted attempts retain intents/sources for recoverInstall. */
export async function installWorkerMerge(
  store: OwnedStore,
  result: AcceptedWorkerMerge,
  budget: WorkingBudget,
  signal = new AbortController().signal,
  beforeInstall?: () => Promise<void>,
): Promise<void> {
  const binding = accepted.get(result);
  if (!binding || binding.store !== store) throw new Error('Unbound accepted worker merge.');
  const plan = await freezeInstallPlan(store, result.incoming, budget, {
    signal,
    maxDirectoryEntries: binding.max,
  });
  await beforeInstall?.();
  await executeInstall(store, plan, budget, { signal });
}
