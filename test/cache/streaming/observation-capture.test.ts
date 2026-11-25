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
import { executeFixtureGc as executeGc } from './observation-fixtures';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { resolveModel } from '../../../src/cache/streaming/model';
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
  const read = vi.spyOn(NativeReadPhase.prototype, 'read'),
    before = await f.store.root.stat('data/a');
  const summaries = new PartitionSummaries(f.model, f.budget);
  const out = await captureObservations(f.store, { budget: f.budget, summaries }),
    values: Value[] = [];
  expect(summaries.snapshot()[0]).toMatchObject({ capturedFiles: 2, logicalBytes: 2n });
  summaries.dispose();
  await f.store.readStream(
    out.reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      values.push(v);
    },
  );
  expect(out.work.listings).toBe(2);
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
  expect(values.filter((v) => tuple(v)[0] === 'file').every((v) => tuple(v)[5] === 'delete')).toBe(
    true,
  );
  const state = tuple(await f.store.state());
  expect(state[4]).toBe('post-active');
  expect(state[6]).not.toEqual(out.reference);
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('reports actual omitted Kotlin DSL members while admitting recognized scripts and accessors', async () => {
  const f = await fixture('gradle', { excluded: ['data/pruned/**'] });
  const dsl = 'caches/9.9.2/kotlin-dsl';
  const admitted = {
    [dsl + '/scripts/' + 'a'.repeat(32) + '/metadata.bin']: 'script',
    [dsl + '/scripts/' + 'a'.repeat(32) + '/classes/member.class']: 'class',
    [dsl + '/accessors/' + 'b'.repeat(32) + '-PS/classes.jar']: 'accessor',
  };
  const unknown = [
    dsl + '/accessors/loose.member',
    dsl + '/scripts/auxiliary.member',
    dsl + '/ic/cache.bin',
    dsl + '/classpath-snapshots/snapshot.bin',
  ];
  const housekeeping = dsl + '/gc.properties';
  await f.files('', {
    ...admitted,
    ...Object.fromEntries(unknown.map((path) => [path, 'local'])),
    [housekeeping]: 'marker',
    'data/pruned/nested/file': 'never inspected',
    'data/runtime.lock': 'excluded',
    'unmanaged/file': 'unowned',
  });
  const summaries = new PartitionSummaries(f.model, f.budget);
  const info = vi.fn(),
    warning = vi.fn();
  try {
    const out = await captureObservations(f.store, {
      budget: f.budget,
      summaries,
      onCaptureInfo: info,
      onWarning: warning,
    });
    const files: string[] = [];
    await f.store.readStream(
      out.reference,
      'observations',
      { budget: f.budget, partition: null },
      async (v) => {
        if (tuple(v)[0] === 'file') files.push(String(tuple(v)[1]));
      },
    );
    expect(files.sort()).toEqual(
      Object.keys(admitted)
        .map((p) => p.slice(p.lastIndexOf('/') + 1))
        .sort(),
    );
    expect(warning).toHaveBeenCalledTimes(1);
    const examples = warning.mock.calls[0][0];
    for (const path of unknown) {
      expect(examples).toContain('data: ' + path);
      expect(await f.store.root.stat(path)).not.toBeNull();
    }
    expect(examples).not.toContain('gc.properties');
    expect(await f.store.root.stat(housekeeping)).not.toBeNull();
    const text = info.mock.calls.flat().join('\n');
    expect(text).toContain('captured=3 files/19 logical bytes');
    expect(text).toContain(
      'observed-excluded=5 files/0 directories/0 other entries, housekeeping=1 files, unsupported-layout=4 files',
    );
    expect(text).toContain('Unattributed: observed-excluded=2 files/2 directories/0 other entries');
    expect(text).toContain('pruned=2 directories (descendant counts unknown)');
    expect(text).not.toContain('nested');
  } finally {
    summaries.dispose();
  }
});

