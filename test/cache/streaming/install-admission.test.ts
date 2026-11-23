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
import { writeFile, link, rename, mkdir } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from './install-plan-fixture';
import { takeInstallIndexes } from '../../../src/cache/streaming/install-plan';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import type { Value } from '../../../src/cache/streaming/encoding';
import { InstallAdmission } from '../../../src/cache/streaming/install-admission';
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
it('admits a complete frozen cold-root plan without modifying live data', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(
      f.store,
      [
        await f.incoming('data', { 'data/a': 'a', 'data/sub/b': 'b' }),
        await f.incoming('state', { 'state/a': 'a' }),
      ],
      f.budget,
    ),
    renames = f.store.root.work.renames;
  const admitted = await InstallAdmission.create(f.store, plan, f.budget);
  admitted.assert(f.store);
  await admitted.close();
  expect(f.store.root.work.renames).toBe(renames);
  expect(await f.store.root.stat('data')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it.each(['directory', 'file'] as const)(
  'rejects changed selected current %s root after freezing before any live mutation',
  async (kind) => {
    const f = await fixture();
    const snapshot = kind === 'directory';
    await f.files('', snapshot ? { 'state/old': 'old' } : { 'data/old': 'old' });
    const input = await f.incoming(
        snapshot ? 'state' : 'data',
        snapshot ? { 'state/new': 'new' } : { 'data/old': 'new' },
      ),
      plan = await freezeInstallPlan(f.store, [input], f.budget),
      renames = f.store.root.work.renames;
    if (snapshot) await f.files('', { 'state/unexpected': 'unexpected' });
    else await writeFile(f.store.root.resolve('data/old'), 'changed-selected-file');
    await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow();
    expect(f.store.root.work.renames).toBe(renames);
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects source-parent changes and non-idle invocation state', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/a': 'a' })],
      f.budget,
    );
  const state = (await f.store.state()) as Value[];
  state[3] = Number(state[3]) + 1;
  state[4] = 'prepare-failed';
  await f.store.updateState(state);
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    'idle prepare-pending',
  );
  expect(f.budget.retained).toBe(0);
});
it('cancels already-aborted admission without granting an executable proof', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(f.store, [], f.budget),
    controller = new AbortController();
  controller.abort(new Error('cancel admission'));
  await expect(InstallAdmission.create(f.store, plan, f.budget, controller.signal)).rejects.toThrow(
    'cancel admission',
  );
  expect(f.budget.retained).toBe(0);
});

it('permits read-only prepare admission but rejects post-build invocation phases', async () => {
  const f = await installFixture('gradle', { access: 'read-only' });
  expect(f.store.codec.options.access).toBe('read-only');
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/a': 'a' })],
      f.budget,
    ),
    cap = await InstallAdmission.create(f.store, plan, f.budget);
  await cap.close();
  expect(f.budget.retained).toBe(0);
});
it('rejects a hardlinked disposable source changed after its producer receipt', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/a': 'a' }),
    plan = await freezeInstallPlan(f.store, [input], f.budget);
  await link(
    f.store.root.resolve(input.nativeRoot + '/data/a'),
    f.store.root.resolve(input.nativeRoot + '/data/alias'),
  );
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow();
  expect(await f.store.root.stat('data')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('rejects a selected directory containing a hardlinked managed descendant during capture', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old', data: null });
  await link(f.store.root.resolve('state/old'), f.store.root.resolve('data/alias'));
  const renames = f.store.root.work.renames;
  await expect(
    freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget),
  ).rejects.toThrow(/alias/i);
  expect(f.store.root.work.renames).toBe(renames);
  expect(f.budget.retained).toBe(0);
});
it('rejects a selected hardlinked current file before any live mutation', async () => {
  const f = await fixture();
  await f.files('', { 'data/old': 'old' });
  const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/old': 'new' })],
      f.budget,
    ),
    renames = f.store.root.work.renames;
  await link(f.store.root.resolve('data/old'), f.store.root.resolve(f.store.prefix + 'alias'));
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    'Aliased selected install endpoint',
  );
  expect(f.store.root.work.renames).toBe(renames);
  expect(await f.store.root.stat('data/old')).not.toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('checks excluded nontransient Maven artifacts once per changed coordinate', async () => {
  const f = await installFixture('maven', { excluded: ['**/excluded.jar'] });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const root = 'repository/g/a/1';
  await f.files('', { [root + '/old.jar']: 'old', [root + '/excluded.jar']: 'preserve' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { [root + '/new.jar']: 'new' })],
    f.budget,
  );
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    'Incomplete Maven',
  );
  expect(f.budget.retained).toBe(0);
});

