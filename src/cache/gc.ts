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

import { lstat, rm, rmdir, utimes } from 'node:fs/promises';
import path from 'node:path';

import { isMissingPathError } from '../util/fs';
import { resolveNormalizedPathWithinRoot } from '../util/paths';
import { captureCacheManifest, type CacheFileManifestEntry } from './manifest';
import type { CacheModel } from './model';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TimestampCacheGcOptions {
  readonly olderThanDays: number;
  readonly now?: Date;
  readonly protectedRelativePaths?: Iterable<string>;
  readonly setTimes?: (filePath: string, atime: Date, mtime: Date) => Promise<unknown>;
  readonly beforeDelete?: (filePath: string) => Promise<unknown>;
  readonly beforeRestoreTimestamps?: (filePath: string) => Promise<unknown>;
}

export interface TimestampCacheGcResult {
  readonly mode: 'timestamp';
  readonly cutoffTimeMs: number;
  readonly scannedFileCount: number;
  readonly deletedFileCount: number;
  readonly deletedByteCount: number;
  readonly keptFileCount: number;
  readonly message: string;
}

/**
 * Deletes managed cache files whose access and modification timestamps are both older than the
 * configured cutoff. Timestamps are only a best-effort signal across runner filesystems, so the
 * policy deliberately keeps files when either access or modification time is recent.
 */
export async function collectTimestampCacheGarbage(
  cacheModel: CacheModel,
  options: TimestampCacheGcOptions,
): Promise<TimestampCacheGcResult> {
  if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 2) {
    throw new Error('cache-gc-older-than-days must be a number greater than or equal to 2.');
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const cutoffTimeMs = nowMs - options.olderThanDays * MILLIS_PER_DAY;
  const manifest = await captureCacheManifest(cacheModel);
  const setTimes = options.setTimes ?? utimes;
  const protectedRelativePaths = new Set(options.protectedRelativePaths ?? []);
  const deletedDirectories = new Set<string>();
  const retainedEntries: CacheFileManifestEntry[] = [];
  let scannedFileCount = 0;
  let deletedFileCount = 0;
  let deletedByteCount = 0;

  for (const partition of manifest.partitions) {
    for (const entry of partition.entries) {
      scannedFileCount += 1;
      if (
        protectedRelativePaths.has(entry.relativePath) ||
        !isTimestampGcEligible(entry, cutoffTimeMs)
      ) {
        retainedEntries.push(entry);
        continue;
      }

      const absolutePath = resolveNormalizedPathWithinRoot(
        cacheModel.cacheRoot,
        entry.relativePath,
        `Cache GC path '${entry.relativePath}' escapes the cache root.`,
      );
      await options.beforeDelete?.(absolutePath);
      if (!(await isRegularNonSymlinkFile(absolutePath))) {
        continue;
      }
      await rm(absolutePath, { force: true });
      deletedDirectories.add(path.dirname(absolutePath));
      deletedFileCount += 1;
      deletedByteCount += entry.size;
    }
  }

  await restoreRetainedFileTimestamps(
    cacheModel.cacheRoot,
    retainedEntries,
    setTimes,
    options.beforeRestoreTimestamps,
  );
  await removeEmptyDirectories(cacheModel.cacheRoot, deletedDirectories);

  return {
    mode: 'timestamp',
    cutoffTimeMs,
    scannedFileCount,
    deletedFileCount,
    deletedByteCount,
    keptFileCount: scannedFileCount - deletedFileCount,
    message:
      `Timestamp cache GC deleted ${deletedFileCount} managed file(s) ` +
      `older than ${options.olderThanDays} day(s).`,
  };
}

async function restoreRetainedFileTimestamps(
  cacheRoot: string,
  entries: readonly CacheFileManifestEntry[],
  setTimes: NonNullable<TimestampCacheGcOptions['setTimes']>,
  beforeRestoreTimestamps: TimestampCacheGcOptions['beforeRestoreTimestamps'],
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = resolveNormalizedPathWithinRoot(
        cacheRoot,
        entry.relativePath,
        `Cache GC path '${entry.relativePath}' escapes the cache root.`,
      );
      await beforeRestoreTimestamps?.(absolutePath);
      if (!(await isRegularNonSymlinkFile(absolutePath))) {
        return;
      }
      await setTimes(absolutePath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(
        () => undefined,
      );
    }),
  );
}

async function isRegularNonSymlinkFile(absolutePath: string): Promise<boolean> {
  const stats = await lstat(absolutePath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  });
  return stats !== null && !stats.isSymbolicLink() && stats.isFile();
}

function isTimestampGcEligible(entry: CacheFileManifestEntry, cutoffTimeMs: number): boolean {
  const effectiveAccessTimeMs = Math.max(entry.atimeMs, entry.mtimeMs);
  return effectiveAccessTimeMs < cutoffTimeMs && entry.mtimeMs < cutoffTimeMs;
}

async function removeEmptyDirectories(
  cacheRoot: string,
  candidateDirectories: ReadonlySet<string>,
): Promise<void> {
  const resolvedRoot = path.resolve(cacheRoot);
  const directories = [...candidateDirectories].sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    let current = path.resolve(directory);
    while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${path.sep}`)) {
      try {
        await rmdir(current);
      } catch (error: unknown) {
        if (isMissingPathError(error) || isNonEmptyDirectoryError(error)) {
          break;
        }
        throw error;
      }
      current = path.dirname(current);
    }
  }
}

function isNonEmptyDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}
