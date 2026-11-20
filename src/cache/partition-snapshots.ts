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
  inventoryInstallTree,
  freezeInstallMetadata,
  type InstallInventory,
} from './install-inventory';
import type { PartitionDescriptor } from './partition-format';
import { assertBaseInstallPlan, type BasePartitionInstallPlan } from './base-install-plan';
import { stageGuardedFiles } from './staged-files';
import { portableCacheFileMode } from './file-permissions';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, lstat, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { cutoffPartitionIdSchema, cutoffUpsertSchema } from './cutoff-format';
import {
  guardedPath,
  verifyParents,
  regularStat,
  copyGuardedFile,
  type PayloadIntegrity,
  DirectoryValidationBatch,
  hashGuardedFile,
} from './guarded-files';
import { captureCacheMetadataSnapshot, createManagedCachePathMatcher } from './manifest';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import { metadataPath, readMetadata, writeMetadata } from './metadata-io';
import { CUTOFF_STATE_DIRECTORY } from './metadata-paths';
import { isMissingPathError } from '../util/fs';
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
export interface ValidatedPartitionSnapshot {
  integrity: PayloadIntegrity;
  manifest: StoredPartitionSnapshot;
  rootDirectory: string;
  digest: string;
  contentDigest: string;
}
const snapshotPlans = new WeakMap<
  ValidatedPartitionSnapshot,
  { cacheRoot: string; model: string; inventory: InstallInventory }
