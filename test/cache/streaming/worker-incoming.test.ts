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

import { mkdir, writeFile, readFile, rmdir, chmod, readdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  completeFixture,
  completeArchive,
  cleanupCompleteFixtures,
  initializeCompleteFixture,
} from './worker-complete-fixtures';
import { mergeWorkerArchives } from '../../../src/cache/streaming/worker-merge';
import {
  acceptWorkerMerge,
  installWorkerMerge,
} from '../../../src/cache/streaming/worker-incoming';
import { recoverInstall } from '../../../src/cache/streaming/install-execute';
import { tuple, type Value } from '../../../src/cache/streaming/encoding';
import { WorkerStage } from '../../../src/cache/streaming/worker-stage';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { resolveModel } from '../../../src/cache/streaming/model';
import { NativeRoot } from '../../../src/cache/streaming/native';
const results: Awaited<ReturnType<typeof mergeWorkerArchives>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of results.splice(0)) await r.dispose();
  await cleanupCompleteFixtures();
});
async function merge(...args: Parameters<typeof mergeWorkerArchives>) {
  const result = await mergeWorkerArchives(...args);
  results.push(result);
  return result;
}
const signal = () => new AbortController().signal;
async function activity(f: Awaited<ReturnType<typeof completeFixture>>, q: Value) {
  const rows: Value[] = [];
  for await (const row of f.store.rows(q, 'activity', { budget: f.budget, partition: null }))
    if (!['local-stream', 'local-end'].includes(String(tuple(row.value)[0]))) rows.push(row.value);
  return rows;
}
it('unions usage, suppresses selected upserts and installs through actual V4a without hashing selected bodies again', async () => {
  const f = await completeFixture();
  await initializeCompleteFixture(f, ['A', 'B']);
  const a = await completeArchive(f, 'A', { 'data/x': 'same' }, ['data/read', 'data/hit']),
    b = await completeArchive(f, 'B', { 'data/x': 'same', 'data/hit': 'hit' }, [
      'data/read',
      'data/other',
    ]);
  const result = await merge(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    }),
    hash = vi.spyOn(NativeRoot.prototype, 'hash'),
    accepted = await acceptWorkerMerge(f.store, result, f.budget);
  expect(accepted.incoming[0].nativeRoot).toBe(f.store.prefix + 'install/data');
  expect(accepted.work.activityDirectoryListings).toBe(2);
  expect(await f.store.root.stat('data/x')).toBe(null);
  const rows = await activity(f, accepted.activity);
  expect(rows).toContainEqual(['upsert', 'x', 'data']);
  expect(rows).toContainEqual(['upsert', 'hit', 'data']);
  expect(rows.filter((r) => tuple(r)[0] === 'used' && tuple(r)[1] === 'read')).toHaveLength(1);
  expect(rows).not.toContainEqual(['used', 'hit', 'data']);
  expect(hash).not.toHaveBeenCalled();
  hash.mockRestore();
  await installWorkerMerge(f.store, accepted, f.budget);
  expect(await readFile(f.store.root.resolve('data/x'), 'utf8')).toBe('same');
  expect(await readFile(f.store.root.resolve('data/hit'), 'utf8')).toBe('hit');
  expect(tuple(await f.store.state())[4]).toBe('prepare-pending');
  expect(f.budget.retained).toBe(0);
});
it('suppresses whole workspace usage including absent winner members before complete-unit replacement', async () => {
  const f = await completeFixture(),
    root = 'caches/transforms-4/' + 'a'.repeat(32),
    files = {
      [root + '/metadata.bin']: 'm',
      [root + '/results.bin']: 'r',
      [root + '/transformed/winner']: 'winner',
    };
  await mkdir(f.store.root.resolve(root + '/transformed'), { recursive: true });
  await writeFile(f.store.root.resolve(root + '/transformed/stale'), 'old');
  await initializeCompleteFixture(f, ['A', 'B']);
  const a = await completeArchive(f, 'A', files),
    b = await completeArchive(f, 'B', {}, [
      root + '/metadata.bin',
      root + '/results.bin',
      root + '/transformed/absent',
    ]);
  const result = await merge(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    }),
    accepted = await acceptWorkerMerge(f.store, result, f.budget),
    rows = await activity(f, accepted.activity);
  expect(rows.some((r) => tuple(r)[0] === 'used')).toBe(false);
  await installWorkerMerge(f.store, accepted, f.budget);
  expect(await f.store.root.stat(root + '/transformed/stale')).toBe(null);
  expect(await readFile(f.store.root.resolve(root + '/transformed/winner'), 'utf8')).toBe('winner');
  expect(f.budget.retained).toBe(0);
});
it('retains independent snapshot copies across authoritative installation including an empty partition', async () => {
  const f = await completeFixture('gradle', 'default', true);
  await mkdir(f.store.root.resolve('other'), { recursive: true });
  await writeFile(f.store.root.resolve('other/stale'), 'old');
  await initializeCompleteFixture(f, ['A']);
  const a = await completeArchive(f, 'A', { 'data/a': 'a' }, [], {
      state: { 'state/x': 'x' },
      other: {},
    }),
    result = await merge(f.store, [a], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
      snapshots: [
        { partition: 'state', job: 'A', required: true },
        { partition: 'other', job: 'A', required: true },
      ],
    }),
    accepted = await acceptWorkerMerge(f.store, result, f.budget);
  expect(accepted.snapshots).toHaveLength(2);
  expect(accepted.work.snapshotCopyBytes).toBe(1);
  const retained = accepted.snapshots.find((s) => s.partition === 'state')!;
  expect(retained.nativeRoot.startsWith(f.store.prefix + 'snapshots/')).toBe(true);
  const before = (await f.store.root.stat(retained.nativeRoot + '/state/x'))!,
    incoming = (await f.store.root.stat(f.store.prefix + 'install/state/state/x'))!;
  expect(before[4]).not.toBe(incoming[4]);
  await installWorkerMerge(f.store, accepted, f.budget);
  expect(await f.store.root.stat('other/stale')).toBe(null);
  expect(await readFile(f.store.root.resolve('state/x'), 'utf8')).toBe('x');
  expect(await readFile(f.store.root.resolve(retained.nativeRoot + '/state/x'), 'utf8')).toBe('x');
  await retained.verify(signal());
  expect(f.budget.retained).toBe(0);
});
it.each(['file', 'directory'])(
  'rejects changed selected %s identity and rolls back unpublished install roots',
  async (kind) => {
    const f = await completeFixture();
    await initializeCompleteFixture(f, ['A']);
    const a = await completeArchive(f, 'A', { 'data/x': 'x', 'data/empty': null }),
      result = await merge(f.store, [a], {
        budget: f.budget,
        ordinaryOrder: ['A'],
        ordinaryPolicy: 'strict',
      }),
      part = result.partitions[0];
    if (kind === 'file')
      await writeFile(f.store.root.resolve(part.nativeRoot + '/data/x'), 'tampered');
    else {
      await rmdir(f.store.root.resolve(part.nativeRoot + '/data/empty'));
      await mkdir(f.store.root.resolve(part.nativeRoot + '/data/empty'));
    }
    await expect(acceptWorkerMerge(f.store, result, f.budget)).rejects.toThrow(/Selected worker/);
    expect(await f.store.root.stat('data/x')).toBe(null);
    expect(await f.store.root.stat(f.store.prefix + 'install/data')).toBe(null);
    expect(f.budget.retained).toBe(0);
  },
);
it('preserves adopted source ownership when V4a is interrupted and recovers its recorded batch', async () => {
  const f = await completeFixture();
  await initializeCompleteFixture(f, ['A']);
  const a = await completeArchive(f, 'A', { 'data/a': 'a', 'data/b': 'b' }),
    result = await merge(f.store, [a], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
    }),
    accepted = await acceptWorkerMerge(f.store, result, f.budget);
  const spy = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'install-source-renamed') throw new Error('interrupted install');
  });
  await expect(installWorkerMerge(f.store, accepted, f.budget)).rejects.toThrow('interrupted');
  spy.mockRestore();
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBe(null);
  await result.dispose();
  await recoverInstall(f.store, f.budget);
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
  expect(await readFile(f.store.root.resolve('data/b'), 'utf8')).toBe('b');
  expect(f.budget.retained).toBe(0);
});

