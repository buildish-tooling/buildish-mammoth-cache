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

import { utimes, writeFile, unlink, mkdir, readFile, readdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { GcSurvivorOwner } from '../../../src/cache/streaming/gc-execute';
import {
  executeFixtureGc as executeGc,
  captureFixtureObservations as captureObservations,
} from './observation-fixtures';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { Digest } from '../../../src/cache/streaming/encoding';
import { InstallParentPhase } from '../../../src/cache/streaming/install-parent-phase';
import { checkGcProjection } from '../../../src/cache/streaming/gc-projection';
import { observationFixture } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(count = 4, fail?: (name: string) => Promise<void>) {
  const f = await observationFixture('maven', { fail });
  fixtures.push(f);
  for (let n = 0; n < count; n++) {
    const path = 'data/f' + String(n).padStart(2, '0');
    await f.files('', { [path]: 'x' });
    await utimes(f.store.root.resolve(path), 1.234, 1.234);
  }
  const observed = await captureObservations(f.store, { budget: f.budget });
  return { ...f, observed };
}
it('executes shared-parent complete batches and commits the real final root boundary', async () => {
  const f = await fixture(),
    result = await executeGc(f.store, { budget: f.budget, batchOperations: 2 });
  expect(() => result.owner.assert()).not.toThrow();
  expect(result.cursor[3]).toBeGreaterThan(0);
  expect(result.cursor[5]).toBeNull();
  expect(result.work.directories).toBe(2); // One actual-mutation reconciliation over root/data, not a precheck per batch/file.
  for (let n = 0; n < 4; n++) expect(await f.store.root.stat('data/f0' + n)).toBeNull();
  expect(f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[4]).toBe(
    'post-active',
  );
  await f.store.assertNoIntents();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('blocks future planned absences, unknown children, replacements and completed target recreation', async () => {
  const f = await fixture();
  await unlink(f.store.root.resolve('data/f03'));
  await expect(executeGc(f.store, { budget: f.budget })).rejects.toThrow();
  expect(await f.store.root.stat('data/f00')).not.toBeNull();
  const g = await fixture();
  await writeFile(g.store.root.resolve('data/unknown'), 'x');
  await expect(executeGc(g.store, { budget: g.budget })).rejects.toThrow();
  const h = await fixture();
  await unlink(h.store.root.resolve('data/f00'));
  await writeFile(h.store.root.resolve('data/f00'), 'x');
  await expect(executeGc(h.store, { budget: h.budget })).rejects.toThrow();
  const j = await fixture();
  await executeGc(j.store, { budget: j.budget });
  await writeFile(j.store.root.resolve('data/f00'), 'x');
  await expect(GcSurvivorOwner.execute(j.observed.index!, { budget: j.budget })).rejects.toThrow();
  for (const x of [f, g, h, j]) {
    await x.finish();
    expect(x.budget.retained).toBe(0);
  }
});
it('defers Maven origin marker until all ordinary siblings and preserves protected bookkeeping', async () => {
  const deleted: string[] = [];
  const f = await observationFixture('maven', {
    fail: async (name) => {
      if (name !== 'gc-target-deleted') return;
      for (const path of [
        'repository/a/_remote.repositories',
        'repository/a/a.jar',
        'repository/a/z.pom',
      ])
        if (!(await f.store.root.stat(path)) && !deleted.includes(path)) deleted.push(path);
    },
  });
  fixtures.push(f);
  await f.files('', {
    'repository/a/_remote.repositories': 'marker',
    'repository/a/a.jar': 'jar',
    'repository/a/z.pom': 'pom',
    'repository/a/keep.lock': 'lock',
  });
  for (const path of ['_remote.repositories', 'a.jar', 'z.pom'])
    await utimes(f.store.root.resolve('repository/a/' + path), 1.234, 1.234);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget, batchOperations: 1 });
  expect(await readFile(f.store.root.resolve('repository/a/keep.lock'), 'utf8')).toBe('lock');
  expect(deleted.indexOf('repository/a/_remote.repositories')).toBeGreaterThan(
    deleted.indexOf('repository/a/z.pom'),
  );
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('stops directory-only projection work on cancellation', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  for (let n = 0; n < 32; n++) await mkdir(f.store.root.resolve('data/d' + n), { recursive: true });
  const observed = await captureObservations(f.store, { budget: f.budget }),
    controller = new AbortController(),
    index = await ObservationIndex.open(f.store, observed.reference, {
      budget: f.budget,
      signal: controller.signal,
    });
  let directories = 0;
  try {
    await expect(
      checkGcProjection(index, 0, 0, undefined, undefined, {
        open: async () => {
          directories++;
          controller.abort();
        },
        file: async () => {},
        protected: async () => {},
        close: async () => {},
      }),
    ).rejects.toThrow();
  } finally {
    await index.dispose();
  }
  expect(directories).toBe(1);
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it('retains a whole Maven coordinate with an excluded artifact sibling before any unlink', async () => {
  const f = await observationFixture('maven', { excluded: ['**/excluded.jar'] });
  fixtures.push(f);
  const root = 'repository/a';
  for (const name of ['_remote.repositories', 'owned.jar', 'excluded.jar']) {
    await f.files('', { [root + '/' + name]: 'x' });
    await utimes(f.store.root.resolve(root + '/' + name), 1.234, 1.234);
  }
  await captureObservations(f.store, { budget: f.budget });
  const before = f.store.root.work.unlinks;
  await executeGc(f.store, { budget: f.budget });
  for (const name of ['_remote.repositories', 'owned.jar', 'excluded.jar'])
    expect(await readFile(f.store.root.resolve(root + '/' + name), 'utf8')).toBe('x');
  // Metadata cleanup is permitted; live payload identities remain exactly original.
  expect(f.store.root.work.unlinks).toBeGreaterThanOrEqual(before);
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('starts no further parent checkpoint after cancellation in a nested dirty chain', async () => {
  const f = await observationFixture('gradle');
  fixtures.push(f);
  const root = 'caches/transforms-4/' + 'a'.repeat(32),
    controller = new AbortController();
  for (const name of ['metadata.bin', 'results.bin', 'transformed/sub/file']) {
    await f.files('', { [root + '/' + name]: 'x' });
    await utimes(f.store.root.resolve(root + '/' + name), 1.234, 1.234);
  }
  await captureObservations(f.store, { budget: f.budget });
  let liveCheckpoints = 0,
    deleting = false;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'gc-target-deleted') deleting = true;
  });
  const created = InstallParentPhase.prototype.created;
  vi.spyOn(InstallParentPhase.prototype, 'created').mockImplementation(async function (
    this: InstallParentPhase,
    ...args
  ) {
    await created.apply(this, args);
    if (deleting && args[0].startsWith('caches/')) {
      liveCheckpoints++;
      controller.abort();
    }
  });
  await expect(
    executeGc(f.store, { budget: f.budget, signal: controller.signal }),
  ).rejects.toThrow();
  expect(liveCheckpoints).toBe(1);
  vi.restoreAllMocks();
  expect(await f.store.readFixed(f.store.prefix + 'gc-intent.json')).toBeNull();
  await expect(executeGc(f.store, { budget: f.budget })).rejects.toThrow();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it('derives cached full post-GC projections independently of native parent clocks', async () => {
  const f = await observationFixture('gradle');
  fixtures.push(f);
  for (const id of ['a', 'b'])
    for (const name of ['metadata.bin', 'results.bin', 'transformed/a']) {
      const path = 'caches/transforms-4/' + id.repeat(32) + '/' + name;
      await f.files('', { [path]: 'old' });
      await utimes(f.store.root.resolve(path), 1.234, 1.234);
    }
  await f.files('', {
    'data/z-file': 'retained',
    'data/a-dir/new': 'retained',
    ['caches/transforms-4/' + 'b'.repeat(32) + '/transformed/keep.lock']: 'protected',
  });
  await captureObservations(f.store, { budget: f.budget });
  const result = await executeGc(f.store, { budget: f.budget });
  const index = result.owner.index;
  try {
    for await (const node of index.walk())
      if (node[0] === 'observed-directory') {
        if (!(await f.store.root.stat(node[1]))) {
          expect(node[10][5]).toBe(1);
          continue;
        }
        const entries = await readdir(f.store.root.resolve(node[1]), { withFileTypes: true });
        entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
        const digest = new Digest('ancestor-children');
        for (const e of entries)
          digest.update([
            e.name,
            e.isFile()
              ? 'file'
              : e.isDirectory()
                ? 'directory'
                : e.isSymbolicLink()
                  ? 'symlink'
                  : 'other',
          ]);
        expect(node[10][7]).toBe(digest.digest());
      }
  } finally {
    await f.finish();
  }
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it('retains actual partial deletions on failure and grants no completion or replay authority', async () => {
  const f = await fixture(4);
  let deleted = 0;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'gc-target-deleted' && ++deleted === 2) throw new Error('partial deletion');
  });
  await expect(executeGc(f.store, { budget: f.budget })).rejects.toThrow('partial deletion');
  expect(await f.store.root.stat('data/f00')).toBeNull();
  expect(await f.store.root.stat('data/f01')).toBeNull();
  expect(await f.store.root.stat('data/f02')).not.toBeNull();
  await expect(GcSurvivorOwner.execute(f.observed.index!, { budget: f.budget })).rejects.toThrow();
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  expect(state[4]).toBe('post-active');
  expect(await f.store.root.stat(f.store.prefix + 'gc-intent.json')).toBeNull();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});

it('counts original capture, actual selected GC and cleanup across shared-parent units', async () => {
  const { recordEncodingWork } = await import('../../../src/cache/streaming/encoding');
  const results = [];
  for (const count of [4, 16]) {
    const f = await observationFixture('maven');
    fixtures.push(f);
    for (let n = 0; n < count; n++) {
      const path = 'data/shared/file-' + String(n).padStart(3, '0');
      await f.files('', { [path]: 'old-payload' });
      await utimes(f.store.root.resolve(path), 1, 1);
    }
    const before = { ...f.store.root.work },
      codec = { ...recordEncodingWork };
    await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget, batchOperations: 2 });
    await f.finish();
    const work = Object.fromEntries(
      Object.entries(f.store.root.work).map(([key, value]) => [
        key,
        value - before[key as keyof typeof before],
      ]),
    );
    const encoding = Object.fromEntries(
      Object.entries(recordEncodingWork).map(([key, value]) => [
        key,
        value - codec[key as keyof typeof codec],
      ]),
    );
    expect(work.bodyHashBytes).toBe(0);
    expect(work.cleanupListings).toBeGreaterThan(0);
    expect(work.scratchWriteBytes).toBeGreaterThanOrEqual(0);
    expect(work.scratchLogicalWriteBytes).toBeGreaterThan(0);
    expect(work.writeBytes).toBeGreaterThan(0);
    expect(encoding.decodedBytes).toBeGreaterThan(0);
    expect(f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[4]).toBe(
      'post-active',
    );
    for (let n = 0; n < count; n++)
      expect(await f.store.root.stat('data/shared/file-' + String(n).padStart(3, '0'))).toBeNull();
    await f.finish();
    expect(f.budget.retained).toBe(0);
    results.push({ count, selectedPayloadUnlinks: count, work, encoding });
  }
  for (const key of Object.keys(results[0].work))
    if (results[0].work[key]) expect(results[1].work[key]).toBeLessThan(results[0].work[key] * 4.5);
  for (const key of Object.keys(results[0].encoding))
    expect(results[1].encoding[key]).toBeLessThan(results[0].encoding[key] * 4.5);
  await writeFile('build/ls2-gc-counts.json', JSON.stringify(results, null, 2) + '\n');
});
