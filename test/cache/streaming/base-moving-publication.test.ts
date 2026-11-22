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

import { readFile, mkdir, utimes } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { RelocationProgram } from '../../../src/cache/streaming/relocation-program';
import { RelocationSource } from '../../../src/cache/streaming/relocation-source';
import { RelocationTreeFile } from '../../../src/cache/streaming/relocation-tree-file';
import { checkMoveMember } from '../../../src/cache/streaming/relocation-member';
import { RelocationEpoch } from '../../../src/cache/streaming/relocation-epoch';
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { FrozenBaseTree } from '../../../src/cache/streaming/base-frozen-tree';
import { checkMoveSourceBindings } from '../../../src/cache/streaming/move-source';
import {
  freezeMovePlans,
  checkMovePlanMetadata,
} from '../../../src/cache/streaming/base-move-plan';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { decodeRecords, tuple, type Value } from '../../../src/cache/streaming/encoding';
import { observationFixture } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [],
  inputs: LiveBaseInputs[] = [],
  publications: FrozenMovingPublication[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of publications.splice(0)) p.dispose();
  for (const i of inputs.splice(0)) await i.dispose();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(
  tool: 'gradle' | 'maven' = 'maven',
  files: Record<string, string | null> = { 'data/a': 'aggregate', 'state/b': 'snapshot' },
  shared: boolean | Parameters<typeof observationFixture>[1] = false,
) {
  const f = await observationFixture(tool, typeof shared === 'boolean' ? { shared } : shared);
  fixtures.push(f);
  await f.files('', files);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  inputs.push(input);
  return { ...f, input };
}
async function moves(pub: FrozenMovingPublication, partition: string): Promise<readonly Value[][]> {
  const choice = pub.choices.find((c) => c[1] === partition)!;
  if (choice[0] !== 'new') return [];
  const result: Value[][] = [];
  for await (const r of pub.store.rows(choice[6], 'move-plan', { ...pub.options, partition })) {
    const v = tuple(r.value);
    if (v[0] !== 'local-stream' && v[0] !== 'local-end' && v[0] !== 'move-source')
      result.push([...v]);
  }
  return result;
}
it('freezes exact decision/keys/record and maximal live plus owned roots before any rename or SDK stage', async () => {
  const f = await fixture(),
    renames = vi.spyOn(f.store.root, 'renameAbsent'),
    reads = vi.spyOn(NativeReadPhase.prototype, 'read'),
    pub = await FrozenMovingPublication.freeze(f.input, 'refs/heads/main');
  publications.push(pub);
  expect(pub.choices.map((c) => c[0])).toEqual(['new', 'new']);
  const data = await moves(pub, 'data'),
    state = await moves(pub, 'state');
  expect(data.filter((r) => r[0] === 'move').map((r) => r.slice(2, 6))).toEqual([
    ['live', 'data', 'data', 'directory'],
  ]);
  expect(state.filter((r) => r[0] === 'move').map((r) => [r[2], r[4], r[5]])).toEqual([
    ['owned', 'state', 'directory'],
  ]);
  expect(
    renames.mock.calls.filter(
      ([from]) => from === 'data' || from.startsWith(f.store.prefix + 'snapshots/'),
    ),
  ).toHaveLength(0);
  expect(reads).not.toHaveBeenCalled();
  expect(await f.store.root.stat(pub.tree('data').root + '/payload')).toBeNull();
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('aggregate');
  const catalog = await pub.cells();
  try {
    expect(catalog.rows.every((c) => c[5] === null && c[6] === null)).toBe(true);
  } finally {
    catalog.release();
  }
  const bound = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  expect(bound[4]).toBe('objects-frozen');
  expect(bound[8]).toEqual(pub.publication);
});
it('resumes the same immutable keys/bytes without assuming a populated SDK payload', async () => {
  const f = await fixture(),
    first = await FrozenMovingPublication.freeze(f.input, 'refs/heads/main');
  const record = first.record,
    generation = first.generation;
  first.dispose();
  const next = await FrozenMovingPublication.resume(await OwnedStore.bind(f.root, f.store.codec), {
    budget: f.budget,
  });
  publications.push(next);
  expect(next.record).toEqual(record);
  expect(next.generation).toEqual(generation);
  expect(await next.store.root.stat(next.tree('data').root + '/payload')).toBeNull();
});
it('splits mixed parent directories while choosing maximal eligible children', async () => {
  const f = await fixture(
      'maven',
      { 'shared/data/a': 'aggregate', 'shared/state/b': 'snapshot' },
      true,
    ),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  expect((await moves(pub, 'data')).filter((r) => r[0] === 'move').map((r) => r[4])).toEqual([
    'shared/data',
  ]);
  expect((await moves(pub, 'state')).filter((r) => r[0] === 'move').map((r) => r[4])).toEqual([
    'shared',
  ]);
});
it('keeps protected workspace splits in one complete semantic move unit', async () => {
  const root = 'caches/transforms-4/' + 'a'.repeat(32),
    f = await fixture('gradle', {
      [root + '/metadata.bin']: 'metadata',
      [root + '/results.bin']: 'results',
      [root + '/transformed/result']: 'body',
      [root + '/keep.lock']: 'lock',
      'state/b': 'snapshot',
    }),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const plan = await moves(pub, 'data');
  expect(plan.filter((r) => r[0] === 'move-unit-open').map((r) => r.slice(1))).toEqual([
    ['artifact-transform', root, 'subtree'],
  ]);
  expect(plan.filter((r) => r[0] === 'move').map((r) => r[4])).toEqual([
    root + '/metadata.bin',
    root + '/results.bin',
    root + '/transformed',
  ]);
  expect(await readFile(f.store.root.resolve(root + '/keep.lock'), 'utf8')).toBe('lock');
});
it('keeps direct Maven files together and separates a child coordinate from protected bookkeeping', async () => {
  const f = await fixture('maven', {
      'repository/a/_remote.repositories': 'marker',
      'repository/a/a.jar': 'jar',
      'repository/a/keep.lock': 'lock',
      'repository/a/child/c.jar': 'child',
      'state/b': 'snapshot',
    }),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const plan = await moves(pub, 'data');
  expect(plan.filter((r) => r[0] === 'move-unit-open').map((r) => r.slice(1))).toEqual([
    ['maven-directory', 'repository/a', 'direct'],
    ['maven-directory', 'repository/a/child', 'direct'],
  ]);
  expect(plan.filter((r) => r[0] === 'move').map((r) => r[4])).toEqual([
    'repository/a/_remote.repositories',
    'repository/a/a.jar',
    'repository/a/child',
  ]);
});
it('represents empty sources without transfer plans or object uploads', async () => {
  const f = await fixture('maven', {}),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  expect(pub.choices).toEqual([
    ['empty', 'data'],
    ['empty', 'state'],
  ]);
  expect(pub.generation[8]).toEqual([
    ['empty', 'data'],
    ['empty', 'state'],
  ]);
});

