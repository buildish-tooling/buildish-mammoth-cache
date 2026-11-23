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

import { afterEach, expect, it, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { mixedDirectoryFixture } from './mixed-directory-fixture';
import { installFixture } from './install-fixture';
import { freezeInstallPlan, assertFrozenInstall, type FrozenInstall } from './install-plan-fixture';
import { takeInstallIndexes } from '../../../src/cache/streaming/install-plan';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { InstallParents } from '../../../src/cache/streaming/install-parents';
import type { MetadataMemberReader } from '../../../src/cache/streaming/metadata-install-context';
import type { Value } from '../../../src/cache/streaming/encoding';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(shared = false) {
  const f = await installFixture('gradle', { shared });
  fixtures.push(f);
  return f;
}
async function read(
  plan: FrozenInstall,
  budget: Awaited<ReturnType<typeof installFixture>>['budget'],
) {
  const readers = new Set<MetadataMemberReader>(),
    rows: Value[] = [];
  let kind: 'file' | 'directory' = 'file';
  expect(await takeInstallIndexes(plan.store, plan)).toBeDefined();
  try {
    for await (const row of plan.store.rows(
      plan.plan,
      'install-plan',
      { budget, partition: null, installKind: () => kind },
      undefined,
      async (value) => {
        if (!Array.isArray(value) || value[0] !== 'install') return;
        const binding = (value[4] ?? value[5]) as Value;
        const reader = plan.metadata.reader(binding);
        readers.add(reader);
        const root = await reader.rootNode(binding, String(value[2]), null);
        kind = root[1] as 'file' | 'directory';
      },
    ))
      rows.push(row.value);
    return rows;
  } finally {
    for (const reader of readers) reader.close();
    await plan.metadata.dispose();
  }
}
it('freezes canonical mixed-owner cold-root units with disjoint empty parents and contiguous indices', async () => {
  const f = await mixedDirectoryFixture();
  fixtures.push(f);
  const plan = await freezeInstallPlan(f.store, f.inputs, f.budget),
    rows = await read(plan, f.budget);
  assertFrozenInstall(f.store, plan);
  const mutations = rows.filter(
    (r) => Array.isArray(r) && ['install', 'install-parent'].includes(String(r[0])),
  ) as Value[][];
  expect(mutations.map((r) => r[1])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const parents = mutations.filter((r) => r[0] === 'install-parent');
  expect(parents.map((r) => r[2])).toEqual(['data', 'data/sub']);
  for (const parent of parents)
    expect(await readdir(f.store.root.resolve(String(parent[3])))).toEqual([]);
  expect(String(parents[1][3]).startsWith(String(parents[0][3]) + '/')).toBe(false);
  expect(f.budget.retained).toBe(0);
});
it('reuses the original missing parent binding when snapshots follow aggregate units', async () => {
  const f = await fixture(true),
    inputs = [
      await f.incoming('state', { 'shared/state/a': 'a' }),
      await f.incoming('data', { 'shared/data/a': 'a' }),
    ];
  const plan = await freezeInstallPlan(f.store, inputs, f.budget),
    rows = await read(plan, f.budget);
  const parents = rows.filter((r) => Array.isArray(r) && r[0] === 'install-parent') as Value[][];
  expect(parents.filter((r) => r[2] === 'shared')).toHaveLength(1);
  const units = rows.filter((r) => Array.isArray(r) && r[0] === 'install-unit-open') as Value[][];
  expect(units.map((r) => r[1])).toEqual(['directory', 'snapshot']);
  expect(f.budget.retained).toBe(0);
});
it('binds the original current context and exact old/new selectors without installing payloads', async () => {
  const f = await fixture();
  await f.files('', { 'state/a/x': 'old', 'state/b': 'old', 'state/keep.lock': 'keep' });
  const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('state', { 'state/a': 'new', 'state/b/y': 'new' })],
      f.budget,
    ),
    rows = await read(plan, f.budget);
  expect(rows[1]).toEqual(['install-context', plan.metadata.nonce]);
  expect(
    rows.filter((r) => Array.isArray(r) && r[0] === 'install').map((r) => (r as Value[])[6]),
  ).toEqual(['replace', 'replace']);
  expect(await readFile(f.store.root.resolve('state/a/x'), 'utf8')).toBe('old');
  expect(f.budget.retained).toBe(0);
});
it('freezes an explicit already-empty snapshot with its zero-operation unit', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget),
    rows = await read(plan, f.budget);
  expect(rows.filter((r) => Array.isArray(r) && r[0] === 'install-unit-open')).toEqual([
    ['install-unit-open', 'snapshot', 'state', 'partition'],
  ]);
  expect(rows.some((r) => Array.isArray(r) && r[0] === 'install')).toBe(false);
  expect(f.budget.retained).toBe(0);
});
it('does not reconstruct a process-owned plan from serialized references', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(f.store, [], f.budget);
  expect(() => assertFrozenInstall(f.store, { ...plan })).toThrow('process-owned');
  expect(f.budget.retained).toBe(0);
});

