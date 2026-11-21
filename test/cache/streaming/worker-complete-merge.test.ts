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

import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  completeFixture,
  completeArchive,
  cleanupCompleteFixtures,
  preparedSnapshotFixture,
} from './worker-complete-fixtures';
import { mergeWorkerArchives as rawMerge } from '../../../src/cache/streaming/worker-merge';
import { tuple, type Value } from '../../../src/cache/streaming/encoding';
import { ActivityProjection } from '../../../src/cache/streaming/worker-activity';
import { PreparedWorkerSnapshot } from '../../../src/cache/streaming/worker-snapshot';
import { byteSource } from './protocol-fixtures';
const results: Awaited<ReturnType<typeof rawMerge>>[] = [];
afterEach(async () => {
  for (const result of results.splice(0)) await result.dispose();
  vi.restoreAllMocks();
  await cleanupCompleteFixtures();
});
async function mergeWorkerArchives(...args: Parameters<typeof rawMerge>) {
  const result = await rawMerge(...args);
  results.push(result);
  return result;
}
const signal = () => new AbortController().signal;
async function facts(result: Awaited<ReturnType<typeof rawMerge>>, partition = 'data') {
  const rows: Value[] = [];
  for await (const r of result.partitions
    .find((p) => p.partition === partition)!
    .facts.rows(signal()))
    rows.push(r);
  return rows.map((r) => tuple(r));
}
const root = 'caches/transforms-4/' + 'a'.repeat(32);
const transform = (tail: Record<string, string | null>) => ({
  [root + '/metadata.bin']: 'metadata',
  [root + '/results.bin']: 'result',
  ...Object.fromEntries(Object.entries(tail).map(([p, b]) => [root + '/transformed/' + p, b])),
});
it('chooses whole ordinal workspace producer and independently hashes opposing losing file/directory shapes', async () => {
  const f = await completeFixture('gradle', 'choose-worker-directory'),
    b = await completeArchive(f, 'B', transform({ 'x/child': 'loser' })),
    a = await completeArchive(f, 'A', transform({ x: 'winner' }));
  const result = await mergeWorkerArchives(f.store, [b, a], {
    budget: f.budget,
    ordinaryOrder: ['B', 'A'],
    ordinaryPolicy: 'newer-mtime',
  });
  expect(
    await readFile(
      f.store.root.resolve(result.partitions[0].nativeRoot + '/' + root + '/transformed/x'),
      'utf8',
    ),
  ).toBe('winner');
  expect(result.warnings.count).toBe(1);
  expect((await facts(result)).map((r) => r[1])).not.toContain(root + '/transformed/x/child');
  expect(result.readers.map((r) => r.work.files)).toEqual([3, 3]);
  expect(result.stage.work.files).toBe(3);
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('keeps workspace strictness even when ordinary newer-mtime is enabled', async () => {
  const f = await completeFixture(),
    a = await completeArchive(f, 'A', transform({ x: 'winner' })),
    b = await completeArchive(f, 'B', transform({ 'x/child': 'loser' }));
  await expect(
    mergeWorkerArchives(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'newer-mtime',
    }),
  ).rejects.toThrow(/complete-unit/);
  expect(f.budget.retained).toBe(0);
});
it.each(['default', 'choose-worker-directory'] as const)(
  'reconciles Maven portable metadata only for strict equivalent units (%s)',
  async (policy) => {
    const f = await completeFixture('maven', policy),
      name = 'repository/g/a/1/a.jar',
      marker = 'repository/g/a/1/_remote.repositories';
    const a = await completeArchive(f, 'A', {
        [name]: { body: 'same', mode: 0o644, time: 1000 },
        [marker]: 'origin',
      }),
      b = await completeArchive(f, 'B', {
        [name]: { body: 'same', mode: 0o755, time: 2000 },
        [marker]: 'origin',
      });
    const result = await mergeWorkerArchives(f.store, [b, a], {
        budget: f.budget,
        ordinaryOrder: ['B', 'A'],
        ordinaryPolicy: 'strict',
      }),
      file = (await facts(result)).find((r) => r[1] === name)!;
    expect(file.slice(6)).toEqual(policy === 'default' ? [0o755, 2000] : [0o644, 1000]);
    expect(result.warnings.count).toBe(0);
    expect(result.stage.work.files).toBe(2);
    await result.dispose();
    expect(f.budget.retained).toBe(0);
  },
);
it('uses ordinal entry winners and preserves contributions when another producer lacks a path', async () => {
  const f = await completeFixture('gradle', 'choose-worker-entry'),
    base = 'caches/build-cache-1/',
    a = await completeArchive(f, 'A', { [base + 'x']: 'first' }),
    b = await completeArchive(f, 'B', {
      [base + 'x']: { body: 'second', time: 9999 },
      [base + 'unique']: 'unique',
    });
  const result = await mergeWorkerArchives(f.store, [b, a], {
    budget: f.budget,
    ordinaryOrder: ['B', 'A'],
    ordinaryPolicy: 'newer-mtime',
  });
  expect(
    await readFile(
      f.store.root.resolve(result.partitions[0].nativeRoot + '/' + base + 'x'),
      'utf8',
    ),
  ).toBe('first');
  expect(
    await readFile(
      f.store.root.resolve(result.partitions[0].nativeRoot + '/' + base + 'unique'),
      'utf8',
    ),
  ).toBe('unique');
  expect(result.warnings.count).toBe(1);
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('aligns different snapshot lists by global model key and accepts authoritative empty snapshots', async () => {
  const f = await completeFixture('gradle', 'default', true),
    a = await completeArchive(f, 'A', { 'data/a': 'a' }, [], { other: { 'other/x': 'x' } }),
    b = await completeArchive(f, 'B', {}, [], { state: {} });
  const result = await mergeWorkerArchives(f.store, [a, b], {
    budget: f.budget,
    ordinaryOrder: ['A'],
    ordinaryPolicy: 'strict',
    snapshots: [
      { partition: 'state', job: 'B', required: true },
      { partition: 'other', job: 'A', required: true },
    ],
  });
  expect(result.selectedSnapshots).toEqual(['state', 'other']);
  expect(result.partitions.map((p) => p.partition).sort()).toEqual(['data', 'other', 'state']);
  expect(await facts(result, 'state')).toEqual([]);
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('validates but ignores aggregate and usage from snapshot-only discovery producers', async () => {
  const f = await completeFixture('gradle', 'default', true),
    a = await completeArchive(f, 'A', { 'data/a': 'a' }, [], { other: {} }),
    b = await completeArchive(
      f,
      'B',
      { 'data/a': 'must not conflict', 'data/b': 'ignored' },
      ['data/used'],
      { state: { 'state/x': 'snapshot' } },
    );
  const result = await mergeWorkerArchives(f.store, [b, a], {
    budget: f.budget,
    ordinaryOrder: ['A'],
    ordinaryPolicy: 'strict',
    snapshots: [
      { partition: 'state', job: 'B', required: true },
      { partition: 'other', job: 'A', required: true },
    ],
  });
  expect((await facts(result)).map((r) => r[1])).toEqual(['data/a']);
  const activity: Value[] = [];
  for (const projection of result.activity)
    for await (const r of projection.spool.rows(signal())) activity.push(r);
  expect(activity.some((r) => tuple(r)[1] === 'used')).toBe(false);
  expect(result.readers[0].work.bodyBytes).toBeGreaterThan(result.stage.work.bodyBytes - 1);
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('preserves optional absence but never drops an admitted optional archive failing late', async () => {
  const f = await completeFixture('gradle', 'default', true),
    a = await completeArchive(f, 'A', { 'data/a': 'a' }, [], { other: {} });
  let verified = 0;
  const baseline = await preparedSnapshotFixture(f, 'state');
  const verify = PreparedWorkerSnapshot.prototype.verify;
  vi.spyOn(PreparedWorkerSnapshot.prototype, 'verify').mockImplementation(async function (
    this: PreparedWorkerSnapshot,
    ...args
  ) {
    if (this === baseline) verified++;
    await verify.apply(this, args);
  });
  const options = {
    budget: f.budget,
    ordinaryOrder: ['A'],
    ordinaryPolicy: 'strict' as const,
    snapshots: [
      { partition: 'state', job: 'B', required: false, baseline },
      { partition: 'other', job: 'A', required: true },
    ],
  };
  const first = await mergeWorkerArchives(f.store, [a], options);
  expect(first.inheritedSnapshots).toEqual([baseline]);
  expect(verified).toBe(1);
  await first.dispose();
  const aa = await completeArchive(f, 'A', { 'data/a': 'a' }, [], { other: {} }),
    b = await completeArchive(f, 'B', {}, [], { state: { 'state/x': 'x' } });
  b.bytes[b.bytes.length - 8] ^= 1;
  await expect(
    mergeWorkerArchives(f.store, [aa, { ...b, source: byteSource(b.bytes) }], options),
  ).rejects.toThrow();
  expect(verified).toBe(1);
  expect(f.budget.retained).toBe(0);
});

it('retains nested all-empty selected workspace subtrees alongside required root markers', async () => {
  const f = await completeFixture('gradle', 'choose-worker-directory'),
    a = await completeArchive(
      f,
      'A',
      transform({ 'a-empty/deeper': null, 'b-empty': null, 'z-files/file': 'file' }),
    ),
    b = await completeArchive(
      f,
      'B',
      transform({ 'a-empty/deeper': null, 'b-empty': null, 'z-files/file': 'file' }),
    );
  const result = await mergeWorkerArchives(f.store, [b, a], {
      budget: f.budget,
      ordinaryOrder: ['B', 'A'],
      ordinaryPolicy: 'strict',
    }),
    part = result.partitions[0];
  for (const dir of ['a-empty', 'a-empty/deeper', 'b-empty'])
    expect(
      (await f.store.root.stat(part.nativeRoot + '/' + root + '/transformed/' + dir))?.[2],
    ).toBe('directory');
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('rejects a missing required snapshot without granting native authority', async () => {
  const f = await completeFixture('gradle', 'default', true),
    a = await completeArchive(f, 'A', { 'data/a': 'a' }, [], { other: {} });
  await expect(
    mergeWorkerArchives(f.store, [a], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
      snapshots: [
        { partition: 'state', job: 'B', required: true },
        { partition: 'other', job: 'A', required: true },
      ],
    }),
  ).rejects.toThrow('Missing required snapshot');
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBe(null);
  expect(f.budget.retained).toBe(0);
});

it('rejects an admitted optional writer omitting its selected snapshot instead of inheriting', async () => {
  const f = await completeFixture('gradle', 'default', true),
    a = await completeArchive(f, 'A', {}, [], { other: {} }),
    b = await completeArchive(f, 'B');
  let baselineCalls = 0;
  const baseline = await preparedSnapshotFixture(f, 'state');
  const verify = PreparedWorkerSnapshot.prototype.verify;
  vi.spyOn(PreparedWorkerSnapshot.prototype, 'verify').mockImplementation(async function (
    this: PreparedWorkerSnapshot,
    ...args
  ) {
    if (this === baseline) baselineCalls++;
    await verify.apply(this, args);
  });
  await expect(
    mergeWorkerArchives(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
      snapshots: [
        { partition: 'state', job: 'B', required: false, baseline },
        { partition: 'other', job: 'A', required: true },
      ],
    }),
  ).rejects.toThrow('Admitted snapshot writer omitted');
  expect(baselineCalls).toBe(0);
  expect(f.budget.retained).toBe(0);
});

it('cancels a pending prepared-baseline verification and validates activity limits before storage', async () => {
  const f = await completeFixture('gradle', 'default', true);
  await expect(ActivityProjection.create(f.store, f.budget, 0)).rejects.toThrow('allowance');
  expect(await f.store.root.stat(f.store.prefix + 'planning')).toBe(null);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    controller = new AbortController();
  const baseline = await preparedSnapshotFixture(f, 'state');
  const verify = PreparedWorkerSnapshot.prototype.verify;
  vi.spyOn(PreparedWorkerSnapshot.prototype, 'verify').mockImplementation(async function (
    this: PreparedWorkerSnapshot,
    ...args
  ) {
    if (this === baseline) {
      entered();
      await new Promise<never>(() => {});
    } else await verify.apply(this, args);
  });
  const pending = mergeWorkerArchives(f.store, [], {
    budget: f.budget,
    ordinaryOrder: [],
    ordinaryPolicy: 'strict',
    signal: controller.signal,
    snapshots: [
      { partition: 'state', job: 'B', required: false, baseline },
      { partition: 'other', job: 'A', required: true },
    ],
  });
  await started;
  controller.abort(new Error('cancelled fallback'));
  await expect(pending).rejects.toThrow('cancelled fallback');
  expect(f.budget.retained).toBe(0);
});
