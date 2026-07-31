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

/**
 * Provider-neutral cache manifest formats and material-state operations.
 *
 * This module deliberately performs no filesystem access. Capture and glob traversal remain in
 * `manifest.ts`, which also re-exports this public format contract for existing consumers.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { validateNormalizedRelativePosixPath } from '../util/paths';
import { parseSerializedJson, parseWithZod } from '../util/serialization';

/** Schema version embedded in every captured cache manifest. Increment on breaking format changes. */
export const CACHE_MANIFEST_SCHEMA_VERSION = 1;
const CACHE_PARTITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const cacheRelativePathSchema = z.string().refine((value) => {
  try {
    validateNormalizedRelativePosixPath(value, '', 'cache root');
    return true;
  } catch {
    return false;
  }
}, 'Must be a normalized relative POSIX path inside the cache root');

const snapshotSchema = z.object({
  contentSha256: z
    .string()
    .regex(LOWERCASE_SHA256_PATTERN, 'Must be a lowercase hex SHA-256 digest'),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  atimeMs: z.number().finite().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
});

const manifestEntrySchema = snapshotSchema.extend({
  relativePath: cacheRelativePathSchema,
});

const manifestPartitionSchema = z.object({
  partitionId: z
    .string()
    .regex(CACHE_PARTITION_ID_PATTERN, 'Contains unsupported partition identifier'),
  entries: z.array(manifestEntrySchema).superRefine(validateSortedEntries),
});

const cacheManifestSchema = z.object({
  schemaVersion: z.literal(CACHE_MANIFEST_SCHEMA_VERSION),
  buildToolId: z.string().min(1),
  cacheRoot: z.string(),
  partitions: z.array(manifestPartitionSchema).superRefine(validateUniquePartitions),
});

const deltaEntrySchema = z
  .object({
    relativePath: cacheRelativePathSchema,
    changeType: z.enum(['added', 'modified', 'deleted']),
    previous: snapshotSchema.nullable(),
    current: snapshotSchema.nullable(),
  })
  .superRefine((entry, context) => {
    const addIssue = (message: string): void => {
      context.addIssue({ code: 'custom', message });
    };
    if (entry.changeType === 'added' && (entry.previous !== null || entry.current === null)) {
      addIssue(`Delta entry '${entry.relativePath}' must only include a current snapshot`);
    } else if (
      entry.changeType === 'deleted' &&
      (entry.previous === null || entry.current !== null)
    ) {
      addIssue(`Delta entry '${entry.relativePath}' must only include a previous snapshot`);
    } else if (
      entry.changeType === 'modified' &&
      (entry.previous === null || entry.current === null)
    ) {
      addIssue(
        `Delta entry '${entry.relativePath}' must include both previous and current snapshots`,
      );
    }
  });

const deltaPartitionSchema = z.object({
  partitionId: z
    .string()
    .regex(CACHE_PARTITION_ID_PATTERN, 'Contains unsupported partition identifier'),
  entries: z.array(deltaEntrySchema).superRefine(validateSortedEntries),
});

const cacheDeltaManifestSchema = z.object({
  schemaVersion: z.literal(CACHE_MANIFEST_SCHEMA_VERSION),
  buildToolId: z.string().min(1),
  cacheRoot: z.string(),
  partitions: z.array(deltaPartitionSchema).superRefine(validateUniquePartitions),
});

/** Stable file metadata captured for one cache file at one point in time. */
export type CacheFileSnapshot = z.infer<typeof snapshotSchema>;

/** Captured manifest entry for one regular file rooted under the build tool's cache root. */
export type CacheFileManifestEntry = z.infer<typeof manifestEntrySchema>;

/** Captured manifest entries for one logical cache partition. */
export type CachePartitionManifest = z.infer<typeof manifestPartitionSchema>;

/** Full pre- or post-build cache manifest for all configured build tool cache partitions. */
export type CacheManifest = z.infer<typeof cacheManifestSchema>;

/** Captured change for a single path between two manifests. */
export type CacheDeltaEntry = z.infer<typeof deltaEntrySchema>;

/** Partition-local delta entries. */
export type CachePartitionDelta = z.infer<typeof deltaPartitionSchema>;

/** Full delta manifest between two cache manifests for the same build tool cache root. */
export type CacheDeltaManifest = z.infer<typeof cacheDeltaManifestSchema>;

/** Computes the partitioned file delta between comparable cache manifests. */
export function computeCacheDelta(
  previousManifest: CacheManifest,
  currentManifest: CacheManifest,
): CacheDeltaManifest {
  validateComparableManifests(previousManifest, currentManifest);

  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    buildToolId: previousManifest.buildToolId,
    cacheRoot: previousManifest.cacheRoot,
    partitions: previousManifest.partitions.map((previousPartition, index) => {
      const currentPartition = currentManifest.partitions[index];
      const entries: CacheDeltaEntry[] = [];
      let previousIndex = 0;
      let currentIndex = 0;

      while (
        previousIndex < previousPartition.entries.length ||
        currentIndex < currentPartition.entries.length
      ) {
        const previousEntry = previousPartition.entries[previousIndex] ?? null;
        const currentEntry = currentPartition.entries[currentIndex] ?? null;

        if (!previousEntry && currentEntry) {
          entries.push(createDeltaEntry(currentEntry.relativePath, 'added', null, currentEntry));
          currentIndex += 1;
          continue;
        }

        if (previousEntry && !currentEntry) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'deleted', previousEntry, null),
          );
          previousIndex += 1;
          continue;
        }

        if (!previousEntry || !currentEntry) {
          continue;
        }

        const pathComparison = previousEntry.relativePath.localeCompare(currentEntry.relativePath);
        if (pathComparison < 0) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'deleted', previousEntry, null),
          );
          previousIndex += 1;
          continue;
        }

        if (pathComparison > 0) {
          entries.push(createDeltaEntry(currentEntry.relativePath, 'added', null, currentEntry));
          currentIndex += 1;
          continue;
        }

        if (!areManifestEntriesEquivalent(previousEntry, currentEntry)) {
          entries.push(
            createDeltaEntry(previousEntry.relativePath, 'modified', previousEntry, currentEntry),
          );
        }

        previousIndex += 1;
        currentIndex += 1;
      }

      return {
        partitionId: previousPartition.partitionId,
        entries,
      };
    }),
  };
}

