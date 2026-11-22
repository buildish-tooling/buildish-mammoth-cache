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

import { mkdir, lstat } from 'node:fs/promises';
import { LocalCodec, policySchema, type Role, type Access } from './local-schema';
import { invocationId, type ResolvedModel } from './model';
import { contextSchema, type Context } from './schema';
import { NativeRoot, missing, type Failpoint } from './native';
import { OwnedStore } from './owned-store';
import {
  OpenedInvocation,
  invocationAnchor,
  encodeInvocationAnchor,
  type InvocationAnchor,
} from './invocation';
import { reconcileInvocation, admitBootstrapCandidate, type RecoveryOptions } from './recovery';
import { PrepareFacts, localRecords } from './prepare-state';
import { equal, uint, type Value } from './encoding';
import { clearPrepareInstall } from './owned-retirement';
import { BaselineMetadata } from './baseline-metadata';
import { assertLifecycleWindow } from './post-admission';
import { PinnedBaseGeneration, ProvisionalBaseSet } from './base-generation';
import { acceptBaseGeneration, type AcceptedBaseGeneration } from './base-incoming';
import { freezeInstallPlan } from './install-plan';
import { executeInstall } from './install-execute';
import { discoverWorkerArtifacts, acquireWorkerArtifacts } from './worker-service';
import { mergeWorkerArchives, type WorkerMergeResult } from './worker-merge';
import { ordinaryOrder } from './reduction';
import { acceptWorkerMerge, installWorkerMerge } from './worker-incoming';
import type { PreparedWorkerSnapshot } from './worker-snapshot';
import {
  prepareWorkerRequests,
  selectedWorkers,
  immutableWorkerInputs,
  emptyInstallInput,
  emptyPrepareSnapshot,
  reopenPrepareSnapshots,
  snapshotSource,
  snapshotRequirements,
} from './prepare-inputs';
import type { BaseCacheBackend } from '../backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';

