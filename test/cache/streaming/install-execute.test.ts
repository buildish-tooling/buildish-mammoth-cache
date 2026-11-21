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

import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { readFile, writeFile, mkdtemp, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall, recoverInstall } from '../../../src/cache/streaming/install-execute';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
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
  expect(((await f.store.state()) as readonly unknown[])[11]).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it.each([
  'install-evidence-published',
  'install-intent-published',
  'install-parent-renamed',
  'install-source-renamed',
  'install-progress-pointer',
  'install-intent-retired',
])('recovers insert interruption at %s', async (point) => {
  const f = await fixture();
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a', 'data/b': 'b', 'data/sub/c': 'c' })],
    f.budget,
  );
  let calls = 0;
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === point && ++calls === (point === 'install-progress-pointer' ? 2 : 1))
      throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  mock.mockRestore();
  const reopened = await OwnedStore.bind(f.root, f.store.codec);
  await recoverInstall(reopened, f.budget);
  await reopened.assertNoIntents();
  expect(f.budget.retained).toBe(0);
  if (point !== 'install-evidence-published') {
    expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
    // Recovery reconciles the whole active batch, including unattempted ordinary units.
    expect(await readFile(f.store.root.resolve('data/sub/c'), 'utf8')).toBe('c');
  }
});
it('rejects unknown children in a populated created parent after restart', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/a': 'a', 'data/b': 'b' })],
      f.budget,
    );
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-source-renamed') throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  mock.mockRestore();
  await writeFile(f.store.root.resolve('data/unknown'), 'unknown');
  await expect(
    recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget),
  ).rejects.toThrow();
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});