it('rejects pre-existing backups without modifying live targets', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const plan = await freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget);
  await f.files('', { [f.store.prefix + 'backups/1']: 'unrelated' });
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    'absent install backup',
  );
  expect(f.budget.retained).toBe(0);
});
it('binds the frozen directory limit to persisted policy', async () => {
  const f = await fixture();
  const plan = await freezeInstallPlan(f.store, [], f.budget, { maxDirectoryEntries: 7 });
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    'persisted invocation policy',
  );
  expect(f.budget.retained).toBe(0);
});
it('rejects an existing parent replaced after freeze before source admission', async () => {
  const f = await fixture();
  await f.files('', { data: null });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a' })],
    f.budget,
  );
  await rename(f.store.root.resolve('data'), f.store.root.resolve('retired'));
  await mkdir(f.store.root.resolve('data'));
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    /ancestor changed|parent changed/i,
  );
  await plan.metadata.dispose();
  expect(f.budget.retained).toBe(0);
});

it('borrows the original current index with no native recapture or frozen-current replay', async () => {
  const f = await fixture();
  await f.files('', { 'data/shared/existing': 'old' });
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/shared/new': 'new' })],
    f.budget,
  );
  const before = { ...f.store.root.work };
  const admission = await InstallAdmission.create(f.store, plan, f.budget);
  expect(f.store.root.work.nativeWalks - before.nativeWalks).toBe(0);
  expect(f.store.root.work.indexBuilds - before.indexBuilds).toBe(0);
  await admission.close();
  expect(f.budget.retained).toBe(0);
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    /consumed|missing|closed/i,
  );
  expect(f.budget.retained).toBe(0);
});
it('rejects copied plans and explicitly revoked current provenance without reconstruction', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(f.store, [], f.budget);
  await expect(InstallAdmission.create(f.store, { ...plan }, f.budget)).rejects.toThrow(
    'process-owned',
  );
  const original = await takeInstallIndexes(f.store, plan);
  expect(original).toBeDefined();
  await original!.scratch.close();
  const walks = f.store.root.work.nativeWalks;
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    /consumed|missing|closed/i,
  );
  expect(f.store.root.work.nativeWalks).toBe(walks);
  expect(f.budget.retained).toBe(0);
});
it('revokes the taken current index on cancellation while reopening without a second walk', async () => {
  const f = await fixture(),
    plan = await freezeInstallPlan(f.store, [], f.budget),
    controller = new AbortController();
  const reopen = InstallScratch.prototype.reopen;
  vi.spyOn(InstallScratch.prototype, 'reopen').mockImplementationOnce(async function (
    this: InstallScratch,
  ) {
    await reopen.call(this);
    controller.abort(new Error('cancel current borrowing'));
  });
  const walks = f.store.root.work.nativeWalks;
  await expect(InstallAdmission.create(f.store, plan, f.budget, controller.signal)).rejects.toThrow(
    'cancel current borrowing',
  );
  expect(f.store.root.work.nativeWalks).toBe(walks);
  expect(f.budget.retained).toBe(0);
  await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
    /consumed|missing|closed/i,
  );
});
