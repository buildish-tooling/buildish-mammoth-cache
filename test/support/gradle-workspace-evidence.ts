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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import type { CacheModel } from '../../src/cache/model';

/** Evidence expires after any build, restore, removal or finalize mutates this home. */
export async function captureWorkspaceEvidence(model: CacheModel) {
  const snapshot = await captureCacheMetadataSnapshot(model);
  const archivePaths = snapshot.partitions
    .flatMap((p) => p.entries)
    .map((e) => e.relativePath)
    .filter((name) => /^caches\/build-cache-[0-9]+\/[a-f0-9]{32}$/u.test(name));
  const paths = new Set([
    ...(snapshot.workspaces ?? []).flatMap((u) => u.workspace.files),
    ...archivePaths,
  ]);
  const hashes = new Map(
    await Promise.all(
      [...paths].map(
        async (name) =>
          [
            name,
            createHash('sha256')
              .update(await readFile(path.join(model.cacheRoot, name)))
              .digest('hex'),
          ] as const,
      ),
    ),
  );
  return {
    snapshot,
    units: new Map(
      (snapshot.workspaces ?? []).map(
        (u) =>
          [
            u.workspace.root,
            {
              workspace: u.workspace,
              hashes: u.workspace.files.map((name) => [name, hashes.get(name)!] as const),
            },
          ] as const,
      ),
    ),
    archives: new Map(archivePaths.map((name) => [name, hashes.get(name)!] as const)),
  };
}
