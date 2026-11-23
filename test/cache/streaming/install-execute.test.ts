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

import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from './install-plan-fixture';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import type { InstallScratch as InstallScratchType } from '../../../src/cache/streaming/install-scratch';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await installFixture();
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  return f;
}
it('installs native files through cold parents and complete units', async () => {
  const f = await fixture();
  const plan = await freezeInstallPlan(
    f.store,
    [
      await f.incoming('data', {
        'data/a': 'a',
        'data/b': 'b',
        'data/sub/c': 'c',
      }),
    ],
    f.budget,
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await readFile(f.store.root.resolve('data/sub/c'), 'utf8')).toBe('c');
  expect((await f.store.state()) as readonly unknown[]).toHaveLength(8);
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('requires admitted operations before constructing an executable program', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [
      await f.incoming('data', { 'data/a': 'a' }),
      await f.incoming('state', { 'state/new': 'new' }),
    ],
    f.budget,
  );
  const { InstallProgram, InstallReaders } =
    await import('../../../src/cache/streaming/install-program');
  const { InstallAdmission } = await import('../../../src/cache/streaming/install-admission');
  const admission = await InstallAdmission.create(f.store, plan, f.budget);
  const readers = new InstallReaders(f.store, f.budget, 100000, admission);
  try {
    await expect(
      InstallProgram.create(f.store, plan.plan, readers, new AbortController().signal),
    ).rejects.toThrow('requires admitted operations');
  } finally {
    await readers.close();
    await admission.close();
    await plan.metadata.dispose();
  }
  expect(await f.store.root.stat('data')).toBeNull();
  expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
  expect((await f.store.state()) as readonly unknown[]).toHaveLength(8);
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('keeps completed units and abandons an unstarted suffix after later failure', async () => {
  const f = await fixture();
  await f.files('', { data: null }); // Exercise the required fine merge into an existing directory.
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a', 'data/b': 'b', 'data/sub/c': 'c' })],
    f.budget,
  );
  let n = 0;
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-source-renamed' && ++n === 2) throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget, { batchOperations: 2 })).rejects.toThrow(
    'interrupted',
  );
  mock.mockRestore();
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
  expect(await readFile(f.store.root.resolve('data/b'), 'utf8')).toBe('b');
  expect(await f.store.root.stat('data/sub')).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('cancels during endpoint checks before initiating another rename', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await f.files('', { data: null });
  const input = await f.incoming('data', { 'data/a': 'a' }),
    plan = await freezeInstallPlan(f.store, [input], f.budget);
  const { InstallParentPhase } = await import('../../../src/cache/streaming/install-parent-phase');
  const stat = InstallParentPhase.prototype.stat;
  let n = 0;
  const mock = vi.spyOn(InstallParentPhase.prototype, 'stat').mockImplementation(async function (
    this: InstanceType<typeof InstallParentPhase>,
    path,
  ) {
    const value = await stat.call(this, path);
    if (path === input.nativeRoot + '/data/a' && ++n === 1)
      controller.abort(new Error('endpoint cancellation'));
    return value;
  });
  await expect(
    executeInstall(f.store, plan, f.budget, { signal: controller.signal }),
  ).rejects.toThrow('endpoint cancellation');
  mock.mockRestore();
  expect(n).toBe(1);
  expect(await f.store.root.stat('data/a')).toBeNull();
  expect(await f.store.root.stat(input.nativeRoot + '/data/a')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('releases all later owners when an earlier cleanup reports failure', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/a': 'a' })],
      f.budget,
    );
  const { InstallProgram, InstallReaders } =
    await import('../../../src/cache/streaming/install-program');
  const { InstallAdmission } = await import('../../../src/cache/streaming/install-admission');
  const close = InstallProgram.prototype.close;
  vi.spyOn(InstallProgram.prototype, 'close').mockImplementationOnce(async function (
    this: typeof InstallProgram.prototype,
  ) {
    await close.call(this);
    throw new Error('cleanup failure');
  });
  const readers = vi.spyOn(InstallReaders.prototype, 'close'),
    admission = vi.spyOn(InstallAdmission.prototype, 'close');
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('resource cleanup failed');
  expect(readers).toHaveBeenCalled();
  expect(admission).toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});
it('amortizes shared-parent traversal and durable cycles across ordinary units', async () => {
  async function measure(count: number, depth: number) {
    const f = await fixture();
    const parent = 'data' + '/nested'.repeat(depth);
    await f.files('', { [parent]: null });
    const entries = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        parent + '/file-' + String(i).padStart(3, '0'),
        'x'.repeat(512 * 1024),
      ]),
    );
    const plan = await freezeInstallPlan(f.store, [await f.incoming('data', entries)], f.budget);
    const before = { ...f.store.root.work },
      names: string[] = [],
      ancestry: string[] = [];
    const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      names.push(name);
    });
    const parents = f.store.root.parents.bind(f.store.root);
    const ancestrySpy = vi.spyOn(f.store.root, 'parents').mockImplementation(async (relative) => {
      ancestry.push(relative);
      await parents(relative);
    });
    await executeInstall(f.store, plan, f.budget);
    expect(f.store.root.work.bodyHashBytes).toBe(0);
    expect(ancestry.some((relative) => Object.hasOwn(entries, relative))).toBe(false);
    expect(names.filter((n) => n === 'install-intent-published')).toHaveLength(0);
    expect(names.filter((n) => n === 'install-progress-pointer')).toHaveLength(0);
    fail.mockRestore();
    ancestrySpy.mockRestore();
    expect(f.budget.retained).toBe(0);
    expect(f.store.root.work.readBytes - before.readBytes).toBeLessThan(count * 512 * 1024);
    return {
      stats: f.store.root.work.stats - before.stats,
      reads: f.store.root.work.readBytes - before.readBytes,
    };
  }
  const a = await measure(4, 0),
    b = await measure(16, 0),
    c = await measure(4, 6),
    d = await measure(16, 6);
  expect(b.stats).toBeLessThan(a.stats * 4);
  expect(d.stats).toBeLessThan(c.stats * 4);
  expect(d.stats - c.stats).toBe(b.stats - a.stats);
  expect(b.reads).toBeLessThan(a.reads * 4);
  expect(d.reads).toBeLessThan(c.reads * 4);
});

