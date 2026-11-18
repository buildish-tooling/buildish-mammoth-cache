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

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cutoffJob } from '../support/cutoff-job';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('restores generation 1, publishes changed generation 2 and selects its exact record', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/generations-'));
  roots.push(root);
  const backend = new ImmutableCacheBackend(path.join(root, 'archives'));
  const one = await cutoffJob(path.join(root, 'one'), { cacheBackend: backend });
  await one.prepare();
  await mkdir(path.join(one.home, 'data'));
  await writeFile(path.join(one.home, 'data/file'), 'first');
  const saved1 = (await executeFinalizeAction(one.deps)).bootstrap.baseCacheResult;
  const two = await cutoffJob(path.join(root, 'two'), { cacheBackend: backend });
  const restore2 = (await two.prepare()).bootstrap.baseCacheResult;
  expect(restore2?.operation === 'restore' ? restore2.matchedKey : null).toBe(
    saved1?.operation === 'save' ? saved1.generationKey : null,
  );
  await writeFile(path.join(two.home, 'data/file'), 'second');
  const saved2 = (await executeFinalizeAction(two.deps)).bootstrap.baseCacheResult;
  const three = await cutoffJob(path.join(root, 'three'), { cacheBackend: backend });
  const restore3 = (await three.prepare()).bootstrap.baseCacheResult;
  expect(restore3?.operation === 'restore' ? restore3.matchedKey : null).toBe(
    saved2?.operation === 'save' ? saved2.generationKey : null,
  );
  expect(backend.savedKeys).toHaveLength(4);
});
it('rejects attempts to overwrite immutable backend entries', async () => {
  const backend = new ImmutableCacheBackend();
  await backend.saveCache([], 'immutable');
  await expect(backend.saveCache([], 'immutable')).rejects.toThrow(/already exists/);
});
