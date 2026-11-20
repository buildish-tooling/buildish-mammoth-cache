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
import { mkdir, mkdtemp, writeFile, lstat, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { groovyFixtureModel } from '../support/groovy-cache';
import { recoverWorkspaceScratch } from '../../src/cache/workspace-apply';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([false, true])(
  'reclaims fresh abandoned staging without an intent, complete=%s',
  async (complete) => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/workspace-scratch-'));
    roots.push(root);
    const parent = 'caches/9.8.1/groovy-dsl/.mammoth';
    const stage = parent + '/stage-12345678-1234-1234-1234-123456789abc';
    await mkdir(path.join(root, stage, 'classes'), { recursive: true });
    await writeFile(path.join(root, stage, complete ? 'metadata.bin' : 'partial'), 'bytes');
    await writeFile(path.join(root, parent, 'keep'), 'keep');
    // Represents process death: no original apply finally/intent exists.
    await recoverWorkspaceScratch(await groovyFixtureModel(root));
    await expect(lstat(path.join(root, stage))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, parent, 'keep'), 'utf8')).toBe('keep');
  },
);
it('rejects linked abandoned staging and preserves the external target', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/workspace-scratch-'));
  roots.push(root);
  const parent = 'caches/9.8.1/groovy-dsl/.mammoth';
  await mkdir(path.join(root, parent), { recursive: true });
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'keep');
  await symlink(
    outside,
    path.join(root, parent, 'stage-12345678-1234-1234-1234-123456789abc'),
    'dir',
  );
  await expect(recoverWorkspaceScratch(await groovyFixtureModel(root))).rejects.toThrow(
    /link|Unsafe/,
  );
  expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
});

it('preserves ordinary files directly under caches during scratch discovery', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/workspace-scratch-'));
  roots.push(root);
  await mkdir(path.join(root, 'caches'));
  await writeFile(path.join(root, 'caches/CACHEDIR.TAG'), 'unmanaged');
  await recoverWorkspaceScratch(await groovyFixtureModel(root));
  expect(await readFile(path.join(root, 'caches/CACHEDIR.TAG'), 'utf8')).toBe('unmanaged');
});

it('rejects a regular file in the reserved directory-stage namespace', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/workspace-scratch-'));
  roots.push(root);
  const parent = 'caches/9.8.1/groovy-dsl/.mammoth';
  await mkdir(path.join(root, parent), { recursive: true });
  const file = path.join(root, parent, 'stage-12345678-1234-1234-1234-123456789abc');
  await writeFile(file, 'keep unexpected file');
  await expect(recoverWorkspaceScratch(await groovyFixtureModel(root))).rejects.toThrow(
    /Unsafe workspace scratch/,
  );
  expect(await readFile(file, 'utf8')).toBe('keep unexpected file');
});
