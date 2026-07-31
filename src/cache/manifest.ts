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

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { hashStableFileSha256, isMissingPathError } from '../util/fs';
import { processAsyncWorkQueue, type EnqueueAsyncWork } from '../util/async-work-queue';
import { resolveNormalizedPathWithinRoot } from '../util/paths';
import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  type CacheFileManifestEntry,
  type CacheManifest,
} from './manifest-format';
import type { CacheModel } from './model';

export {
  CACHE_MANIFEST_SCHEMA_VERSION,
  calculateCanonicalCacheManifestDigest,
  computeCacheDelta,
  deserializeCacheDeltaManifest,
  deserializeCacheManifest,
  serializeCacheDeltaManifest,
  serializeCacheManifest,
  type CacheDeltaEntry,
  type CacheDeltaManifest,
  type CacheFileManifestEntry,
  type CacheFileSnapshot,
  type CacheManifest,
  type CachePartitionDelta,
  type CachePartitionManifest,
} from './manifest-format';

/** Maximum simultaneous filesystem operations used by manifest and metadata traversal. */
export const DEFAULT_CACHE_MANIFEST_SCAN_CONCURRENCY = 32;
const STABLE_ENTRY_CAPTURE_ATTEMPTS = 3;

export interface CacheFileMetadataEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
}

export interface CachePartitionMetadata {
  readonly partitionId: string;
  readonly entries: readonly CacheFileMetadataEntry[];
}

export interface CacheMetadataSnapshot {
  readonly buildToolId: string;
  readonly cacheRoot: string;
  readonly partitions: readonly CachePartitionMetadata[];
}

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

/** Tuning options for deterministic manifest and metadata capture. */
export interface CacheManifestCaptureOptions {
  /**
   * Maximum simultaneous traversal or file-capture operations. Defaults to
   * {@link DEFAULT_CACHE_MANIFEST_SCAN_CONCURRENCY}.
   */
  readonly maxConcurrency?: number;
}

interface IncludedTreeWorkItem {
  readonly absolutePath: string;
  readonly kind: 'inspect' | 'directory' | 'file' | 'symbolic-link';
}

/**
 * Scans all configured cache partitions and captures a deterministic manifest of regular files.
 *
 * The scanner retries a small number of times when a file changes while being hashed, so the later delta
 * computation does not observe inconsistent size/hash metadata for the same path.
 */
export async function captureCacheManifest(
  cacheModel: CacheModel,
  options: CacheManifestCaptureOptions = {},
): Promise<CacheManifest> {
  const cacheRoot = cacheModel.cacheRoot;
  const partitions = await scanCachePartitions(
    cacheModel,
    captureStableFileEntry,
    resolveManifestScanConcurrency(options.maxConcurrency),
  );

  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    buildToolId: cacheModel.buildToolId,
    cacheRoot,
    partitions,
  };
}

/**
 * Scans all configured cache partitions and captures regular-file metadata without reading file
 * contents. This is intended for timestamp-only decisions such as cache garbage collection.
 */
export async function captureCacheMetadataSnapshot(
  cacheModel: CacheModel,
  options: CacheManifestCaptureOptions = {},
): Promise<CacheMetadataSnapshot> {
  return {
    buildToolId: cacheModel.buildToolId,
    cacheRoot: cacheModel.cacheRoot,
    partitions: await scanCachePartitions(
      cacheModel,
      captureFileMetadataEntry,
      resolveManifestScanConcurrency(options.maxConcurrency),
    ),
  };
}

