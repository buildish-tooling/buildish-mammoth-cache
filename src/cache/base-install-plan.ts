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
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { CacheModel } from './model';
import { readMetadata } from './metadata-io';
import {
  partitionObjectRoot,
  PARTITION_STORAGE_LIMITS,
  validatePartitionDescriptor,
  type PartitionDescriptor,
  type PartitionReference,
} from './partition-format';
import {
  inventoryInstallTree,
  freezeInstallMetadata,
  type InstallInventory,
} from './install-inventory';
import { DirectoryValidationBatch, guardedPath } from './guarded-files';
import { workspaceRoot } from './immutable-workspaces';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';

export interface BasePartitionInstallPlan {
  readonly rootDirectory: string;
  readonly descriptor: PartitionDescriptor;
  readonly inventory: InstallInventory;
  readonly ordinaryFiles: PartitionDescriptor['files'];
  readonly workspaceDirectories: ReadonlyMap<string, ReadonlyMap<string, FileIdentity>>;
  readonly sharedDirectories: ReadonlyMap<string, FileIdentity>;
}
const plans = new WeakMap<BasePartitionInstallPlan, CacheModel>();
export function assertBaseInstallPlan(plan: BasePartitionInstallPlan, model: CacheModel): void {
  if (plans.get(plan) !== model) throw new Error('Invalid base installation plan/model.');
}
/** Newly downloaded metadata is validated once; filesystem evidence is operation-local. */
export async function readBasePartitionPlan(
  model: CacheModel,
  rootDirectory: string,
  reference: PartitionReference,
): Promise<BasePartitionInstallPlan> {
  const relative = partitionObjectRoot(reference.identity.partitionId) + '/object.json';
  const raw = await readMetadata(rootDirectory, relative, PARTITION_STORAGE_LIMITS.bytes);
  if (raw === null) throw new Error('Restored partition descriptor is missing.');
  const descriptor = freezeInstallMetadata(
    validatePartitionDescriptor(model, JSON.parse(raw), reference),
  );
  const inventory = await inventoryInstallTree(rootDirectory, PARTITION_STORAGE_LIMITS.records);
  const expected = new Set([relative, ...descriptor.files.map((e) => e.payloadPath)]);
  if (
    inventory.files.size !== expected.size ||
    [...inventory.files.keys()].some((name) => !expected.has(name))
  )
    throw new Error('Partition payload membership mismatch.');
  for (const entry of descriptor.files) {
    if (inventory.files.get(entry.payloadPath)?.size !== entry.size)
      throw new Error('Base payload size mismatch.');
  }
  const workspaceDirectories = new Map(
    descriptor.workspaces.map((workspace) => [workspace.root, new Map<string, FileIdentity>()]),
  );
  const sharedDirectories = new Map<string, FileIdentity>();
  const indexDirectory = (name: string, identity: FileIdentity) => {
    const root = workspaceRoot(name);
    (root ? (workspaceDirectories.get(root) ?? sharedDirectories) : sharedDirectories).set(
      name,
      identity,
    );
  };
  // Do not bless unrelated topology changes while refreshing ancestors for our mkdirs.
  for (const [name, identity] of inventory.directories) {
    indexDirectory(name, identity);
    const current = await lstat(name ? guardedPath(rootDirectory, name) : rootDirectory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(identity, fileIdentity(current), true)
    )
      throw new Error('Base source directory changed after inventory.');
  }
  const directories = new DirectoryValidationBatch(rootDirectory);
  const workspaceFiles = new Set<string>();
  for (const workspace of descriptor.workspaces) {
    const allowed = new Set([workspace.root]);
    const emptyDirectories = new Set(workspace.emptyDirectories);
    for (const name of [...workspace.files, ...workspace.emptyDirectories]) {
      let parent = emptyDirectories.has(name) ? name : path.posix.dirname(name);
      while (parent === workspace.root || parent.startsWith(workspace.root + '/')) {
        allowed.add(parent);
        if (parent === workspace.root) break;
        parent = path.posix.dirname(parent);
      }
    }
    for (const name of workspaceDirectories.get(workspace.root)!.keys())
      if (!allowed.has(name)) throw new Error('Unexpected workspace directory.');
    for (const directory of workspace.emptyDirectories) {
      await directories.verify(directory, true);
      let current = directory;
      while (current !== '.') {
        const identity = fileIdentity(await lstat(guardedPath(rootDirectory, current)));
        inventory.directories.set(current, identity);
        indexDirectory(current, identity);
        current = path.posix.dirname(current);
      }
    }
    for (const name of workspace.files) workspaceFiles.add(name);
  }
  const plan = Object.freeze({
    rootDirectory,
    descriptor,
    inventory,
    workspaceDirectories,
    sharedDirectories,
    ordinaryFiles: descriptor.files.filter((e) => !workspaceFiles.has(e.relativePath)),
  });
  plans.set(plan, model);
  return plan;
}
