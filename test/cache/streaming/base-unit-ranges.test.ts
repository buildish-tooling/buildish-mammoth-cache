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

import { appendFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { baseFixture, cleanupBaseFixtures } from './base-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { BaseSourceTree } from '../../../src/cache/streaming/base-source-tree';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { summarizeNativeTree } from '../../../src/cache/streaming/native-tree';
const builders: BaseSourceTree[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of builders.splice(0)) {
    await b.disposeUnit();
    await b.events.dispose();
    expect(b.options.budget.retained).toBe(0);
  }
  await cleanupBaseFixtures();
});
async function fixture(count: number) {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [['data', ['repository/**'], hard, 'aggregate', null, 'default']],
      ],
      'ranges-',
      1,
    ),
    f = await baseFixture(model),
    paths: string[] = [],
    create = InstallScratch.create;
  vi.spyOn(InstallScratch, 'create').mockImplementation(async (...args) => {
    const scratch = await create(...args);
    paths.push(scratch.path);
    return scratch;
  });
  const b = await BaseSourceTree.create(f.store, 'data', { budget: f.budget }),
    signal = new AbortController().signal;
  builders.push(b);
  for (const path of ['', 'repository', 'repository/g', 'repository/g/a'])
    await b.open(path, signal);
  for (let i = 0; i < count; i++) {
    const path = 'repository/g/a/' + String(i).padStart(3, '0');
    await b.open(path, signal);
    await b.file(
      path + '/a.jar',
      0,
      0o644,
      1234,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      signal,
    );
    await b.close(path, signal);
  }
  for (const path of ['repository/g/a', 'repository/g', 'repository', ''])
    await b.close(path, signal);
  return { ...f, b, paths, signal };
}
it.each([4, 16])(
  'uses two scratch files in total for %i complete Maven coordinate units',
  async (count) => {
    const f = await fixture(count);
    await f.b.seal(f.signal);
    expect(f.paths).toHaveLength(2); // events plus one range stream, independent of coordinate count
    const s = await summarizeNativeTree(
      f.b.events.rows(f.signal),
      { model: f.model, partition: 'data', budget: f.budget },
      f.signal,
    );
    expect(s.counts[0]).toBe(count);
    expect(s.counts[2]).toBe(count);
    expect(f.store.root.work.nativeWalks).toBe(0);
  },
);
it('rejects changed range backing bytes before granting completed events', async () => {
  const f = await fixture(4);
  await appendFile(f.store.root.resolve(f.paths[1]), 'unexpected');
  await expect(f.b.seal(f.signal)).rejects.toThrow(/scratch/i);
});