async function scanCachePartitions<T extends { readonly relativePath: string }>(
  cacheModel: CacheModel,
  captureEntry: (
    cacheRoot: string,
    absolutePath: string,
    relativePath: string,
  ) => Promise<T | null>,
  maxConcurrency: number,
): Promise<{ partitionId: string; entries: T[] }[]> {
  const cacheRoot = cacheModel.cacheRoot;
  const compiledPartitions = cacheModel.partitions.map((partition) => ({
    partition,
    includePatterns: partition.relativeIncludeGlobs.map(compileGlobPattern),
    excludePatterns: partition.relativeExcludeGlobs.map(compileGlobPattern),
    entries: [] as T[],
    seenRelativePaths: new Set<string>(),
  }));
  const claimedPaths = new Map<string, string>();

  for (const compiledPartition of compiledPartitions) {
    for (const includePattern of compiledPartition.includePatterns) {
      const includeRoots = await expandIncludePatternRoots(cacheRoot, includePattern);

      for (const includeRoot of includeRoots) {
        await walkIncludedTree(
          includeRoot,
          async (absolutePath) => {
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

            const entry = await captureEntry(cacheRoot, absolutePath, relativePath);
            if (!entry) {
              return;
            }

            compiledPartition.seenRelativePaths.add(relativePath);
            claimedPaths.set(relativePath, compiledPartition.partition.id);
            compiledPartition.entries.push(entry);
          },
          maxConcurrency,
        );
      }
    }
  }

  return cacheModel.partitions.map((partition) => ({
    partitionId: partition.id,
    entries: [
      ...(compiledPartitions.find((candidate) => candidate.partition.id === partition.id)
        ?.entries ?? []),
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  }));
}

async function captureFileMetadataEntry(
  _cacheRoot: string,
  absolutePath: string,
  relativePath: string,
): Promise<CacheFileMetadataEntry | null> {
  const stats = await lstat(absolutePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  });

  if (!stats) {
    return null;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Cache manifest does not support symbolic links: '${relativePath}'.`);
  }

  if (!stats.isFile()) {
    throw new Error(`Cache manifest only supports regular files, but found '${relativePath}'.`);
  }

  return {
    relativePath,
    size: stats.size,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
  };
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

    const contentSha256 = await hashStableFileSha256(absolutePath, beforeStat).catch(
      (error: unknown) => {
        if (isMissingPathError(error)) {
          return null;
        }

        throw error;
      },
    );

    if (!contentSha256) {
      const currentStat = await lstat(absolutePath).catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return null;
        }

        throw error;
      });
      if (currentStat?.isSymbolicLink()) {
        throw new Error(`Cache manifest does not support symbolic links: '${relativePath}'.`);
      }
      if (!currentStat) {
        return null;
      }
      continue;
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
  maxConcurrency: number,
): Promise<void> {
  await processAsyncWorkQueue<IncludedTreeWorkItem>(
    [{ absolutePath: pathToScan, kind: 'inspect' }],
    maxConcurrency,
    async (item, enqueue) => {
      if (item.kind === 'file' || item.kind === 'symbolic-link') {
        await onFile(item.absolutePath);
        return;
      }

      const entryStat = await lstat(item.absolutePath).catch((error: unknown) => {
        if (isMissingPathError(error)) {
          return null;
        }

        throw error;
      });

      if (!entryStat) {
        return;
      }

      if (entryStat.isSymbolicLink() || entryStat.isFile()) {
        await onFile(item.absolutePath);
        return;
      }

      if (!entryStat.isDirectory()) {
        return;
      }

      const entries = await readSortedDirectoryEntries(item.absolutePath);
      if (entries) {
        enqueueDirectoryEntries(item.absolutePath, entries, enqueue);
      }
    },
  );
}

function enqueueDirectoryEntries(
  directoryPath: string,
  entries: NonNullable<Awaited<ReturnType<typeof readSortedDirectoryEntries>>>,
  enqueue: EnqueueAsyncWork<IncludedTreeWorkItem>,
): void {
  enqueue(createDirectoryWorkItems(directoryPath, entries));
}

function* createDirectoryWorkItems(
  directoryPath: string,
  entries: NonNullable<Awaited<ReturnType<typeof readSortedDirectoryEntries>>>,
): Iterable<IncludedTreeWorkItem> {
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isSymbolicLink()) {
      yield { absolutePath, kind: 'symbolic-link' };
    } else if (entry.isDirectory()) {
      yield { absolutePath, kind: 'directory' };
    } else if (entry.isFile()) {
      yield { absolutePath, kind: 'file' };
    }
  }
}

function resolveManifestScanConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CACHE_MANIFEST_SCAN_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Cache manifest scan concurrency must be a positive integer.');
  }
  return concurrency;
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
    // Path-containment guard: a segment like '..' could escape the scan root. Resolving
    // via resolveNormalizedPathWithinRoot (using currentPath as the root) rejects any
    // upward traversal before we ever touch the filesystem. The error is propagated to the
    // caller rather than silently ignored, consistent with how other invalid glob shapes
    // (missing trailing '**', non-terminal '**') are treated.
    const nextPath = resolveNormalizedPathWithinRoot(
      currentPath,
      segment.raw,
      `Cache include glob contains a path-traversal segment ('${segment.raw}') that would escape the scan root.`,
    );
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
