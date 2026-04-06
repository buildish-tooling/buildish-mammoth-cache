/*
 * Copyright 2026 The Apache Software Foundation
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

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { hashFileSha256, isMissingPathError } from '../util/fs';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import { parseSerializedJson, parseWithZod } from '../util/serialization';
import type { CacheModel } from './model';

/** Schema version embedded in every captured cache manifest. Increment on breaking format changes. */
export const CACHE_MANIFEST_SCHEMA_VERSION = 1;
const STABLE_ENTRY_CAPTURE_ATTEMPTS = 3;
const CACHE_PARTITION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

// ---------------------------------------------------------------------------
// Zod schemas — define once, derive both the runtime validator and the TS type
// ---------------------------------------------------------------------------

const cacheRelativePathSchema = z.string().refine((val) => {
  try {
    validateNormalizedRelativePosixPath(val, '', 'cache root');
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
  entries: z.array(manifestEntrySchema).superRefine((entries, ctx) => {
    let prev = '';
    for (const [i, entry] of entries.entries()) {
      if (prev.localeCompare(entry.relativePath) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'relativePath'],
          message: 'Entries must be sorted by strictly increasing relativePath',
        });
      }
      prev = entry.relativePath;
    }
  }),
});

const cacheManifestSchema = z.object({
  schemaVersion: z.literal(CACHE_MANIFEST_SCHEMA_VERSION),
  buildToolId: z.string().min(1),
  cacheRoot: z.string(),
  partitions: z.array(manifestPartitionSchema).superRefine((partitions, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of partitions.entries()) {
      if (seen.has(p.partitionId)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'partitionId'],
          message: `Duplicate partition id '${p.partitionId}'`,
        });
      }
      seen.add(p.partitionId);
    }
  }),
});

const deltaEntrySchema = z
  .object({
    relativePath: cacheRelativePathSchema,
    changeType: z.enum(['added', 'modified', 'deleted']),
    previous: snapshotSchema.nullable(),
    current: snapshotSchema.nullable(),
  })
  .superRefine((entry, ctx) => {
    const addIssue = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
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
  entries: z.array(deltaEntrySchema).superRefine((entries, ctx) => {
    let prev = '';
    for (const [i, entry] of entries.entries()) {
      if (prev.localeCompare(entry.relativePath) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'relativePath'],
          message: 'Entries must be sorted by strictly increasing relativePath',
        });
      }
      prev = entry.relativePath;
    }
  }),
});

const cacheDeltaManifestSchema = z.object({
  schemaVersion: z.literal(CACHE_MANIFEST_SCHEMA_VERSION),
  buildToolId: z.string().min(1),
  cacheRoot: z.string(),
  partitions: z.array(deltaPartitionSchema).superRefine((partitions, ctx) => {
    const seen = new Set<string>();
    for (const [i, p] of partitions.entries()) {
      if (seen.has(p.partitionId)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'partitionId'],
          message: `Duplicate partition id '${p.partitionId}'`,
        });
      }
      seen.add(p.partitionId);
    }
  }),
});

// ---------------------------------------------------------------------------
// Exported types (derived from schemas — single source of truth)
// ---------------------------------------------------------------------------

/**
 * Stable file metadata captured for one cache file at one point in time.
 */
export type CacheFileSnapshot = z.infer<typeof snapshotSchema>;

/**
 * Captured manifest entry for one regular file rooted under the build tool's cache root.
 */
export type CacheFileManifestEntry = z.infer<typeof manifestEntrySchema>;

/**
 * Captured manifest entries for one logical cache partition.
 */
export type CachePartitionManifest = z.infer<typeof manifestPartitionSchema>;

/**
 * Full pre- or post-build cache manifest for all configured build tool cache partitions.
 */
export type CacheManifest = z.infer<typeof cacheManifestSchema>;

/**
 * Captured change for a single path between two manifests.
 */
export type CacheDeltaEntry = z.infer<typeof deltaEntrySchema>;

/**
 * Partition-local delta entries.
 */
export type CachePartitionDelta = z.infer<typeof deltaPartitionSchema>;

/**
 * Full delta manifest between two cache manifests for the same build tool cache root.
 */
export type CacheDeltaManifest = z.infer<typeof cacheDeltaManifestSchema>;

// ---------------------------------------------------------------------------

interface CompiledGlobPattern {
  readonly source: string;
  readonly segments: readonly CompiledGlobSegment[];
}

type CompiledGlobSegment =
  | { readonly kind: 'globstar' }
  | {
      readonly kind: 'segment';
      readonly raw: string;
      readonly hasWildcard: boolean;
      readonly regex: RegExp;
    };

/**
 * Scans all configured cache partitions and captures a deterministic manifest of regular files.
 *
 * The scanner retries a small number of times when a file changes while being hashed, so the later delta
 * computation does not observe inconsistent size/hash metadata for the same path.
 */
