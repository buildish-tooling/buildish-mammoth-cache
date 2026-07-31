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

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  areCacheFileSnapshotsMateriallyEquivalent,
  type CacheDeltaEntry,
  type CacheFileSnapshot,
} from '../cache/manifest';
import { hashStableFileSha256, isMissingPathError, isReplaceTargetError } from '../util/fs';
import {
  resolveNormalizedPathWithinRoot,
  validateNormalizedRelativePosixPath,
} from '../util/paths';
import type { MergedDeltaPayload, MergedDeltaPlan, MergedDeltaPrecondition } from './apply';

/** Options that control how a merged delta plan is applied to a cache root directory. */
export interface DeltaApplyOptions {
  /** Override the filesystem `utimes` call for testing; defaults to `node:fs/promises` `utimes`. */
  readonly setTimes?: (filePath: string, atime: Date, mtime: Date) => Promise<unknown>;
}

/** Summary counts and warnings produced after applying a merged delta plan. */
export interface DeltaApplyResult {
  readonly cacheRoot: string;
  readonly preconditionValidatedCount: number;
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly noopCount: number;
  readonly warnings: readonly string[];
}

/**
 * Applies a merged delta plan to its build-tool cache root.
 *
 * Every target is first inspected against its accepted previous states. No path is changed unless
 * all targets satisfy their preconditions. A target already in the desired state is an idempotent
 * no-op. Immediately before each remaining mutation, its inspected identity is checked again.
 *
 * Payload files are written atomically via a temporary file followed by a rename so a partially
 * written file is never visible to a concurrent build-tool invocation. The destination path is
 * validated to stay within the cache root before each write. Access and modification timestamps
 * are restored from the manifest when supported by the OS.
 */
export async function applyMergedDeltaPlan(
  plan: MergedDeltaPlan,
  cacheRoot: string,
  options: DeltaApplyOptions = {},
): Promise<DeltaApplyResult> {
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const setTimes = options.setTimes ?? utimes;
  const warnings: string[] = [];
  const payloads = indexUniquePlanEntries(plan.payloads, 'payload');
  const preconditions = indexUniquePlanEntries(plan.preconditions, 'precondition');
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;
  let noopCount = 0;

  await ensureDirectoryPath(resolvedCacheRoot, '');
  const executionPlan = await validateDeltaPreconditions(
    plan,
    payloads,
    preconditions,
    resolvedCacheRoot,
  );

  for (const plannedEntry of executionPlan) {
    const { entry, targetInspection, targetPath } = plannedEntry;
    if (plannedEntry.operation === 'noop') {
      noopCount += 1;
      continue;
    }

    await assertTargetUnchanged(
      resolvedCacheRoot,
      targetPath,
      entry.relativePath,
      targetInspection,
    );

    if (entry.changeType === 'deleted') {
      await deleteTargetPath(resolvedCacheRoot, targetPath, entry.relativePath);
      deletedCount += 1;
      continue;
    }

    const currentSnapshot = entry.current;
    if (!currentSnapshot) {
      throw new Error(
        `Merged delta entry '${entry.relativePath}' is missing its current snapshot.`,
      );
    }

    const payload = payloads.get(entry.relativePath);
    if (!payload) {
      throw new Error(`Merged delta entry '${entry.relativePath}' is missing its payload file.`);
    }

    await writePayloadAtomically(
      payload.payloadPath,
      resolvedCacheRoot,
      targetPath,
      entry.relativePath,
      currentSnapshot,
    );
    const timestampWarning = await restoreFileTimestamps(
      targetPath,
      entry.relativePath,
      currentSnapshot,
      setTimes,
    );
    if (timestampWarning) {
      warnings.push(timestampWarning);
    }

    if (entry.changeType === 'added') {
      addedCount += 1;
    } else {
      modifiedCount += 1;
    }
  }

  return {
    cacheRoot: resolvedCacheRoot,
    preconditionValidatedCount: executionPlan.length,
    addedCount,
    modifiedCount,
    deletedCount,
    noopCount,
    warnings,
  };
}

interface ValidatedDeltaExecutionEntry {
  readonly entry: CacheDeltaEntry;
  readonly targetPath: string;
  readonly targetInspection: TargetInspection;
  readonly operation: 'mutate' | 'noop';
}

