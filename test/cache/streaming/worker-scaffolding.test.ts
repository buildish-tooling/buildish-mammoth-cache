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

import { afterEach, expect, it } from 'vitest';
import { writeFile, rm, utimes } from 'node:fs/promises';
import { observationFixture } from './observation-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { executeGc, recoverGc } from '../../../src/cache/streaming/gc-execute';
import { WorkerSources } from '../../../src/cache/streaming/worker-walk';
import { resolveModel } from '../../../src/cache/streaming/model';
import { localRecords } from '../../../src/cache/streaming/prepare-state';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(scaffolds = 1) {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', ['d/**'], hard, 'aggregate', null, 'default']]],
      'scaffold-',
      1,
    );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  await f.files('', { 'd/a': 'body' });
  for (let n = 0; n < scaffolds; n++)
    await f.files('', { ['init' + n + '/keep.txt']: 'protected' });
  const capture = await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  const workerSources = await f.store.writeStream(
    'worker-sources',
    { budget: f.budget, partition: null },
    localRecords([]),
  );
  return { ...f, capture, view: { observations: state[6]!, gcProgress: state[10], workerSources } };
}
it('retains unowned walked scaffolding for co-replay without uploading or deleting it, with one listing per directory', async () => {
  const counts = [];
  for (const width of [1, 8]) {
    const f = await fixture(width),
      sources = await WorkerSources.create(f.store, f.view, f.budget);
    try {
      for await (const event of sources.events(new AbortController().signal)) {
        if ('path' in event) expect(event.path).not.toMatch(/^init/);
        if (event.type === 'file')
          for await (const bytes of event.bytes) expect(bytes.length).toBeGreaterThan(0);
      }
      for (let n = 0; n < width; n++)
        expect(await f.store.root.stat('init' + n + '/keep.txt')).not.toBeNull();
      expect(f.capture.work.listings).toBe(width + 2);
      expect(sources.work.listings).toBe(width + 2);
      counts.push({
        width,
        captureListings: f.capture.work.listings,
        replayListings: sources.work.listings,
      });
    } finally {
      await sources.dispose();
    }
  }
  process.stdout.write('V7_SCAFFOLD_COST ' + JSON.stringify(counts) + '\n');
});
it.each(['add', 'remove', 'mtime'] as const)(
  'rejects post-freeze %s inside unowned walked scaffolding',
  async (mutation) => {
    const f = await fixture();
    if (mutation === 'add') await writeFile(f.root + '/init0/late', 'late');
    if (mutation === 'remove') await rm(f.root + '/init0/keep.txt');
    if (mutation === 'mtime') await utimes(f.root + '/init0', 1, 1);
    await expect(WorkerSources.create(f.store, f.view, f.budget)).rejects.toThrow();
  },
);

it.each(['unowned', 'owned-file', 'owned-empty'] as const)(
  'retains a recognized workspace as evidence only when it has no owned presence: %s',
  async (kind) => {
    const unit = 'caches/transforms-4/' + 'a'.repeat(32),
      hard = ['.mammoth/**'];
    const includes =
      kind === 'unowned'
        ? ['d/**']
        : kind === 'owned-file'
          ? [unit + '/transformed/*.bin']
          : [unit + '/transformed/**'];
    const model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', includes, hard, 'aggregate', null, 'default']]],
      'scaffold-unit-',
      1,
    );
    const f = await observationFixture('gradle', { role: 'distributed-worker', model });
    fixtures.push(f);
    await f.files('', {
      [unit + '/metadata.bin']: 'metadata',
      [unit + '/results.bin']: 'results',
      [unit + '/transformed']: null,
    });
    if (kind === 'owned-file') await f.files('', { [unit + '/transformed/body.bin']: 'owned' });
    const capture = await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget });
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    const workerSources = await f.store.writeStream(
      'worker-sources',
      { budget: f.budget, partition: null },
      localRecords([]),
    );
    const create = () =>
      WorkerSources.create(
        f.store,
        { observations: capture.reference, gcProgress: state[10], workerSources },
        f.budget,
      );
    if (kind !== 'unowned')
      await expect(create()).rejects.toThrow('Unowned workspace contains managed members');
    else {
      const sources = await create();
      try {
        for await (const event of sources.events(new AbortController().signal)) {
          expect(event.type).not.toBe('unit-open');
          if ('path' in event) expect(event.path).toBe('');
        }
      } finally {
        await sources.dispose();
      }
      expect(await f.store.root.stat(unit + '/metadata.bin')).not.toBeNull();
    }
  },
);
it('reuses the frozen hard-prune boundary rather than following opaque scaffolding', async () => {
  const hard = ['.mammoth/**', 'opaque/**'],
    model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', ['d/**'], hard, 'aggregate', null, 'default']]],
      'scaffold-opaque-',
      1,
    );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  await f.files('', { 'd/body': 'body', 'opaque/hidden': 'excluded' });
  const capture = await captureObservations(f.store, { budget: f.budget });
  const workerSources = await f.store.writeStream(
    'worker-sources',
    { budget: f.budget, partition: null },
    localRecords([]),
  );
  const sources = await WorkerSources.create(
    f.store,
    { observations: capture.reference, gcProgress: null, workerSources },
    f.budget,
  );
  try {
    expect(sources.work.listings).toBe(2);
  } finally {
    await sources.dispose();
  }
});

it('does not exempt ambiguous observation ownership when retaining a physical empty directory', async () => {
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      hard,
      [
        ['a', ['init0/**'], hard, 'aggregate', null, 'default'],
        ['b', ['init0/**'], hard, 'aggregate', null, 'default'],
      ],
    ],
    'scaffold-ambiguous-',
    1,
  );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  await f.files('', { init0: null });
  await expect(captureObservations(f.store, { budget: f.budget })).rejects.toThrow(
    'Ambiguous partition ownership',
  );
});
it('rejects a hard-excluded empty directory as an observation node rather than exempting its ownership', async () => {
  const hard = ['.mammoth/**', 'init0/**'];
  const model = resolveModel(
    ['model', 1, 'gradle', hard, [['data', ['d/**'], hard, 'aggregate', null, 'default']]],
    'scaffold-excluded-',
    1,
  );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  await f.files('', { init0: null });
  const root = (await f.store.root.stat(''))!,
    dir = (await f.store.root.stat('init0'))!;
  await expect(
    f.store.writeStream(
      'observations',
      { budget: f.budget, partition: null },
      localRecords([
        ['dir-open', '', root],
        ['child', 'init0', 'directory', dir[3], dir[4]],
        ['dir-open', 'init0', dir],
        ['dir-close', 'init0'],
        ['dir-close', ''],
      ]),
    ),
  ).rejects.toThrow('Reserved/excluded managed path');
});

it.each(['empty', 'unknown-file', 'late-file'] as const)(
  'keeps workspace namespace scaffolding evidence-only: %s',
  async (kind) => {
    const hard = ['.mammoth/**'],
      model = resolveModel(
        [
          'model',
          1,
          'gradle',
          hard,
          [['data', ['caches/transforms-*/**'], hard, 'aggregate', null, 'default']],
        ],
        'scaffold-namespace-',
        1,
      );
    const f = await observationFixture('gradle', { role: 'distributed-worker', model });
    fixtures.push(f);
    await f.files('', { 'caches/transforms-3': null });
    if (kind === 'unknown-file') await f.files('', { 'caches/transforms-3/body': 'unsupported' });
    const capture = await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget });
    expect(await f.store.root.stat('caches/transforms-3')).not.toBeNull();
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    const workerSources = await f.store.writeStream(
      'worker-sources',
      { budget: f.budget, partition: null },
      localRecords([]),
    );
    if (kind === 'late-file') await f.files('', { 'caches/transforms-3/late': 'late' });
    const create = () =>
      WorkerSources.create(
        f.store,
        { observations: capture.reference, gcProgress: state[10], workerSources },
        f.budget,
      );
    if (kind === 'late-file') await expect(create()).rejects.toThrow();
    else {
      const sources = await create();
      try {
        for await (const event of sources.events(new AbortController().signal)) {
          expect(event.type).not.toBe('file');
          if ('path' in event) expect(event.path).toBe('');
        }
      } finally {
        await sources.dispose();
      }
    }
  },
);

