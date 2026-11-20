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
import { guardedPath, verifyParents } from './guarded-files';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';

export interface InstallInventory {
  files: Map<string, FileIdentity>;
  directories: Map<string, FileIdentity>;
}
/** One bounded, no-follow extraction traversal collects membership and native metadata. */
export async function inventoryInstallTree(
  root: string,
  limit = 200_000,
): Promise<InstallInventory> {
  await verifyParents(root, '');
  const files = new Map<string, FileIdentity>(),
    directories = new Map<string, FileIdentity>();
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 100 || files.size + directories.size > limit)
      throw new Error('Installation tree exceeds resource bounds.');
    const name = relative ? guardedPath(root, relative) : path.resolve(root);
    const stat = await lstat(name);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error('Unsafe installation tree member.');
    const identity = fileIdentity(stat);
    if (stat.isFile()) {
      files.set(relative, identity);
      return;
    }
    directories.set(relative, identity);
    for (const child of await readdir(name))
      await visit(relative ? relative + '/' + child : child, depth + 1);
    if (!sameFileIdentity(identity, fileIdentity(await lstat(name)), true))
      throw new Error('Installation tree changed during inventory.');
  }
  await visit('', 0);
  return { files, directories };
}
export function freezeInstallMetadata<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeInstallMetadata(child);
    Object.freeze(value);
  }
  return value;
}