it.each(['portable', 'owned'] as const)(
  'rejects a resealed %s span offset that is not the exact member boundary',
  async (what) => {
    const f = await fixture(),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    const p = what === 'portable' ? 'data' : 'state',
      choices = structuredClone(pub.choices),
      choice = choices.find((c) => c[1] === p)!;
    if (choice[0] !== 'new') throw new Error('Fixture requires changed choice.');
    const rows: Value[] = [];
    for await (const r of f.store.rows(choice[6], 'move-plan', {
      budget: f.budget,
      partition: p,
    })) {
      const v = tuple(r.value);
      if (v[0] === 'local-stream' || v[0] === 'local-end') continue;
      const changed = structuredClone([...v]);
      if (changed[0] === 'move')
        (changed[what === 'portable' ? 6 : 7] as Value[])[2] =
          Number(tuple(changed[what === 'portable' ? 6 : 7])[2]) + 1;
      rows.push(changed);
    }
    choice[6] = f.store.codec.schemas.ref('move-plan').parse(
      await f.store.writeStream(
        'move-plan',
        { budget: f.budget, partition: p },
        (async function* () {
          yield* rows;
        })(),
      ),
    );
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
      doc = f.store.codec.schemas.documents.publication.parse(
        await f.store.readDocument(state[8]!, 'publication'),
      );
    doc[6] = f.store.codec.schemas.ref('publication-partitions').parse(
      await f.store.writeStream(
        'publication-partitions',
        { budget: f.budget, partition: null },
        (async function* () {
          yield* choices;
        })(),
      ),
    );
    state[3]++;
    state[8] = f.store.codec.schemas.ref('publication').parse(await f.store.writeDocument(doc));
    await f.store.updateState(state);
    await expect(FrozenMovingPublication.resume(f.store, { budget: f.budget })).rejects.toThrow(
      'span',
    );
    expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('aggregate');
  },
);

