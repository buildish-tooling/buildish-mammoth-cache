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
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import type { Value } from '../../../src/cache/streaming/encoding';
import { InstallAdmission } from '../../../src/cache/streaming/install-admission';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
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
it.each(['current-extra', 'current-body', 'source-body'] as const)(
  'rejects %s changed after freezing before any live mutation',
  async (kind) => {
    const f = await fixture();
    await f.files('', { 'state/old': 'old' });
    const input = await f.incoming('state', { 'state/new': 'new' }),
      plan = await freezeInstallPlan(f.store, [input], f.budget),
      renames = f.store.root.work.renames;
    if (kind === 'current-extra') await f.files('', { 'state/unexpected': 'unexpected' });
    if (kind === 'current-body') await writeFile(f.store.root.resolve('state/old'), 'changed-body');
    if (kind === 'source-body')
      await writeFile(f.store.root.resolve(input.nativeRoot + '/state/new'), 'changed-body');
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
  state[4] = 'build-ready';
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
it('rejects selected hardlinked preimages before publishing a plan', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old', data: null });
  await link(f.store.root.resolve('state/old'), f.store.root.resolve('data/alias'));
  await expect(
    freezeInstallPlan(f.store, [await f.incoming('state', {})], f.budget),
  ).rejects.toThrow('Aliased selected preimage');
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
it('rejects an existing parent replaced during source admission', async () => {
  const f = await fixture();
  await f.files('', { data: null });
  const input = await f.incoming('data', { 'data/a': 'a' });
  const plan = await freezeInstallPlan(f.store, [input], f.budget);
  const { EvidenceFile } = await import('../../../src/cache/streaming/evidence-file');
  const open = EvidenceFile.open;
  const mock = vi.spyOn(EvidenceFile, 'open').mockImplementation(async (...args) => {
    const value = await open(...args);
    if (args[1] === input.evidence || JSON.stringify(args[1]) === JSON.stringify(input.evidence)) {
      await rename(f.store.root.resolve('data'), f.store.root.resolve('retired'));
      await mkdir(f.store.root.resolve('data'));
    }
    return value;
  });
  try {
    await expect(InstallAdmission.create(f.store, plan, f.budget)).rejects.toThrow(
      'ancestor changed',
    );
  } finally {
    mock.mockRestore();
  }
  expect(f.budget.retained).toBe(0);
});
