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
import os from 'node:os';
import path from 'node:path';
import * as glob from '@actions/glob';
import { cutoffJob } from '../support/cutoff-job';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { createBaseCachePaths } from '../../src/cache/service';
import { cutoffFixtureModel } from '../support/cutoff-fixture';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';
const roots: string[] = [];
async function root() {
  const r = await mkdtemp(path.join(os.tmpdir(), 'cutoff-archive-'));
  roots.push(r);
  return r;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function selected(patterns: readonly string[]) {
  return (
    await glob.create(patterns.join('\n'), {
      followSymbolicLinks: false,
      implicitDescendants: false,
    })
  ).glob();
}
it('actual cache glob + GNU tar exclude root/nested journals and all directory recursion, include only sentinel exception', async () => {
  const r = await root(),
    home = path.join(r, 'cache');
  const files = [
    'data/a',
    'data/.mammoth/write.tmp',
    'data/.MAMMOTH./x',
    '.mammoth/cutoff-state-v1/current.json',
    '.mammoth/empty-generation-v1',
  ];
  for (const f of files) {
    await mkdir(path.dirname(path.join(home, f)), { recursive: true });
    await writeFile(path.join(home, f), 'x');
  }
  const model = cutoffFixtureModel(home);
  const patterns = createBaseCachePaths(model);
  const found = await selected(patterns);
  expect(found.map((f) => path.relative(home, f)).sort()).toEqual([
    '.mammoth/empty-generation-v1',
    'data/a',
  ]);
  const archive = await packCacheFiles(
    home,
    found.map((f) => path.relative(home, f)),
    path.join(r, 'archive'),
  );
  const fresh = path.join(r, 'fresh');
  await unpackCacheFiles(fresh, archive);
  expect(await readFile(path.join(fresh, 'data/a'), 'utf8')).toBe('x');
  await expect(readFile(path.join(fresh, 'data/.mammoth/write.tmp'))).rejects.toThrow();
  await expect(
    readFile(path.join(fresh, '.mammoth/cutoff-state-v1/current.json')),
  ).rejects.toThrow();
});
it('publishes an empty generation after GC with identical restore/save paths and restores it instead of old data', async () => {
  const r = await root(),
    generations: { key: string; archive: string; paths: string[] }[] = [];
  const home = path.join(r, 'cache');
  const backend: BaseCacheBackend = {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable: () => true,
    isMissingPathsError: () => false,
    restoreCache: async (paths, primary) => {
      const hit = [...generations].reverse().find((g) => g.key.startsWith(primary));
      if (!hit) return undefined;
      expect(paths).toEqual(hit.paths);
      await unpackCacheFiles(home, hit.archive);
      return hit.key;
    },
    saveCache: async (paths, key) => {
      const found = await selected(paths);
      expect(found.length).toBeGreaterThan(0);
      const archive = await packCacheFiles(
        home,
        found.map((f) => path.relative(home, f)),
        path.join(r, 'archives', String(generations.length)),
      );
      generations.push({ key, archive, paths: [...paths] });
      return generations.length;
    },
  };
  const seed = await cutoffJob(r, { cacheBackend: backend, inputs: { 'cache-gc-mode': 'off' } });
  await seed.prepare();
  await mkdir(path.join(home, 'data'));
  await writeFile(path.join(home, 'data/old'), 'old');
  await executeFinalizeAction(seed.deps);
  expect(generations).toHaveLength(1);
  await utimes(path.join(home, 'data/old'), 1700000000, 1700000000);
  const gc = await cutoffJob(r, { cacheBackend: backend });
  gc.deps.now = () => Date.now() + 10000;
  await gc.prepare();
  // Tar extraction may restore recent original mtime; make the frozen age fixture deterministic.
  await utimes(path.join(home, 'data/old'), 1700000000, 1700000000);
  const collected = await executeFinalizeAction(gc.deps);
  expect(collected.cacheGcResult?.deletedFileCount).toBe(1);
  expect(generations).toHaveLength(2);
  expect(generations[0]!.paths).toEqual(generations[1]!.paths);
  await rm(home, { recursive: true });
  const fresh = await cutoffJob(r, { cacheBackend: backend });
  const prepared = await fresh.prepare();
  expect(prepared.bootstrap.baseCacheResult?.status).toBe('current-lineage-hit');
  await expect(readFile(path.join(home, 'data/old'))).rejects.toThrow();
  expect(await readFile(path.join(home, '.mammoth/empty-generation-v1'), 'utf8')).toContain(
    'mammoth-empty-v1',
  );
  expect((await executeFinalizeAction(fresh.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
});