it.each(['moving-publication-candidate', 'moving-publication-pointer'] as const)(
  'keeps pointer ownership exact after %s failure',
  async (point) => {
    const f = await fixture();
    let armed = true;
    vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      if (name === point && armed) {
        armed = false;
        throw new Error('freeze interruption');
      }
    });
    await expect(FrozenMovingPublication.freeze(f.input, 'main')).rejects.toThrow(
      'freeze interruption',
    );
    const store = await OwnedStore.bind(f.root, f.store.codec),
      state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (point === 'moving-publication-candidate') {
      expect(state[8]).toBeNull();
      await expect(FrozenMovingPublication.resume(store, { budget: f.budget })).rejects.toThrow(
        'No frozen',
      );
      await expect(LiveBaseInputs.capture(store, { budget: f.budget })).rejects.toThrow(
        'keyed source metadata',
      );
      const reads = vi.spyOn(NativeReadPhase.prototype, 'read'),
        pub = await FrozenMovingPublication.freeze(f.input, 'main');
      publications.push(pub);
      expect(reads).not.toHaveBeenCalled();
    } else {
      expect(state[8]).not.toBeNull();
      const pub = await FrozenMovingPublication.resume(store, { budget: f.budget });
      publications.push(pub);
      expect(pub.publication).toEqual(state[8]);
    }
    expect(await readFile(store.root.resolve('data/a'), 'utf8')).toBe('aggregate');
  },
);