async function validateDeltaPreconditions(
  plan: MergedDeltaPlan,
  payloads: ReadonlyMap<string, MergedDeltaPayload>,
  preconditions: ReadonlyMap<string, MergedDeltaPrecondition>,
  cacheRoot: string,
): Promise<readonly ValidatedDeltaExecutionEntry[]> {
  const executionPlan: ValidatedDeltaExecutionEntry[] = [];

  for (const partition of plan.deltaManifest.partitions) {
    for (const entry of partition.entries) {
      const targetPath = resolvePathWithinRoot(
        cacheRoot,
        entry.relativePath,
        'merged delta relativePath',
      );
      const precondition = preconditions.get(entry.relativePath);
      if (!precondition || precondition.acceptablePreviousSnapshots.length === 0) {
        throw new Error(`Merged delta entry '${entry.relativePath}' is missing its preconditions.`);
      }
      if (entry.changeType !== 'deleted' && !payloads.has(entry.relativePath)) {
        throw new Error(`Merged delta entry '${entry.relativePath}' is missing its payload file.`);
      }

      const targetInspection = await captureTargetInspection(
        cacheRoot,
        targetPath,
        entry.relativePath,
      );
      const inspectedSnapshot = targetInspection.snapshot;
      const desiredSnapshot = entry.current;
      const alreadyApplied =
        entry.changeType === 'deleted'
          ? inspectedSnapshot === null
          : desiredSnapshot !== null &&
            areOptionalSnapshotsMateriallyEquivalent(inspectedSnapshot, desiredSnapshot);
      if (alreadyApplied) {
        executionPlan.push({ entry, targetPath, targetInspection, operation: 'noop' });
        continue;
      }

      if (
        !precondition.acceptablePreviousSnapshots.some((expected) =>
          areOptionalSnapshotsMateriallyEquivalent(inspectedSnapshot, expected),
        )
      ) {
        throw new Error(
          `Merged delta target '${entry.relativePath}' does not match its desired state or any accepted previous state.`,
        );
      }

      executionPlan.push({ entry, targetPath, targetInspection, operation: 'mutate' });
    }
  }

  return executionPlan;
}

function indexUniquePlanEntries<T extends { readonly relativePath: string }>(
  entries: readonly T[],
  label: string,
): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const entry of entries) {
    if (indexed.has(entry.relativePath)) {
      throw new Error(
        `Merged delta plan contains duplicate ${label} path '${entry.relativePath}'.`,
      );
    }
    indexed.set(entry.relativePath, entry);
  }
  return indexed;
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

interface TargetInspection {
  readonly snapshot: CacheFileSnapshot | null;
  readonly fileIdentity: TargetFileIdentity | null;
}

interface TargetFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

async function captureTargetInspection(
  cacheRoot: string,
  targetPath: string,
  relativePath: string,
): Promise<TargetInspection> {
  await verifyDirectoryPath(cacheRoot, path.posix.dirname(relativePath), false);
  const beforeStats = await statReplaceableFile(targetPath, relativePath);
  if (!beforeStats) {
    return { snapshot: null, fileIdentity: null };
  }

  const contentSha256 = await hashStableFileSha256(targetPath, beforeStats);
  const afterStats = await statReplaceableFile(targetPath, relativePath);
  if (
    !contentSha256 ||
    !afterStats ||
    beforeStats.dev !== afterStats.dev ||
    beforeStats.ino !== afterStats.ino ||
    beforeStats.mode !== afterStats.mode ||
    beforeStats.size !== afterStats.size ||
    beforeStats.mtimeMs !== afterStats.mtimeMs ||
    beforeStats.ctimeMs !== afterStats.ctimeMs
  ) {
    throw new Error(`Merged delta target '${relativePath}' changed while it was inspected.`);
  }

  return {
    snapshot: {
      contentSha256,
      size: afterStats.size,
      mode: afterStats.mode,
      atimeMs: beforeStats.atimeMs,
      mtimeMs: afterStats.mtimeMs,
    },
    fileIdentity: createTargetFileIdentity(afterStats),
  };
}

async function assertTargetUnchanged(
  cacheRoot: string,
  targetPath: string,
  relativePath: string,
  inspection: TargetInspection,
): Promise<void> {
  await verifyDirectoryPath(cacheRoot, path.posix.dirname(relativePath), false);
  const currentStats = await statReplaceableFile(targetPath, relativePath);
  const currentIdentity = currentStats ? createTargetFileIdentity(currentStats) : null;
  if (!areTargetFileIdentitiesEqual(currentIdentity, inspection.fileIdentity)) {
    throw new Error(`Merged delta target '${relativePath}' changed after precondition validation.`);
  }
}

function createTargetFileIdentity(
  stats: NonNullable<Awaited<ReturnType<typeof statReplaceableFile>>>,
): TargetFileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
  };
}

