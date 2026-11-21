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

import { symlink, utimes, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { tuple, type Value } from '../../../src/cache/streaming/encoding';
import { observationFixture } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(...args: Parameters<typeof observationFixture>) {
  const f = await observationFixture(...args);
  fixtures.push(f);
  return f;
}
async function old(f: Awaited<ReturnType<typeof fixture>>, path: string, body = 'x') {
  await f.files('', { [path]: body });
  await utimes(f.store.root.resolve(path), 1.234, 1.234);
}
it('captures once with complete protected projections, frozen decisions and no body read before pointer', async () => {
  const f = await fixture();
  await old(f, 'data/a');
  await old(f, 'data/b');
  await old(f, 'data/kept.lock');
  const hash = vi.spyOn(NativeReadPhase.prototype, 'hash'),
    read = vi.spyOn(NativeReadPhase.prototype, 'read'),
    before = await f.store.root.stat('data/a');
  const out = await captureObservations(f.store, { budget: f.budget }),
    values: Value[] = [];
  await f.store.readStream(
    out.reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      values.push(v);
    },
  );
  expect(out.work.listings).toBe(2);
  expect(hash).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(await f.store.root.stat('data/a')).toEqual(before);
  expect(await f.store.root.stat('data/b')).not.toBeNull();
  expect(values).toContainEqual([
    'child',
    'kept.lock',
    'file',
    expect.any(String),
    expect.any(String),
  ]);
  expect(values.filter((v) => tuple(v)[0] === 'file').map((v) => tuple(v).slice(1, 3))).toEqual([
    ['a', 'data'],
    ['b', 'data'],
  ]);
  expect(values.filter((v) => tuple(v)[0] === 'file').every((v) => tuple(v)[6] === 'delete')).toBe(
    true,
  );
  const state = tuple(await f.store.state());
  expect(state[4]).toBe('observations-frozen');
  expect(state[6]).toEqual(out.reference);
  expect(state[10]).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('promotes direct Maven siblings together while keeping nested coordinate decisions independent', async () => {
  const f = await fixture('maven', {}, [
    ['dir-open', ''],
    ['dir-open', 'repository'],
    ['dir-open', 'repository/g'],
    ['dir-open', 'repository/g/a'],
    ['dir-open', 'repository/g/a/1'],
    ['unit-open', 'maven-directory', 'repository/g/a/1', 'direct', 'used'],
    ['used', 'a.jar', 'data'],
    ['used', 'a.pom', 'data'],
    ['used', 'removed.pom', 'data'],
    ['unit-close', 'maven-directory', 'repository/g/a/1'],
    ['dir-close', 'repository/g/a/1'],
    ['dir-close', 'repository/g/a'],
    ['dir-close', 'repository/g'],
    ['dir-close', 'repository'],
    ['dir-close', ''],
  ]);
  for (const p of [
    'repository/g/a/1/a.jar',
    'repository/g/a/1/a.pom',
    'repository/g/a/1/child/b.jar',
  ])
    await old(f, p);
  const out = await captureObservations(f.store, { budget: f.budget }),
    units: Value[] = [];
  await f.store.readStream(
    out.reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      if (tuple(v)[0] === 'unit-open') units.push(v);
    },
  );
  expect(units.map((v) => tuple(v).slice(1, 6))).toEqual([
    ['maven-directory', 'repository/g/a/1', 'direct', 'used', 'retain'],
    ['maven-directory', 'repository/g/a/1/child', 'direct', 'none', 'delete'],
  ]);
  expect(f.budget.retained).toBe(0);
});
it.each([true, false])(
  'only deletes complete Gradle workspace markers; complete=%s',
  async (complete) => {
    const f = await fixture('gradle'),
      root = 'caches/transforms-4/' + 'a'.repeat(32);
    await old(f, root + '/metadata.bin');
    if (complete) {
      await old(f, root + '/results.bin');
      await old(f, root + '/transformed/a');
    }
    const out = await captureObservations(f.store, { budget: f.budget }),
      units: Value[] = [];
    await f.store.readStream(
      out.reference,
      'observations',
      { budget: f.budget, partition: null },
      async (v) => {
        if (tuple(v)[0] === 'unit-open') units.push(v);
      },
    );
    expect(units).toHaveLength(1);
    expect(tuple(units[0])[5]).toBe(complete ? 'delete' : 'retain');
    expect(f.budget.retained).toBe(0);
  },
);
it.each(['policy', 'phase', 'abort', 'mutation'] as const)(
  'rejects %s before granting observation authority',
  async (what) => {
    const f = await fixture();
    await old(f, 'data/a');
    const options: { budget: typeof f.budget; signal?: AbortSignal; maxDirectoryEntries?: number } =
      { budget: f.budget };
    if (what === 'policy') options.maxDirectoryEntries = 200000;
    if (what === 'abort') {
      const abort = new AbortController();
      abort.abort(new Error('abort'));
      options.signal = abort.signal;
    }
    if (what === 'phase') {
      const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
      state[3]++;
      state[4] = 'build-ready';
      await f.store.updateState(state);
    }
    if (what === 'mutation')
      vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
        if (point === 'observations-candidate')
          await writeFile(f.store.root.resolve('data/a'), 'changed');
      });
    await expect(captureObservations(f.store, options)).rejects.toThrow();
    expect(tuple(await f.store.state())[6]).toBeNull();
    expect(f.budget.retained).toBe(0);
  },
);
it('does not follow an excluded symlink or accept a managed one', async () => {
  const f = await fixture();
  await old(f, 'data/a');
  await symlink(f.store.root.resolve('data/a'), f.store.root.resolve('data/kept.lock'));
  const out = await captureObservations(f.store, { budget: f.budget });
  expect(out.reference[3]).toBeGreaterThan(0);
  const other = await fixture();
  await old(other, 'data/a');
  await symlink(other.store.root.resolve('data/a'), other.store.root.resolve('data/link'));
  await expect(captureObservations(other.store, { budget: other.budget })).rejects.toThrow(
    'Unsupported',
  );
  expect(other.budget.retained).toBe(0);
});
it('captures a growing hot directory with linear listings/rows and stable policy cutoff', async () => {
  const counts: number[] = [];
  for (const count of [4, 16]) {
    const f = await fixture();
    for (let n = 0; n < count; n++) await old(f, 'data/f' + String(n).padStart(2, '0'));
    const before = f.store.codec.schemas.documents.bindings.parse(
      await f.store.readDocument(tuple(await f.store.state())[5], 'bindings'),
    )[8];
    const out = await captureObservations(f.store, { budget: f.budget });
    let records = 0;
    await f.store.readStream(
      out.reference,
      'observations',
      { budget: f.budget, partition: null },
      async () => {
        records++;
      },
    );
    counts.push(records);
    expect(out.work.listings).toBe(2);
    expect(out.work.entries).toBe(count + 2);
    expect(f.budget.retained).toBe(0);
    const after = f.store.codec.schemas.documents.bindings.parse(
      await f.store.readDocument(tuple(await f.store.state())[5], 'bindings'),
    )[8];
    expect(after).toEqual(before);
  }
  expect(counts[1] - counts[0]).toBe(24);
});

