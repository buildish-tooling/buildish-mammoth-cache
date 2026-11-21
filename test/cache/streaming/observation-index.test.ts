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

import { utimes } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { checkSharedGcMetadata } from '../../../src/cache/streaming/gc-metadata';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { Digest, tuple, type Value } from '../../../src/cache/streaming/encoding';
import { observationFixture, rows } from './observation-fixtures';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(count = 4) {
  const f = await observationFixture();
  fixtures.push(f);
  for (let n = 0; n < count; n++) {
    const path = 'data/f' + String(n).padStart(2, '0');
    await f.files('', { [path]: 'x' });
    await utimes(f.store.root.resolve(path), 1.234, 1.234);
  }
  const observed = await captureObservations(f.store, { budget: f.budget });
  return { ...f, observed };
}
it('binds complete original projection spans and exact selected target identities', async () => {
  const f = await fixture(),
    index = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget });
  try {
    const p = await index.directory('data'),
      span: Value = ['span', index.reference[4], p.node[3], p.node[4]];
    p.release();
    await index.checkParent('data', span);
    const file = await index.file('data/f00');
    try {
      await index.checkFile(file.node[1], file.node[3], file.node[2]);
      await expect(index.checkFile(file.node[1], 'state', file.node[2])).rejects.toThrow();
    } finally {
      file.release();
    }
    await expect(
      index.checkParent('data', ['span', 'b'.repeat(64), tuple(span)[2], tuple(span)[3]]),
    ).rejects.toThrow('Foreign');
    await expect(
      index.checkParent('data', [
        'span',
        index.reference[4],
        Number(tuple(span)[2]) + 1,
        tuple(span)[3],
      ]),
    ).rejects.toThrow('complete original');
    await expect(index.checkParent('', span)).rejects.toThrow('complete original');
    await expect(index.checkParent('missing', span)).rejects.toThrow();
  } finally {
    await index.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('validates full observation Q/EOF and rejects corrupt byte references', async () => {
  const f = await fixture(),
    ref = [...f.observed.reference] as typeof f.observed.reference;
  ref[4] = 'c'.repeat(64);
  await expect(ObservationIndex.open(f.store, ref, { budget: f.budget })).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('refuses to retire metadata with active readers and permits explicit cleanup after release', async () => {
  const f = await fixture(),
    index = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget }),
    lease = await index.directory('data');
  await expect(index.dispose()).rejects.toThrow('active readers');
  await expect(index.directory('data')).rejects.toThrow('Unavailable');
  lease.release();
  await index.dispose();
  expect(f.budget.retained).toBe(0);
});
it('indexes once and shares projection rows across growing hot-parent targets and independent reloads', async () => {
  const measurements: { rows: number; bytes: number; reads: number }[] = [];
  for (const count of [4, 16]) {
    const f = await fixture(count);
    let previous: number | undefined;
    for (const restart of [false, true]) {
      const store = restart ? await OwnedStore.bind(f.root, f.store.codec) : f.store,
        seen = vi.spyOn(store, 'rows'),
        index = await ObservationIndex.open(store, f.observed.reference, { budget: f.budget }),
        parent = await index.directory('data'),
        span: Value = ['span', index.reference[4], parent.node[3], parent.node[4]];
      parent.release();
      const data: Value[] = [['gc-context', index.reference]];
      try {
        for (let n = 0; n < count; n++) {
          const path = 'data/f' + String(n).padStart(2, '0'),
            file = await index.file(path);
          try {
            await index.checkParent('data', span);
            await index.checkFile(path, 'data', file.node[2]);
            const unit: Value[] = [
              ['gc-unit-open', 'file', path, 'file'],
              ['gc-parent', 'data', span],
              ['target', path, 'data', file.node[2]],
            ];
            data.push(...unit, [
              'gc-unit-close',
              'file',
              path,
              unit.reduce((h, r) => h.update(r), new Digest('gc-unit')).digest(),
            ]);
          } finally {
            file.release();
          }
        }
        const q = await store.writeStream(
          'gc-evidence',
          { budget: f.budget, partition: null, gcMode: 'shared' },
          rows(data),
        );
        expect(await checkSharedGcMetadata(index, q)).toEqual({ units: count, targets: count });
        let projections = 0,
          records = 0;
        await store.readStream(
          q,
          'gc-evidence',
          { budget: f.budget, partition: null, gcMode: 'shared' },
          async (r) => {
            records++;
            if (tuple(r)[0] === 'gc-parent') projections++;
          },
        );
        expect(records).toBe(4 * count + 3);
        expect(projections).toBe(count);
        expect(seen.mock.calls.filter((call) => call[1] === 'observations')).toHaveLength(1);
        if (previous !== undefined) expect(index.rows).toBe(previous);
        previous = index.rows;
        if (!restart)
          measurements.push({
            rows: index.rows,
            bytes: index.work.readBytes,
            reads: index.work.reads,
          });
      } finally {
        seen.mockRestore();
        await index.dispose();
      }
      expect(f.budget.retained).toBe(0);
    }
  }
  expect(measurements[1].rows - measurements[0].rows).toBe(24);
  expect(measurements[1].bytes).toBeLessThan(measurements[0].bytes * 5);
  expect(measurements[1].reads).toBeLessThan(measurements[0].reads * 5);
});

it.each(['span', 'context', 'identity', 'missing', 'unknown'] as const)(
  'rejects shared evidence %s against complete original metadata',
  async (what) => {
    const f = await fixture(),
      index = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget }),
      parent = await index.directory('data'),
      span: Value[] = ['span', index.reference[4], parent.node[3], parent.node[4]],
      file = await index.file('data/f00');
    parent.release();
    const context = [...index.reference],
      native = [...file.node[2]];
    file.release();
    if (what === 'span') span[3] = Number(span[3]) - 1;
    if (what === 'context') context[2] = index.store.prefix + 'files/foreign';
    if (what === 'identity') native[4] = '999999';
    const unit: Value[] = [
      ['gc-unit-open', 'file', 'data/f00', 'file'],
      ['gc-parent', 'data', span],
    ];
    if (what !== 'missing') unit.push(['target', 'data/f00', 'data', native]);
    const digest = unit.reduce((d, row) => d.update(row), new Digest('gc-unit')).digest();
    try {
      if (what === 'unknown') {
        // A nonmatching original root cannot be substituted even with a valid seal.
        unit[0] = ['gc-unit-open', 'file', 'data/unknown', 'file'];
        if (unit[2]) unit[2] = ['target', 'data/unknown', 'data', native];
      }
      const seal =
          what === 'unknown'
            ? unit.reduce((d, row) => d.update(row), new Digest('gc-unit')).digest()
            : digest,
        q = await f.store.writeStream(
          'gc-evidence',
          { budget: f.budget, partition: null, gcMode: 'shared' },
          rows([
            ['gc-context', context],
            ...unit,
            ['gc-unit-close', 'file', what === 'unknown' ? 'data/unknown' : 'data/f00', seal],
          ]),
        );
      await expect(checkSharedGcMetadata(index, q)).rejects.toThrow();
    } finally {
      await index.dispose();
    }
    expect(f.budget.retained).toBe(0);
  },
);