>();
const restoredBaseSnapshots = new WeakMap<PartitionDescriptor, ValidatedPartitionSnapshot>();
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
  let directories = new DirectoryValidationBatch(model.cacheRoot);
  for (const entry of entries) {
    await verifyParents(
      model.cacheRoot,
      path.posix.dirname(entry.relativePath),
      false,
      directories,
    );
    const file = guardedPath(model.cacheRoot, entry.relativePath),
      current = await regularStat(file);
    if (!current || !sameFileIdentity(entry.identity, fileIdentity(current), true))
      throw new Error('Snapshot replacement target changed.');
  }
  directories = new DirectoryValidationBatch(model.cacheRoot);
  for (const entry of entries) {
    await verifyParents(
      model.cacheRoot,
      path.posix.dirname(entry.relativePath),
      false,
      directories,
    );
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
  integrity: PayloadIntegrity = 'verified',
): Promise<ValidatedPartitionSnapshot | null> {
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
  const inventory = await inventoryInstallTree(root);
  const expected = new Set(['snapshot.json', ...manifest.files.map((e) => e.payloadPath)]);
  if (
    inventory.files.size !== expected.size ||
    [...inventory.files.keys()].some((name) => !expected.has(name)) ||
    [...inventory.directories.keys()].some((name) => name !== '' && name !== 'payload')
  )
    throw new Error('Unexpected snapshot transport membership.');
  const sources = new DirectoryValidationBatch(root);
  for (const entry of manifest.files) {
    const native = inventory.files.get(entry.payloadPath);
    if (!native || native.size !== entry.size)
      throw new Error(
        integrity === 'verified'
          ? 'Snapshot payload size/SHA-256 mismatch.'
          : 'Snapshot payload size mismatch.',
      );
    if (integrity === 'verified')
      await hashGuardedFile(root, entry.payloadPath, entry, native, sources);
  }
  const snapshot = {
    manifest: freezeInstallMetadata(manifest),
    rootDirectory: root,
    integrity,
    ...snapshotDigests(manifest),
  };
  snapshotPlans.set(snapshot, {
    cacheRoot: model.cacheRoot,
    model: snapshotModelBinding(model),
    inventory,
  });
  return Object.freeze(snapshot);
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
): Promise<ValidatedPartitionSnapshot> {
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
    return {
      manifest: parsed,
      rootDirectory: target,
      integrity: 'verified',
      ...snapshotDigests(parsed),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
/** Restore a verified snapshot as a replacement, preserving user-excluded files. */
export async function restorePartitionSnapshot(
  model: CacheModel,
  snapshot: ValidatedPartitionSnapshot,
): Promise<void> {
  let evidence = snapshotPlans.get(snapshot);
  const verified =
    evidence?.cacheRoot === model.cacheRoot && evidence.model === snapshotModelBinding(model)
      ? snapshot
      : await readPartitionSnapshot(model, snapshot.manifest.partitionId, snapshot.integrity);
  if (!verified || verified.digest !== snapshot.digest)
    throw new Error('Snapshot changed before restore.');
  evidence = snapshotPlans.get(verified)!;
  await verifyParents(
    model.cacheRoot,
    PARTITION_SNAPSHOT_DIRECTORY + '/' + verified.manifest.partitionId,
  );
  for (const [name, identity] of evidence.inventory.directories) {
    const current = await lstat(
      name ? guardedPath(verified.rootDirectory, name) : verified.rootDirectory,
    );
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(identity, fileIdentity(current), true)
    )
      throw new Error('Snapshot transport directory changed.');
  }
  const manifestStat = await regularStat(guardedPath(verified.rootDirectory, 'snapshot.json'));
  if (
    !manifestStat ||
    !sameFileIdentity(
      evidence.inventory.files.get('snapshot.json')!,
      fileIdentity(manifestStat),
      true,
    )
  )
    throw new Error('Snapshot changed before restore.');
  // Preflight, staging and live commit each own a fresh directory batch.
  const preflight = new DirectoryValidationBatch(model.cacheRoot);
  for (const entry of verified.manifest.files) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath), false, preflight);
    await regularStat(guardedPath(model.cacheRoot, entry.relativePath));
  }
  await clearSnapshotFiles(model, verified.manifest.partitionId);
  const staged = verified.manifest.files.map((entry) => {
    const parent = path.posix.dirname(entry.relativePath);
    const destination = (parent === '.' ? '' : parent + '/') + '.mammoth/restore-' + randomUUID();
    return { entry, destination, temporary: guardedPath(model.cacheRoot, destination) };
  });
  try {
    const identities = await stageGuardedFiles(
      model.cacheRoot,
      staged.map(({ entry, destination }) => ({
        sourceRoot: verified.rootDirectory,
        sourcePath: entry.payloadPath,
        destination,
        native: evidence!.inventory.files.get(entry.payloadPath),
        expected: {
          ...entry,
          mode: portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
        },
      })),
      snapshot.integrity,
    );
    const commit = new DirectoryValidationBatch(model.cacheRoot);
    for (const { entry, temporary, destination } of staged) {
      await verifyParents(
        model.cacheRoot,
        path.posix.dirname(path.relative(model.cacheRoot, temporary).split(path.sep).join('/')),
        false,
        commit,
      );
      const stagedStat = await regularStat(temporary);
      if (
        !stagedStat ||
        !sameFileIdentity(identities.get(destination)!, fileIdentity(stagedStat), true)
      )
        throw new Error('Snapshot staging changed before replacement.');
      const target = guardedPath(model.cacheRoot, entry.relativePath);
      if (await regularStat(target))
        throw new Error('Snapshot restore target unexpectedly appeared.');
      await rename(temporary, target);
    }
  } finally {
    const cleanup = new DirectoryValidationBatch(model.cacheRoot);
    for (const { temporary } of staged) {
      await verifyParents(
        model.cacheRoot,
        path.posix.dirname(path.relative(model.cacheRoot, temporary).split(path.sep).join('/')),
        false,
        cleanup,
      );
      await rm(temporary, { force: true });
    }
  }
}
export async function verifySnapshotTransport(
  model: CacheModel,
  expected?: ReadonlyMap<string, string>,
  integrity: PayloadIntegrity = 'verified',
  restoredDescriptors: readonly PartitionDescriptor[] = [],
): Promise<ValidatedPartitionSnapshot[]> {
  const snapshots: ValidatedPartitionSnapshot[] = [];
  for (const p of snapshotPartitions(model)) {
    const descriptor =
      integrity === 'trusted-base'
        ? restoredDescriptors.find((entry) => entry.identity.partitionId === p.id)
        : undefined;
    const restored = descriptor ? restoredBaseSnapshots.get(descriptor) : undefined;
    const evidence = restored && snapshotPlans.get(restored);
    const snapshot =
      restored &&
      evidence?.cacheRoot === model.cacheRoot &&
      evidence.model === snapshotModelBinding(model)
        ? restored
        : await readPartitionSnapshot(model, p.id, integrity);
    if (descriptor) restoredBaseSnapshots.delete(descriptor);
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

/** Carry base snapshot metadata/inventory through its own transport rename, without rediscovery. */
export async function installBaseSnapshot(
  plan: BasePartitionInstallPlan,
  model: CacheModel,
): Promise<void> {
  assertBaseInstallPlan(plan, model);
  const id = plan.descriptor.identity.partitionId;
  if (plan.descriptor.kind !== 'single-writer') throw new Error('Expected snapshot partition.');
  const relative = PARTITION_SNAPSHOT_DIRECTORY + '/' + id;
  const inventory: InstallInventory = { files: new Map(), directories: new Map() };
  await verifyParents(plan.rootDirectory, path.posix.dirname(relative));
  for (const [name, identity] of plan.inventory.directories) {
    if (name !== relative && !name.startsWith(relative + '/')) continue;
    const current = await lstat(guardedPath(plan.rootDirectory, name));
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(identity, fileIdentity(current), true)
    )
      throw new Error('Base snapshot directory changed.');
    inventory.directories.set(name === relative ? '' : name.slice(relative.length + 1), identity);
  }
  for (const entry of plan.descriptor.files) {
    const current = await regularStat(guardedPath(plan.rootDirectory, entry.payloadPath));
    const identity = plan.inventory.files.get(entry.payloadPath)!;
    if (!current || !sameFileIdentity(identity, fileIdentity(current), true))
      throw new Error('Base snapshot source changed.');
    inventory.files.set(entry.payloadPath.slice(relative.length + 1), identity);
  }
  const manifest = freezeInstallMetadata({
    schemaVersion: 1 as const,
    partitionId: id,
    files: plan.descriptor.files.map((entry) => ({
      ...entry,
      payloadPath: entry.payloadPath.slice(relative.length + 1),
    })),
  });
  await writeMetadata(
    plan.rootDirectory,
    relative + '/snapshot.json',
    manifest,
    MAX_MANIFEST_BYTES,
  );
  inventory.files.set(
    'snapshot.json',
    fileIdentity(
      (await regularStat(guardedPath(plan.rootDirectory, relative + '/snapshot.json')))!,
    ),
  );
  const target = path.dirname(
    await metadataPath(model.cacheRoot, relative + '/snapshot.json', true),
  );
  await assertRegularTree(target);
  await rm(target, { recursive: true });
  await rename(guardedPath(plan.rootDirectory, relative), target);
  inventory.directories.set('', fileIdentity(await lstat(target)));
  const snapshot: ValidatedPartitionSnapshot = {
    manifest,
    rootDirectory: target,
    integrity: 'trusted-base',
    ...snapshotDigests(manifest),
  };
  snapshotPlans.set(snapshot, {
    cacheRoot: model.cacheRoot,
    model: snapshotModelBinding(model),
    inventory,
  });
  restoredBaseSnapshots.set(plan.descriptor, Object.freeze(snapshot));
}

function snapshotModelBinding(model: CacheModel): string {
  return JSON.stringify([
    model.cacheFamilyKey,
    model.buildToolId,
    model.partitionFingerprint,
    model.partitions.map((p) => [
      p.id,
      p.publication,
      p.relativeIncludeGlobs,
      p.relativeExcludeGlobs,
    ]),
  ]);
}