async function replacePlan(
  pub: FrozenMovingPublication,
  partition: string,
  change: (rows: Value[][]) => Value[][],
  changeSource?: (source: Value[]) => void,
) {
  const store = pub.store,
    choices = structuredClone(pub.choices),
    choice = choices.find((c) => c[1] === partition)!;
  if (choice[0] !== 'new') throw new Error('Expected new test choice.');
  const rows: Value[][] = [];
  for await (const r of store.rows(choice[6], 'move-plan', { ...pub.options, partition })) {
    const v = tuple(r.value);
    if (v[0] !== 'local-stream' && v[0] !== 'local-end') rows.push([...v]);
  }
  const source = rows.find((row) => row[0] === 'move-source')!;
  changeSource?.(source);
  const changed = [source, ...change(rows.filter((row) => row[0] !== 'move-source'))];
  let n = 0;
  for (const row of changed) if (row[0] === 'move') row[1] = ++n;
  choice[6] = store.codec.schemas.ref('move-plan').parse(
    await store.writeStream(
      'move-plan',
      { ...pub.options, partition },
      (async function* () {
        yield* changed;
      })(),
    ),
  );
  const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    doc = store.codec.schemas.documents.publication.parse(
      await store.readDocument(state[8]!, 'publication'),
    );
  doc[6] = store.codec.schemas.ref('publication-partitions').parse(
    await store.writeStream(
      'publication-partitions',
      { ...pub.options, partition: null },
      (async function* () {
        yield* choices;
      })(),
    ),
  );
  state[3]++;
  state[8] = store.codec.schemas.ref('publication').parse(await store.writeDocument(doc));
  await store.updateState(state);
}
it.each(['a', 'b', 'c', 'all'] as const)(
  'rejects a resealed plan omitting %s rather than merely draining its uncovered tree',
  async (omitted) => {
    const f = await fixture('maven', {
        'data/a': 'a',
        'data/b': 'b',
        'data/c': 'c',
        'data/keep.lock': 'lock',
        'state/b': 'snapshot',
      }),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    await replacePlan(pub, 'data', (rows) =>
      omitted === 'all'
        ? []
        : rows.filter((r) =>
            r[0] === 'move' ? r[4] !== 'data/' + omitted : r[2] !== 'data/' + omitted,
          ),
    );
    await expect(FrozenMovingPublication.resume(f.store, { budget: f.budget })).rejects.toThrow(
      'Uncovered portable',
    );
  },
);
it('requires coverage of a meaningful empty subtree while permitting unmoved structural ancestors', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', { 'data/a': 'a', 'data/keep.lock': 'lock', 'state/b': 'snapshot' });
  await mkdir(f.store.root.resolve('data/empty'));
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  inputs.push(input);
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  publications.push(pub);
  await replacePlan(pub, 'data', (rows) =>
    rows.filter((r) => (r[0] === 'move' ? r[4] !== 'data/empty' : r[2] !== 'data/empty')),
  );
  await expect(FrozenMovingPublication.resume(f.store, { budget: f.budget })).rejects.toThrow(
    'Uncovered portable',
  );
});
it('charges a newly retained tree during freeze and releases earlier catalog holds on admission failure', async () => {
  const f = await fixture(),
    render = FrozenBaseTree.fromDraft.bind(FrozenBaseTree),
    retain = f.budget.retain.bind(f.budget),
    before = f.budget.retained;
  let newlyRetained = false;
  vi.spyOn(FrozenBaseTree, 'fromDraft').mockImplementation(async (...args) => {
    const result = await render(...args);
    newlyRetained = true;
    return result;
  });
  vi.spyOn(f.budget, 'retain').mockImplementation((bytes) => {
    if (newlyRetained) {
      newlyRetained = false;
      throw new Error('catalog admission');
    }
    retain(bytes);
  });
  await expect(FrozenMovingPublication.freeze(f.input, 'main')).rejects.toThrow(
    'catalog admission',
  );
  expect(f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[8]).toBeNull();
  // A completed replay may retire a charged writer buffer; no new hold may leak.
  expect(f.budget.retained).toBeLessThanOrEqual(before);
});
it('validates shared-directory roots in one global frontier across 4 to 16 partitions', async () => {
  const measurements: number[] = [];
  for (const count of [4, 16]) {
    const f = await observationFixture('maven', { partitionCount: count });
    fixtures.push(f);
    const files: Record<string, string> = {};
    for (let d = 0; d < 4; d++)
      for (let p = 0; p < count; p++)
        files['shared/d' + d + '/p' + String(p).padStart(3, '0')] = 'x';
    await f.files('', files);
    await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget });
    const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
    inputs.push(input);
    const pub = await FrozenMovingPublication.freeze(input, 'main');
    publications.push(pub);
    const indexes: ObservationIndex[] = [],
      open = ObservationIndex.open.bind(ObservationIndex);
    const spy = vi.spyOn(ObservationIndex, 'open').mockImplementation(async (...args) => {
      const index = await open(...args);
      indexes.push(index);
      return index;
    });
    const beforeRows = f.store.root.work.metadataRowsRead;
    try {
      await checkMovePlanMetadata(
        f.store,
        input.view.observations,
        pub.choices.flatMap((c) =>
          c[0] === 'new'
            ? [{ partition: c[1], plan: c[6], tree: pub.tree(c[1]), source: null }]
            : [],
        ),
        { budget: f.budget },
      );
      expect(indexes).toHaveLength(1);
      measurements.push(f.store.root.work.metadataRowsRead - beforeRows);
    } finally {
      spy.mockRestore();
    }
  }
  expect(measurements[1]).toBeLessThan(measurements[0] * 4.5);
}, 30000);

