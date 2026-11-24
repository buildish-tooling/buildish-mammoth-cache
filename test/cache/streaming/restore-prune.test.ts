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
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from './install-plan-fixture';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import * as current from '../../../src/cache/streaming/install-current';
import type { Value } from '../../../src/cache/streaming/encoding';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(tool: 'gradle' | 'maven' = 'gradle', shared = false) {
  const f = await installFixture(tool, { shared });
  fixtures.push(f);
  (f.bindings[8] as Value[])[4] = 'prune-managed';
  await f.store.initialize(f.bindings);
  return f;
}
it('replaces complete eligible aggregate space and empty snapshots while preserving protected/unmanaged entries', async () => {
  const f = await fixture('gradle', true);
  await f.files('', {
    'shared/data/old': 'old',
    'shared/data/other/a': 'a',
    'shared/data/keep.lock': 'protected',
    'shared/state/old': 'stale-snapshot',
    'unmanaged/x': 'foreign',
  });
  const plan = await freezeInstallPlan(
    f.store,
    [
      await f.incoming('data', { 'shared/data/new': 'new' }, 'trusted-base'),
      await f.incoming('state', {}, 'trusted-base'),
    ],
    f.budget,
    { pruneAggregates: true },
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await f.store.root.stat('shared/data/old')).toBeNull();
  expect(await f.store.root.stat('shared/data/other/a')).toBeNull();
  expect(await f.store.root.stat('shared/state/old')).toBeNull();
  expect(await readFile(f.store.root.resolve('shared/data/new'), 'utf8')).toBe('new');
  expect(await readFile(f.store.root.resolve('shared/data/keep.lock'), 'utf8')).toBe('protected');
  expect(await readFile(f.store.root.resolve('unmanaged/x'), 'utf8')).toBe('foreign');
});
it.each(['gradle', 'maven'] as const)(
  'prunes unavailable complete %s units without touching excluded coordination files',
  async (tool) => {
    const f = await fixture(tool),
      unit = tool === 'gradle' ? 'caches/transforms-4/' + 'a'.repeat(32) : 'repository/org/a/1';
    await f.files('', {
      [unit + '/metadata.bin']: 'metadata',
      [unit + '/results.bin']: 'result',
      [unit + '/nested/body']: 'body',
      [unit + '/keep.lock']: 'protected',
    });
    const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', {}, 'trusted-base'), await f.incoming('state', {}, 'trusted-base')],
      f.budget,
      { pruneAggregates: true },
    );
    await executeInstall(f.store, plan, f.budget);
    for (const name of ['metadata.bin', 'results.bin', 'nested/body'])
      expect(await f.store.root.stat(unit + '/' + name)).toBeNull();
    expect(await readFile(f.store.root.resolve(unit + '/keep.lock'), 'utf8')).toBe('protected');
  },
);
it('does not make ordinary indexed overlay authoritative for absent aggregate files', async () => {
  const f = await fixture();
  await f.files('', { 'data/old': 'keep' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/new': 'new' })],
    f.budget,
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await readFile(f.store.root.resolve('data/old'), 'utf8')).toBe('keep');
});
it('rejects incomplete metadata source coverage as pruning authority', async () => {
  const f = await fixture(),
    inputs = [await f.incoming('data', {})];
  await expect(
    freezeInstallPlan(f.store, inputs, f.budget, { pruneAggregates: true }),
  ).rejects.toThrow('incomplete/cold metadata contexts');
});
it.each([false, true])(
  'does not enable aggregate pruning on a real prepare miss (backend available=%s)',
  async (available) => {
    const f = await installFixture('maven');
    fixtures.push(f);
    await f.files('', { 'data/keep.lock': 'preserve' });
    const ready = await prepareStreaming({
      root: f.root,
      model: f.model,
      context: f.store.codec.options.context,
      nonce: String(f.bindings[4]),
      budget: f.budget,
      policy: {
        role: 'standalone',
        access: 'writable',
        restoreCleanup: 'prune-managed',
        gcAgeMs: null,
        ordinaryPolicy: 'strict',
        ordinaryOrder: [],
      },
      currentRef: 'refs/heads/main',
      captureTempDirectory: null,
      artifactRetentionDays: 7,
      cleanupEnabled: true,
      saveAnchor() {},
      cacheBackend: async () => ({
        capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
        isFeatureAvailable: () => available,
        restoreCache: async () => undefined,
        saveCache: async () => 1,
        isMissingPathsError: () => false,
      }),
      provision: async () => {},
      installHooks: async () => {},
      assertCurrent: (): undefined => {},
    });
    expect(ready.restoreStatus).toBe(available ? 'miss' : 'feature-unavailable');
    expect(await readFile(f.store.root.resolve('data/keep.lock'), 'utf8')).toBe('preserve');
  },
);
it('uses the existing shared current inventory with linear work at widths4/16', async () => {
  const totals = [];
  for (const width of [4, 16]) {
    const f = await fixture('gradle', true);
    for (let n = 0; n < width; n++) await f.files('', { ['shared/data/group/f' + n]: 'body' });
    const inputs = [
      await f.incoming('data', { 'shared/data/group/new': 'new' }, 'trusted-base'),
      await f.incoming('state', {}, 'trusted-base'),
    ];
    const scan = vi.spyOn(current, 'installCurrentRows'),
      before = { ...f.store.root.work };
    const plan = await freezeInstallPlan(f.store, inputs, f.budget, { pruneAggregates: true });
    await executeInstall(f.store, plan, f.budget);
    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
    totals.push({
      stats: f.store.root.work.stats - before.stats,
      readBytes: f.store.root.work.readBytes - before.readBytes,
      renames: f.store.root.work.renames - before.renames,
    });
  }
  expect(totals[1].stats).toBeLessThan(totals[0].stats * 5);
  expect(totals[1].renames).toBeLessThan(totals[0].renames * 5);
  process.stdout.write('V5_RESTORE_PRUNE_COST ' + JSON.stringify(totals) + '\n');
});

it('prunes stale managed children under an explicitly present empty incoming directory', async () => {
  const f = await fixture();
  await f.files('', { 'data/empty/stale': 'old', 'data/empty/keep.lock': 'protected' });
  const plan = await freezeInstallPlan(
    f.store,
    [
      await f.incoming('data', { 'data/empty': null }, 'trusted-base'),
      await f.incoming('state', {}, 'trusted-base'),
    ],
    f.budget,
    { pruneAggregates: true },
  );
  await executeInstall(f.store, plan, f.budget);
  expect(await f.store.root.stat('data/empty/stale')).toBeNull();
  expect((await f.store.root.stat('data/empty'))?.[2]).toBe('directory');
  expect(await readFile(f.store.root.resolve('data/empty/keep.lock'), 'utf8')).toBe('protected');
});