it.each(['selected-file', 'selected-directory'])(
  'suppresses usage with incompatible %s topology before actual install',
  async (kind) => {
    const f = await completeFixture();
    await initializeCompleteFixture(f, ['A', 'B', 'C']);
    const selected: Record<string, string> =
        kind === 'selected-file' ? { 'data/x': 'file' } : { 'data/x/child': 'child' },
      used = kind === 'selected-file' ? ['data/x/child'] : ['data/x'];
    const a = await completeArchive(f, 'A', selected),
      b = await completeArchive(f, 'B', {}, used),
      c = await completeArchive(
        f,
        'C',
        {},
        kind === 'selected-file' ? ['data/read'] : ['data/x/old'],
      ),
      result = await merge(f.store, [a, b, c], {
        budget: f.budget,
        ordinaryOrder: ['A', 'B', 'C'],
        ordinaryPolicy: 'strict',
      }),
      accepted = await acceptWorkerMerge(f.store, result, f.budget),
      rows = await activity(f, accepted.activity);
    expect(rows).not.toContainEqual(['used', kind === 'selected-file' ? 'child' : 'x', 'data']);
    if (kind === 'selected-directory') expect(rows).toContainEqual(['used', 'old', 'data']);
    await installWorkerMerge(f.store, accepted, f.budget);
    expect(
      await readFile(
        f.store.root.resolve(kind === 'selected-file' ? 'data/x' : 'data/x/child'),
        'utf8',
      ),
    ).toBe(kind === 'selected-file' ? 'file' : 'child');
    expect(f.budget.retained).toBe(0);
  },
);
it('suppresses direct Maven usage without suppressing independent descendant coordinate usage', async () => {
  const f = await completeFixture('maven');
  await initializeCompleteFixture(f, ['A', 'B']);
  const base = 'repository/g/a/1/',
    a = await completeArchive(f, 'A', {
      [base + 'a.jar']: 'jar',
      [base + '_remote.repositories']: 'origin',
    }),
    b = await completeArchive(f, 'B', {}, [base + 'absent.jar', base + 'child/used.jar']);
  const result = await merge(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    }),
    accepted = await acceptWorkerMerge(f.store, result, f.budget),
    rows = await activity(f, accepted.activity);
  expect(rows).not.toContainEqual(['used', 'absent.jar', 'data']);
  expect(rows).toContainEqual(['used', 'used.jar', 'data']);
  await installWorkerMerge(f.store, accepted, f.budget);
  expect(await readFile(f.store.root.resolve(base + 'a.jar'), 'utf8')).toBe('jar');
  expect(f.budget.retained).toBe(0);
});
it('rejects cross-channel Maven publication claims before any incoming namespace is published', async () => {
  const f = await completeFixture('maven'),
    hard = ['.mammoth/**'];
  f.model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['repository/**/*.jar'], hard, 'aggregate', null, 'default'],
        ['origins', ['repository/**/_remote.repositories'], hard, 'single-writer', 'A', 'default'],
      ],
    ],
    'mixed-',
    1,
  );
  f.store = await OwnedStore.bind(
    f.root,
    new LocalCodec({ ...f.store.codec.options, model: f.model }),
  );
  await initializeCompleteFixture(f, ['B']);
  const base = 'repository/g/a/1/',
    a = await completeArchive(f, 'A', {}, [], {
      origins: { [base + '_remote.repositories']: 'origin' },
    }),
    b = await completeArchive(f, 'B', { [base + 'a.jar']: 'jar' }),
    result = await merge(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['B'],
      ordinaryPolicy: 'strict',
      snapshots: [{ partition: 'origins', job: 'A', required: true }],
    });
  await expect(acceptWorkerMerge(f.store, result, f.budget)).rejects.toThrow(
    'Mixed Maven publication',
  );
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBe(null);
  expect(f.budget.retained).toBe(0);
});
it('rejects unexplained root ctime changes before attributing its own publication rename', async () => {
  const f = await completeFixture();
  await initializeCompleteFixture(f, ['A']);
  const a = await completeArchive(f, 'A', { 'data/x': 'x' }),
    result = await merge(f.store, [a], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
    }),
    part = result.partitions[0],
    original = part.rootNative!;
  let changed = false;
  const spy = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'immutable-publication-barrier' && !changed) {
      changed = true;
      await chmod(f.store.root.resolve(part.nativeRoot), 0o555);
      await chmod(f.store.root.resolve(part.nativeRoot), original[6] & 0o777);
    }
  });
  try {
    await expect(acceptWorkerMerge(f.store, result, f.budget)).rejects.toThrow(
      'root changed before publication',
    );
    expect(changed).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(await f.store.root.stat('data/x')).toBe(null);
  expect(await f.store.root.stat(f.store.prefix + 'install/data')).toBe(null);
  expect(f.budget.retained).toBe(0);
});
it('returns no accepted result after post-adopt cleanup failure and preserves unclaimed published sources', async () => {
  const f = await completeFixture('gradle', 'default', true);
  await initializeCompleteFixture(f, ['A']);
  const a = await completeArchive(f, 'A', { 'data/x': 'x' }, [], {
      state: { 'state/y': 'y' },
      other: {},
    }),
    result = await merge(f.store, [a], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
      snapshots: [
        { partition: 'state', job: 'A', required: true },
        { partition: 'other', job: 'A', required: true },
      ],
    });
  const adopt = WorkerStage.prototype.adopt,
    dispose = WorkerStage.prototype.dispose;
  let adopted = false,
    injected = false;
  const aSpy = vi.spyOn(WorkerStage.prototype, 'adopt').mockImplementation(function (
      this: WorkerStage,
    ) {
      adopt.call(this);
      if (this === result.stage) adopted = true;
    }),
    dSpy = vi.spyOn(WorkerStage.prototype, 'dispose').mockImplementation(async function (
      this: WorkerStage,
    ) {
      if (this === result.stage && adopted && !injected) {
        injected = true;
        throw new Error('post-adopt cleanup failure');
      }
      await dispose.call(this);
    });
  try {
    await expect(acceptWorkerMerge(f.store, result, f.budget)).rejects.toThrow(
      'Worker merge cleanup failed',
    );
    expect(injected).toBe(true);
  } finally {
    aSpy.mockRestore();
    dSpy.mockRestore();
  }
  expect(await f.store.root.stat('data/x')).toBe(null);
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).toBe(null);
  expect(await readFile(f.store.root.resolve(f.store.prefix + 'install/data/data/x'), 'utf8')).toBe(
    'x',
  );
  let retained = false;
  for (const id of await readdir(f.store.root.resolve(f.store.prefix + 'snapshots')))
    if (await f.store.root.stat(f.store.prefix + 'snapshots/' + id + '/state/state/y'))
      retained = true;
  expect(retained).toBe(true);
  expect(f.budget.retained).toBe(0);
});

