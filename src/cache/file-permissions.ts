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

import { chmod, utimes, glob } from 'node:fs/promises';
import path from 'node:path';
import { guardedPath, verifyParents, regularStat } from './guarded-files';
import { createManagedCachePathMatcher } from './manifest';
import type { FileIdentity } from './file-identity';
import { canonicalTimestampMs } from '../util/timestamps';
import type { CacheModel } from './model';

/** Cache data needs ordinary read/write access; retain any executable bits supplied by producers. */
export function portableCacheFileMode(
  mode: number,
  buildToolId?: string,
  relativePath?: string,
): number {
  if (relativePath && isDistributionLauncher(buildToolId, relativePath)) return 0o755;
  return 0o644 | (mode & 0o111);
}

/** Reuse native metadata already required for correctness; never stat merely to avoid a write. */
export async function repairCacheFileMetadata(
  target: string,
  current: FileIdentity,
  desired: { mode: number; mtimeMs: number },
): Promise<boolean> {
  let changed = false;
  if ((current.mode & 0o7777) !== desired.mode) {
    await chmod(target, desired.mode);
    changed = true;
  }
  if (canonicalTimestampMs(current.mtimeMs) !== canonicalTimestampMs(desired.mtimeMs)) {
    await utimes(target, new Date(desired.mtimeMs), new Date(desired.mtimeMs));
    changed = true;
  }
  return changed;
}

function isDistributionLauncher(buildToolId: string | undefined, relative: string): boolean {
  return buildToolId === 'gradle'
    ? /^wrapper\/dists\/[^/]+\/[^/]+\/gradle-[^/]+\/bin\/gradle$/u.test(relative)
    : buildToolId === 'maven' &&
        /^wrapper\/dists\/[^/]+\/[^/]+\/(?:apache-maven-[^/]+\/)?bin\/(?:mvn|mvnDebug|mvnyjp)$/u.test(
          relative,
        );
}

/** Windows archives may not carry executable bits for POSIX distribution launchers. */
export async function restoreDistributionLauncherPermissions(model: CacheModel): Promise<void> {
  if (process.platform === 'win32' || !['gradle', 'maven'].includes(model.buildToolId)) return;
  const owns = createManagedCachePathMatcher(model);
  const pattern =
    model.buildToolId === 'gradle'
      ? 'wrapper/dists/*/*/gradle-*/bin/gradle'
      : 'wrapper/dists/*/*/**/bin/{mvn,mvnDebug,mvnyjp}';
  for await (const name of glob(pattern, { cwd: model.cacheRoot })) {
    const relative = name.split(path.sep).join('/');
    if (
      !isDistributionLauncher(model.buildToolId, relative) ||
      !model.partitions.some((p) => owns(p.id, relative))
    )
      continue;
    await verifyParents(model.cacheRoot, path.posix.dirname(relative));
    const target = guardedPath(model.cacheRoot, relative);
    const current = await regularStat(target);
    if (current && (current.mode & 0o7777) !== 0o755) await chmod(target, 0o755);
  }
}