it('preserves a workspace namespace after GC removes its last supported unit, including replay', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [['data', ['caches/transforms-*/**'], hard, 'aggregate', null, 'default']],
      ],
      'scaffold-last-unit-',
      1,
    );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  const unit = 'caches/transforms-4/' + 'a'.repeat(32);
  await f.files('', {
    [unit + '/metadata.bin']: 'metadata',
    [unit + '/results.bin']: 'results',
    [unit + '/transformed/body']: 'body',
  });
  for (const path of [
    unit + '/metadata.bin',
    unit + '/results.bin',
    unit + '/transformed/body',
    unit + '/transformed',
    unit,
  ])
    await utimes(f.store.root.resolve(path), 1, 1);
  const capture = await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  expect(await f.store.root.stat(unit)).toBeNull();
  expect(await f.store.root.stat('caches/transforms-4')).not.toBeNull();
  const reopened = await OwnedStore.bind(f.root, f.store.codec);
  await recoverGc(reopened, { budget: f.budget });
  await executeGc(reopened, { budget: f.budget });
  expect(await reopened.root.stat('caches/transforms-4')).not.toBeNull();
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  const workerSources = await f.store.writeStream(
    'worker-sources',
    { budget: f.budget, partition: null },
    localRecords([]),
  );
  const sources = await WorkerSources.create(
    f.store,
    { observations: capture.reference, gcProgress: state[10], workerSources },
    f.budget,
  );
  await sources.dispose();
});