function areTargetFileIdentitiesEqual(
  left: TargetFileIdentity | null,
  right: TargetFileIdentity | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

async function writePayloadAtomically(
  payloadPath: string,
  cacheRoot: string,
  targetPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  await ensureDirectoryPath(cacheRoot, path.posix.dirname(relativePath));
  await statReplaceableFile(targetPath, relativePath);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.buildish-mammoth-cache-delta.${randomUUID()}.tmp`,
  );

  try {
    await copyAndVerifyPayload(payloadPath, temporaryPath, relativePath, expectedSnapshot);
    await chmod(temporaryPath, expectedSnapshot.mode & 0o777);
    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      if (!isReplaceTargetError(error)) throw error;
      await rm(targetPath, { force: true });
      await rename(temporaryPath, targetPath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function copyAndVerifyPayload(
  payloadPath: string,
  destinationPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  const beforeStat = await lstat(payloadPath);
  if (beforeStat.isSymbolicLink()) {
    throw new Error(`Delta payload '${relativePath}' must not be a symbolic link.`);
  }
  if (!beforeStat.isFile()) {
    throw new Error(`Delta payload '${relativePath}' must be a regular file.`);
  }

  const hash = createHash('sha256');
  let copiedBytes = 0;
  const input = createReadStream(payloadPath);
  input.on('data', (chunk: Buffer) => {
    copiedBytes += chunk.length;
    hash.update(chunk);
  });
  await pipeline(input, createWriteStream(destinationPath, { flags: 'wx' }));

  const afterStat = await lstat(payloadPath);
  if (afterStat.isSymbolicLink() || !afterStat.isFile()) {
    throw new Error(`Delta payload '${relativePath}' changed while it was being applied.`);
  }
  if (
    beforeStat.size !== afterStat.size ||
    beforeStat.mtimeMs !== afterStat.mtimeMs ||
    beforeStat.ctimeMs !== afterStat.ctimeMs
  ) {
    throw new Error(`Delta payload '${relativePath}' changed while it was being applied.`);
  }
  if (
    copiedBytes !== expectedSnapshot.size ||
    hash.digest('hex') !== expectedSnapshot.contentSha256
  ) {
    throw new Error(`Delta payload '${relativePath}' does not match the expected snapshot.`);
  }
}

async function restoreFileTimestamps(
  targetPath: string,
  relativePath: string,
  snapshot: CacheFileSnapshot,
  setTimes: NonNullable<DeltaApplyOptions['setTimes']>,
): Promise<string | null> {
  const atime = new Date(snapshot.atimeMs);
  const mtime = new Date(snapshot.mtimeMs);
  try {
    await setTimes(targetPath, atime, mtime);
  } catch (error) {
    if (snapshot.atimeMs === snapshot.mtimeMs) throw error;
    await setTimes(targetPath, mtime, mtime);
    return `Could not fully restore access time for '${relativePath}'; preserved modification time only.`;
  }
  return null;
}

async function deleteTargetPath(
  cacheRoot: string,
  targetPath: string,
  relativePath: string,
): Promise<void> {
  await verifyDirectoryPath(cacheRoot, path.posix.dirname(relativePath), false);
  const stats = await statReplaceableFile(targetPath, relativePath);
  if (stats) await rm(targetPath);
}

async function statReplaceableFile(targetPath: string, relativePath: string) {
  const stats = await lstat(targetPath).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw new Error(`Merged delta target '${relativePath}' must not be a symbolic link.`);
  }
  if (!stats.isFile()) {
    throw new Error(`Merged delta target '${relativePath}' must be a regular file.`);
  }
  return stats;
}

async function ensureDirectoryPath(
  directoryPath: string,
  relativeDirectory: string,
): Promise<void> {
  await verifyDirectoryPath(directoryPath, relativeDirectory, true);
}

async function verifyDirectoryPath(
  directoryPath: string,
  relativeDirectory: string,
  createMissing: boolean,
): Promise<void> {
  const segments =
    relativeDirectory === '.' || relativeDirectory.length === 0 ? [] : relativeDirectory.split('/');
  let currentPath = path.resolve(directoryPath);
  const rootStats = await lstat(currentPath).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootStats) {
    if (!createMissing) return;
    await mkdir(currentPath, { recursive: true });
  } else if (rootStats.isSymbolicLink()) {
    throw new Error(`Merged delta directory '${relativeDirectory}' contains a symbolic link.`);
  } else if (!rootStats.isDirectory()) {
    throw new Error(`Merged delta directory '${relativeDirectory}' contains a non-directory path.`);
  }

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = await lstat(currentPath).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!stats) {
      if (!createMissing) return;
      await mkdir(currentPath);
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Merged delta directory '${relativeDirectory}' contains a symbolic link.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Merged delta directory '${relativeDirectory}' contains a non-directory path.`,
      );
    }
  }
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
