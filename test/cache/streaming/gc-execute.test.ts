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

import { utimes, writeFile, unlink, mkdir, readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { executeGc, recoverGc } from '../../../src/cache/streaming/gc-execute';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { Digest } from '../../../src/cache/streaming/encoding';
import { InstallParentPhase } from '../../../src/cache/streaming/install-parent-phase';
import { GcProgram } from '../../../src/cache/streaming/gc-program';
import { checkGcProjection } from '../../../src/cache/streaming/gc-projection';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { observationFixture } from './observation-fixtures';
import { installFixture } from './install-fixture';
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
  expect(result.complete).toBe(true);
  expect(result.cursor[3]).toBeGreaterThan(0);
  expect(result.cursor[5]).toBeNull();
  expect(result.work.directories).toBe(4); // two phases × root/data, not per batch/file.
  for (let n = 0; n < 4; n++) expect(await f.store.root.stat('data/f0' + n)).toBeNull();
  expect(f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[4]).toBe(
    'gc-complete',
  );
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it.each([
  'gc-evidence-published',
  'gc-intent-published',
  'gc-target-deleted',
  'gc-deletions-durable',
  'gc-progress-pointer',
  'gc-intent-retired',
])('reopens after %s and recovers only the active complete range', async (point) => {
  let hit = false;
  const f = await fixture(5, async (name) => {
    if (name === point && !hit) {
      hit = true;
      throw new Error('interrupted');
    }
  });
  await expect(executeGc(f.store, { budget: f.budget, batchOperations: 2 })).rejects.toThrow(
    'interrupted',
  );
  expect(hit).toBe(true);
  const reopened = await OwnedStore.bind(f.root, f.store.codec),
    recovered = await recoverGc(reopened, { budget: f.budget, batchOperations: 3 });
  expect(recovered.complete).toBe(false);
  expect(await reopened.root.stat('data/f04')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
  expect((await executeGc(reopened, { budget: f.budget, batchOperations: 3 })).complete).toBe(true);
  await reopened.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('blocks future planned absences, unknown children, replacements and completed target recreation', async () => {
  const f = await fixture();
  await unlink(f.store.root.resolve('data/f03'));
  await expect(executeGc(f.store, { budget: f.budget })).rejects.toThrow('Unplanned missing');
  expect(await f.store.root.stat('data/f00')).not.toBeNull();
  const g = await fixture();
  await writeFile(g.store.root.resolve('data/unknown'), 'x');
  await expect(executeGc(g.store, { budget: g.budget })).rejects.toThrow('Unexpected');
  const h = await fixture();
  await unlink(h.store.root.resolve('data/f00'));
  await writeFile(h.store.root.resolve('data/f00'), 'x');
  await expect(executeGc(h.store, { budget: h.budget })).rejects.toThrow();
  const j = await fixture();
  await executeGc(j.store, { budget: j.budget });
  await writeFile(j.store.root.resolve('data/f00'), 'x');
  await expect(recoverGc(j.store, { budget: j.budget })).rejects.toThrow();
  for (const x of [f, g, h, j]) expect(x.budget.retained).toBe(0);
});
it('rejects forged cursor record and stack boundaries before any deletion', async () => {
  const f = await fixture(),
    index = await ObservationIndex.open(f.store, f.observed.reference, { budget: f.budget });
  try {
    const p = await GcProgram.create(index, { operations: 1 });
    try {
      const first = await p.batches.record(0);
      let cursor;
      try {
        cursor = await p.cursor(first.value as Parameters<typeof p.cursor>[0]);
      } finally {
        first.release();
      }
      cursor[3]++;
      await expect(GcProgram.create(index, {}, [cursor])).rejects.toThrow('boundary');
      expect(await f.store.root.stat('data/f00')).not.toBeNull();
    } finally {
      await p.close();
    }
  } finally {
    await index.dispose();
  }
  expect(f.budget.retained).toBe(0);
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
      checkGcProjection(index, 0, 0, {
        created: async () => {
          directories++;
          controller.abort();
        },
      } as never),
    ).rejects.toThrow();
  } finally {
    await index.dispose();
  }
  expect(directories).toBe(1);
  expect(f.budget.retained).toBe(0);
});

it.each([false, true])(
  'keeps an oversized workspace indivisible and preserves protected descendants (%s)',
  async (protectedChild) => {
    let deletions = 0;
    const f = await observationFixture('gradle', {
      fail: async (name) => {
        if (name === 'gc-target-deleted' && ++deletions === 2)
          throw new Error('workspace interruption');
      },
    });
    fixtures.push(f);
    const root = 'caches/transforms-4/' + 'a'.repeat(32);
    for (const name of ['metadata.bin', 'results.bin', 'transformed/a', 'transformed/sub/b']) {
      const path = root + '/' + name;
      await f.files('', { [path]: 'x' });
      await utimes(f.store.root.resolve(path), 1.234, 1.234);
    }
    if (protectedChild) await f.files('', { [root + '/transformed/keep.lock']: 'lock' });
    await captureObservations(f.store, { budget: f.budget });
    await expect(executeGc(f.store, { budget: f.budget, batchOperations: 1 })).rejects.toThrow(
      'workspace interruption',
    );
    const marker = f.store.codec.schemas.documents['gc-intent'].parse(
      await f.store.readFixed(f.store.prefix + 'gc-intent.json'),
    );
    expect(marker[5][4] - marker[4][4]).toBe(1);
    const reopened = await OwnedStore.bind(f.root, f.store.codec);
    await recoverGc(reopened, { budget: f.budget });
    if (protectedChild) {
      expect(await readFile(reopened.root.resolve(root + '/transformed/keep.lock'), 'utf8')).toBe(
        'lock',
      );
      expect(await reopened.root.stat(root + '/metadata.bin')).toBeNull();
    } else expect(await reopened.root.stat(root)).toBeNull();
    await executeGc(reopened, { budget: f.budget });
    expect(f.budget.retained).toBe(0);
  },
);
it('keeps hot-parent listings and evidence proportional across 4 to 16 units with reload', async () => {
  const measured: { listings: number; stats: number; evidence: number; projectionRows: number }[] =
    [];
  for (const count of [4, 16]) {
    const f = await fixture(count),
      startStats = f.store.root.work.stats;
    let evidence = 0,
      projectionRows = 0;
    const write = f.store.writeStream.bind(f.store);
    vi.spyOn(f.store, 'writeStream').mockImplementation(async (...args) => {
      const q = await write(...args);
      if (args[0] === 'gc-evidence') {
        evidence += q[3];
        for await (const row of f.store.rows(q, 'gc-evidence', {
          budget: f.budget,
          partition: null,
          gcMode: 'shared',
        }))
          if (Array.isArray(row.value) && row.value[0] === 'child') projectionRows++;
      }
      return q;
    });
    const result = await executeGc(f.store, { budget: f.budget, batchOperations: 2 });
    const reopened = await OwnedStore.bind(f.root, f.store.codec),
      recovery = await recoverGc(reopened, { budget: f.budget });
    measured.push({
      listings: result.work.directories + recovery.work.directories,
      stats: f.store.root.work.stats - startStats,
      evidence,
      projectionRows,
    });
    expect(f.budget.retained).toBe(0);
  }
  expect(measured[1].listings).toBe(measured[0].listings);
  expect(measured[1].projectionRows).toBe(0);
  expect(measured[1].evidence).toBeLessThan(measured[0].evidence * 4.1);
  expect(measured[1].stats).toBeLessThan(measured[0].stats * 4.1);
});

let processDir: string, processBundle: string;
beforeAll(async () => {
  processDir = await mkdtemp(path.resolve('build/gc-child-'));
  processBundle = path.join(processDir, 'fixture.mjs');
  await build({
    entryPoints: ['test/cache/streaming/gc-process-fixture.ts'],
    outfile: processBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
});
afterAll(async () => {
  await rm(processDir, { recursive: true, force: true });
});
it.each([
  ['gc-evidence-published', 1],
  ['gc-intent-published', 2],
  ['gc-target-deleted', 3],
  ['gc-deletions-durable', 2],
  ['gc-progress-candidate', 2],
  ['gc-progress-pointer', 2],
  ['gc-intent-retired', 2],
] as const)(
  'recovers independent process exit at %s/%s without owning the future suffix',
  async (point, nth) => {
    const f = await installFixture('maven');
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [processBundle, 'start', f.root, point, String(nth)], {
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    execFileSync(process.execPath, [processBundle, 'recover', f.root, 'unused', '1'], {
      stdio: 'pipe',
    });
    await f.store.assertNoIntents();
    expect(await f.store.root.stat('data/f5')).not.toBeNull();
    execFileSync(process.execPath, [processBundle, 'continue', f.root, 'unused', '1'], {
      stdio: 'pipe',
    });
    expect(await f.store.root.stat('data/f5')).toBeNull();
  },
);

it('checks an already-absent last deletion before the recovered progress pointer', async () => {
  let targets = 0;
  const f = await fixture(2, async (name) => {
    if (name === 'gc-target-deleted' && ++targets === 2) throw new Error('last unlink crash');
  });
  await expect(executeGc(f.store, { budget: f.budget, batchOperations: 2 })).rejects.toThrow(
    'last unlink crash',
  );
  let committed = false;
  const reopened = await OwnedStore.bind(f.root, f.store.codec, async (name) => {
    if (name === 'gc-progress-pointer') {
      expect(await f.store.root.stat('data/f0')).toBeNull();
      expect(await f.store.root.stat('data/f1')).toBeNull();
      committed = true;
    }
  });
  await recoverGc(reopened, { budget: f.budget });
  expect(committed).toBe(true);
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
  expect(f.budget.retained).toBe(0);
});
it('rejects cancellation during final metadata cleanup despite durable GC completion', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let finishing = false;
  const store = await OwnedStore.bind(f.root, f.store.codec, async (name) => {
    if (name === 'gc-progress-pointer') finishing = true;
    if (finishing && name === 'disposable-member-retired') controller.abort();
  });
  await expect(executeGc(store, { budget: f.budget, signal: controller.signal })).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(store.codec.schemas.documents['local-state'].parse(await store.state())[4]).toBe(
    'gc-complete',
  );
  await store.assertNoIntents();
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
  expect(await f.store.readFixed(f.store.prefix + 'gc-intent.json')).not.toBeNull();
  const reopened = await OwnedStore.bind(f.root, f.store.codec);
  await recoverGc(reopened, { budget: f.budget });
  await reopened.assertNoIntents();
  expect(await reopened.root.stat(root)).toBeNull();
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
  const observed = await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const index = await ObservationIndex.open(f.store, observed.reference, { budget: f.budget });
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
    await index.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
