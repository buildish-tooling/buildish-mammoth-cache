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

import { PORTABLE_CACHE_ROOT, type DownloadedDeltaArtifactPackage } from './service';
import {
  resolveNormalizedPathWithinRoot,
  validateNormalizedRelativePosixPath,
} from '../util/paths';

import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  areCacheFileSnapshotsMateriallyEquivalent,
  type CacheDeltaEntry,
  type CacheDeltaManifest,
  type CacheFileSnapshot,
} from '../cache/manifest';
import type { CachePartitionDefinition } from '../cache/model';

export { applyMergedDeltaPlan } from './apply-execution';
export type { DeltaApplyOptions, DeltaApplyResult } from './apply-execution';

interface MergedDeltaState {
  readonly entry: CacheDeltaEntry;
  readonly acceptablePreviousSnapshots: readonly (CacheFileSnapshot | null)[];
  readonly artifactName: string;
  readonly producerJobName: string;
  readonly payloadPath: string | null;
}

/** A single file entry resolved from one or more downloaded delta artifact packages. */
export interface MergedDeltaPayload {
  readonly relativePath: string;
  readonly payloadPath: string;
  readonly artifactName: string;
  readonly producerJobName: string;
}

/**
 * The result of merging one or more downloaded delta artifact packages into a single apply plan.
 *
 * Contains a portable delta manifest (using the portable cache root sentinel) and the resolved
 * payload file paths that back each changed entry.
 */
export interface MergedDeltaPlan {
  readonly deltaManifest: CacheDeltaManifest;
  readonly payloads: readonly MergedDeltaPayload[];
  /** Accepted target states for each changed path, captured from all compatible worker deltas. */
  readonly preconditions: readonly MergedDeltaPrecondition[];
}

/** File states that permit one merged delta path to be applied. `null` represents absence. */
export interface MergedDeltaPrecondition {
  readonly relativePath: string;
  readonly acceptablePreviousSnapshots: readonly (CacheFileSnapshot | null)[];
}

/** Options that control conflict resolution when merging overlapping delta artifact packages. */
export interface MergeDeltaOptions {
  /**
   * When `true`, overlapping paths with different content are resolved by taking the entry with
   * the newer modification timestamp rather than throwing a hard error.
   *
   * Use only when multiple workers are known to produce compatible build-tool cache entries for the
   * same path (e.g. identical downloaded dependency JARs with differing timestamps).
   */
  readonly allowDuplicateDependentDeltaPaths?: boolean;
}

/**
 * Merges an ordered list of downloaded delta artifact packages into a single {@link MergedDeltaPlan}.
 *
 * Overlapping paths (same relative path across multiple packages) are resolved according to
 * `options.allowDuplicateDependentDeltaPaths`. Content conflicts that cannot be resolved are
 * collected across the full merge pass and reported together in a single thrown error, so the
 * caller can see all conflicting paths at once rather than discovering them one per run.
 *
 * Returns an empty plan when `packages` is empty.
 */
