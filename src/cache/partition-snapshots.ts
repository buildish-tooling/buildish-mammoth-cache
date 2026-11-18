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
import { portableCacheFileMode } from './file-permissions';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, lstat, rm, rename, chmod, utimes } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cutoffPartitionIdSchema, cutoffUpsertSchema } from './cutoff-format';
import { guardedPath, verifyParents, regularStat, copyGuardedFile } from './guarded-files';
import { captureCacheMetadataSnapshot, createManagedCachePathMatcher } from './manifest';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import { metadataPath, readMetadata, writeMetadata } from './metadata-io';
import { CUTOFF_STATE_DIRECTORY } from './metadata-paths';
import { hashStableFileSha256, isMissingPathError } from '../util/fs';
import type { CacheModel, CachePartitionDefinition } from './model';
import { DELTA_ARTIFACT_RESOURCE_LIMITS } from '../delta/discovery';

export const PARTITION_SNAPSHOT_DIRECTORY = '.mammoth/partition-snapshots-v1';
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const storedPartitionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    partitionId: cutoffPartitionIdSchema,
    files: z.array(cutoffUpsertSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = new Set<string>(),
      payloads = new Set<string>();
    let previous: string | undefined;
    for (const entry of value.files) {
      if (
        paths.has(entry.relativePath) ||
        payloads.has(entry.payloadPath) ||
        (previous !== undefined && previous.localeCompare(entry.relativePath) >= 0)
      )
        ctx.addIssue({ code: 'custom', message: 'Snapshot membership must be sorted and unique.' });
      paths.add(entry.relativePath);
      payloads.add(entry.payloadPath);
      previous = entry.relativePath;
    }
    if (
      value.files.length > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries ||
      value.files.reduce((n, e) => n + e.size, 0) >
        DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes
    )
      ctx.addIssue({ code: 'custom', message: 'Partition snapshot exceeds resource limits.' });
  });