export async function captureCacheManifest(cacheModel: CacheModel): Promise<CacheManifest> {
  const cacheRoot = cacheModel.cacheRoot;
  const compiledPartitions = cacheModel.partitions.map((partition) => ({
    partition,
    includePatterns: partition.relativeIncludeGlobs.map(compileGlobPattern),
    excludePatterns: partition.relativeExcludeGlobs.map(compileGlobPattern),
    entries: [] as CacheFileManifestEntry[],
    seenRelativePaths: new Set<string>(),
  }));
  const claimedPaths = new Map<string, string>();

  for (const compiledPartition of compiledPartitions) {
    for (const includePattern of compiledPartition.includePatterns) {
      const includeRoots = await expandIncludePatternRoots(cacheRoot, includePattern);

      for (const includeRoot of includeRoots) {
        await walkIncludedTree(includeRoot, async (absolutePath) => {
          const relativePath = toPosixRelativePath(cacheRoot, absolutePath);
          if (
            compiledPartition.seenRelativePaths.has(relativePath) ||
            matchesAnyCompiledGlob(relativePath, compiledPartition.excludePatterns)
          ) {
            return;
          }

          const existingPartitionId = claimedPaths.get(relativePath);
          if (existingPartitionId && existingPartitionId !== compiledPartition.partition.id) {
            throw new Error(
              `Cache manifest path '${relativePath}' matches multiple cache partitions: ${existingPartitionId}, ${compiledPartition.partition.id}.`,
            );
          }

          const entry = await captureStableFileEntry(cacheRoot, absolutePath, relativePath);
          if (!entry) {
            return;
          }

          compiledPartition.seenRelativePaths.add(relativePath);
          claimedPaths.set(relativePath, compiledPartition.partition.id);
          compiledPartition.entries.push(entry);
        });
      }
    }
  }

  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    buildToolId: cacheModel.buildToolId,
    cacheRoot,
    partitions: cacheModel.partitions.map((partition) => ({
      partitionId: partition.id,
      entries: [
        ...(compiledPartitions.find((candidate) => candidate.partition.id === partition.id)
          ?.entries ?? []),
      ].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    })),
  };
}

/**
 * Computes the partitioned file delta between two manifests captured from the same build tool cache root.
 */
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

/**
 * Serializes a captured manifest into deterministic compact JSON with a trailing newline for file storage.
 */
export function serializeCacheManifest(manifest: CacheManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

/**
 * Serializes a computed delta manifest into deterministic compact JSON with a trailing newline for file storage.
 */
export function serializeCacheDeltaManifest(deltaManifest: CacheDeltaManifest): string {
  return `${JSON.stringify(deltaManifest)}\n`;
}

/**
 * Parses a serialized cache manifest and validates that it conforms to the current schema.
 */
export function deserializeCacheManifest(serializedManifest: string): CacheManifest {
  return parseWithZod(
    cacheManifestSchema,
    parseSerializedJson(serializedManifest, 'cache manifest'),
    'cache manifest',
  );
}

/**
 * Parses a serialized delta manifest and validates that it conforms to the current schema.
 */
export function deserializeCacheDeltaManifest(serializedDeltaManifest: string): CacheDeltaManifest {
  return parseWithZod(
    cacheDeltaManifestSchema,
    parseSerializedJson(serializedDeltaManifest, 'cache delta manifest'),
    'cache delta manifest',
  );
}

async function captureStableFileEntry(
  cacheRoot: string,
  absolutePath: string,
  relativePath: string,
): Promise<CacheFileManifestEntry | null> {
  for (let attempt = 0; attempt < STABLE_ENTRY_CAPTURE_ATTEMPTS; attempt += 1) {
    const beforeStat = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!beforeStat) {
      return null;
    }

    if (beforeStat.isSymbolicLink()) {
      throw new Error(`Cache manifest does not support symbolic links: '${relativePath}'.`);
    }

    if (!beforeStat.isFile()) {
      throw new Error(`Cache manifest only supports regular files, but found '${relativePath}'.`);
    }

    const contentSha256 = await hashFileSha256(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!contentSha256) {
      return null;
    }

    const afterStat = await lstat(absolutePath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!afterStat) {
      return null;
    }

    if (isStableDuringCapture(beforeStat, afterStat)) {
      return {
        relativePath: toPosixRelativePath(cacheRoot, absolutePath),
        contentSha256,
        size: afterStat.size,
        mode: afterStat.mode,
        atimeMs: beforeStat.atimeMs,
        mtimeMs: afterStat.mtimeMs,
      };
    }
  }

  throw new Error(`Cache manifest could not capture a stable snapshot for '${relativePath}'.`);
}