let processDir: string, processBundle: string;
beforeAll(async () => {
  processDir = await mkdtemp(path.resolve('build/install-child-'));
  processBundle = path.join(processDir, 'fixture.mjs');
  await build({
    entryPoints: ['test/cache/streaming/install-process-fixture.ts'],
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
  ['install-intent-published', 1],
  ['install-parent-renamed', 1],
  ['install-parent-renamed', 2],
  ['install-source-renamed', 1],
  ['install-progress-candidate', 2],
  ['install-progress-pointer', 2],
  ['install-intent-retired', 1],
] as const)('reopens an abruptly terminated process at %s/%s', async (point, nth) => {
  const f = await installFixture();
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
  expect(await readFile(f.store.root.resolve('data/sub/c'), 'utf8')).toBe('c');
});

it('rejects a mixed unsupported plan before any live mutation or progress', async () => {
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
  const readers = new InstallReaders(f.store, f.budget, 100000);
  try {
    await expect(
      InstallProgram.create(f.store, plan.plan, readers, new AbortController().signal),
    ).rejects.toThrow('slice not enabled');
  } finally {
    await readers.close();
  }
  expect(await f.store.root.stat('data')).toBeNull();
  expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
  expect(((await f.store.state()) as readonly unknown[])[11]).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('verifies a retired-intent committed prefix before abandoning its suffix', async () => {
  const f = await installFixture();
  fixtures.push(f);
  try {
    execFileSync(
      process.execPath,
      [processBundle, 'start', f.root, 'install-intent-retired', '1'],
      { stdio: 'pipe' },
    );
  } catch (error) {
    expect((error as { status: number }).status).toBe(73);
  }
  await writeFile(f.store.root.resolve('data/unknown'), 'unknown');
  expect(() =>
    execFileSync(process.execPath, [processBundle, 'recover', f.root, 'unused', '1'], {
      stdio: 'pipe',
    }),
  ).toThrow();
  expect(((await f.store.state()) as readonly unknown[])[11]).not.toBeNull();
});
it('reconciles only the active batch after earlier complete batches', async () => {
  const f = await fixture();
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
  await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
  expect(await readFile(f.store.root.resolve('data/b'), 'utf8')).toBe('b');
  expect(await f.store.root.stat('data/sub')).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it('blocks a lost source and target without discarding the intent', async () => {
  const f = await fixture();
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a' })],
    f.budget,
  );
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-source-renamed') throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  mock.mockRestore();
  await unlink(f.store.root.resolve('data/a'));
  await expect(
    recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget),
  ).rejects.toThrow('Lost insert');
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('preserves intent ownership on cancellation after a parent rename', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a' })],
    f.budget,
  );
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-parent-renamed') controller.abort(new Error('cancelled'));
  });
  await expect(
    executeInstall(f.store, plan, f.budget, { signal: controller.signal }),
  ).rejects.toThrow('cancelled');
  mock.mockRestore();
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
  await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
  expect(f.budget.retained).toBe(0);
});

it('cancels during endpoint checks before initiating another rename', async () => {
  const f = await fixture(),
    controller = new AbortController();
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
    if (path === input.nativeRoot + '/data/a' && ++n === 3)
      controller.abort(new Error('endpoint cancellation'));
    return value;
  });
  await expect(
    executeInstall(f.store, plan, f.budget, { signal: controller.signal }),
  ).rejects.toThrow('endpoint cancellation');
  mock.mockRestore();
  expect(n).toBe(3);
  expect(await f.store.root.stat('data/a')).toBeNull();
  expect(await f.store.root.stat(input.nativeRoot + '/data/a')).not.toBeNull();
  await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
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
it('releases the change-spool claim if its initial frame exceeds budget', async () => {
  const f = await fixture();
  const { WorkingBudget } = await import('../../../src/cache/streaming/tree-state');
  const { InstallScratch } = await import('../../../src/cache/streaming/install-scratch');
  const { buildChangeIndex } = await import('../../../src/cache/streaming/install-changes');
  const budget = new WorkingBudget(1),
    scratch = await InstallScratch.create(f.store, budget);
  await expect(buildChangeIndex(scratch, (async function* () {})())).rejects.toThrow(
    'working budget',
  );
  await scratch.close();
  expect(budget.retained).toBe(0);
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
    const hash = vi.spyOn(f.store.root, 'hash');
    await executeInstall(f.store, plan, f.budget);
    expect(hash).not.toHaveBeenCalled();
    expect(ancestry.some((relative) => Object.hasOwn(entries, relative))).toBe(false);
    expect(names.filter((n) => n === 'install-intent-published')).toHaveLength(1);
    expect(names.filter((n) => n === 'install-progress-pointer')).toHaveLength(2);
    fail.mockRestore();
    ancestrySpy.mockRestore();
    hash.mockRestore();
    expect(f.budget.retained).toBe(0);
    expect(f.store.root.work.readBytes - before.readBytes).toBeLessThan(count * 512 * 1024);
    return {
      stats: f.store.root.work.stats - before.stats,
      reads: f.store.root.work.readBytes - before.readBytes,
      syncs: f.store.root.work.directorySyncs - before.directorySyncs,
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
  expect(b.syncs).toBe(a.syncs);
  expect(d.syncs).toBe(c.syncs);
});

it('syncs completed active rename parents before committing the recovered cursor', async () => {
  const f = await fixture();
  const input = await f.incoming('data', { 'data/a': 'a', 'data/b': 'b' });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  let moves = 0;
  const crash = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-source-renamed' && ++moves === 2) throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  crash.mockRestore();
  const synced: string[] = [];
  const reopened = await OwnedStore.bind(f.root, f.store.codec, async (name) => {
    if (name === 'install-progress-pointer') {
      expect(synced).toContain('data');
      expect(synced).toContain(input.nativeRoot + '/data');
    }
  });
  const sync = reopened.root.syncDirectory.bind(reopened.root);
  vi.spyOn(reopened.root, 'syncDirectory').mockImplementation(async (relative) => {
    synced.push(relative);
    return sync(relative);
  });
  await recoverInstall(reopened, f.budget);
  expect(synced.filter((p) => p === 'data')).toHaveLength(1);
  expect(synced.filter((p) => p === input.nativeRoot + '/data')).toHaveLength(1);
  await reopened.assertNoIntents();
  expect(f.budget.retained).toBe(0);
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
it.each([
  'install-old-backed-up',
  'install-source-renamed',
  'install-progress-pointer',
  'install-backup-member-retired',
  'install-backups-retired',
])('reconciles replacement interrupted at %s', async (point) => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old', 'state/sub/old': 'old-sub' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('state', { 'state/new': 'new' })],
    f.budget,
  );
  let n = 0;
  const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === point && ++n === (point === 'install-progress-pointer' ? 2 : 1))
      throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  mock.mockRestore();
  await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  expect(await f.store.root.stat('state/old')).toBeNull();
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});
it.each(['install-delete-backed-up', 'install-progress-pointer', 'install-backup-member-retired'])(
  'reconciles authoritative empty snapshot deletion interrupted at %s',
  async (point) => {
    const f = await fixture();
    await f.files('', { 'state/a': 'a', 'state/sub/b': 'b', 'state/keep.lock': 'keep' });
    const plan = await freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget);
    let n = 0;
    const mock = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      if (name === point && ++n === (point === 'install-progress-pointer' ? 2 : 1))
        throw new Error('interrupted');
    });
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
    mock.mockRestore();
    await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
    expect(await f.store.root.stat('state/a')).toBeNull();
    expect(await f.store.root.stat('state/sub')).toBeNull();
    expect(await readFile(f.store.root.resolve('state/keep.lock'), 'utf8')).toBe('keep');
    await f.store.assertNoIntents();
    expect(f.budget.retained).toBe(0);
  },
);