it.each(['protected', 'foreign'] as const)(
  'derives a presence-only live aggregate stage obligation from %s source contents',
  async (kind) => {
    const f = await observationFixture('maven', { foreignSibling: kind === 'foreign' });
    fixtures.push(f);
    await f.files(
      '',
      kind === 'foreign'
        ? { 'data/empty/foreign': 'other' }
        : { 'data/empty/keep.lock': 'protected' },
    );
    await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget });
    const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
    inputs.push(input);
    const pub = await FrozenMovingPublication.freeze(input, 'main');
    publications.push(pub);
    expect(pub.choices[0][0]).toBe('new');
    expect(await moves(pub, 'data')).toEqual([]);
    expect(pub.tree('data').empty).toBe(false);
    const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
    publications.push(resumed);
    expect(resumed.generation).toEqual(pub.generation);
    expect(await f.store.root.stat(pub.tree('data').root + '/payload')).toBeNull(); // metadata is not a ready stage
    expect(
      await readFile(
        f.store.root.resolve(kind === 'foreign' ? 'data/empty/foreign' : 'data/empty/keep.lock'),
        'utf8',
      ),
    ).toBe(kind === 'foreign' ? 'other' : 'protected');
  },
);

it('still moves an actually empty eligible subtree after GC removed its old files', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', { 'data/empty/old': 'expired', 'data/keep.lock': 'protected' });
  await utimes(f.store.root.resolve('data/empty/old'), 1.234, 1.234);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  expect(await f.store.root.stat('data/empty/old')).toBeNull();
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  inputs.push(input);
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  publications.push(pub);
  expect((await moves(pub, 'data')).filter((r) => r[0] === 'move').map((r) => r[4])).toEqual([
    'data/empty',
  ]);
  await replacePlan(pub, 'data', () => []);
  await expect(FrozenMovingPublication.resume(f.store, { budget: f.budget })).rejects.toThrow(
    'Uncovered portable empty',
  );
});
it('keeps the original protected projected-presence native facts guarded after metadata freeze', async () => {
  const f = await fixture('maven', { 'data/empty/keep.lock': 'protected', 'state/b': 'snapshot' }),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  await f.files('', { 'data/empty/late.lock': 'unexpected' });
  await expect(f.input.view.assertStable()).rejects.toThrow('retained live source changed');
  expect(await f.store.root.stat(pub.tree('data').root + '/payload')).toBeNull();
});

it('guards protected remnants of a deleted complete workspace without resurrecting a contribution', async () => {
  const f = await observationFixture('gradle');
  fixtures.push(f);
  const root = 'caches/transforms-4/' + 'a'.repeat(32);
  await f.files('', {
    [root + '/metadata.bin']: 'metadata',
    [root + '/results.bin']: 'results',
    [root + '/transformed/a']: 'body',
    [root + '/keep.lock']: 'protected',
  });
  for (const name of ['metadata.bin', 'results.bin', 'transformed/a'])
    await utimes(f.store.root.resolve(root + '/' + name), 1.234, 1.234);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  inputs.push(input);
  expect(input.work).toEqual({ hashBytes: 0, copyBytes: 0 });
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  publications.push(pub);
  expect(pub.choices).toEqual([
    ['empty', 'data'],
    ['empty', 'state'],
  ]);
  expect(await readFile(f.store.root.resolve(root + '/keep.lock'), 'utf8')).toBe('protected');
  expect(await f.store.root.stat(root + '/metadata.bin')).toBeNull();
  await f.files('', { [root + '/late.lock']: 'unexpected' });
  await expect(input.view.assertStable()).rejects.toThrow('retained live source changed');
});