it('replaces opposite file/directory kinds and removes stale snapshot files beside an excluded lock', async () => {
  const f = await fixture();
  await f.files('', {
    'state/a': 'old-a',
    'state/b/old': 'old-b',
    'state/stale': 'stale',
    'state/keep.lock': 'keep',
  });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/a/new': 'new-a', 'state/b': 'new-b' })],
    f.budget,
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await readFile(f.store.root.resolve('state/a/new'), 'utf8')).toBe('new-a');
  expect(await readFile(f.store.root.resolve('state/b'), 'utf8')).toBe('new-b');
  expect(await readFile(f.store.root.resolve('state/keep.lock'), 'utf8')).toBe('keep');
  expect(await f.store.root.stat('state/stale')).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it.each(['install-old-backed-up', 'install-source-renamed', 'install-rename-before-stat'])(
  'cleans the current replacement in process after %s without completing an unstarted suffix',
  async (point) => {
    const f = await fixture();
    await f.files('', { 'state/old': 'old', 'state/sub/old': 'old-sub' });
    const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('state', { 'state/new': 'new' })],
      f.budget,
    );
    let once = false;
    vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      if (name === point && !once) {
        once = true;
        throw new Error('interrupted');
      }
    });
    const before = f.store.root.work.renames;
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
    const old = await f.store.root.stat('state/old'),
      next = await f.store.root.stat('state/new');
    expect(!!old !== !!next).toBe(true);
    expect(await f.store.root.stat(f.store.prefix + 'backups/1')).toBeNull();
    expect(f.store.root.work.renames).toBeGreaterThan(before);
    expect(f.budget.retained).toBe(0);
  },
);
it('restores a parked old root after cancellation before placing the replacement', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  const abort = new AbortController();
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-old-backed-up') abort.abort(new Error('cancelled'));
  });
  await expect(executeInstall(f.store, plan, f.budget, { signal: abort.signal })).rejects.toThrow(
    'cancelled',
  );
  expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
  expect(await f.store.root.stat('state/new')).toBeNull();
  expect(await f.store.root.stat(f.store.prefix + 'backups/1')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('preserves a parked original when a return target is occupied', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-old-backed-up') {
      await f.files('', { 'state/foreign': 'foreign' });
      throw new Error('interrupted');
    }
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('retained backup roots');
  expect(await readFile(f.store.root.resolve(f.store.prefix + 'backups/1/old'), 'utf8')).toBe(
    'old',
  );
  expect(await readFile(f.store.root.resolve('state/foreign'), 'utf8')).toBe('foreign');
  expect(f.budget.retained).toBe(0);
});
it('retains a partially retired backup without replaying deletion', async () => {
  const f = await fixture();
  await f.files('', { 'state/a': 'a', 'state/sub/b': 'b' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  let retirements = 0;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-backup-member-retired') {
      retirements++;
      throw new Error('retire failed');
    }
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('retire failed');
  expect(retirements).toBe(1);
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  expect(await f.store.root.stat(f.store.prefix + 'backups/1')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});

it('owns an incoming placement whose post-rename observation fails', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  let moves = 0;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-rename-before-stat' && ++moves === 2)
      throw new Error('incoming observation failed');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow(
    'incoming observation failed',
  );
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  expect(await f.store.root.stat(f.store.prefix + 'backups/1')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('retains ownership when recording the completed backup fails', async () => {
  const { InstallScratch } = await import('../../../src/cache/streaming/install-scratch');
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  const append = InstallScratch.prototype.append;
  vi.spyOn(InstallScratch.prototype, 'append').mockImplementation(async function (
    this: InstallScratchType,
    value,
    ...rest
  ) {
    if (Array.isArray(value) && value[0] === 'backup') throw new Error('backup record failed');
    return append.call(this, value, ...rest);
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('backup record failed');
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  expect(await f.store.root.stat(f.store.prefix + 'backups/1')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('reports retained endpoints when reverse cleanup rename succeeds before its observation fails', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  let restoring = false;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-old-backed-up') {
      restoring = true;
      throw new Error('place failed');
    }
    if (name === 'install-rename-before-stat' && restoring)
      throw new Error('return observation failed');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('retained backup roots');
  expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
  expect(await f.store.root.stat(f.store.prefix + 'backups/1')).toBeNull();
  expect(f.budget.retained).toBe(0);
});

it.each(['file-backups', 'directory-backup'] as const)(
  'keeps %s retirement work linear with fixed scratch and durable cycles',
  async (shape) => {
    const { InstallScratch } = await import('../../../src/cache/streaming/install-scratch');
    async function measure(count: number) {
      const f = await fixture();
      const old = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          'state/file-' + String(i).padStart(3, '0'),
          'x'.repeat(512 * 1024),
        ]),
      );
      if (shape === 'file-backups') old['state/keep.lock'] = 'keep';
      await f.files('', old);
      const plan = await freezeInstallPlan(
        f.store,
        [await f.incoming('state', shape === 'file-backups' ? {} : { 'state/new': 'new' })],
        f.budget,
      );
      const before = { ...f.store.root.work };
      const scratch = vi.spyOn(InstallScratch, 'create');
      let intents = 0,
        pointers = 0;
      const hook = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
        if (name === 'install-intent-published') intents++;
        if (name === 'install-progress-pointer') pointers++;
      });
      await executeInstall(f.store, plan, f.budget);
      expect(f.store.root.work.bodyHashBytes).toBe(0);
      expect(intents).toBe(0);
      expect(pointers).toBe(0);
      const result = {
        scratch: scratch.mock.calls.length,
        stats: f.store.root.work.stats - before.stats,
        reads: f.store.root.work.readBytes - before.readBytes,
        unlinks: f.store.root.work.unlinks - before.unlinks,
      };
      scratch.mockRestore();
      hook.mockRestore();
      expect(f.budget.retained).toBe(0);
      return result;
    }
    const a = await measure(4),
      b = await measure(16);
    expect(b.scratch).toBe(a.scratch);
    expect(b.stats).toBeLessThan(a.stats * 4);
    expect(b.reads).toBeLessThan(a.reads * 4);
    expect(b.unlinks - a.unlinks).toBe(12);
  },
);

it('retires a native read-only preimage without copying or changing the installed source', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'read-only-old' });
  const { chmod } = await import('node:fs/promises');
  await chmod(f.store.root.resolve('state/old'), 0o444);
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('consumes an admitted metadata source through the isolated installer in read-only prepare', async () => {
  const f = await installFixture('gradle', { access: 'read-only' });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const input = await f.incoming('state', { 'state/body': 'verified' });
  // The retained authoritative snapshot is independent of disposable install staging.
  await f.files(f.store.prefix + 'snapshots/state', { 'state/body': 'retained' });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  await executeInstall(f.store, plan, f.budget);
  expect(f.store.root.work.bodyHashBytes).toBe(0);
  expect(await readFile(f.store.root.resolve('state/body'), 'utf8')).toBe('verified');
  expect(
    await readFile(f.store.root.resolve(f.store.prefix + 'snapshots/state/state/body'), 'utf8'),
  ).toBe('retained');
  expect(await f.store.root.stat(plan.plan[2])).toBeNull();
  expect(() => plan.metadata.assert(f.store)).toThrow('closed');
  expect(await f.store.root.stat(input.objectRoot + '/envelope.json')).not.toBeNull();
  for (const directory of ['planning', 'admission', 'mutation'])
    expect(
      await (
        await import('node:fs/promises')
      ).readdir(f.store.root.resolve(f.store.prefix + directory)),
    ).toEqual([]);
  expect(f.budget.retained).toBe(0);
});