it.each([
  ['start-replace', 'install-old-backed-up'],
  ['start-replace', 'install-source-renamed'],
  ['start-replace', 'install-backup-member-retired'],
  ['start-delete', 'install-delete-backed-up'],
  ['start-delete', 'install-backup-member-retired'],
] as const)('recovers an abruptly terminated %s process at %s', async (mode, point) => {
  const f = await installFixture();
  fixtures.push(f);
  let status: unknown;
  try {
    execFileSync(process.execPath, [processBundle, mode, f.root, point, '1'], { stdio: 'pipe' });
  } catch (error) {
    status = (error as { status: unknown }).status;
  }
  expect(status).toBe(73);
  execFileSync(process.execPath, [processBundle, 'recover', f.root, 'unused', '1'], {
    stdio: 'pipe',
  });
  await f.store.assertNoIntents();
  if (mode === 'start-replace')
    expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('new');
  else expect(await f.store.root.stat('state')).toBeNull();
});
it.each(['unknown', 'changed-survivor', 'recreated-target'] as const)(
  'blocks %s during partial committed backup cleanup',
  async (damage) => {
    const f = await fixture();
    await f.files('', { 'state/a': 'a', 'state/sub/b': 'b' });
    const input = await f.incoming(
      'state',
      damage === 'recreated-target' ? {} : { 'state/new': 'new' },
    );
    const plan = await freezeInstallPlan(f.store, [input], f.budget);
    const crash = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      if (name === 'install-backup-member-retired') throw new Error('interrupted');
    });
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
    crash.mockRestore();
    const backup = f.store.prefix + 'backups/1';
    if (damage === 'unknown') await writeFile(f.store.root.resolve(backup + '/unknown'), 'unknown');
    if (damage === 'changed-survivor')
      await writeFile(f.store.root.resolve(backup + '/sub/b'), 'changed');
    if (damage === 'recreated-target') await f.files('', { 'state/recreated': 'recreated' });
    await expect(
      recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget),
    ).rejects.toThrow();
    expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
    expect(f.budget.retained).toBe(0);
  },
);
it('does not accept a lost delete preimage before its cursor commits', async () => {
  const f = await fixture();
  await f.files('', { 'state/a': 'a' });
  const plan = await freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget);
  const crash = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-delete-backed-up') throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  crash.mockRestore();
  await rm(f.store.root.resolve(f.store.prefix + 'backups/1'), { recursive: true });
  await expect(
    recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget),
  ).rejects.toThrow('lost delete preimage');
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});

it.each(['file-backups', 'directory-backup'] as const)(
  'keeps %s retirement work linear with fixed scratch and durable cycles',
  async (shape) => {
    const { InstallScratch } = await import('../../../src/cache/streaming/install-scratch');
    const { NativeReadPhase } = await import('../../../src/cache/streaming/native-read-phase');
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
      const scratch = vi.spyOn(InstallScratch, 'create'),
        hash = vi.spyOn(NativeReadPhase.prototype, 'hash');
      let intents = 0,
        pointers = 0;
      const hook = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
        if (name === 'install-intent-published') intents++;
        if (name === 'install-progress-pointer') pointers++;
      });
      await executeInstall(f.store, plan, f.budget);
      expect(hash).not.toHaveBeenCalled();
      expect(intents).toBe(1);
      expect(pointers).toBe(2);
      const result = {
        scratch: scratch.mock.calls.length,
        stats: f.store.root.work.stats - before.stats,
        reads: f.store.root.work.readBytes - before.readBytes,
        syncs: f.store.root.work.directorySyncs - before.directorySyncs,
        unlinks: f.store.root.work.unlinks - before.unlinks,
      };
      scratch.mockRestore();
      hash.mockRestore();
      hook.mockRestore();
      expect(f.budget.retained).toBe(0);
      return result;
    }
    const a = await measure(4),
      b = await measure(16);
    expect(b.scratch).toBe(a.scratch);
    expect(b.syncs).toBe(a.syncs);
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
it.each(['worker', 'trusted-base'] as const)(
  'consumes %s verification through the same isolated installer in read-only prepare',
  async (origin) => {
    const f = await installFixture('gradle', { access: 'read-only' });
    fixtures.push(f);
    await f.store.initialize(f.bindings);
    const input = await f.incoming('state', { 'state/body': 'verified' }, origin);
    // The retained authoritative snapshot is independent of disposable install staging.
    await f.files(f.store.prefix + 'snapshots/state', { 'state/body': 'retained' });
    const plan = await freezeInstallPlan(f.store, [input], f.budget);
    const hash = vi.spyOn(f.store.root, 'hash');
    await executeInstall(f.store, plan, f.budget);
    expect(hash).not.toHaveBeenCalled();
    hash.mockRestore();
    expect(await readFile(f.store.root.resolve('state/body'), 'utf8')).toBe('verified');
    expect(
      await readFile(f.store.root.resolve(f.store.prefix + 'snapshots/state/state/body'), 'utf8'),
    ).toBe('retained');
    expect(await f.store.root.stat(plan.plan[2])).toBeNull();
    expect(await f.store.root.stat(plan.current[2])).toBeNull();
    expect(await f.store.root.stat(input.evidence[2])).not.toBeNull();
    for (const directory of ['planning', 'admission', 'mutation'])
      expect(
        await (
          await import('node:fs/promises')
        ).readdir(f.store.root.resolve(f.store.prefix + directory)),
      ).toEqual([]);
    expect(f.budget.retained).toBe(0);
  },
);