it.each([
  'wrong-partition',
  'missing-file',
  'changed-native',
  'changed-hash',
  'owned-ref',
] as const)('rejects a resealed move-source with %s evidence before native work', async (bad) => {
  const f = await fixture(),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const partition = bad === 'owned-ref' ? 'state' : 'data';
  const source = f.input.partitions.find((p) => p.partition === partition)!;
  const rows: Value[][] = [];
  for await (const row of f.store.rows(source.evidence, 'native-evidence', {
    ...pub.options,
    partition,
  })) {
    const value = tuple(row.value);
    if (value[0] !== 'local-stream' && value[0] !== 'local-end')
      rows.push(structuredClone([...value]));
  }
  if (bad === 'missing-file')
    rows.splice(
      rows.findIndex((r) => r[0] === 'file'),
      1,
    );
  if (bad === 'changed-native') {
    const row = rows.find((r) => r[0] === 'file')!;
    (row[2] as Value[])[9] = String(BigInt(String((row[2] as Value[])[9])) + 1n);
  }
  if (bad === 'changed-hash') rows.find((r) => r[0] === 'file')![3] = 'f'.repeat(64);
  const q = await f.store.writeStream(
    'native-evidence',
    { ...pub.options, partition: bad === 'wrong-partition' ? 'state' : partition },
    (async function* () {
      if (bad === 'wrong-partition') {
        yield ['directory', '', rows[0][2]];
        return;
      }
      yield* rows;
    })(),
  );
  await replacePlan(
    pub,
    partition,
    (rows) => rows,
    (source) => {
      source[1] = q;
    },
  );
  const renames = vi.spyOn(f.store.root, 'renameAbsent');
  await expect(FrozenMovingPublication.resume(f.store, { budget: f.budget })).rejects.toThrow();
  expect(renames).not.toHaveBeenCalled();
});

it('releases source-join record charges when a portable record is not a tuple', async () => {
  const f = await fixture(),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const original = await ObservationIndex.open(f.store, f.input.view.observations, {
    budget: f.budget,
  });
  const read = f.store.read.bind(f.store),
    retained = f.budget.retained;
  vi.spyOn(f.store, 'read').mockImplementation((q, ...rest) =>
    tuple(q)[1] === 'native-tree'
      ? (async function* () {
          yield Buffer.from('42\n');
        })()
      : read(q, ...rest),
  );
  try {
    await expect(
      checkMoveSourceBindings(
        original,
        [
          {
            partition: 'data',
            evidence: f.input.partitions[0].evidence,
            tree: pub.tree('data'),
            owned: null,
          },
        ],
        { budget: f.budget },
      ),
    ).rejects.toThrow();
    expect(f.budget.retained).toBe(retained);
  } finally {
    await original.dispose();
  }
});

