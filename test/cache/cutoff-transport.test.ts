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

import { it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { cutoffJob } from '../support/cutoff-job';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { GENERATION_RECORD_PATH } from '../../src/cache/partition-format';
const roots: string[] = [];
async function root() {
  await mkdir('build', { recursive: true });
  const r = await mkdtemp(path.resolve('build/cutoff-archive-'));
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
it('real partition archives exclude root/nested journals, metadata aliases and excluded files', async () => {
  const r = await root(),
    backend = new ImmutableCacheBackend(path.join(r, 'archives'));
  const seed = await cutoffJob(path.join(r, 'seed'), { cacheBackend: backend });
  await seed.prepare();
  for (const name of [
    'data/a',
    'data/x.lock',
    'data/.mammoth/write.tmp',
    'data/.MAMMOTH./x',
    '.mammoth/private.json',
  ]) {
    await mkdir(path.dirname(path.join(seed.home, name)), { recursive: true });
    await writeFile(path.join(seed.home, name), 'x');
  }
  await executeFinalizeAction(seed.deps);
  expect(backend.savedKeys).toHaveLength(2);
  const bytes = backend.entries.map((e) => e.files.map((f) => f.name).join(' ')).join(' ');
  expect(bytes).not.toContain('private.json');
  expect(bytes).not.toContain('write.tmp');
  expect(bytes).not.toContain('x.lock');
  const fresh = await cutoffJob(path.join(r, 'fresh'), { cacheBackend: backend });
  await fresh.prepare();
  expect(await readFile(path.join(fresh.home, 'data/a'), 'utf8')).toBe('x');
  await expect(readFile(path.join(fresh.home, 'data/.mammoth/write.tmp'))).rejects.toThrow();
  await expect(readFile(path.join(fresh.home, 'data/x.lock'))).rejects.toThrow();
});
it('publishes record-only emptiness after GC and restores it without older payload fallback', async () => {
  const r = await root(),
    backend = new ImmutableCacheBackend(path.join(r, 'archives'));
  const seed = await cutoffJob(path.join(r, 'seed'), {
    cacheBackend: backend,
    inputs: { 'cache-gc-mode': 'off' },
  });
  await seed.prepare();
  await mkdir(path.join(seed.home, 'data'));
  await writeFile(path.join(seed.home, 'data/old'), 'old');
  await executeFinalizeAction(seed.deps);
  const gc = await cutoffJob(path.join(r, 'gc'), { cacheBackend: backend });
  gc.deps.now = () => Date.now() + 10000;
  await gc.prepare();
  await utimes(path.join(gc.home, 'data/old'), 1700000000, 1700000000);
  const result = await executeFinalizeAction(gc.deps);
  expect(result.cacheGcResult?.deletedFileCount).toBe(1);
  expect(result.bootstrap.baseCacheResult?.status).toBe('saved');
  expect(backend.entries.at(-1)!.files.map((f) => f.name)).toEqual([GENERATION_RECORD_PATH]);
  const fresh = await cutoffJob(path.join(r, 'fresh'), { cacheBackend: backend });
  await fresh.prepare();
  await expect(readFile(path.join(fresh.home, 'data/old'))).rejects.toThrow();
  expect((await executeFinalizeAction(fresh.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
});