it('rejects opposing usage-only shapes with no selected payload authority before live installation', async () => {
  const f = await completeFixture();
  await initializeCompleteFixture(f, ['A', 'B', 'C']);
  const a = await completeArchive(f, 'A', { 'data/a': 'a' }),
    b = await completeArchive(f, 'B', {}, ['data/x']),
    c = await completeArchive(f, 'C', {}, ['data/x/child']),
    result = await merge(f.store, [a, b, c], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B', 'C'],
      ordinaryPolicy: 'strict',
    });
  await expect(acceptWorkerMerge(f.store, result, f.budget)).rejects.toThrow(/colliding/);
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBe(null);
  expect(f.budget.retained).toBe(0);
});
it('counts one topology listing per selected physical directory as input units grow', async () => {
  for (const count of [2, 8]) {
    const f = await completeFixture();
    await initializeCompleteFixture(f, ['A']);
    const entries = Object.fromEntries(
        Array.from({ length: count }, (_, i) => ['data/d' + i + '/x', 'x']),
      ),
      a = await completeArchive(f, 'A', entries),
      result = await merge(f.store, [a], {
        budget: f.budget,
        ordinaryOrder: ['A'],
        ordinaryPolicy: 'strict',
      }),
      accepted = await acceptWorkerMerge(f.store, result, f.budget);
    expect(accepted.work.activityDirectoryListings).toBe(count + 2);
    expect(f.budget.retained).toBe(0);
  }
});
