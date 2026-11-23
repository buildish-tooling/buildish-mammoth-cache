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

import { timed } from '../../util/timing';
import { mkdir, lstat } from 'node:fs/promises';
import { lineagePrefix } from './native-records';
import { LocalCodec, policySchema } from './local-schema';
import type { Role, Access } from './local-schema';
import { ownsLocalSnapshot, invocationId, lineageId, type ResolvedModel } from './model';
import { contextSchema, type Context } from './schema';
import { NativeRoot, missing, type Failpoint } from './native';
import { OwnedStore, completedPreviousOwner } from './owned-store';
import { invocationAnchor, encodeInvocationAnchor, type InvocationAnchor } from './invocation';
import type { LifecycleOptions } from './lifecycle-options';
import { uint, type Value } from './encoding';
import { assertLifecycleWindow } from './post-admission';
import { MetadataBaseRestore } from './metadata-base-restore';
import { freezeMetadataInstallPlan } from './install-plan';
import { executeInstall } from './install-execute';
import { discoverWorkerArtifacts, acquireWorkerArtifacts } from './worker-service';
import type { DownloadedWorkerArchive } from './worker-download';
import { mergeWorkerArchives, type WorkerMergeResult } from './worker-merge';
import { ordinaryOrder } from './reduction';
import { acceptWorkerMerge, installWorkerMerge, type AcceptedWorkerMerge } from './worker-incoming';
import { MetadataSnapshot } from './metadata-snapshot';
import { MetadataPublicationSource } from './metadata-publication-source';
import { lifecycleDocuments } from './lifecycle-documents';
import { handoffSchemas, type HandoffHeader } from './lifecycle-handoff';
import { metadataWorkerRequests, metadataSnapshotRequirements } from './prepare-inputs';
import { retireInstallStaging } from './owned-retirement';
import { settleNativeCleanup } from './native-operation';
import type { BaseCacheBackend } from '../backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';