/** Serializes a captured manifest into deterministic compact JSON with a trailing newline. */
export function serializeCacheManifest(manifest: CacheManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

/** Serializes a computed delta manifest into deterministic compact JSON with a trailing newline. */
export function serializeCacheDeltaManifest(deltaManifest: CacheDeltaManifest): string {
  return `${JSON.stringify(deltaManifest)}\n`;
}

/**
 * Calculates the portable material-state digest used in immutable generation keys.
 *
 * Access time and the machine-specific absolute cache root are intentionally excluded. Partition
 * and entry order are retained because validated manifests already require deterministic ordering.
 */
export function calculateCanonicalCacheManifestDigest(manifest: CacheManifest): string {
  const canonicalManifest = {
    schemaVersion: manifest.schemaVersion,
    buildToolId: manifest.buildToolId,
    cacheRoot: '$CACHE_ROOT',
    partitions: manifest.partitions.map((partition) => ({
      partitionId: partition.partitionId,
      entries: partition.entries.map((entry) => ({
        relativePath: entry.relativePath,
        contentSha256: entry.contentSha256,
        size: entry.size,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
      })),
    })),
  };

  return createHash('sha256').update(JSON.stringify(canonicalManifest)).digest('hex');
}

/** Parses and validates a serialized cache manifest against the current schema. */
export function deserializeCacheManifest(serializedManifest: string): CacheManifest {
  return parseWithZod(
    cacheManifestSchema,
    parseSerializedJson(serializedManifest, 'cache manifest'),
    'cache manifest',
  );
}

/** Parses and validates a serialized cache delta manifest against the current schema. */
export function deserializeCacheDeltaManifest(serializedDeltaManifest: string): CacheDeltaManifest {
  return parseWithZod(
    cacheDeltaManifestSchema,
    parseSerializedJson(serializedDeltaManifest, 'cache delta manifest'),
    'cache delta manifest',
  );
}

function createDeltaEntry(
  relativePath: string,
  changeType: CacheDeltaEntry['changeType'],
  previousEntry: CacheFileManifestEntry | null,
  currentEntry: CacheFileManifestEntry | null,
): CacheDeltaEntry {
  return {
    relativePath,
    changeType,
    previous: previousEntry ? toSnapshot(previousEntry) : null,
    current: currentEntry ? toSnapshot(currentEntry) : null,
  };
}

function toSnapshot({
  relativePath: _relativePath,
  ...snapshot
}: CacheFileManifestEntry): CacheFileSnapshot {
  return snapshot;
}

function validateComparableManifests(
  previousManifest: CacheManifest,
  currentManifest: CacheManifest,
): void {
  if (
    previousManifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION ||
    currentManifest.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error('Cache delta computation only supports the current manifest schema version.');
  }

  if (previousManifest.buildToolId !== currentManifest.buildToolId) {
    throw new Error(
      `Cache delta computation requires manifests from the same build tool, but got '${previousManifest.buildToolId}' and '${currentManifest.buildToolId}'.`,
    );
  }

  if (previousManifest.cacheRoot !== currentManifest.cacheRoot) {
    throw new Error('Cache delta computation requires manifests from the same cache root.');
  }

  if (previousManifest.partitions.length !== currentManifest.partitions.length) {
    throw new Error('Cache delta computation requires matching partition layouts.');
  }

  previousManifest.partitions.forEach((partition, index) => {
    if (partition.partitionId !== currentManifest.partitions[index]?.partitionId) {
      throw new Error(
        'Cache delta computation requires matching partition identifiers in the same order.',
      );
    }
  });
}

function areManifestEntriesEquivalent(
  previousEntry: CacheFileManifestEntry,
  currentEntry: CacheFileManifestEntry,
): boolean {
  return (
    previousEntry.contentSha256 === currentEntry.contentSha256 &&
    previousEntry.size === currentEntry.size &&
    previousEntry.mode === currentEntry.mode &&
    previousEntry.mtimeMs === currentEntry.mtimeMs
  );
}

function validateSortedEntries(
  entries: readonly { readonly relativePath: string }[],
  context: z.RefinementCtx,
): void {
  let previousPath = '';
  for (const [index, entry] of entries.entries()) {
    if (previousPath.localeCompare(entry.relativePath) >= 0) {
      context.addIssue({
        code: 'custom',
        path: [index, 'relativePath'],
        message: 'Entries must be sorted by strictly increasing relativePath',
      });
    }
    previousPath = entry.relativePath;
  }
}

function validateUniquePartitions(
  partitions: readonly { readonly partitionId: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, partition] of partitions.entries()) {
    if (seen.has(partition.partitionId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'partitionId'],
        message: `Duplicate partition id '${partition.partitionId}'`,
      });
    }
    seen.add(partition.partitionId);
  }
}
