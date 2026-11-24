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

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import { memoryArtifacts } from './memory-artifact-fixture';
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
const fixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const f = await metadataFixture();
  fixtures.push(f);
  return f;
}
it('installs v2 base projections through actual prepare while preserving exclusions and an authoritative empty snapshot', async () => {
  const f = await fixture(),
    seeded = await f.seed({ data: { 'data/base': 'remote' } });
  await f.files(f.root, { 'data/local.lock': 'protected', 'state/local.lock': 'protected' });
  const ready = await f.prepare();
  expect(ready.restoreStatus).toBe('current-lineage-hit');
  expect(await readFile(f.root + '/data/base', 'utf8')).toBe('remote');
  expect(await readFile(f.root + '/data/local.lock', 'utf8')).toBe('protected');
  expect(await readFile(f.root + '/state/local.lock', 'utf8')).toBe('protected');
  const state = ready.store.codec.schemas.documents['local-state'].parse(await ready.store.state());
  expect(state).toHaveLength(8);
  expect(state[4]).toBe('build-ready');
  const handoff = await LifecycleHandoff.read(ready.store, state[6]!, { budget: f.budget });
  try {
    expect(handoff.entries[0][3]![7]).toEqual(
      seeded.entries[0][0] === 'object' ? seeded.entries[0][2] : null,
    );
    const pin = handoff.entries[0][3];
    expect(pin?.[0] === 'pinned-partition-metadata' && pin[9][3]).toBe(1); // pin describes remote payload without local excluded files
    expect(handoff.entries[1][2]).toBe('empty');
  } finally {
    handoff.close();
  }
  expect(ready.store.root.work.bodyHashCalls).toBe(0);
});
it.each([false, true])(
  'retains actual independent optional baseline snapshot bytes after installation (empty=%s)',
  async (empty) => {
    const f = await fixture(),
      seeded = await f.seed({
        data: { 'data/a': 'base' },
        state: empty ? {} : { 'state/value': 'baseline' },
      });
    const context = [...f.request.context] as typeof f.request.context;
    context[4] = 'collector';
    const artifacts = memoryArtifacts();
    const ready = await f.prepare({
        context,
        policy: { ...f.request.policy, role: 'distributed-aggregator' },
        artifactBackend: async () => artifacts.api,
      }),
      state = ready.store.codec.schemas.documents['local-state'].parse(await ready.store.state());
    const handoff = await LifecycleHandoff.read(ready.store, state[6]!, { budget: f.budget });
    try {
      const snapshot = handoff.entries[1][4];
      expect(snapshot).not.toBeNull();
      const entry = seeded.entries[1];
      if (entry[0] !== 'object' || !snapshot) throw new Error('fixture');
      expect(snapshot[4]).toEqual(['base', entry[2]]);
      if (empty) expect(await readdir(ready.store.root.resolve(snapshot[1]))).toEqual([]);
      else {
        await writeFile(f.root + '/state/value', 'later-live-value');
        expect(await readFile(ready.store.root.resolve(snapshot[1] + '/state/value'), 'utf8')).toBe(
          'baseline',
        );
        expect(await readFile(f.root + '/state/value', 'utf8')).toBe('later-live-value');
      }
      expect(ready.store.root.work.bodyHashBytes).toBe(0);
    } finally {
      handoff.close();
    }
  },
);
it('keeps an unavailable connected Maven group cold while an independent available group installs', async () => {
  const { resolveModel } = await import('../../../src/cache/streaming/model');
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['a', ['repository/**/a'], hard, 'aggregate', null, 'default'],
          ['b', ['repository/**/b'], hard, 'aggregate', null, 'default'],
          ['c', ['repository/**/c'], hard, 'aggregate', null, 'default'],
        ],
      ],
      'cold-incoming-',
      1,
    );
  const f = await metadataFixture(model);
  fixtures.push(f);
  const seeded = await f.seed(
    {
      a: { 'repository/shared/a': 'A' },
      b: { 'repository/shared/b': 'B' },
      c: { 'repository/independent/c': 'C' },
    },
    [['a', 'b'], ['c']],
  );
  const unavailable = seeded.entries[1];
  if (unavailable[0] !== 'object') throw new Error('fixture');
  f.objects.delete(unavailable[2][2]);
  const ready = await f.prepare();
  expect(ready.restoreStatus).toBe('current-lineage-partial-hit');
  await expect(readFile(f.root + '/repository/shared/a')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(f.root + '/repository/independent/c', 'utf8')).toBe('C');
});