export interface StreamingPrepareRequest extends LifecycleOptions {
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
export type PrepareRestoreStatus =
  | 'feature-unavailable'
  | 'miss'
  | 'current-lineage-hit'
  | 'fallback-lineage-hit'
  | 'current-lineage-partial-hit'
  | 'fallback-lineage-partial-hit';
export interface StreamingPrepareResult {
  readonly restoreStatus: PrepareRestoreStatus;
  readonly store: OwnedStore;
  readonly anchor: InvocationAnchor;
  readonly cutoff: number;
  readonly restoredKey: string | null;
  readonly workerCount: number;
}
const rows = async function* (values: readonly Value[]) {
  yield* values;
};
/** One normal prepare attempt. Interrupted namespaces never dispatch a resume operation. */
export async function prepareStreaming(
  input: StreamingPrepareRequest,
): Promise<StreamingPrepareResult> {
  const request = Object.freeze({
    ...input,
    context: contextSchema.parse(input.context),
    policy: Object.freeze({
      ...input.policy,
      ordinaryOrder: Object.freeze(ordinaryOrder(input.policy.ordinaryOrder)),
    }),
    defaultRef: input.defaultRef === input.currentRef ? undefined : input.defaultRef,
  });
  const signal = request.signal ?? new AbortController().signal,
    options = Object.freeze({
      ...request,
      signal,
      maxDirectoryEntries: request.maxDirectoryEntries ?? 100000,
    }),
    id = invocationId(request.context, request.nonce);
  const assertCurrent = (): undefined => {
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
  const root = await NativeRoot.bind(request.root);
  await completedPreviousOwner(root);
  assertCurrent();
  const codec = new LocalCodec({
      model: request.model,
      context: request.context,
      invocation: id,
      role: request.policy.role,
      access: request.policy.access,
    }),
    store = await OwnedStore.bind(root.path, codec, request.fail),
    docs = lifecycleDocuments(codec.options),
    anchor = invocationAnchor(store.root, request.context, request.nonce);
  request.saveAnchor(encodeInvocationAnchor(anchor));
  if (await store.root.stat(store.prefix.slice(0, -1)))
    throw new Error(
      'Existing invocation namespace; use a fresh dedicated root or handle retained data manually.',
    );
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
  const installOwner = (await store.root.stat(store.prefix + 'install'))!;
  if (installOwner[3] !== store.root.binding[3])
    throw new Error('Cross-filesystem install staging.');
  const model = await store.writeStream(
    'model',
    { ...options, partition: null },
    rows([
      ['model-header', request.model.tuple[2], request.model.tuple[3]],
      ...request.model.partitions.map((p) => ['partition', ...p] as Value),
    ]),
    signal,
  );
  let bindings = docs.bindings.parse([
    'bindings',
    2,
    id,
    request.context,
    request.nonce,
    [store.root.path, store.root.binding],
    model,
    request.model.familyProjection,
    policy,
  ]);
  await store.initialize(bindings);
  let restored: MetadataBaseRestore | undefined,
    merged: WorkerMergeResult | undefined,
    accepted: AcceptedWorkerMerge | undefined;
  const snapshots = new Set<MetadataSnapshot>(),
    downloads: DownloadedWorkerArchive[] = [];
  let failure: unknown, answer: StreamingPrepareResult | undefined;
  try {
    await request.provision();
    await assertLifecycleWindow(store, bindings, { signal, assertCurrent });
    const cache = await request.cacheBackend(),
      unavailable = !cache.isFeatureAvailable();
    restored = await timed(
      options,
      'base discovery and admission',
      () => MetadataBaseRestore.acquire(store, unavailable ? null : cache, request, options),
      (r) => (unavailable ? 'unavailable' : r.key ? 'hit' : 'miss'),
    );
    const requests = metadataWorkerRequests(store, policy),
      required = new Set(request.policy.ordinaryOrder);
    if (requests.length) {
      if (!request.artifactBackend) throw new Error('Required artifact backend is missing.');
      const backend = await request.artifactBackend();
      const selected = await timed(options, 'worker discovery', () =>
        discoverWorkerArtifacts(backend, request.model, request.context, requests, { signal }),
      );
      downloads.push(
        ...(await acquireWorkerArtifacts(store, backend, selected, {
          signal,
          timing: options.timing,
        })),
      );
    }
    const selectedJobs = new Set(downloads.map((download) => download.context[4]));
    // Pins already refer to the exact materialized base BEFORE extras or worker overlays.
    const fallback = new Map<string, MetadataSnapshot>();
    for (const entry of restored.entries) {
      const partition = request.model.partitions.find((p) => p[0] === entry[1])!;
      if (
        request.policy.role === 'distributed-worker' ||
        request.policy.access === 'read-only' ||
        partition[3] !== 'single-writer' ||
        ownsLocalSnapshot(partition, store.codec.options) ||
        selectedJobs.has(partition[4]!)
      )
        continue;
      let snapshot: MetadataSnapshot;
      const source = restored.context!.source(entry[1]);
      if (entry[2] === 'available' && source) {
        const publication = MetadataPublicationSource.borrow(source);
        try {
          snapshot = await MetadataSnapshot.copy(
            publication,
            entry[1],
            ['base', entry[3]![7]],
            options,
          );
        } finally {
          await publication.dispose();
        }
      } else
        snapshot = await MetadataSnapshot.empty(
          store,
          entry[1],
          ['empty', entry[2] === 'empty' ? 'generation' : entry[2] === 'cold' ? 'cold' : 'miss'],
          options,
        );
      snapshots.add(snapshot);
      fallback.set(entry[1], snapshot);
    }
    if (downloads.length) {
      merged = await timed(options, 'shared worker validation and merge', () =>
        mergeWorkerArchives(
          store,
          downloads.map((download) => download.input()),
          {
            ...options,
            ordinaryOrder: request.policy.ordinaryOrder,
            ordinaryPolicy: request.policy.ordinaryPolicy,
            snapshots: metadataSnapshotRequirements(store, required, fallback),
          },
        ),
      );
      request.onWorkerWarnings?.(merged.warnings);
    }
    const prune = request.policy.restoreCleanup === 'prune-managed' && restored.generation !== null;
    for (const entry of restored.entries)
      if (
        (entry[2] === 'miss' || entry[2] === 'cold') &&
        (prune || request.model.partitions.find((p) => p[0] === entry[1])![3] === 'single-writer')
      )
        await restored.context!.declareEmpty(entry[1], signal);
    const cold = new Set(restored.context!.cold.flat());
    if (
      request.model.partitions.some((p) => {
        const source = restored!.context!.source(p[0]);
        return source && (!cold.has(p[0]) || source.upstream.kind === 'declared-empty');
      })
    ) {
      await assertLifecycleWindow(store, bindings, { signal, assertCurrent });
      const plan = await timed(options, 'shared base install planning', () =>
        freezeMetadataInstallPlan(store, restored!.context!, request.budget, {
          ...options,
          pruneAggregates: prune,
        }),
      );
      await timed(options, 'base install', () =>
        executeInstall(store, plan, request.budget, { signal }),
      );
    }
    await store.fail('prepare-base-installed');
    if (merged) {
      accepted = await acceptWorkerMerge(store, merged, request.budget, signal);
      merged = undefined;
      for (const snapshot of accepted.snapshots) snapshots.add(snapshot);
      for (const snapshot of accepted.snapshots) fallback.set(snapshot.partition, snapshot);
      if (accepted.incoming.length)
        await timed(options, 'worker install', () =>
          installWorkerMerge(store, accepted!, request.budget, signal, () =>
            assertLifecycleWindow(store, bindings, { signal, assertCurrent }),
          ),
        );
    }
    await store.fail('prepare-workers-installed');
    const activity =
      accepted?.activity ??
      (await store.writeStream(
        'activity',
        { ...options, partition: null },
        rows([
          ['dir-open', ''],
          ['dir-close', ''],
        ]),
        signal,
      ));
    for (const entry of restored.entries)
      entry[4] = fallback.get(entry[1])?.sourceDescriptor() ?? null;
    await timed(options, 'install staging retirement', () =>
      retireInstallStaging(store, installOwner, options, assertCurrent),
    );
    await request.installHooks(store);
    await assertLifecycleWindow(store, bindings, { signal, assertCurrent });
    const cutoff = uint((request.now ?? Date.now)());
    bindings = docs.bindings.parse(bindings);
    bindings[8][7] = cutoff;
    const header: HandoffHeader = handoffSchemas(codec).header.parse([
      'handoff',
      2,
      request.currentRef,
      request.defaultRef ?? null,
      request.captureTempDirectory,
      request.artifactRetentionDays,
      request.cleanupEnabled ? 'enabled' : 'disabled',
      age,
      restored.key && restored.record ? [restored.key, restored.record] : null,
      activity,
      cutoff,
      downloads.length,
    ]);
    const handoff = await timed(options, 'handoff creation', () =>
      store.writeStream(
        'handoff',
        { ...options, partition: null },
        rows([header, ...restored!.entries]),
        signal,
      ),
    );

    // Retire operation-owned metadata before successful main/post handoff; only imported activity crosses per-file.
    await timed(options, 'cleanup and retirement', () =>
      settleNativeCleanup([
        () => accepted?.dispose(),
        () => restored?.dispose(),
        ...downloads.map((download) => () => download.dispose()),
        ...[...snapshots].map(
          (snapshot) => () =>
            [...fallback.values()].includes(snapshot) ? snapshot.dispose() : snapshot.retire(),
        ),
      ]),
    );
    const state = docs['local-state'].parse(await store.state()),
      oldBindings = state[5];
    const nextBindings = await store.writeDocument(bindings);
    state[3]++;
    state[4] = 'build-ready';
    state[5] = codec.schemas.ref('bindings').parse(nextBindings);
    state[6] = codec.schemas.ref('handoff').parse(handoff);
    await store.fail('prepare-before-build-ready');
    await store.updateState(state);
    await store.retireReplacedDocument(oldBindings);
    await store.fail('prepare-ready');
    await assertLifecycleWindow(store, bindings, { signal, assertCurrent });
    const allCold = restored.entries.every((entry) => entry[2] === 'cold'),
      key = allCold ? null : restored.key;
    let restoreStatus: PrepareRestoreStatus = unavailable ? 'feature-unavailable' : 'miss';
    if (key) {
      const current = key.startsWith(
          lineagePrefix(request.model.family, lineageId(request.currentRef)),
        ),
        partial = restored.entries.some((entry) => entry[2] === 'cold');
      restoreStatus = current
        ? partial
          ? 'current-lineage-partial-hit'
          : 'current-lineage-hit'
        : partial
          ? 'fallback-lineage-partial-hit'
          : 'fallback-lineage-hit';
    }
    answer = {
      restoreStatus,
      store,
      anchor,
      cutoff,
      restoredKey: key,
      workerCount: downloads.length,
    };
  } catch (error) {
    failure = error;
  }
  try {
    await timed(options, 'cleanup and retirement', () =>
      settleNativeCleanup(
        [
          () => merged?.dispose(),
          () => accepted?.dispose(),
          () => restored?.dispose(),
          ...downloads.map((download) => () => download.dispose()),
          ...[...snapshots].map(
            (snapshot) => () => (failure === undefined ? snapshot.dispose() : snapshot.retire()),
          ),
        ],
        failure,
      ),
    );
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    try {
      const state = docs['local-state'].parse(await store.state());
      state[3]++;
      state[4] = 'prepare-failed';
      state[7] = null;
      await store.updateState(state);
    } catch (status) {
      throw new AggregateError(
        [failure, status],
        'Prepare failed and failure status could not be written.',
        { cause: status },
      );
    }
    throw failure;
  }
  return answer!;
}
