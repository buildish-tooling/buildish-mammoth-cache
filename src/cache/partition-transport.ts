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

import { opendir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  hashGuardedFile,
  moveGuardedFile,
  guardedPath,
  regularStat,
  verifyParents,
  type PayloadIntegrity,
  DirectoryValidationBatch,
} from './guarded-files';
import { fileIdentity, sameFileIdentity } from './file-identity';
import { metadataPath, readMetadata, writeMetadata } from './metadata-io';
import { portableCacheFileMode, repairCacheFileMetadata } from './file-permissions';
import { assertBaseInstallPlan, type BasePartitionInstallPlan } from './base-install-plan';
import type { StoreEvidence } from './store-evidence';
import { applyBaseWorkspaces, applyWorkspaces } from './workspace-apply';
import {
  PARTITION_SNAPSHOT_DIRECTORY,
  readPartitionSnapshot,
  installBaseSnapshot,
} from './partition-snapshots';
import type { CacheModel } from './model';
import type { SnapshotSource } from './partition-snapshots';
import {
  PARTITION_STORAGE_LIMITS,
  partitionObjectRoot,
  partitionObjectKey,
  storageDigest,
  validatePartitionDescriptor,
  type PartitionDescriptor,
  type PartitionReference,
} from './partition-format';

/** Freeze descriptors over native/frozen snapshot files; create no payload copies or hardlinks. */
export async function stagePartitionObject(
  model: CacheModel,
  root: string,
  descriptor: PartitionDescriptor,
  sourceRoot: string,
  sources: readonly SnapshotSource[],
  evidence?: StoreEvidence,
): Promise<{ reference: PartitionReference; descriptor: PartitionDescriptor }> {
  const projected = {
    ...descriptor,
    files: sources.map((entry) => ({
      relativePath: entry.relativePath,
      payloadPath: path
        .relative(model.cacheRoot, path.join(sourceRoot, entry.sourcePath))
        .split(path.sep)
        .join('/'),
      contentSha256: entry.contentSha256 ?? '0'.repeat(64),
      size: entry.size,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
    })),
  };
  const workspaceFiles = new Set(descriptor.workspaces.flatMap((w) => w.files));
  const reference: PartitionReference = {
    identity: descriptor.identity,
    key: partitionObjectKey(descriptor.identity),
    descriptorDigest: storageDigest(projected),
    ...(descriptor.kind === 'workspace'
      ? {
          workspaceRoots: descriptor.workspaces.map((w) => w.root),
          ordinaryPaths: projected.files
            .filter((e) => !workspaceFiles.has(e.relativePath))
            .map((e) => e.relativePath),
        }
      : {}),
  };
  validatePartitionDescriptor(model, projected, reference);
  const directories = new DirectoryValidationBatch(sourceRoot);
  for (const [i, source] of sources.entries())
    projected.files[i]!.contentSha256 = await (
      evidence ? evidence.hash.bind(evidence) : hashGuardedFile
    )(
      sourceRoot,
      source.sourcePath,
      { size: source.size, contentSha256: source.contentSha256 },
      source.identity,
      directories,
    );
  reference.descriptorDigest = storageDigest(projected);
  const validated = validatePartitionDescriptor(model, projected, reference);
  await writeMetadata(
    root,
    `${partitionObjectRoot(descriptor.identity.partitionId)}/object.json`,
    validated,
    PARTITION_STORAGE_LIMITS.bytes,
  );
  return { reference, descriptor: validated };
}
/** Validate persisted descriptor metadata without reopening payload bytes. */
export async function readPartitionDescriptor(
  model: CacheModel,
  root: string,
  reference: PartitionReference,
): Promise<PartitionDescriptor> {
  const relative = `${partitionObjectRoot(reference.identity.partitionId)}/object.json`;
  const raw = await readMetadata(root, relative, PARTITION_STORAGE_LIMITS.bytes);
  if (raw === null) throw new Error('Restored partition descriptor is missing.');
  return validatePartitionDescriptor(model, JSON.parse(raw), reference);
}
export async function readPartitionObject(
  model: CacheModel,
  root: string,
  reference: PartitionReference,
  live = false,
  integrity: PayloadIntegrity = 'verified',
): Promise<PartitionDescriptor> {
  const relative = `${partitionObjectRoot(reference.identity.partitionId)}/object.json`;
  const descriptor = await readPartitionDescriptor(model, root, reference);
  if (!live) {
    const expected = new Set([relative, ...descriptor.files.map((e) => e.payloadPath)]);
    const actual = new Set<string>();
    async function inventory(directory: string) {
      await verifyParents(root, directory);
      for await (const entry of await opendir(path.join(root, directory))) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await inventory(name);
        else if (entry.isFile() && !entry.isSymbolicLink()) actual.add(name);
        else throw new Error('Unsafe partition transport member.');
      }
    }
    await inventory('');
    if (actual.size !== expected.size || [...actual].some((p) => !expected.has(p)))
      throw new Error('Partition payload membership mismatch.');
  }
  for (const entry of descriptor.files) {
    if (integrity === 'verified') await hashGuardedFile(root, entry.payloadPath, entry);
    else {
      await verifyParents(root, path.posix.dirname(entry.payloadPath));
      const stat = await regularStat(guardedPath(root, entry.payloadPath));
      if (!stat || stat.size !== entry.size) throw new Error('Base payload size mismatch.');
    }
  }
  return descriptor;
}
export async function installPartitionObject(
  model: CacheModel,
  root: string,
  descriptor: PartitionDescriptor,
  integrity: PayloadIntegrity = 'verified',
): Promise<void> {
  if (descriptor.kind === 'single-writer') {
    const relative = `${PARTITION_SNAPSHOT_DIRECTORY}/${descriptor.identity.partitionId}`;
    const files = descriptor.files.map((e) => ({
      ...e,
      payloadPath: e.payloadPath.slice(relative.length + 1),
    }));
    await writeMetadata(
      root,
      relative + '/snapshot.json',
      { schemaVersion: 1, partitionId: descriptor.identity.partitionId, files },
      PARTITION_STORAGE_LIMITS.bytes,
    );
    // Reuse existing guarded snapshot validation before replacing its local transport tree.
    const staged = await readPartitionSnapshot(
      { ...model, cacheRoot: root },
      descriptor.identity.partitionId,
      integrity,
    );
    if (!staged) throw new Error('Restored snapshot transport disappeared.');
    await readPartitionSnapshot(model, descriptor.identity.partitionId, integrity);
    const target = path.dirname(
      await metadataPath(model.cacheRoot, relative + '/snapshot.json', true),
    );
    await verifyParents(model.cacheRoot, relative);
    await rm(target, { recursive: true });
    await rename(path.join(root, relative), target);
    return;
  }
  if (descriptor.kind === 'workspace') {
    const byPath = new Map(descriptor.files.map((e) => [e.relativePath, e]));
    await applyWorkspaces(
      descriptor.workspaces.map((workspace) => ({
        partitionId: descriptor.identity.partitionId,
        workspace,
        entries: workspace.files.map((name) => byPath.get(name)!),
        rootDirectory: root,
      })),
      model,
      true,
      integrity,
    );
  }
  const workspaceFiles = new Set(descriptor.workspaces.flatMap((w) => w.files));
  const destinations = new DirectoryValidationBatch(model.cacheRoot);
  const sources = new DirectoryValidationBatch(root);
  for (const entry of descriptor.files.filter((e) => !workspaceFiles.has(e.relativePath))) {
    const parent = path.posix.dirname(entry.relativePath);
    await verifyParents(model.cacheRoot, parent, true, destinations);
    const target = guardedPath(model.cacheRoot, entry.relativePath);
    await regularStat(target);
    const moved = await moveGuardedFile(
      root,
      entry.payloadPath,
      target,
      entry,
      model.cacheRoot,
      integrity,
      sources,
    );
    await repairCacheFileMetadata(target, moved.identity, {
      mode: portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
      mtimeMs: entry.mtimeMs,
    });
  }
}