it('keeps essential layout warnings for capture callers without a summary collector', async () => {
  const f = await fixture('gradle');
  const path = 'caches/9.9.2/kotlin-dsl/ic/actual.file';
  await f.files('', { [path]: 'local only' });
  const warning = vi.fn();
  await captureObservations(f.store, { budget: f.budget, onWarning: warning });
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('data: ' + path));
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
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it.each([false, true])(
  'isolates Maven snapshot ownership to direct children; nested=%s',
  async (nested) => {
    const hard = ['.mammoth/**'],
      model = resolveModel(
        [
          'model',
          1,
          'maven',
          hard,
          [
            ['data', ['repository/**/*.jar'], hard, 'aggregate', null, 'default', 0],
            ['state', ['repository/**/*.pom'], hard, 'single-writer', 'A', 'default', 0],
          ],
        ],
        'observation-owner-',
        1,
      );
    const f = await fixture('maven', { model }),
      coordinate = 'repository/g/a/1';
    await old(f, coordinate + '/a.jar');
    await old(f, coordinate + (nested ? '/child/a.pom' : '/a.pom'));
    const capture = captureObservations(f.store, { budget: f.budget });
    if (nested) await expect(capture).resolves.toHaveProperty('index');
    else await expect(capture).rejects.toThrow('Maven direct unit splits a snapshot owner');
    await f.finish();
    expect(f.budget.retained).toBe(0);
  },
);
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
    await f.finish();
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
    if (what === 'mutation') {
      await captureObservations(f.store, options);
      // Observations are expected facts, not mutation authority. The consuming
      // original/native join rejects the late write before any GC deletion.
      await expect(executeGc(f.store, options)).rejects.toThrow();
    } else {
      await expect(captureObservations(f.store, options)).rejects.toThrow();
      expect(tuple(await f.store.state())[4]).toBe(
        what === 'phase' ? 'build-ready' : 'post-active',
      );
    }
    await f.finish();
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
  await other.finish();
  expect(other.budget.retained).toBe(0);
});
it('captures growing shared Maven coordinates with linear work and stable policy cutoff', async () => {
  const counts: number[] = [];
  for (const count of [4, 16]) {
    const f = await fixture();
    for (let n = 0; n < count; n++) {
      const unit = `repository/shared/unit-${n}`;
      await old(f, unit + '/a.jar');
      await old(f, unit + '/a.pom');
    }
    await old(f, 'repository/shared/keep.lock');
    const before = f.store.codec.schemas.documents.bindings.parse(
      await f.store.readDocument(tuple(await f.store.state())[5], 'bindings'),
    )[8];
    const pointReads = vi.spyOn(InstallScratch.prototype, 'record');
    const out = await captureObservations(f.store, { budget: f.budget });
    // One root/repository/shared read each and one render + digest visit per unit node.
    expect(pointReads).toHaveBeenCalledTimes(3 + 6 * count);
    pointReads.mockRestore();
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
    expect(out.work.listings).toBe(3 + count);
    expect(out.work.entries).toBe(4 + 3 * count);
    await f.finish();
    expect(f.budget.retained).toBe(0);
    const after = f.store.codec.schemas.documents.bindings.parse(
      await f.store.readDocument(tuple(await f.store.state())[5], 'bindings'),
    )[8];
    expect(after).toEqual(before);
  }
  expect(counts[1] - counts[0]).toBe(108);
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
  expect(files.every((v) => tuple(v)[4] === 'none')).toBe(true);
  await f.finish();
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
  expect(files.every((v) => tuple(v)[4] === 'upsert' && tuple(v)[5] === 'retain')).toBe(true);
  await f.finish();
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
  expect(tuple(await f.store.state())[4]).toBe('post-active');
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it.each([
  ['standalone', 'remote', 'upsert'],
  ['distributed-aggregator', null, 'upsert'],
  ['distributed-aggregator', 'local', 'upsert'],
  ['distributed-aggregator', 'remote', 'none'],
  ['distributed-worker', null, 'none'],
  ['distributed-worker', 'local', 'upsert'],
] as const)(
  'classifies snapshot activity for %s writer=%s as %s',
  async (role, writer, expected) => {
    const hard = ['.mammoth/**'];
    const model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [['state', ['state/**'], hard, 'single-writer', writer, 'default', 0]],
      ],
      'snapshot-activity-',
      1,
    );
    const f = await fixture('maven', { model, role, job: 'local' });
    await old(f, 'state/a');
    const out = await captureObservations(f.store, { budget: f.budget });
    const files: Value[] = [];
    await f.store.readStream(
      out.reference,
      'observations',
      { budget: f.budget, partition: null },
      async (row) => {
        if (tuple(row)[0] === 'file') files.push(row);
      },
    );
    expect(files).toHaveLength(1);
    expect(tuple(files[0])[4]).toBe(expected);
    expect(tuple(files[0])[5]).toBe('retain');
    await f.finish();
  },
);