it('ignores prepare-time activity for removed files and replaced file/directory kinds', async () => {
  const activity: Value[] = [
    ['dir-open', ''],
    ['dir-open', 'data'],
    ['used', 'a', 'data'],
    ['used', 'missing', 'data'],
    ['dir-close', 'data'],
    ['dir-close', ''],
  ];
  const f = await fixture('maven', {}, activity);
  await old(f, 'data/a/new');
  await old(f, 'data/b');
  const out = await captureObservations(f.store, { budget: f.budget }),
    files: Value[] = [];
  await f.store.readStream(
    out.reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      if (tuple(v)[0] === 'file') files.push(v);
    },
  );
  expect(files).toHaveLength(2);
  expect(files.every((v) => tuple(v)[5] === 'none')).toBe(true);
  expect(f.budget.retained).toBe(0);
});
it('retains whole imported activity on the surviving post-build workspace view', async () => {
  const root = 'caches/transforms-4/' + 'a'.repeat(32),
    activity: Value[] = [
      ['dir-open', ''],
      ['dir-open', 'caches'],
      ['dir-open', 'caches/transforms-4'],
      ['dir-open', root],
      ['unit-open', 'artifact-transform', root, 'subtree', 'upsert'],
      ['upsert', 'removed', 'data'],
      ['unit-close', 'artifact-transform', root],
      ['dir-close', root],
      ['dir-close', 'caches/transforms-4'],
      ['dir-close', 'caches'],
      ['dir-close', ''],
    ],
    f = await fixture('gradle', {}, activity);
  for (const name of ['metadata.bin', 'results.bin', 'transformed/current'])
    await old(f, root + '/' + name);
  const out = await captureObservations(f.store, { budget: f.budget }),
    files: Value[] = [];
  await f.store.readStream(
    out.reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      if (tuple(v)[0] === 'file') files.push(v);
    },
  );
  expect(files).toHaveLength(3);
  expect(files.every((v) => tuple(v)[5] === 'upsert' && tuple(v)[6] === 'retain')).toBe(true);
  expect(f.budget.retained).toBe(0);
});
it('rejects cancellation during final cleanup after durable observation commitment', async () => {
  const f = await fixture();
  await old(f, 'data/a');
  const abort = new AbortController(),
    reason = new Error('cancel at final cleanup'),
    close = InstallScratch.prototype.close;
  vi.spyOn(InstallScratch.prototype, 'close').mockImplementation(async function (
    this: InstallScratch,
  ) {
    await close.call(this);
    abort.abort(reason);
  });
  await expect(
    captureObservations(f.store, { budget: f.budget, signal: abort.signal }),
  ).rejects.toBe(reason);
  expect(tuple(await f.store.state())[4]).toBe('observations-frozen');
  expect(f.budget.retained).toBe(0);
});