export function mergeDeltaArtifactPackages(
  packages: readonly DownloadedDeltaArtifactPackage[],
  options: MergeDeltaOptions = {},
): MergedDeltaPlan {
  if (packages.length === 0) {
    return {
      deltaManifest: {
        schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
        buildToolId: '',
        cacheRoot: PORTABLE_CACHE_ROOT,
        partitions: [],
      },
      payloads: [],
      preconditions: [],
    };
  }

  const expectedBuildToolId = packages[0]!.deltaManifest.buildToolId;

  const expectedPartitionIds = packages[0]!.deltaManifest.partitions.map(
    (partition) => partition.partitionId,
  );
  const mergedByPartition = new Map<
    CachePartitionDefinition['id'],
    Map<string, MergedDeltaState>
  >();
  const conflicts: string[] = [];

  for (const artifactPackage of packages) {
    assertPortableDeltaPackage(artifactPackage, expectedPartitionIds, expectedBuildToolId);
    const payloads = collectPayloadPaths(artifactPackage);

    for (const partition of artifactPackage.deltaManifest.partitions) {
      const partitionEntries =
        mergedByPartition.get(partition.partitionId) ?? new Map<string, MergedDeltaState>();
      mergedByPartition.set(partition.partitionId, partitionEntries);

      for (const entry of partition.entries) {
        const candidatePayloadPath =
          entry.changeType === 'deleted' ? null : (payloads.get(entry.relativePath) ?? null);
        if (entry.changeType !== 'deleted' && !candidatePayloadPath) {
          throw new Error(
            `Downloaded delta artifact '${artifactPackage.artifact.name}' is missing payload metadata for '${entry.relativePath}'.`,
          );
        }

        const candidateState: MergedDeltaState = {
          entry,
          acceptablePreviousSnapshots: [entry.previous],
          artifactName: artifactPackage.artifact.name,
          producerJobName: artifactPackage.metadata.producer.jobName,
          payloadPath: candidatePayloadPath,
        };
        const existing = partitionEntries.get(entry.relativePath);
        if (!existing) {
          partitionEntries.set(entry.relativePath, candidateState);
          continue;
        }

        const result = mergeOverlappingDeltaStates(existing, candidateState, options);
        if ('conflict' in result) {
          conflicts.push(result.conflict);
        } else {
          partitionEntries.set(entry.relativePath, result.merged);
        }
      }
    }
  }

  if (conflicts.length > 0) {
    const noun = conflicts.length === 1 ? 'conflict' : 'conflicts';
    const list = conflicts.map((c) => `  - ${c}`).join('\n');
    throw new Error(
      `${conflicts.length} path ${noun} found while merging dependent worker delta artifacts:\n${list}\n\n` +
        `Paths that differ across worker jobs cannot be merged safely. ` +
        `If these are build-tool-internal state files (such as resolver markers or status files), ` +
        `add a matching glob pattern to the hard cache excludes for your build tool adapter.`,
    );
  }

  const partitions = expectedPartitionIds.map((partitionId) => ({
    partitionId,
    entries: [...(mergedByPartition.get(partitionId)?.values() ?? [])]
      .map((state) => state.entry)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  }));
  const payloads = [...mergedByPartition.values()]
    .flatMap((partitionEntries) => [...partitionEntries.values()])
    .filter((state) => state.payloadPath !== null)
    .map((state) => ({
      relativePath: state.entry.relativePath,
      payloadPath: state.payloadPath!,
      artifactName: state.artifactName,
      producerJobName: state.producerJobName,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const preconditions = [...mergedByPartition.values()]
    .flatMap((partitionEntries) => [...partitionEntries.values()])
    .map((state) => ({
      relativePath: state.entry.relativePath,
      acceptablePreviousSnapshots: state.acceptablePreviousSnapshots,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    deltaManifest: {
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: expectedBuildToolId,
      cacheRoot: PORTABLE_CACHE_ROOT,
      partitions,
    },
    payloads,
    preconditions,
  };
}

function assertPortableDeltaPackage(
  artifactPackage: DownloadedDeltaArtifactPackage,
  expectedPartitionIds: readonly CachePartitionDefinition['id'][],
  expectedBuildToolId: string,
): void {
  if (artifactPackage.deltaManifest.buildToolId !== expectedBuildToolId) {
    throw new Error(
      `Downloaded delta artifact '${artifactPackage.artifact.name}' has build tool '${artifactPackage.deltaManifest.buildToolId}', but expected '${expectedBuildToolId}'.`,
    );
  }

  if (artifactPackage.deltaManifest.cacheRoot !== PORTABLE_CACHE_ROOT) {
    throw new Error(
      `Downloaded delta artifact '${artifactPackage.artifact.name}' must use the portable cache root sentinel.`,
    );
  }

  const actualPartitionIds = artifactPackage.deltaManifest.partitions.map(
    (partition) => partition.partitionId,
  );
  if (actualPartitionIds.length !== expectedPartitionIds.length) {
    throw new Error('Downloaded delta artifacts must share the same partition layout.');
  }

  actualPartitionIds.forEach((partitionId, index) => {
    if (partitionId !== expectedPartitionIds[index]) {
      throw new Error('Downloaded delta artifacts must share the same partition order.');
    }
  });
}

function collectPayloadPaths(
  artifactPackage: DownloadedDeltaArtifactPackage,
): ReadonlyMap<string, string> {
  return new Map(
    artifactPackage.metadata.payloadEntries.map((payloadEntry) => [
      payloadEntry.relativePath,
      resolvePathWithinRoot(
        artifactPackage.downloadDirectory,
        payloadEntry.payloadPath,
        `payload path for '${payloadEntry.relativePath}'`,
      ),
    ]),
  );
}

type MergeOverlappingResult = { readonly merged: MergedDeltaState } | { readonly conflict: string };

function mergeOverlappingDeltaStates(
  existing: MergedDeltaState,
  candidate: MergedDeltaState,
  options: MergeDeltaOptions,
): MergeOverlappingResult {
  if (areEntriesContentCompatible(existing.entry, candidate.entry)) {
    const preferred = selectNewerState(existing, candidate) ?? existing;
    const other = preferred === existing ? candidate : existing;
    return { merged: mergeCompatibleStates(preferred, other) };
  }

  if (options.allowDuplicateDependentDeltaPaths) {
    const preferred = selectNewerState(existing, candidate);
    if (preferred) {
      return { merged: preferred };
    }
  }

  return {
    conflict:
      `'${candidate.entry.relativePath}': ` +
      `'${existing.producerJobName}' (artifact '${existing.artifactName}') and ` +
      `'${candidate.producerJobName}' (artifact '${candidate.artifactName}') ` +
      `produce different content or metadata`,
  };
}

function areEntriesContentCompatible(left: CacheDeltaEntry, right: CacheDeltaEntry): boolean {
  if (left.current && right.current) {
    return areSnapshotsContentCompatible(left.current, right.current);
  }

  if (
    !left.current &&
    !right.current &&
    left.changeType === 'deleted' &&
    right.changeType === 'deleted'
  ) {
    return left.previous !== null && right.previous !== null;
  }

  return false;
}

function areSnapshotsContentCompatible(left: CacheFileSnapshot, right: CacheFileSnapshot): boolean {
  return (
    left.contentSha256 === right.contentSha256 &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function selectNewerState(
  left: MergedDeltaState,
  right: MergedDeltaState,
): MergedDeltaState | null {
  const leftSnapshot = getComparableSnapshot(left.entry);
  const rightSnapshot = getComparableSnapshot(right.entry);
  if (!leftSnapshot || !rightSnapshot) {
    return null;
  }

  if (leftSnapshot.mtimeMs > rightSnapshot.mtimeMs) {
    return left;
  }
  if (rightSnapshot.mtimeMs > leftSnapshot.mtimeMs) {
    return right;
  }

  return null;
}

function mergeCompatibleStates(
  preferred: MergedDeltaState,
  other: MergedDeltaState,
): MergedDeltaState {
  const preferredSnapshot = getComparableSnapshot(preferred.entry);
  const otherSnapshot = getComparableSnapshot(other.entry);
  if (!preferredSnapshot || !otherSnapshot || preferred.entry.current === null) {
    return {
      ...preferred,
      acceptablePreviousSnapshots: mergeAcceptedPreviousSnapshots(preferred, other),
    };
  }

  return {
    ...preferred,
    acceptablePreviousSnapshots: mergeAcceptedPreviousSnapshots(preferred, other),
    entry: replaceComparableSnapshot(
      preferred.entry,
      mergeSnapshotTimestamps(preferredSnapshot, otherSnapshot),
    ),
  };
}

function mergeAcceptedPreviousSnapshots(
  preferred: MergedDeltaState,
  other: MergedDeltaState,
): readonly (CacheFileSnapshot | null)[] {
  const accepted: (CacheFileSnapshot | null)[] = [...preferred.acceptablePreviousSnapshots];
  for (const candidate of other.acceptablePreviousSnapshots) {
    if (
      !accepted.some((existing) => areOptionalSnapshotsMateriallyEquivalent(existing, candidate))
    ) {
      accepted.push(candidate);
    }
  }
  return accepted;
}

function getComparableSnapshot(entry: CacheDeltaEntry): CacheFileSnapshot | null {
  return entry.current ?? entry.previous;
}

function replaceComparableSnapshot(
  entry: CacheDeltaEntry,
  snapshot: CacheFileSnapshot,
): CacheDeltaEntry {
  if (entry.current) {
    return {
      ...entry,
      current: snapshot,
    };
  }

  if (entry.previous) {
    return {
      ...entry,
      previous: snapshot,
    };
  }

  return entry;
}

function mergeSnapshotTimestamps(
  preferred: CacheFileSnapshot,
  other: CacheFileSnapshot,
): CacheFileSnapshot {
  return {
    ...preferred,
    atimeMs: Math.max(preferred.atimeMs, other.atimeMs),
    mtimeMs: Math.max(preferred.mtimeMs, other.mtimeMs),
  };
}

function areOptionalSnapshotsMateriallyEquivalent(
  left: CacheFileSnapshot | null,
  right: CacheFileSnapshot | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return areCacheFileSnapshotsMateriallyEquivalent(left, right);
}

function resolvePathWithinRoot(rootDirectory: string, relativePath: string, label: string): string {
  const normalizedRelativePath = validateNormalizedRelativePosixPath(
    relativePath,
    label,
    'the target directory',
  );
  return resolveNormalizedPathWithinRoot(
    rootDirectory,
    normalizedRelativePath,
    `${label} '${relativePath}' escapes the target directory.`,
  );
}