/** Only the freshly validated extraction plan can select the trusted-base native path. */
export async function installBasePartitionPlan(
  model: CacheModel,
  plan: BasePartitionInstallPlan,
): Promise<void> {
  assertBaseInstallPlan(plan, model);
  if (plan.descriptor.kind === 'single-writer') {
    await installBaseSnapshot(plan, model);
    return;
  }
  await applyBaseWorkspaces(plan, model);
  const destinations = new DirectoryValidationBatch(model.cacheRoot);
  const sources = new DirectoryValidationBatch(plan.rootDirectory);
  for (const entry of plan.ordinaryFiles) {
    await destinations.verify(path.posix.dirname(entry.relativePath), true);
    const target = guardedPath(model.cacheRoot, entry.relativePath);
    await regularStat(target);
    const source = await regularStat(guardedPath(plan.rootDirectory, entry.payloadPath));
    const identity = plan.inventory.files.get(entry.payloadPath)!;
    if (!source || !sameFileIdentity(identity, fileIdentity(source), true))
      throw new Error('Base source changed after inventory.');
    const moved = await moveGuardedFile(
      plan.rootDirectory,
      entry.payloadPath,
      target,
      entry,
      model.cacheRoot,
      'trusted-base',
      sources,
    );
    await repairCacheFileMetadata(target, moved.identity, {
      mode: portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
      mtimeMs: entry.mtimeMs,
    });
  }
}
