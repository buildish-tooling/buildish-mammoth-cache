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
import { readFile, rename, mkdir } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import { freezeInstallPlan } from './install-plan-fixture';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
const counts = vi.hoisted(() => ({ prefix: '', renames: 0, exdev: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (counts.prefix && from.startsWith(counts.prefix)) {
        counts.renames++;
        if (counts.exdev) {
          throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
        }
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
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
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
          0,
        ]),
      ],
      'dirs-',
      1,
    );
    const f = await fixture(model),
      inputs = [];
    for (let p = 0; p < 4; p++) {
      const entries: Record<string, string | null> = { ['q' + p + '/empty']: null };
      for (let i = 0; i < n; i++) {
        entries['q' + p + '/d' + Math.floor(i / 16) + '/f' + String(i).padStart(4, '0')] = 'body';
      }
      inputs.push(await f.incoming('q' + p, entries, 'trusted-base'));
    }
    const plan = await freezeInstallPlan(f.store, inputs, f.budget);
    const rows = [];
    for await (const row of f.store.rows(plan.plan, 'install-plan', {
      budget: f.budget,
      partition: null,
      installKind: () => 'directory',
    })) {
      rows.push(row.value);
    }
    expect(rows.filter((r) => Array.isArray(r) && r[0] === 'install')).toHaveLength(4);
    counts.prefix = f.store.root.resolve(f.store.prefix + 'base') + sep;
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
    [
      'model',
      1,
      'maven',
      hard,
      [['data', ['data/**/*.bin'], hard, 'aggregate', null, 'default', 0]],
    ],
    'files-',
    1,
  );
  const f = await fixture(model),
    input = await f.incoming('data', { 'data/a.bin': 'a', 'data/deep/b.bin': 'b' });
  expect(() => model.owner('data/.workspace-directory-probe')).toThrow();
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  counts.prefix = f.store.root.resolve(f.store.prefix + 'base') + sep;
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
  counts.prefix = f.store.root.resolve(f.store.prefix + 'base') + sep;
  await executeInstall(f.store, plan, f.budget);
  expect(counts.renames).toBe(1);
  expect(await readFile(f.store.root.resolve('repository/local/1/keep.jar'), 'utf8')).toBe('local');
  expect(await readFile(f.store.root.resolve('repository/new/a/1/a.pom'), 'utf8')).toBe('pom');
});
it.each(['source-root-replaced', 'destination-occupied'] as const)(
  'rejects %s at the selected directory boundary before payload rename',
  async (kind) => {
    const f = await fixture(),
      input = await f.incoming('data', { 'data/deep/a': 'original' }),
      plan = await freezeInstallPlan(f.store, [input], f.budget);
    if (kind === 'destination-occupied') {
      await f.files('', { 'data/foreign': 'keep' });
    } else {
      await rename(
        f.store.root.resolve(input.nativeRoot + '/data'),
        f.store.root.resolve(input.nativeRoot + '/retained'),
      );
      await mkdir(f.store.root.resolve(input.nativeRoot + '/data'));
    }
    counts.prefix = f.store.root.resolve(f.store.prefix + 'base') + sep;
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow();
    expect(counts.renames).toBe(0);
    await f.store.assertNoIntents();
    if (kind === 'destination-occupied') {
      expect(await readFile(f.store.root.resolve('data/foreign'), 'utf8')).toBe('keep');
    } else {
      expect(await f.store.root.stat('data')).toBeNull();
      expect(
        await readFile(f.store.root.resolve(input.nativeRoot + '/retained/deep/a'), 'utf8'),
      ).toBe('original');
    }
    expect(f.budget.retained).toBe(0);
  },
);
it('fails EXDEV without copy or recorded intent replay', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/deep/a': 'body' });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  counts.prefix = f.store.root.resolve(f.store.prefix + 'base') + sep;
  counts.exdev = true;
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('cross device');
  expect(await f.store.root.stat('data')).toBeNull();
  expect(await readFile(f.store.root.resolve(input.nativeRoot + '/data/deep/a'), 'utf8')).toBe(
    'body',
  );
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
