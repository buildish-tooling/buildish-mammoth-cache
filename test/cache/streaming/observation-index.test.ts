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
import { GcProgram } from '../../../src/cache/streaming/gc-program';
import { GcSurvivorOwner } from '../../../src/cache/streaming/gc-execute';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { Digest, tuple, type Value } from '../../../src/cache/streaming/encoding';
import { observationFixture, rows } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
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
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('validates full observation Q/EOF and rejects corrupt byte references', async () => {
  const f = await fixture(),
    ref = [...f.observed.reference] as typeof f.observed.reference;
  ref[4] = 'c'.repeat(64);
  await expect(ObservationIndex.open(f.store, ref, { budget: f.budget })).rejects.toThrow();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('does not certify an empty selected Maven unit as retained-only', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', { repository: null });
  const native = (await f.store.root.stat('repository'))!,
    digest = new Digest('observation-unit');
  digest.update(['directory', 'repository', native]);
  const sha = digest.digest();
  const index = await ObservationIndex.write(
    f.store,
    rows([
      ['dir-open', '', f.store.root.binding],
      ['child', 'repository', 'directory', native[3], native[4]],
      ['dir-open', 'repository', native],
      ['unit-open', 'maven-directory', 'repository', 'direct', 'none', 'delete', sha],
      ['unit-close', 'maven-directory', 'repository', sha],
      ['dir-close', 'repository'],
      ['dir-close', ''],
    ]),
    { budget: f.budget },
  );
  try {
    expect(index.hasGcSelections).toBe(true);
    await expect(index.completedWithoutGcSelections(new AbortController().signal)).rejects.toThrow(
      'retained-only observation completion',
    );
    const program = await GcProgram.create(index);
    try {
      expect(program.final).toEqual(index.completed);
    } finally {
      await program.close();
    }
  } finally {
    await index.dispose();
  }
  await f.finish();
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
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it.each([4, 16])(
  'uses original captured index for %s shared-parent targets; copied facts cannot grant GC authority',
  async (count) => {
    const f = await fixture(count),
      original = f.observed.index!,
      builds = f.store.root.work.indexBuilds;
    const program = await GcProgram.create(original, { operations: 2, bytes: 65536 });
    try {
      let targets = 0,
        parents = 0;
      for await (const row of program.batches.rows(0, program.batches.position)) {
        const b = tuple(row);
        for await (const value of program.evidence(Number(b[1]), Number(b[2]))) {
          const r = tuple(value);
          if (r[0] === 'target') {
            targets++;
          }
          if (r[0] === 'gc-parent') {
            parents++;
          }
        }
      }
      expect(targets).toBe(count);
      expect(parents).toBe(count);
      expect(f.store.root.work.indexBuilds).toBe(builds);
    } finally {
      await program.close();
    }
    const replay = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget });
    await expect(GcSurvivorOwner.execute(replay, { budget: f.budget })).rejects.toThrow(
      'original observation capture',
    );
    await replay.dispose();
    await f.finish();
    expect(f.budget.retained).toBe(0);
  },
);
