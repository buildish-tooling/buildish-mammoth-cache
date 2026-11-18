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
import {
  snapshotPartitions,
  readPartitionSnapshot,
  restorePartitionSnapshot,
  stagePartitionSnapshot,
  verifySnapshotTransport,
  ownsSnapshot,
  type VerifiedPartitionSnapshot,
} from './partition-snapshots';
import { persistCutoffJournal, type CutoffJournal } from './cutoff-state';

export function snapshotRecord(
  snapshot: VerifiedPartitionSnapshot,
  baselineDigest: string | null,
  source: 'seed' | 'writer' | 'local',
) {
  return {
    partitionId: snapshot.manifest.partitionId,
    baselineDigest,
    digest: snapshot.digest,
    contentDigest: snapshot.contentDigest,
    fileCount: snapshot.manifest.files.length,
    byteCount: snapshot.manifest.files.reduce((n, e) => n + e.size, 0),
    source,
    changed:
      source !== 'seed' &&
      snapshot.contentDigest !== baselineDigest &&
      (baselineDigest !== null || snapshot.manifest.files.length > 0),
  };
}
/** Restored transport, not the overlayed live tree, establishes inherited membership. */
export async function initializePartitionSnapshots(
  state: CutoffJournal,
  hit: boolean,
  results?: readonly { partitionId: string; status: string }[],
): Promise<void> {
  const partitions = snapshotPartitions(state.model);
  const restored = hit ? await verifySnapshotTransport(state.model) : [];
  for (const partition of partitions) {
    const snapshot =
      restored.find((s) => s.manifest.partitionId === partition.id) ??
      (await stagePartitionSnapshot(state.model, partition.id, state.model.cacheRoot, []));
    await restorePartitionSnapshot(state.model, snapshot);
    state.partitionSnapshots.push(
      snapshotRecord(
        snapshot,
        hit && results?.find((p) => p.partitionId === partition.id)?.status !== 'missing'
          ? snapshot.contentDigest
          : null,
        'seed',
      ),
    );
    if (state.policy.jobMode !== 'standalone' && !partition.writer)
      state.snapshotWarnings.push(
        `Partition '${partition.id}' has no distributed writer configured. Retaining previous metadata; local updates will not be published. Set its cache-partitions writer to a job name.`,
      );
  }
}
/** All source identities were durably frozen before any content reads. */
export async function captureLocalPartitionSnapshots(state: CutoffJournal): Promise<void> {
  if (!state.selection) throw new Error('Snapshot capture requires frozen observations.');
  if (state.policy.readOnly || state.policy.jobMode === 'distributed-worker') return;
  for (const partition of snapshotPartitions(state.model)) {
    if (!ownsSnapshot(partition, state.policy.jobMode, state.execution.jobName)) continue;
    const previous = state.partitionSnapshots.find((s) => s.partitionId === partition.id)!;
    if (previous.source === 'local') {
      const selected = await readPartitionSnapshot(state.model, partition.id);
      if (!selected || selected.digest !== previous.digest)
        throw new Error('Frozen local snapshot changed.');
      continue;
    }
    // Until the new record is durable, every byte is reproducible from the frozen live sources.
    const snapshot = await stagePartitionSnapshot(
      state.model,
      partition.id,
      state.model.cacheRoot,
      state.selection.upserts
        .filter((e) => e.partitionId === partition.id)
        .map((e) => ({
          relativePath: e.relativePath,
          sourcePath: e.relativePath,
          size: e.identity.size,
          mode: e.identity.mode & 0o777,
          mtimeMs: Math.trunc(e.identity.mtimeMs),
          identity: e.identity,
        })),
    );
    const candidate = {
      ...state,
      partitionSnapshots: state.partitionSnapshots.map((s) =>
        s.partitionId === partition.id
          ? snapshotRecord(snapshot, previous.baselineDigest, 'local')
          : s,
      ),
    };
    await persistCutoffJournal(candidate);
    Object.assign(state, candidate);
  }
}
export function projectedSnapshotStatistics(state: CutoffJournal) {
  const selection = state.selection!;
  return {
    fileCount:
      selection.fileCount -
      (selection.snapshotFileCount ?? 0) +
      state.partitionSnapshots.reduce((n, s) => n + s.fileCount, 0),
    byteCount:
      selection.byteCount -
      (selection.snapshotByteCount ?? 0) +
      state.partitionSnapshots.reduce((n, s) => n + s.byteCount, 0),
  };
}
export function partitionSnapshotSummary(state: CutoffJournal): string[] {
  return state.partitionSnapshots.map((s) => {
    if (state.policy.readOnly)
      return `Partition '${s.partitionId}': prepare snapshot; ${s.fileCount} file(s). Post-build contents not observed (read-only).`;
    const partition = state.model.partitions.find((p) => p.id === s.partitionId)!;
    const owner = ownsSnapshot(partition, state.policy.jobMode, state.execution.jobName);
    if (
      owner &&
      !state.policy.readOnly &&
      state.policy.jobMode === 'distributed-worker' &&
      state.selection
    )
      return `Partition '${s.partitionId}': complete worker snapshot from '${state.execution.jobName}'; ${state.selection.upserts.filter((e) => e.partitionId === s.partitionId).length} file(s).`;
    const selected =
      s.source === 'local'
        ? `local writer '${state.execution.jobName}'`
        : s.source === 'writer'
          ? `writer '${partition.writer}'`
          : `${s.baselineDigest === null ? 'no previous snapshot' : 'previous snapshot'}${owner ? '' : ' (local updates omitted)'}`;
    return `Partition '${s.partitionId}': ${selected}; ${s.fileCount} file(s).`;
  });
}