async function walkIncludedTree(
  pathToScan: string,
  onFile: (absolutePath: string) => Promise<void>,
): Promise<void> {
  const entryStat = await lstat(pathToScan).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!entryStat) {
    return;
  }

  if (entryStat.isSymbolicLink() || entryStat.isFile()) {
    await onFile(pathToScan);
    return;
  }

  if (!entryStat.isDirectory()) {
    return;
  }

  const entries = await readSortedDirectoryEntries(pathToScan);

  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(pathToScan, entry.name);

    if (entry.isSymbolicLink()) {
      await onFile(absolutePath);
      continue;
    }

    if (entry.isDirectory()) {
      await walkIncludedTree(absolutePath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

async function expandIncludePatternRoots(
  baseDirectory: string,
  pattern: CompiledGlobPattern,
): Promise<readonly string[]> {
  const terminalSegment = pattern.segments.at(-1);
  if (!terminalSegment || terminalSegment.kind !== 'globstar') {
    throw new Error(`Unsupported cache include glob '${pattern.source}': expected trailing '**'.`);
  }

  return await expandPatternPrefix(baseDirectory, pattern.segments.slice(0, -1), 0);
}

async function expandPatternPrefix(
  currentPath: string,
  segments: readonly CompiledGlobSegment[],
  segmentIndex: number,
): Promise<readonly string[]> {
  if (segmentIndex >= segments.length) {
    return [currentPath];
  }

  const segment = segments[segmentIndex];
  if (segment.kind === 'globstar') {
    throw new Error('Unsupported cache include glob: non-terminal ** segment.');
  }

  if (!segment.hasWildcard) {
    const nextPath = path.join(currentPath, segment.raw);
    const nextStat = await lstat(nextPath).catch((error: unknown) => {
      if (isMissingPathError(error)) {
        return null;
      }

      throw error;
    });

    if (!nextStat || (segmentIndex < segments.length - 1 && !nextStat.isDirectory())) {
      return [];
    }

    return await expandPatternPrefix(nextPath, segments, segmentIndex + 1);
  }

  const entries = await readSortedDirectoryEntries(currentPath);
  if (!entries) {
    return [];
  }

  const expandedRoots: string[] = [];
  for (const entry of entries) {
    if (!segment.regex.test(entry.name)) {
      continue;
    }

    if (segmentIndex < segments.length - 1 && !entry.isDirectory()) {
      continue;
    }

    expandedRoots.push(
      ...(await expandPatternPrefix(
        path.join(currentPath, entry.name),
        segments,
        segmentIndex + 1,
      )),
    );
  }

  return expandedRoots;
}

function compileGlobPattern(pattern: string): CompiledGlobPattern {
  return {
    source: pattern,
    segments: pattern.split('/').map((segment) => {
      if (segment === '**') {
        return { kind: 'globstar' };
      }

      return {
        kind: 'segment',
        raw: segment,
        hasWildcard: segment.includes('*'),
        regex: compileSegmentRegex(segment),
      };
    }),
  };
}

function matchesAnyCompiledGlob(
  relativePath: string,
  compiledPatterns: readonly CompiledGlobPattern[],
): boolean {
  const pathSegments = relativePath.split('/');
  return compiledPatterns.some((pattern) => matchesGlobSegments(pathSegments, pattern.segments));
}

function matchesGlobSegments(
  pathSegments: readonly string[],
  patternSegments: readonly CompiledGlobSegment[],
  pathIndex = 0,
  patternIndex = 0,
): boolean {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment.kind === 'globstar') {
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchesGlobSegments(pathSegments, patternSegments, nextPathIndex, patternIndex + 1)) {
        return true;
      }
    }

    return false;
  }

  if (pathIndex === pathSegments.length) {
    return false;
  }

  return (
    patternSegment.regex.test(pathSegments[pathIndex]) &&
    matchesGlobSegments(pathSegments, patternSegments, pathIndex + 1, patternIndex + 1)
  );
}

function compileSegmentRegex(patternSegment: string): RegExp {
  return new RegExp(
    `^${patternSegment.replaceAll(/([.+^${}()|[\]\\])/g, '\\$1').replaceAll('*', '[^/]*')}$`,
    'u',
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

async function readSortedDirectoryEntries(directoryPath: string) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!entries) {
    return null;
  }

  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function isStableDuringCapture(
  beforeStat: Awaited<ReturnType<typeof lstat>>,
  afterStat: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    beforeStat.size === afterStat.size &&
    beforeStat.mode === afterStat.mode &&
    beforeStat.mtimeMs === afterStat.mtimeMs &&
    beforeStat.ctimeMs === afterStat.ctimeMs
  );
}

function toPosixRelativePath(baseDirectory: string, absolutePath: string): string {
  return path.relative(baseDirectory, absolutePath).split(path.sep).join(path.posix.sep);
}