export type StoredPartitionSnapshot = z.infer<typeof storedPartitionSnapshotSchema>;
export interface VerifiedPartitionSnapshot {
  manifest: StoredPartitionSnapshot;
  rootDirectory: string;
  digest: string;
  contentDigest: string;
}
export function snapshotPartitions(model: CacheModel): readonly CachePartitionDefinition[] {
  return model.partitions.filter((p) => p.publication === 'single-writer');
}
export function ownsSnapshot(
  partition: CachePartitionDefinition,
  mode: string,
  job: string,
): boolean {
  return (
    partition.publication === 'single-writer' && (mode === 'standalone' || partition.writer === job)
  );
}
export function snapshotDigests(manifest: StoredPartitionSnapshot) {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    digest: hash(manifest),
    contentDigest: hash({
      partitionId: manifest.partitionId,
      files: manifest.files.map((e) => [e.relativePath, e.contentSha256, e.size, e.mode]),
    }),
  };
}
function partitionModel(model: CacheModel, id?: string): CacheModel {
  return {
    ...model,
    partitions: snapshotPartitions(model).filter((p) => id === undefined || p.id === id),
  };
}
function assertMembership(model: CacheModel, manifest: StoredPartitionSnapshot) {
  if (!snapshotPartitions(model).some((p) => p.id === manifest.partitionId))
    throw new Error('Unknown snapshot partition.');
  const owns = createManagedCachePathMatcher(model);
  if (manifest.files.some((e) => !owns(manifest.partitionId, e.relativePath)))
    throw new Error('Snapshot path is outside its configured partition.');
}
/** Delete managed members only. Excluded files and parent directories survive. */
export async function clearSnapshotFiles(model: CacheModel, id?: string): Promise<number> {
  const snapshot = await captureCacheMetadataSnapshot(partitionModel(model, id));
  const owns = createManagedCachePathMatcher(model);
  for (const p of snapshot.partitions)
    for (const entry of p.entries)
      if (!owns(p.partitionId, entry.relativePath))
        throw new Error('Snapshot deletion has ambiguous partition ownership.');
  const entries = snapshot.partitions.flatMap((p) => p.entries);
  for (const entry of entries) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath));
    const file = guardedPath(model.cacheRoot, entry.relativePath),
      current = await regularStat(file);
    if (!current || !sameFileIdentity(entry.identity, fileIdentity(current), true))
      throw new Error('Snapshot replacement target changed.');
  }
  for (const entry of entries) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath));
    const file = guardedPath(model.cacheRoot, entry.relativePath),
      current = await regularStat(file);
    if (!current || !sameFileIdentity(entry.identity, fileIdentity(current), true))
      throw new Error('Snapshot replacement target changed.');
    await rm(file);
  }
  return entries.length;
}
/** Reserved transport cleanup rejects links and unexpected file types before recursive removal. */
export async function resetSnapshotTransport(model: CacheModel): Promise<void> {
  const marker = await metadataPath(
    model.cacheRoot,
    PARTITION_SNAPSHOT_DIRECTORY + '/reserved',
    true,
  );
  const root = path.dirname(marker);
  await assertRegularTree(root);
  await rm(root, { recursive: true, force: true });
}
async function assertRegularTree(root: string): Promise<void> {
  let count = 0;
  const visit = async (directory: string) => {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe snapshot directory.');
    for await (const entry of await opendir(directory)) {
      if (++count > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries + 1000)
        throw new Error('Snapshot transport exceeds entry limit.');
      const name = path.join(directory, entry.name),
        st = await lstat(name);
      if (st.isSymbolicLink()) throw new Error('Snapshot transport contains a symlink.');
      if (st.isDirectory()) await visit(name);
      else if (!st.isFile()) throw new Error('Snapshot transport contains a special file.');
    }
  };
  await visit(root);
}
export async function readPartitionSnapshot(
  model: CacheModel,
  id: string,
): Promise<VerifiedPartitionSnapshot | null> {
  cutoffPartitionIdSchema.parse(id);
  const relative = PARTITION_SNAPSHOT_DIRECTORY + '/' + id;
  const serialized = await readMetadata(
    model.cacheRoot,
    relative + '/snapshot.json',
    MAX_MANIFEST_BYTES,
  );
  if (serialized === null) {
    const directory = await metadataPath(model.cacheRoot, relative + '/reserved').catch(
      (error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      },
    );
    if (directory !== null) throw new Error('Snapshot transport is missing its manifest.');
    return null;
  }
  const manifest = storedPartitionSnapshotSchema.parse(JSON.parse(serialized));
  if (manifest.partitionId !== id) throw new Error('Snapshot partition identity mismatch.');
  assertMembership(model, manifest);
  const root = path.dirname(await metadataPath(model.cacheRoot, relative + '/snapshot.json'));
  await assertRegularTree(root);
  const expected = new Set(['snapshot.json', ...manifest.files.map((e) => e.payloadPath)]);
  const actual = new Set<string>();
  for await (const entry of await opendir(root)) {
    if (entry.name === 'payload' && entry.isDirectory()) {
      for await (const file of await opendir(path.join(root, 'payload')))
        actual.add('payload/' + file.name);
    } else actual.add(entry.name);
  }
  if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name)))
    throw new Error('Unexpected snapshot transport membership.');
  for (const entry of manifest.files) {
    await verifyParents(root, 'payload');
    const file = guardedPath(root, entry.payloadPath),
      st = await regularStat(file);
    if (
      !st ||
      st.size !== entry.size ||
      (await hashStableFileSha256(file, st)) !== entry.contentSha256
    )
      throw new Error('Snapshot payload size/SHA-256 mismatch.');
  }
  return { manifest, rootDirectory: root, ...snapshotDigests(manifest) };
}
export interface SnapshotSource {
  relativePath: string;
  sourcePath: string;
  size: number;
  mode: number;
  mtimeMs: number;
  contentSha256?: string;
  identity?: FileIdentity;
}
/** Build completely in excluded scratch before publishing a fixed, version-stable archive path. */
export async function stagePartitionSnapshot(
  model: CacheModel,
  id: string,
  sourceRoot: string,
  sources: readonly SnapshotSource[],
): Promise<VerifiedPartitionSnapshot> {
  cutoffPartitionIdSchema.parse(id);
  if (
    sources.length > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries ||
    sources.reduce((n, e) => n + e.size, 0) >
      DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes
  )
    throw new Error('Snapshot exceeds resource limits.');
  const scratchRelative = CUTOFF_STATE_DIRECTORY + '/snapshot-' + randomUUID();
  const marker = await metadataPath(model.cacheRoot, scratchRelative + '/snapshot.json', true);
  const scratch = path.dirname(marker);
  await mkdir(path.join(scratch, 'payload'));
  try {
    const manifest: StoredPartitionSnapshot = { schemaVersion: 1, partitionId: id, files: [] };
    const sorted = [...sources].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    // Validate the complete projected manifest and ownership before opening source payloads.
    const projected = {
      ...manifest,
      files: sorted.map((entry, i) => ({
        relativePath: entry.relativePath,
        payloadPath: `payload/${String(i + 1).padStart(6, '0')}.bin`,
        contentSha256: 'f'.repeat(64),
        size: entry.size,
        mode: portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
        mtimeMs: entry.mtimeMs,
      })),
    };
    storedPartitionSnapshotSchema.parse(projected);
    assertMembership(model, projected);
    if (Buffer.byteLength(JSON.stringify(projected)) > MAX_MANIFEST_BYTES)
      throw new Error('Snapshot manifest exceeds byte limit.');
    for (const [i, source] of sorted.entries()) {
      const entry = projected.files[i]!;
      const digest = await copyGuardedFile(
        sourceRoot,
        source.sourcePath,
        path.join(scratch, entry.payloadPath),
        { size: source.size, contentSha256: source.contentSha256 },
        source.identity,
      );
      manifest.files.push({ ...entry, contentSha256: digest });
    }
    const parsed = storedPartitionSnapshotSchema.parse(manifest);
    await writeMetadata(
      model.cacheRoot,
      scratchRelative + '/snapshot.json',
      parsed,
      MAX_MANIFEST_BYTES,
    );
    const targetMarker = await metadataPath(
      model.cacheRoot,
      PARTITION_SNAPSHOT_DIRECTORY + '/' + id + '/snapshot.json',
      true,
    );
    const target = path.dirname(targetMarker);
    await assertRegularTree(target);
    await rm(target, { recursive: true });
    await rename(scratch, target);
    return { manifest: parsed, rootDirectory: target, ...snapshotDigests(parsed) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
/** Restore a verified snapshot as a replacement, preserving user-excluded files. */
export async function restorePartitionSnapshot(
  model: CacheModel,
  snapshot: VerifiedPartitionSnapshot,
): Promise<void> {
  const verified = await readPartitionSnapshot(model, snapshot.manifest.partitionId);
  if (!verified || verified.digest !== snapshot.digest)
    throw new Error('Snapshot changed before restore.');
  // Validate incoming target paths before deleting old members.
  for (const entry of verified.manifest.files) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath));
    await regularStat(guardedPath(model.cacheRoot, entry.relativePath));
  }
  await clearSnapshotFiles(model, verified.manifest.partitionId);
  for (const entry of verified.manifest.files) {
    const parent = path.posix.dirname(entry.relativePath),
      target = guardedPath(model.cacheRoot, entry.relativePath);
    await verifyParents(model.cacheRoot, parent, true);
    const temporaryRelative =
      (parent === '.' ? '' : parent + '/') + '.mammoth/restore-' + randomUUID();
    const temporary = await metadataPath(model.cacheRoot, temporaryRelative, true);
    try {
      await copyGuardedFile(verified.rootDirectory, entry.payloadPath, temporary, {
        size: entry.size,
        contentSha256: entry.contentSha256,
      });
      await chmod(
        temporary,
        portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
      );
      await utimes(temporary, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
      await verifyParents(model.cacheRoot, parent);
      const current = await regularStat(target);
      if (current) throw new Error('Snapshot restore target unexpectedly appeared.');
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
export async function verifySnapshotTransport(
  model: CacheModel,
  expected?: ReadonlyMap<string, string>,
): Promise<VerifiedPartitionSnapshot[]> {
  const snapshots: VerifiedPartitionSnapshot[] = [];
  for (const p of snapshotPartitions(model)) {
    const snapshot = await readPartitionSnapshot(model, p.id);
    if (!snapshot || (expected && expected.get(p.id) !== snapshot.digest))
      throw new Error('Selected partition snapshot is missing or changed.');
    snapshots.push(snapshot);
  }
  if (snapshots.length) {
    const root = path.dirname(
      await metadataPath(model.cacheRoot, PARTITION_SNAPSHOT_DIRECTORY + '/reserved'),
    );
    for await (const entry of await opendir(root))
      if (
        !snapshots.some((s) => s.manifest.partitionId === entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        throw new Error('Unexpected snapshot partition transport.');
  }
  return snapshots;
}