it.each(['aggregate', 'parents'] as const)(
  'closes all acquired scratch handles when %s acquisition fails',
  async (failure) => {
    const f = await fixture(),
      input = await f.incoming('data', { 'data/a': 'a' }),
      original = InstallScratch.create.bind(InstallScratch),
      closed: ReturnType<typeof vi.spyOn>[] = [];
    let calls = 0;
    const creates = vi.spyOn(InstallScratch, 'create').mockImplementation(async (...args) => {
      if (++calls === 2 && failure === 'aggregate') throw new Error('acquire failed');
      const scratch = await original(...args);
      closed.push(vi.spyOn(scratch, 'close'));
      return scratch;
    });
    const parents =
      failure === 'parents'
        ? vi.spyOn(InstallParents, 'create').mockRejectedValueOnce(new Error('acquire failed'))
        : null;
    try {
      await expect(freezeInstallPlan(f.store, [input], f.budget)).rejects.toThrow('acquire failed');
      expect(closed.length).toBeGreaterThan(0);
      expect(closed.every((c) => c.mock.calls.length >= 1)).toBe(true);
    } finally {
      creates.mockRestore();
      parents?.mockRestore();
    }
    expect(f.budget.retained).toBe(0);
  },
);
it('releases previously gathered parent frames when a later ancestor read fails', async () => {
  const f = await fixture();
  await f.files('', { data: null });
  const input = await f.incoming('data', { 'data/sub/deep/a': 'a' }),
    record = InstallScratch.prototype.record;
  let ancestors = 0;
  const reads = vi.spyOn(InstallScratch.prototype, 'record').mockImplementation(async function (
    this: InstallScratch,
    at: number,
  ) {
    const lease = await record.call(this, at);
    if (Array.isArray(lease.value) && lease.value[0] === 'ancestor' && ++ancestors === 2) {
      lease.release();
      throw new Error('ancestor read failed');
    }
    return lease;
  });
  try {
    await expect(freezeInstallPlan(f.store, [input], f.budget)).rejects.toThrow(
      'ancestor read failed',
    );
  } finally {
    reads.mockRestore();
  }
  expect(f.budget.retained).toBe(0);
});
it('pins metadata offers before the first asynchronous admission work', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/a': 'new' }),
    originalRoot = input.nativeRoot,
    inputs = [input],
    create = InstallScratch.create.bind(InstallScratch);
  let once = false;
  vi.spyOn(InstallScratch, 'create').mockImplementation(async (...args) => {
    if (!once) {
      once = true;
      inputs.length = 0;
      input.nativeRoot = 'foreign';
      input.objectRoot = 'foreign';
    }
    return create(...args);
  });
  const plan = await freezeInstallPlan(f.store, inputs, f.budget);
  expect(plan.inputs.map((source) => [source.partition, source.nativeRoot])).toEqual([
    ['data', originalRoot],
  ]);
  await plan.metadata.dispose();
  expect(f.budget.retained).toBe(0);
});

it('bounds final merged directory breadth even when both separate inputs fit', async () => {
  const f = await fixture();
  await f.files('', { 'data/a': 'old', 'data/b': 'old' });
  const input = await f.incoming('data', { 'data/c': 'new', 'data/d': 'new' });
  await expect(
    freezeInstallPlan(f.store, [input], f.budget, { maxDirectoryEntries: 3 }),
  ).rejects.toThrow('during install selection at "data" (cache-max-directory-entries=3)');
  expect(f.budget.retained).toBe(0);
});
it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
  'rejects native name aliases across selected partition trees',
  async () => {
    const f = await installFixture('gradle', { upperSibling: true });
    fixtures.push(f);
    const inputs = [
      await f.incoming('data', { 'shared/lower/a': 'a' }),
      await f.incoming('state', { 'shared/LOWER/b': 'b' }),
    ];
    await expect(freezeInstallPlan(f.store, inputs, f.budget)).rejects.toThrow('path alias');
    expect(f.budget.retained).toBe(0);
  },
);