export interface StreamingPrepareRequest extends RecoveryOptions {
  readonly root: string;
  readonly model: ResolvedModel;
  readonly context: Context;
  readonly nonce: string;
  readonly policy: {
    readonly role: Role;
    readonly access: Access;
    readonly restoreCleanup: 'none' | 'prune-managed';
    readonly gcAgeMs: number | null;
    readonly ordinaryPolicy: 'strict' | 'newer-mtime';
    readonly ordinaryOrder: readonly string[];
  };
  readonly currentRef: string;
  readonly defaultRef?: string;
  readonly captureTempDirectory: string | null;
  readonly artifactRetentionDays: number;
  readonly cleanupEnabled: boolean;
  readonly onWorkerWarnings?: (warnings: WorkerMergeResult['warnings']) => void;
  readonly saveAnchor: (anchor: string) => void;
  readonly cacheBackend: () => Promise<BaseCacheBackend>;
  readonly artifactBackend?: () => Promise<WorkflowArtifactBackend>;
  readonly provision: () => Promise<void>;
  readonly installHooks: (store: OwnedStore) => Promise<void>;
  readonly now?: () => number;
  readonly fail?: Failpoint;
}
export interface StreamingPrepareResult {
  readonly store: OwnedStore;
  readonly anchor: InvocationAnchor;
  readonly cutoff: number;
  readonly restoredKey: string | null;
  readonly workerCount: number;
}
async function commit(
  store: OwnedStore,
  options: RecoveryOptions,
  change: Parameters<PrepareFacts['commit']>[0],
) {
  const facts = await PrepareFacts.open(store, options);
  try {
    await facts.commit(change);
  } finally {
    facts.close();
  }
}
async function clearInstall(store: OwnedStore, options: RecoveryOptions) {
  const facts = await PrepareFacts.open(store, options);
  try {
    await clearPrepareInstall(facts, options.assertCurrent);
  } finally {
    facts.close();
  }
}
function assertRequest(request: StreamingPrepareRequest, facts: PrepareFacts) {
  const s = facts.selection,
    b = facts.bindings,
    p = request.policy;
  if (!s) throw new Error('Integrated prepare is missing frozen configuration.');
  equal(
    [request.model.id, request.model.family, request.context, request.nonce],
    [facts.store.codec.options.model.id, facts.store.codec.options.model.family, b[3], b[4]],
    'prepare identity/configuration',
  );
  equal(
    [
      p.role,
      p.access,
      p.restoreCleanup,
      p.gcAgeMs === null ? 'off' : 'timestamp',
      p.ordinaryPolicy,
      request.maxDirectoryEntries ?? 100000,
      p.ordinaryOrder,
    ],
    [b[8][2], b[8][3], b[8][4], b[8][5], b[8][8], b[8][9], b[8][10]],
    'prepare effective policy',
  );
  equal(
    [
      request.currentRef,
      request.defaultRef ?? null,
      request.captureTempDirectory,
      request.artifactRetentionDays,
      request.cleanupEnabled ? 'enabled' : 'disabled',
      p.gcAgeMs,
    ],
    [s[2], s[3], s[4][2], s[4][3], s[4][4], s[4][5]],
    'prepare frozen execution configuration',
  );
  if (s[6][0] === 'selected') selectedWorkers(facts);
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-prepare-selection.
// Internal composition for R1; released Actions still select their existing lifecycle.
export async function prepareStreaming(
  input: StreamingPrepareRequest,
): Promise<StreamingPrepareResult> {
  const order = Object.freeze(ordinaryOrder(input.policy.ordinaryOrder));
  const request: StreamingPrepareRequest = Object.freeze({
    ...input,
    context: contextSchema.parse(input.context),
    policy: Object.freeze({
      ...input.policy,
      ordinaryOrder: order,
    }),
    defaultRef: input.defaultRef === input.currentRef ? undefined : input.defaultRef,
  });
  const signal = request.signal ?? new AbortController().signal,
    cleanup = request.cleanupSignal ?? new AbortController().signal,
    options = {
      budget: request.budget,
      signal,
      maxDirectoryEntries: request.maxDirectoryEntries ?? 100000,
      cleanupSignal: cleanup,
      assertCurrent: request.assertCurrent,
      inspect: request.inspect,
      onWorkerWarnings: request.onWorkerWarnings,
    },
    id = invocationId(request.context, request.nonce);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (request.assertCurrent() !== undefined)
      throw new Error('Prepare lifetime assertion must be synchronous.');
  };
  if (request.policy.gcAgeMs !== null && uint(request.policy.gcAgeMs) === 0)
    throw new Error('Invalid GC age.');
  if (
    !request.cleanupEnabled &&
    (request.policy.gcAgeMs !== null || request.policy.restoreCleanup !== 'none')
  )
    throw new Error('Disabled cleanup has active deletion policy.');
  if (request.policy.role !== 'distributed-aggregator' && request.policy.ordinaryOrder.length)
    throw new Error('Only an aggregator applies dependent workers.');
  try {
    await lstat(request.root);
  } catch (error) {
    if (!missing(error)) throw error;
    signal.throwIfAborted();
    await mkdir(request.root, { recursive: true });
  }
  const root = await NativeRoot.bind(request.root),
    old = await OpenedInvocation.current(root.path, request.budget, cleanup);
  if (old)
    await reconcileInvocation(
      old,
      old.store.codec.options.invocation === id ? 'resume' : 'abandon',
      options,
    );
  signal.throwIfAborted();
  assertCurrent();
  if (old?.store.codec.options.invocation === id)
    equal(
      [request.model.id, request.model.family, request.policy.role, request.policy.access],
      [
        old.store.codec.options.model.id,
        old.store.codec.options.model.family,
        old.store.codec.options.role,
        old.store.codec.options.access,
      ],
      'frozen prepare model/role',
    );
  const codec = new LocalCodec({
      model: request.model,
      context: request.context,
      invocation: id,
      role: request.policy.role,
      access: request.policy.access,
    }),
    store = await OwnedStore.bind(root.path, codec, request.fail),
    anchor = invocationAnchor(store.root, request.context, request.nonce);
  request.saveAnchor(encodeInvocationAnchor(anchor));
  if (!old || old.store.codec.options.invocation !== id) {
    await admitBootstrapCandidate(store, options);
    const start = uint((request.now ?? Date.now)()),
      age = request.policy.gcAgeMs;
    const policy = policySchema.parse([
      'policy',
      1,
      request.policy.role,
      request.policy.access,
      request.policy.restoreCleanup,
      age === null ? 'off' : 'timestamp',
      age === null ? null : Math.max(0, start - age),
      null,
      request.policy.ordinaryPolicy,
      options.maxDirectoryEntries,
      request.policy.ordinaryOrder,
    ]);
    await store.makeParents(store.prefix + 'install/pending');
    const install = (await store.root.stat(store.prefix + 'install'))!;
    if (install[3] !== store.root.binding[3]) throw new Error('Cross-filesystem install staging.');
    const selection = codec.schemas.rows.prepareSelection.parse([
      'prepare-selection',
      1,
      request.currentRef,
      request.defaultRef ?? null,
      [
        'execution',
        1,
        request.captureTempDirectory,
        request.artifactRetentionDays,
        request.cleanupEnabled ? 'enabled' : 'disabled',
        age,
      ],
      ['pending'],
      ['pending'],
      null,
      install,
      'selected',
    ]);
    const stream = { ...options, partition: null };
    const model = await store.writeStream(
        'model',
        stream,
        localRecords([
          ['model-header', request.model.tuple[2], request.model.tuple[3]],
          ...request.model.partitions.map((p) => ['partition', ...p] as Value),
        ]),
        signal,
      ),
      producers = await store.writeStream('producers', stream, localRecords([]), signal),
      sources = await store.writeStream(
        'prepare-sources',
        stream,
        localRecords([selection]),
        signal,
      );
    await store.initialize(
      [
        'bindings',
        1,
        id,
        request.context,
        request.nonce,
        [store.root.path, store.root.binding],
        model,
        request.model.familyProjection,
        policy,
        null,
        producers,
        sources,
        null,
      ],
      old?.store,
    );
  }
  let cache: BaseCacheBackend | undefined, artifacts: WorkflowArtifactBackend | undefined;
  const getCache = async () => (cache ??= await request.cacheBackend());
  const getArtifacts = async () => {
    if (!request.artifactBackend) throw new Error('Required artifact backend is missing.');
    return (artifacts ??= await request.artifactBackend());
  };
  try {
    let facts = await PrepareFacts.open(store, options);
    try {
      assertRequest(request, facts);
      if (facts.state[4] === 'build-ready') {
        await assertLifecycleWindow(store, facts.bindings, options);
        assertCurrent();
        return result(facts, anchor);
      }
      if (facts.state[4] !== 'prepare-pending')
        throw new Error('Prepare cannot restart this lifecycle phase.');
    } finally {
      facts.close();
    }
    await request.provision();
    signal.throwIfAborted();
    assertCurrent();
    while (true) {
      facts = await PrepareFacts.open(store, options);
      try {
        assertRequest(request, facts);
        const s = structuredClone(facts.selection!);
        if (s[5][0] === 'pending') {
          const backend = await getCache(),
            pin = backend.isFeatureAvailable()
              ? await PinnedBaseGeneration.discover(
                  store,
                  backend,
                  { currentRef: s[2], defaultRef: s[3] ?? undefined },
                  options,
                )
              : null;
          const failures: unknown[] = [];
          try {
            if (pin) {
              const ref = await store.write(
                'generation',
                store.read(pin.record, 'generation'),
                signal,
              );
              s[5] = ['pinned', pin.key, codec.schemas.ref('generation').parse(ref)];
            } else s[5] = ['miss'];
            await facts.commit({ selection: s });
          } catch (error) {
            failures.push(error);
          }
          try {
            await pin?.dispose();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length)
            throw new AggregateError(failures, 'Base selection commitment and cleanup failed.');
          continue;
        }
        if (s[6][0] === 'pending') {
          const requests = prepareWorkerRequests(facts),
            selected = requests.length
              ? await discoverWorkerArtifacts(
                  await getArtifacts(),
                  request.model,
                  request.context,
                  requests,
                  { signal },
                )
              : [];
          s[6] = [
            'selected',
            selected.map((w) => [
              w.artifact.id,
              w.artifact.name,
              w.artifact.size,
              w.artifact.digest,
              w.context,
              [...w.authorizedSnapshots],
            ]),
          ];
          await facts.commit({ selection: s });
          continue;
        }
        await store.fail('prepare-inputs-selected');
        const selected = selectedWorkers(facts);
        if (selected.length && !facts.producers.length) {
          const downloads = await acquireWorkerArtifacts(store, await getArtifacts(), selected, {
            signal,
          });
          let committed = false;
          const failures: unknown[] = [];
          try {
            await facts.commit({
              producers: downloads.map((d) =>
                codec.schemas.rows.producer.parse((d.producer() as readonly Value[])[1]),
              ),
            });
            committed = true;
          } catch (error) {
            failures.push(error);
          }
          if (!committed)
            for (const d of downloads)
              try {
                await d.dispose();
              } catch (error) {
                failures.push(error);
              }
          if (failures.length === 1) throw failures[0];
          if (failures.length)
            throw new AggregateError(failures, 'Prepare artifact commitment failed.');
          continue;
        }
        if (facts.producers.length !== selected.length)
          throw new Error('Frozen producer inventory is incomplete.');
        if (s[9] === 'workers-installed') break;
        // Only proven private incoming copies are disposable; no live source is removed here.
        await clearPrepareInstall(facts, request.assertCurrent);
        await installSelectedPrepare(facts, options, getCache);
      } finally {
        facts.close();
      }
    }
    await clearInstall(store, options);
    await request.installHooks(store);
    signal.throwIfAborted();
    assertCurrent();
    const terminal = await PrepareFacts.open(store, options);
    try {
      await assertLifecycleWindow(store, terminal.bindings, options);
      assertCurrent();
      await store.fail('prepare-before-build-ready');
      await terminal.commit({ cutoff: uint((request.now ?? Date.now)()), ready: true });
      await store.fail('prepare-ready');
      assertCurrent();
      signal.throwIfAborted();
    } finally {
      terminal.close();
    }
    const ready = await PrepareFacts.open(store, options);
    try {
      await assertLifecycleWindow(store, ready.bindings, options);
      assertCurrent();
      return result(ready, anchor);
    } finally {
      ready.close();
    }
  } catch (primary) {
    // Close phase consumers before this outer boundary. Ordinary cancellation must
    // not suppress a discoverable active install's independent reconciliation.
    try {
      const current = await OpenedInvocation.current(root.path, request.budget, cleanup);
      if (current?.store.codec.options.invocation === id)
        await reconcileInvocation(current, 'resume', {
          ...options,
          signal: cleanup,
          cleanupSignal: cleanup,
        });
    } catch (error) {
      throw new AggregateError(
        [primary, error],
        'Prepare failed and root recovery remains blocked.',
        { cause: error },
      );
    }
    throw primary;
  }
}
function result(facts: PrepareFacts, anchor: InvocationAnchor): StreamingPrepareResult {
  if (facts.state[4] !== 'build-ready' || facts.bindings[8][7] === null)
    throw new Error('Prepare did not finish.');
  return {
    store: facts.store,
    anchor,
    cutoff: facts.bindings[8][7],
    restoredKey: facts.bindings[9]?.[1] ?? null,
    workerCount: facts.producers.length,
  };
}