// Independently assemble the existing physical-group shape before its planner emits it.
async function coarseRows(pub: FrozenMovingPublication, root: string): Promise<Value[][]> {
  const observation = (await pub.state())[6]!,
    index = await ObservationIndex.open(pub.store, observation, pub.options);
  let native: Value;
  try {
    const lease = await index.directory(root);
    try {
      native = ['span', observation[4], lease.node[5], lease.node[6]];
    } finally {
      lease.release();
    }
  } finally {
    await index.dispose();
  }
  let start = -1,
    end = -1;
  for await (const row of decodeRecords(pub.store.read(pub.tree('data').tree, 'native-tree'))) {
    const r = tuple(row.value);
    if (r[0] === 'dir-open' && r[1] === root) start = row.start;
    if (r[0] === 'dir-close' && r[1] === root) end = row.end;
  }
  if (start < 0 || end < 0) throw new Error('Missing coarse test subtree.');
  return [
    ['move-unit-open', 'directory', root, 'subtree'],
    [
      'move',
      1,
      'live',
      root,
      root,
      'directory',
      ['span', pub.tree('data').tree[4], start, end],
      native!,
    ],
    ['move-unit-close', 'directory', root, 1],
  ];
}
it.each(['repository', 'repository/org'])(
  'admits a handcrafted Maven physical group at %s through exact source/tree readers',
  async (root) => {
    const f = await fixture('maven', {
        'repository/org/a/1/a.jar': 'a',
        'repository/org/b/1/b.jar': 'b',
      }),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    const rows = await coarseRows(pub, root);
    await replacePlan(pub, 'data', () => rows);
    const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
    publications.push(resumed);
    const program = await RelocationProgram.create(resumed, 'data'),
      source = await RelocationSource.open(program),
      tree = await RelocationTreeFile.open(resumed.tree('data'), resumed.options);
    try {
      expect(program.rootCount).toBe(1);
      for await (const range of program.ranges())
        for await (const move of program.moves(range)) {
          const fact = await source.member(move);
          const checked = await checkMoveMember(
            program,
            move,
            move[3],
            source.evidence,
            fact.span,
            tree,
          );
          expect(checked.work.files).toBe(2);
        }
    } finally {
      await tree.close();
      await source.close();
      await program.close();
    }
  },
);
it.each(['direct', 'portable-span', 'observation-span', 'overlap'])(
  'rejects a resealed invalid coarse Maven %s plan',
  async (bad) => {
    const f = await fixture('maven', {
        'repository/org/a/1/a.jar': 'a',
        'repository/org/b/1/b.jar': 'b',
      }),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    const rows = await coarseRows(pub, 'repository');
    if (bad === 'direct') {
      rows[0] = ['move-unit-open', 'maven-directory', 'repository', 'direct'];
      rows[2] = ['move-unit-close', 'maven-directory', 'repository', 1];
    }
    if (bad === 'portable-span') (rows[1][6] as Value[])[3] = (rows[1][6] as number[])[3] - 1;
    if (bad === 'observation-span') (rows[1][7] as Value[])[3] = (rows[1][7] as number[])[3] - 1;
    if (bad === 'overlap') rows.push(...(await coarseRows(pub, 'repository/org')));
    await expect(
      (async () => {
        await replacePlan(pub, 'data', () => rows);
        const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
        publications.push(resumed);
      })(),
    ).rejects.toThrow();
    expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).toBeNull();
  },
);
it('rejects an extra excluded descendant before a coarse-root relocation intent', async () => {
  const f = await fixture('maven', {
      'repository/org/a/1/a.jar': 'a',
      'repository/org/b/1/b.jar': 'b',
    }),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const rows = await coarseRows(pub, 'repository');
  await replacePlan(pub, 'data', () => rows);
  const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  publications.push(resumed);
  await f.files('', { 'repository/late.lock': 'excluded' });
  await expect(RelocationEpoch.open(resumed, 'data')).rejects.toThrow();
  expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).toBeNull();
  expect(await readFile(f.store.root.resolve('repository/late.lock'), 'utf8')).toBe('excluded');
});

