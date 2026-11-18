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
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CacheModel } from './model';
import { guardedPath, verifyParents } from './guarded-files';
import { isCacheMetadataPath } from './metadata-paths';
import { isMissingPathError } from '../util/fs';

export const MAVEN_TRANSIENT_CACHE_EXCLUDE_GLOBS: readonly string[] = [
  '**/*.lastUpdated',
  '**/resolver-status.properties',
  '**/*.lock',
];
export function isMavenTransientFile(name: string): boolean {
  return (
    name.endsWith('.lastUpdated') || name.endsWith('.lock') || name === 'resolver-status.properties'
  );
}

/** Excluded artifacts still belong to Maven's directory view; only check state is disposable. */
export async function assertCompleteMavenRepositoryDirectories(
  model: CacheModel,
  paths: Iterable<string>,
): Promise<void> {
  if (model.buildToolId !== 'maven') return;
  const selected = new Set(paths);
  const directories = new Set(
    [...selected]
      .filter((name) => name.startsWith('repository/'))
      .map((name) => path.posix.dirname(name)),
  );
  for (const directory of directories) {
    await verifyParents(model.cacheRoot, directory);
    const entries = await readdir(guardedPath(model.cacheRoot, directory), {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory() || isCacheMetadataPath(name) || isMavenTransientFile(entry.name))
        continue;
      if (!selected.has(name))
        throw new Error(
          `Incomplete Maven repository directory: ${directory}. Excluded or missing sibling ${name} would be separated from its origin marker; exclude whole directories and use one writer per changed directory.`,
        );
    }
  }
}