it('skips unknown local files during the existing walk with bounded warnings and no extra listing', async () => {
  const counts = [];
  for (const width of [4, 16]) {
    const f = await observationFixture('gradle', { role: 'distributed-worker' });
    fixtures.push(f);
    const warnings: string[] = [];
    for (let n = 0; n < width; n++) {
      const base = 'caches/transforms-3/' + n.toString(16).padStart(32, '0');
      await f.files('', { [base + '/transformed/a']: 'a', [base + '/transformed/b']: 'b' });
    }
    const capture = await captureObservations(f.store, {
      budget: f.budget,
      onWarning: (w) => warnings.push(w),
    });
    expect(capture.work.listings).toBe(3 + 2 * width);
    expect(warnings).toHaveLength(Math.min(10, width));
    expect(new Set(warnings).size).toBe(warnings.length);
    for (const w of warnings) expect(w.length).toBeLessThan(310);
    await executeGc(f.store, { budget: f.budget });
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    const workerSources = await f.store.writeStream(
      'worker-sources',
      { budget: f.budget, partition: null },
      localRecords([]),
    );
    const sources = await WorkerSources.create(
      f.store,
      { observations: capture.reference, gcProgress: state[10], workerSources },
      f.budget,
    );
    try {
      expect(sources.work.listings).toBe(3 + 2 * width);
      for await (const event of sources.events(new AbortController().signal))
        expect(event.type).not.toBe('file');
    } finally {
      await sources.dispose();
    }
    counts.push({
      width,
      captureListings: capture.work.listings,
      replayListings: sources.work.listings,
      warnings: warnings.length,
    });
    expect(
      await f.store.root.stat('caches/transforms-3/' + '0'.repeat(32) + '/transformed/a'),
    ).not.toBeNull();
  }
  process.stdout.write('V7_UNKNOWN_LAYOUT_COST ' + JSON.stringify(counts) + '\n');
});
it('does not conceal ambiguous ownership behind the unknown-layout filter', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [
          ['a', ['caches/**'], hard, 'aggregate', null, 'default'],
          ['b', ['caches/**'], hard, 'aggregate', null, 'default'],
        ],
      ],
      'unknown-ambiguous-',
      1,
    );
  const f = await observationFixture('gradle', { role: 'distributed-worker', model });
  fixtures.push(f);
  await f.files('', { 'caches/transforms-3/body': 'unknown' });
  await expect(captureObservations(f.store, { budget: f.budget })).rejects.toThrow(
    'Ambiguous partition ownership',
  );
});
