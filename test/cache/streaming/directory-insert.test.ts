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
import { sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall, recoverInstall } from '../../../src/cache/streaming/install-execute';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
const counts = vi.hoisted(() => ({ prefix: '', renames: 0, exdev: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (counts.prefix && from.startsWith(counts.prefix)) {
        counts.renames++;
        if (counts.exdev) throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
      }
      return actual.rename(from, to);
    },
  };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  counts.prefix = '';
  counts.renames = 0;
  counts.exdev = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(model?: ReturnType<typeof resolveModel>) {
  const f = await installFixture('maven', { model });
  cleanup.push(() => f.close());
  await f.store.initialize(f.bindings);
  return f;
}
it.each([16, 256])(
  'moves four absent partition subtrees with %i descendants each using four payload renames',
  async (n) => {
    const hard = ['.mammoth/**', '**/*.lock'];
    const model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        Array.from({ length: 4 }, (_, p) => [
          'q' + p,
          ['q' + p + '/**'],
          hard,
          'aggregate',
          null,
          'default',
        ]),
      ],
      'dirs-',
      1,
    );
    const f = await fixture(model),
      inputs = [];
    for (let p = 0; p < 4; p++) {
      const entries: Record<string, string | null> = { ['q' + p + '/empty']: null };
      for (let i = 0; i < n; i++)
        entries['q' + p + '/d' + Math.floor(i / 16) + '/f' + String(i).padStart(4, '0')] = 'body';
      inputs.push(await f.incoming('q' + p, entries, 'trusted-base'));
    }
    const plan = await freezeInstallPlan(f.store, inputs, f.budget);
    const rows = [];
    for await (const row of f.store.rows(plan.plan, 'install-plan', {
      budget: f.budget,
      partition: null,
      installKind: () => 'directory',
    }))
      rows.push(row.value);
    expect(rows.filter((r) => Array.isArray(r) && r[0] === 'install')).toHaveLength(4);
    counts.prefix = f.store.root.resolve(f.store.prefix + 'install') + sep;
    await executeInstall(f.store, plan, f.budget, { batchOperations: 1, batchBytes: 1 });
    expect(counts.renames).toBe(4);
    for (let p = 0; p < 4; p++) {
      expect(await readFile(f.store.root.resolve('q' + p + '/d0/f0000'), 'utf8')).toBe('body');
      expect((await f.store.root.stat('q' + p + '/empty'))?.[2]).toBe('directory');
    }
    expect(f.budget.retained).toBe(0);
  },
  30000,
);
it('moves file-only included structural roots without a fabricated owner probe', async () => {
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    ['model', 1, 'maven', hard, [['data', ['data/**/*.bin'], hard, 'aggregate', null, 'default']]],
    'files-',
    1,
  );
  const f = await fixture(model),
    input = await f.incoming('data', { 'data/a.bin': 'a', 'data/deep/b.bin': 'b' });
  expect(() => model.owner('data/.workspace-directory-probe')).toThrow();
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  counts.prefix = f.store.root.resolve(f.store.prefix + 'install') + sep;
  await executeInstall(f.store, plan, f.budget);
  expect(counts.renames).toBe(1);
  expect(await readFile(f.store.root.resolve('data/deep/b.bin'), 'utf8')).toBe('b');
});
it('keeps existing Maven coordinates and moves only missing complete coordinate subtrees', async () => {
  const f = await fixture();
  await f.files('', { 'repository/local/1/keep.jar': 'local' });
  const input = await f.incoming('data', {
    'repository/new/a/1/a.jar': 'jar',
    'repository/new/a/1/a.pom': 'pom',
    'repository/new/b/1/b.jar': 'jar-b',
  });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  counts.prefix = f.store.root.resolve(f.store.prefix + 'install') + sep;
  await executeInstall(f.store, plan, f.budget);
  expect(counts.renames).toBe(1);
  expect(await readFile(f.store.root.resolve('repository/local/1/keep.jar'), 'utf8')).toBe('local');
  expect(await readFile(f.store.root.resolve('repository/new/a/1/a.pom'), 'utf8')).toBe('pom');
});
it.each(['unknown-descendant', 'changed-body', 'destination-race'])(
  'rejects %s at the actual directory boundary before a payload rename',
  async (kind) => {
    const f = await fixture(),
      input = await f.incoming('data', { 'data/deep/a': 'original' });
    const plan = await freezeInstallPlan(f.store, [input], f.budget);
    let changed = false;
    vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point !== 'install-intent-published' || changed) return;
      changed = true;
      if (kind === 'destination-race') await f.files('', { 'data/foreign': 'keep' });
      else
        await f.files(input.nativeRoot, {
          [kind === 'unknown-descendant' ? 'data/deep/foreign.lock' : 'data/deep/a']: 'foreign',
        });
    });
    counts.prefix = f.store.root.resolve(f.store.prefix + 'install') + sep;
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow();
    expect(counts.renames).toBe(0);
    expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
    if (kind === 'destination-race')
      expect(await readFile(f.store.root.resolve('data/foreign'), 'utf8')).toBe('keep');
    else expect(await f.store.root.stat('data')).toBeNull();
    expect(f.budget.retained).toBe(0);
  },
);
it('fails EXDEV without copy and retries the same directory intent after endpoint reconciliation', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/deep/a': 'body' });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  counts.prefix = f.store.root.resolve(f.store.prefix + 'install') + sep;
  counts.exdev = true;
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('cross device');
  expect(await f.store.root.stat('data')).toBeNull();
  expect(await readFile(f.store.root.resolve(input.nativeRoot + '/data/deep/a'), 'utf8')).toBe(
    'body',
  );
  counts.exdev = false;
  await recoverInstall(await OwnedStore.bind(f.root, f.store.codec), f.budget);
  expect(await readFile(f.store.root.resolve('data/deep/a'), 'utf8')).toBe('body');
  await f.store.assertNoIntents();
  expect(f.budget.retained).toBe(0);
});

it.runIf(process.platform === 'linux')(
  'preserves the conservative normalization alias gate below a coarsened source root',
  async () => {
    const f = await fixture(),
      input = await f.incoming('data', { 'data/A': 'one', 'data/a': 'two' });
    // Policy-only profile check on the existing Linux tree; not native macOS qualification.
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    await expect(freezeInstallPlan(f.store, [input], f.budget)).rejects.toThrow(
      'normalization path alias',
    );
    expect(await f.store.root.stat('data')).toBeNull();
    expect(f.budget.retained).toBe(0);
  },
);