it('coarsens a clean Maven repository without changing its logical direct units', async () => {
  const files = {
      'repository/org/a/1/_remote.repositories': 'marker',
      'repository/org/a/1/a.jar': 'a',
      'repository/org/a/1/child/b.jar': 'b',
      'repository/org/b/1/b.jar': 'b',
      'repository/empty': null,
    },
    f = await fixture('maven', files),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const plan = await moves(pub, 'data');
  expect(plan.filter((r) => r[0] === 'move-unit-open').map((r) => r.slice(1))).toEqual([
    ['directory', 'repository', 'subtree'],
  ]);
  expect(plan.filter((r) => r[0] === 'move').map((r) => r.slice(2, 6))).toEqual([
    ['live', 'repository', 'repository', 'directory'],
  ]);
  const units = [];
  for await (const row of decodeRecords(f.store.read(pub.tree('data').tree, 'native-tree'))) {
    const r = tuple(row.value);
    if (r[0] === 'unit-open') units.push(r.slice(1, 4));
  }
  expect(units).toEqual([
    ['maven-directory', 'repository/org/a/1', 'direct'],
    ['maven-directory', 'repository/org/a/1/child', 'direct'],
    ['maven-directory', 'repository/org/b/1', 'direct'],
  ]);
  const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  publications.push(resumed);
  expect(resumed.publication).toEqual(pub.publication);
  expect(await moves(resumed, 'data')).toEqual(plan);
});
it.each(['lock', 'custom'] as const)(
  'coarsens only the eligible Maven ancestor beside a %s exclusion',
  async (kind) => {
    const excluded = kind === 'lock' ? 'repository/keep.lock' : 'repository/private.bin',
      f = await fixture(
        'maven',
        { 'repository/org/a/1/a.jar': 'a', 'repository/org/b/1/b.jar': 'b', [excluded]: 'private' },
        { excluded: kind === 'custom' ? ['**/private.bin'] : [] },
      ),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    const plan = await moves(pub, 'data');
    expect(plan.filter((r) => r[0] === 'move').map((r) => r[4])).toEqual(['repository/org']);
    expect(await readFile(f.store.root.resolve(excluded), 'utf8')).toBe('private');
  },
);
it.each(['aggregate', 'single-writer'] as const)(
  'keeps mixed Maven %s ownership in separate physical sources',
  async (mode) => {
    const f = await fixture(
        'maven',
        {
          'repository/org/a/1/a.jar': 'a',
          'repository/org/b/1/b.jar': 'b',
          'repository/other/c/1/c.jar': 'c',
        },
        { repositorySplit: mode },
      ),
      pub = await FrozenMovingPublication.freeze(f.input, 'main');
    publications.push(pub);
    expect(
      (await moves(pub, 'data')).filter((r) => r[0] === 'move').map((r) => [r[2], r[4]]),
    ).toEqual([['live', 'repository/org']]);
    expect(
      (await moves(pub, 'state')).filter((r) => r[0] === 'move').map((r) => [r[2], r[4]]),
    ).toEqual(mode === 'aggregate' ? [['live', 'repository/other']] : [['owned', 'repository']]);
  },
);

it('does not coarsen across an unselected Maven owner', async () => {
  const f = await fixture(
      'maven',
      { 'repository/org/a/1/a.jar': 'a', 'repository/other/c/1/c.jar': 'c' },
      { repositorySplit: 'aggregate' },
    ),
    pub = await FrozenMovingPublication.freeze(f.input, 'main');
  publications.push(pub);
  const plans = await freezeMovePlans(f.input, [pub.tree('data')]);
  expect([...plans.keys()]).toEqual(['data']);
  const roots = [];
  for await (const row of f.store.rows(plans.get('data')!, 'move-plan', {
    ...pub.options,
    partition: 'data',
  })) {
    const r = tuple(row.value);
    if (r[0] === 'move') roots.push(r[4]);
  }
  expect(roots).toEqual(['repository/org']);
});

it('releases warm handoff charges when late summary reporting fails and leaves cold resume valid', async () => {
  const f = await fixture(),
    summaries = new PartitionSummaries(f.model, f.budget);
  vi.spyOn(summaries, 'choice').mockImplementation(() => {
    throw new Error('late summary failure');
  });
  await expect(FrozenMovingPublication.freeze(f.input, 'main', [], summaries)).rejects.toThrow(
    'late summary failure',
  );
  summaries.dispose();
  await f.input.dispose();
  inputs.splice(inputs.indexOf(f.input), 1);
  expect(f.budget.retained).toBe(0);
  expect(tuple(await f.store.state())[4]).toBe('objects-frozen');
  const resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  publications.push(resumed);
  summaries.dispose();
});