async function installSelectedPrepare(
  facts: PrepareFacts,
  options: RecoveryOptions & Pick<StreamingPrepareRequest, 'onWorkerWarnings'>,
  getCache: () => Promise<BaseCacheBackend>,
) {
  const { store } = facts,
    s = facts.selection!,
    signal = options.signal ?? new AbortController().signal;
  let pin: PinnedBaseGeneration | undefined,
    set: ProvisionalBaseSet | undefined,
    accepted: AcceptedBaseGeneration | undefined,
    merged: WorkerMergeResult | undefined;
  const failures: unknown[] = [];
  try {
    let snapshots: PreparedWorkerSnapshot[];
    if (s[9] === 'selected') {
      if (s[5][0] === 'pinned') {
        pin = await PinnedBaseGeneration.resume(
          store,
          s[5][1],
          s[5][2],
          { currentRef: s[2], defaultRef: s[3] ?? undefined },
          options,
        );
        set = await ProvisionalBaseSet.acquire(pin, await getCache(), options);
        accepted = await acceptBaseGeneration(store, set, options);
        const available = new Set(accepted.cold.flat());
        for (const download of set.downloads)
          if (download.object && !available.has(download.object.reference[1][2]))
            await BaselineMetadata.retain(download.object, options);
      }
      const cold = accepted ? new Set(accepted.cold.flat()) : new Set<string>();
      const outcome = store.codec.options.model.partitions
        .filter((p) => cold.has(p[0]))
        .map((p) => p[0]);
      if (s[7] !== null) equal(outcome, s[7], 'frozen base availability outcome');
      const next = structuredClone(s);
      next[7] = outcome;
      await facts.commit({
        selection: next,
        baseline: accepted
          ? store.codec.schemas.documents.bindings.parse([
              ...facts.bindings.slice(0, 9),
              accepted.baseline,
              ...facts.bindings.slice(10),
            ])[9]
          : null,
        sources: accepted?.snapshots.map(snapshotSource) ?? [],
      });
      // Accepted incoming roots and retained snapshots are independent now. Drop
      // unused downloaded group members before worker staging overlaps this phase.
      await set?.dispose();
      set = undefined;
      await pin?.dispose();
      pin = undefined;
      // Missing/cold snapshots have a deliberately empty authority, not stale live contents.
      const selectedFacts = await PrepareFacts.open(store, options);
      try {
        snapshots = [...(accepted?.snapshots ?? [])];
        const present = new Set(snapshots.map((p) => p.partition));
        for (const p of store.codec.options.model.partitions)
          if (p[3] === 'single-writer' && !present.has(p[0]))
            snapshots.push(await emptyPrepareSnapshot(selectedFacts, p[0]));
        await selectedFacts.commit({ sources: snapshots.map(snapshotSource) });
      } finally {
        selectedFacts.close();
      }
      const beforeInstall = await PrepareFacts.open(store, options);
      try {
        if (
          store.codec.options.role === 'distributed-aggregator' &&
          store.codec.options.access === 'writable'
        )
          merged = await mergeWorkerArchives(store, immutableWorkerInputs(beforeInstall), {
            ...options,
            ordinaryOrder: beforeInstall.bindings[8][10],
            ordinaryPolicy: beforeInstall.bindings[8][8],
            snapshots: snapshotRequirements(beforeInstall, snapshots),
          });
        if (merged) options.onWorkerWarnings?.(merged.warnings);
        const incoming = [...(accepted?.incoming ?? [])],
          present = new Set(incoming.map((i) => i.partition)),
          prune = beforeInstall.bindings[8][4] === 'prune-managed' && s[5][0] === 'pinned';
        for (const p of store.codec.options.model.partitions)
          if (!present.has(p[0]) && (prune || p[3] === 'single-writer'))
            incoming.push(await emptyInstallInput(store, p[0], options));
        if (incoming.length) {
          await assertLifecycleWindow(store, beforeInstall.bindings, options);
          const plan = await freezeInstallPlan(store, incoming, options.budget, {
            ...options,
            pruneAggregates: prune,
          });
          await assertLifecycleWindow(store, beforeInstall.bindings, options);
          await executeInstall(store, plan, options.budget, { signal });
        }
        const next = structuredClone(beforeInstall.selection!);
        next[9] = 'base-installed';
        beforeInstall.close();
        await commit(store, options, { selection: next });
        await store.fail('prepare-base-installed');
      } finally {
        beforeInstall.close();
      }
      await clearInstall(store, options);
    } else {
      snapshots = await reopenPrepareSnapshots(facts);
      if (
        store.codec.options.role === 'distributed-aggregator' &&
        store.codec.options.access === 'writable'
      )
        merged = await mergeWorkerArchives(store, immutableWorkerInputs(facts), {
          ...options,
          ordinaryOrder: facts.bindings[8][10],
          ordinaryPolicy: facts.bindings[8][8],
          snapshots: snapshotRequirements(facts, snapshots),
        });
    }
    if (merged) {
      const worker = await acceptWorkerMerge(store, merged, options.budget, signal);
      merged = undefined;
      await commit(store, options, {
        sources: worker.snapshots.map(snapshotSource),
        activity: worker.activity,
      });
      if (worker.incoming.length) {
        await assertLifecycleWindow(store, facts.bindings, options);
        await installWorkerMerge(store, worker, options.budget, signal, () =>
          assertLifecycleWindow(store, facts.bindings, options),
        );
      }
    } else {
      const activity = await store.writeStream(
        'activity',
        { ...options, partition: null },
        localRecords([
          ['dir-open', ''],
          ['dir-close', ''],
        ]),
        signal,
      );
      await commit(store, options, { activity });
    }
    const current = await PrepareFacts.open(store, options);
    try {
      const next = structuredClone(current.selection!);
      next[9] = 'workers-installed';
      await current.commit({ selection: next });
      await store.fail('prepare-workers-installed');
    } finally {
      current.close();
    }
  } catch (error) {
    failures.push(error);
  }
  for (const close of [() => merged?.dispose(), () => set?.dispose(), () => pin?.dispose()])
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, 'Prepare stage and resource cleanup failed.');
}