it('requires all complete-workspace targets and selected child cleanup before parent cleanup', async () => {
  const f = await observationFixture('gradle');
  fixtures.push(f);
  const root = 'caches/transforms-4/' + 'a'.repeat(32);
  for (const name of ['metadata.bin', 'results.bin', 'transformed/a']) {
    const path = root + '/' + name;
    await f.files('', { [path]: 'x' });
    await utimes(f.store.root.resolve(path), 1.234, 1.234);
  }
  const observed = await captureObservations(f.store, { budget: f.budget }),
    index = await ObservationIndex.open(f.store, observed.reference, { budget: f.budget });
  async function parent(path: string): Promise<Value> {
    const p = await index.directory(path);
    try {
      return ['gc-parent', path, ['span', index.reference[4], p.node[3], p.node[4]]];
    } finally {
      p.release();
    }
  }
  async function target(path: string, dir = false): Promise<Value> {
    const p = dir ? await index.directory(path) : await index.file(path);
    try {
      return ['target', path, 'data', p.node[2]];
    } finally {
      p.release();
    }
  }
  const complete: Value[] = [
    await parent(root),
    await target(root + '/metadata.bin'),
    await target(root + '/results.bin'),
    await parent(root + '/transformed'),
    await target(root + '/transformed/a'),
    await target(root + '/transformed', true),
    await target(root, true),
  ];
  try {
    for (const omit of [null, 1, 5]) {
      const body = complete.filter((_, n) => n !== omit),
        unit: Value[] = [['gc-unit-open', 'artifact-transform', root, 'subtree'], ...body],
        sha = unit.reduce((d, r) => d.update(r), new Digest('gc-unit')).digest(),
        q = await f.store.writeStream(
          'gc-evidence',
          { budget: f.budget, partition: null, gcMode: 'shared' },
          rows([
            ['gc-context', index.reference],
            ...unit,
            ['gc-unit-close', 'artifact-transform', root, sha],
          ]),
        );
      if (omit === null)
        expect(await checkSharedGcMetadata(index, q)).toEqual({ units: 1, targets: 5 });
      else await expect(checkSharedGcMetadata(index, q)).rejects.toThrow();
    }
  } finally {
    await index.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it.each(['dispose', 'lookup'] as const)(
  'preserves an active page load against competing %s',
  async (action) => {
    const f = await fixture(),
      index = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget }),
      children = ObservationIndex.prototype.children;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    vi.spyOn(ObservationIndex.prototype, 'children').mockImplementation(async function* (
      this: ObservationIndex,
      node,
    ) {
      for await (const row of children.call(this, node)) {
        if (this === index) {
          entered();
          await gate;
        }
        yield row;
      }
    });
    const load = index.file('data/f00');
    await started;
    try {
      if (action === 'dispose') await expect(index.dispose()).rejects.toThrow('lookup active');
      else await expect(index.directory('')).rejects.toThrow('lookup active');
    } finally {
      release();
    }
    const lease = await load;
    expect(lease.node[1]).toBe('data/f00');
    lease.release();
    const next = await index.file('data/f01');
    next.release();
    await index.dispose();
    expect(f.budget.retained).toBe(0);
  },
);
