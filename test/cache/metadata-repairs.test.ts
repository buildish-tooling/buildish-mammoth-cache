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
import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile, lstat, chmod, utimes, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { repairCacheFileMetadata, portableCacheFileMode } from '../../src/cache/file-permissions';
import { fileIdentity } from '../../src/cache/file-identity';
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('repairs only differing mode=%s/mtime=%s without a stat pass', async (modeDiff, timeDiff) => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/metadata-repairs-'));
  roots.push(root);
  const target = path.join(root, 'file');
  await writeFile(target, 'payload');
  await chmod(target, 0o644);
  await utimes(target, 1700000000, 1700000000);
  const before = fileIdentity(await lstat(target));
  const mode = vi.spyOn(fs, 'chmod'),
    times = vi.spyOn(fs, 'utimes'),
    stats = vi.spyOn(fs, 'lstat');
  const desired = {
    mode: modeDiff ? 0o755 : 0o644,
    mtimeMs: timeDiff ? 1700000001000 : 1700000000000,
  };
  expect(await repairCacheFileMetadata(target, before, desired)).toBe(modeDiff || timeDiff);
  expect(mode).toHaveBeenCalledTimes(modeDiff ? 1 : 0);
  expect(times).toHaveBeenCalledTimes(timeDiff ? 1 : 0);
  expect(stats).not.toHaveBeenCalled();
  const actual = await lstat(target);
  if (process.platform !== 'win32') expect(actual.mode & 0o777).toBe(desired.mode);
  expect(Math.trunc(actual.mtimeMs)).toBe(desired.mtimeMs);
});
it('retains portable distribution launcher executable repair', () => {
  expect(
    portableCacheFileMode(
      0o644,
      'gradle',
      'wrapper/dists/gradle-9.8.1-all/key/gradle-9.8.1/bin/gradle',
    ),
  ).toBe(0o755);
  expect(
    portableCacheFileMode(
      0o644,
      'maven',
      'wrapper/dists/apache-maven-3.9.12/key/apache-maven-3.9.12/bin/mvn',
    ),
  ).toBe(0o755);
});

it.skipIf(process.platform === 'win32')(
  'clears special permission bits even when ordinary mode bits match',
  async () => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/metadata-special-'));
    roots.push(root);
    const target = path.join(root, 'file');
    await writeFile(target, 'payload');
    await chmod(target, 0o4644);
    const before = fileIdentity(await lstat(target));
    const mode = vi.spyOn(fs, 'chmod');
    await repairCacheFileMetadata(target, before, { mode: 0o644, mtimeMs: before.mtimeMs });
    expect(mode).toHaveBeenCalledTimes(1);
    expect((await lstat(target)).mode & 0o7777).toBe(0o644);
  },
);
