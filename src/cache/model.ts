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

import { isWorkspacePartition } from './immutable-workspaces';
import type { BuiltInCachePartitionPreset } from '../build-tool/types';
import type {
  ConfiguredCachePartitionInput,
  PartitionPublication,
  PartitionConflictHandling,
} from '../config/types';

export interface CacheModelDefinition {
  readonly buildToolId: 'gradle' | 'maven';
  readonly hardCacheExcludeGlobs: readonly string[];
  readonly partitions: readonly CachePartitionDefinition[];
}

export interface CachePartitionDefinition {
  /** Resolved deletion rules, distinct from preserve-only exclusions. */
  readonly purgeableGlobs?: readonly string[];
  /** Effective default is omitted to preserve existing compatibility identities. */
  readonly conflictHandling?: Exclude<PartitionConflictHandling, 'default'>;
  /** Defaults to aggregation when absent. Single-writer partitions travel as complete snapshots. */
  readonly publication?: PartitionPublication;
  readonly writer?: string;
  /**
   * Stable machine-readable partition identifier.
   */
  readonly id: string;
  /** Short human-readable partition label for logs and summaries. */
  readonly displayName: string;
  /** Longer human-readable explanation of what the partition stores. */
  readonly description: string;
  /**
   * Partition include-globs relative to the build tool's cache root.
   *
   * These remain stable across machines and contribute to the model identity.
   */
  readonly relativeIncludeGlobs: readonly string[];
  /**
   * Partition exclude-globs relative to the build tool's cache root.
   *
   * The effective list always contains the non-overridable hard safety excludes plus any
   * partition-specific excludes from the built-in preset or user override.
   */
  readonly relativeExcludeGlobs: readonly string[];
}

export function createCachePartitions(
  configuredPartitions: readonly ConfiguredCachePartitionInput[] = [],
  builtInPresets: readonly BuiltInCachePartitionPreset[] = [],
  hardCacheExcludeGlobs: readonly string[] = [],
): readonly CachePartitionDefinition[] {
  const builtInPresetIds = new Set(builtInPresets.map((preset) => preset.id));
  const configuredById = new Map(
    configuredPartitions.map((partition) => [partition.id, partition]),
  );
  const builtIns = builtInPresets.flatMap((preset) => {
    const override = configuredById.get(preset.id);
    if (!override && !preset.defaultEnabled) {
      return [];
    }

    const includeGlobs = deduplicatePaths(override?.includes ?? preset.relativeIncludeGlobs);
    if (includeGlobs.length === 0) {
      return [];
    }

    return [
      createPartition(
        preset.id,
        preset.displayName,
        preset.description,
        includeGlobs,
        deduplicatePaths(override?.excludes ?? preset.relativeExcludeGlobs),
        hardCacheExcludeGlobs,
        override?.publication ?? preset.publication,
        override?.writer,
        override?.conflictHandling ?? preset.conflictHandling,
        override?.purgeableGlobs ?? preset.purgeableGlobs,
      ),
    ];
  });

  const customPartitions = configuredPartitions.flatMap((partition) => {
    if (builtInPresetIds.has(partition.id)) {
      return [];
    }
    if (!partition.includes?.length) {
      throw new Error(
        `Custom cache partition '${partition.id}' must declare at least one include glob. Empty includes only disable built-in partitions.`,
      );
    }

    return [
      createPartition(
        partition.id,
        `Custom partition '${partition.id}'`,
        `User-defined build tool cache partition '${partition.id}'.`,
        deduplicatePaths(partition.includes),
        deduplicatePaths(partition.excludes ?? []),
        hardCacheExcludeGlobs,
        partition.publication,
        partition.writer,
        partition.conflictHandling,
        partition.purgeableGlobs,
      ),
    ];
  });

  return [...builtIns, ...customPartitions];
}

function createPartition(
  id: CachePartitionDefinition['id'],
  displayName: string,
  description: string,
  relativeIncludeGlobs: readonly string[],
  partitionRelativeExcludeGlobs: readonly string[],
  hardCacheExcludeGlobs: readonly string[],
  publication: PartitionPublication = 'aggregate',
  writer?: string,
  conflictHandling?: PartitionConflictHandling,
  purgeableGlobs: readonly string[] = [],
): CachePartitionDefinition {
  if (writer && publication !== 'single-writer')
    throw new Error(`Partition '${id}' writer requires single-writer publication.`);
  const deduplicatedIncludeGlobs = deduplicatePaths(relativeIncludeGlobs);
  const ordinaryExcludeGlobs = deduplicatePaths([
    ...hardCacheExcludeGlobs,
    ...partitionRelativeExcludeGlobs,
  ]);
  const purge = deduplicatePaths(purgeableGlobs);

  return {
    id,
    publication,
    ...(writer ? { writer } : {}),
    ...(conflictHandling && conflictHandling !== 'default' ? { conflictHandling } : {}),
    displayName,
    description,
    ...(purge.length ? { purgeableGlobs: purge } : {}),
    relativeIncludeGlobs: deduplicatedIncludeGlobs,
    relativeExcludeGlobs: ordinaryExcludeGlobs,
  };
}

function deduplicatePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Validate again when restoring persisted models, not only when parsing user inputs. */
export function validatePartitionConflictHandling(
  buildToolId: string,
  partitions: readonly CachePartitionDefinition[],
): void {
  for (const partition of partitions) {
    const workspace = buildToolId === 'gradle' && isWorkspacePartition(partition);
    if (workspace && ((partition.publication ?? 'aggregate') !== 'aggregate' || partition.writer))
      throw new Error(
        `Partition '${partition.id}' Gradle workspaces require aggregate publication without a writer.`,
      );
    if (!partition.conflictHandling) continue;
    const maven =
      buildToolId === 'maven' &&
      partition.relativeIncludeGlobs.length > 0 &&
      partition.relativeIncludeGlobs.every((glob) => glob.startsWith('repository/'));
    const archive =
      buildToolId === 'gradle' &&
      partition.relativeIncludeGlobs.length > 0 &&
      partition.relativeIncludeGlobs.every((glob) =>
        /^caches\/build-cache-(?:[0-9]+|\*)\//u.test(glob),
      );
    if (
      (partition.publication ?? 'aggregate') !== 'aggregate' ||
      partition.writer ||
      (partition.conflictHandling === 'choose-worker-directory'
        ? !maven && !workspace
        : partition.conflictHandling === 'choose-worker-entry'
          ? !archive
          : true)
    )
      throw new Error(
        `Partition '${partition.id}' conflict policy requires aggregate Maven directories, Gradle workspaces, or choose-worker-entry on Gradle build-cache paths.`,
      );
  }
}
