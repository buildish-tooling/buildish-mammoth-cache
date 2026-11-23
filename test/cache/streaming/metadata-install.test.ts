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

import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './install-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import {
  createMetadataDescriptor,
  createMetadataGeneration,
} from '../../../src/cache/streaming/metadata-base-records';
import type { GenerationEntry } from '../../../src/cache/streaming/native-records';
import { MetadataInstallContext } from '../../../src/cache/streaming/metadata-install-context';
import { freezeMetadataInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import { InstallAdmission } from '../../../src/cache/streaming/install-admission';
import type { nativeWork } from '../../../src/cache/streaming/native';
import { recordEncodingWork, type Value } from '../../../src/cache/streaming/encoding';
const h = 'a'.repeat(64);
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
const contexts: MetadataInstallContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of contexts.splice(0)) await c.dispose();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(
  partitions = 2,
  units = 2,
  options: { snapshot?: boolean; fail?: (name: string) => Promise<void> } = {},
) {
  const ids = Array.from({ length: partitions }, (_, i) => 'p' + i),
    hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      ids.map((id) => [
        id,
        options.snapshot ? ['state/**'] : ['repository/**/file-' + id],
        hard,
        options.snapshot ? 'single-writer' : 'aggregate',
        options.snapshot ? 'A' : null,
        'default',
      ]),
    ],
    'metadata-install-',
    1,
  );
  const f = await installFixture('maven', { model, fail: options.fail });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const entries: GenerationEntry[] = [],
    materialized: { partition: string; root: string }[] = [];
  for (const id of ids) {
    if (!units) {
      entries.push(['empty', id]);
      continue;
    }
    const root = f.store.prefix + 'objects/' + id,
      payload = root + '/payload';
    await mkdir(f.store.root.resolve(payload), { recursive: true });
    const descriptor = createMetadataDescriptor(model, [model.family, model.id, id, h, h, h]);
    await writeFile(f.store.root.resolve(root + '/envelope.json'), descriptor.bytes);
    for (let i = 0; i < units; i++)
      await f.files(payload, {
        [(options.snapshot ? 'state/' : 'repository/') +
        'shared/unit-' +
        String(i).padStart(3, '0') +
        '/file-' +
        id]: 'new-' + id + '-' + i,
      });
    entries.push(['object', id, descriptor.reference]);
    materialized.push({ partition: id, root });
  }
  const groups = [ids],
    generation = createMetadataGeneration(
      model,
      h,
      h,
      h,
      entries,
      partitions === 1 ? [[ids[0]]] : groups,
    );
  return { ...f, ids, units, entries, materialized, generation };
}
async function discover(f: Awaited<ReturnType<typeof fixture>>, offered = f.materialized) {
  const c = await MetadataInstallContext.discover(f.store, f.generation, offered, {
    budget: f.budget,
  });
  contexts.push(c);
  return c;
}
function difference(after: ReturnType<typeof nativeWork>, before: ReturnType<typeof nativeWork>) {
  return Object.fromEntries(
    Object.keys(before).map((k) => [
      k,
      after[k as keyof typeof after] - before[k as keyof typeof before],
    ]),
  ) as unknown as ReturnType<typeof nativeWork>;
}
it('installs multiple native projections using original index selectors and no hash/preimage catalogue', async () => {
  const f = await fixture(2, 3);
  for (const id of f.ids)
    for (let i = 0; i < f.units; i++)
      await f.files('', {
        ['repository/shared/unit-' + String(i).padStart(3, '0') + '/file-' + id]: 'old',
      });
  const c = await discover(f),
    builds = f.store.root.work.indexBuilds;
  const plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
  expect('preimages' in plan).toBe(false);
  expect(f.store.root.work.indexBuilds - builds).toBe(1); // current only; native source indexes are borrowed
  expect(c.work.memberRows).toBe(0);
  await executeInstall(f.store, plan, f.budget, { batchOperations: 2 });
  for (const id of f.ids)
    for (let i = 0; i < f.units; i++)
      expect(
        await readFile(
          f.store.root.resolve(
            'repository/shared/unit-' + String(i).padStart(3, '0') + '/file-' + id,
          ),
          'utf8',
        ),
      ).toBe('new-' + id + '-' + i);
  expect(f.store.root.work.bodyHashCalls).toBe(0);
  expect(f.budget.retained).toBe(0);
  expect(() => c.take()).toThrow('closed');
});
it('folds native coordinate groups, rejects crossings/invented joins, and keeps cold authority private', async () => {
  const f = await fixture(2, 2),
    c = await discover(f, [f.materialized[0]]);
  expect(c.cold).toEqual([f.ids]);
  const diagnostic = c.cold as string[][];
  diagnostic[0].length = 0;
  expect(c.cold).toEqual([f.ids]);
  expect(c.take()).toEqual([]);
  await c.dispose();
  const crossing = await fixture(2, 2);
  crossing.generation = createMetadataGeneration(
    crossing.model,
    h,
    h,
    h,
    crossing.entries,
    crossing.ids.map((id) => [id]),
  );
  await expect(discover(crossing)).rejects.toThrow('crosses');
  expect(crossing.budget.retained).toBe(0);
  const invented = await fixture(2, 2);
  // Move one projection's direct files into a distinct coordinate without changing its bounded descriptor.
  for (let i = 0; i < invented.units; i++) {
    const root = invented.materialized[1].root + '/payload';
    await mkdir(invented.store.root.resolve(root + '/repository/distinct-' + i), {
      recursive: true,
    });
    await rename(
      invented.store.root.resolve(
        root + '/repository/shared/unit-' + String(i).padStart(3, '0') + '/file-p1',
      ),
      invented.store.root.resolve(root + '/repository/distinct-' + i + '/file-p1'),
    );
    const { rmdir } = await import('node:fs/promises');
    await rmdir(
      invented.store.root.resolve(root + '/repository/shared/unit-' + String(i).padStart(3, '0')),
    );
  }
  // Empty routing directories have no owned payload; remove them for this projection.
  const { rmdir } = await import('node:fs/promises');
  await rmdir(
    invented.store.root.resolve(invented.materialized[1].root + '/payload/repository/shared'),
  );
  await expect(discover(invented)).rejects.toThrow('Invented');
  expect(invented.budget.retained).toBe(0);
});
it.each([2, 8])(
  'visits each recovery-group edge once with %i units per partition',
  async (units) => {
    const f = await fixture(2, units),
      a = f.materialized[0].root + '/payload',
      b = f.materialized[1].root + '/payload';
    // The shared parent is the only join, and a child in A sorts before its direct file.
    await rename(
      f.store.root.resolve(a + '/repository/shared/unit-000'),
      f.store.root.resolve(a + '/repository/shared/a-nested'),
    );
    await rename(
      f.store.root.resolve(b + '/repository/shared'),
      f.store.root.resolve(b + '/repository/distinct'),
    );
    await f.files(a, { 'repository/shared/file-p0': 'direct' });
    await f.files(b, { 'repository/shared/file-p1': 'direct' });

    const c = await discover(f),
      directories = 7 + 2 * units,
      files = 2 * (units + 1);
    expect(c.cold).toEqual([]);
    expect(c.work.coordinateNodes).toBe(directories);
    expect(c.work.coordinateEdges).toBe(directories - 2 + files); // two payload roots have no edge
    await c.dispose();
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects an arbitrary delta-shaped source without original completed merge/native index provenance', async () => {
  const f = await fixture(1, 0);
  expect(() =>
    MetadataInstallContext.fromWorkerNative(f.store, {} as never, {} as never, {
      budget: f.budget,
    }),
  ).toThrow();
  expect(f.budget.retained).toBe(0);
});
it('checks metadata selector nonce, role, partition, offset, kind, path, and closed lifetime', async () => {
  const f = await fixture(1, 2),
    c = await discover(f),
    input = c.source('p0')!;
  const selected = c.selector('source', 'p0', input.index),
    reader = c.reader(selected);
  await expect(reader.rootNode(selected, 'wrong', 'directory')).rejects.toThrow();
  await expect(reader.rootNode(selected, '', 'file')).rejects.toThrow();
  const changed = [...selected] as unknown as Value[];
  changed[1] = 'b'.repeat(32);
  expect(() => c.reader(changed)).toThrow('context');
  const role = [...selected] as unknown as Value[];
  role[2] = 'current';
  expect(() => c.reader(role)).toThrow('index');
  const part = [...selected] as unknown as Value[];
  part[3] = 'wrong';
  expect(() => c.reader(part)).toThrow();
  const offset = [...selected] as unknown as Value[];
  offset[4] = input.index + 1;
  await expect(reader.rootNode(offset, '', 'directory')).rejects.toThrow();
  await c.dispose();
  expect(() => c.reader(selected)).toThrow('closed');
  expect(f.budget.retained).toBe(0);
});
it.each(['state', 'cancel', 'changed-current'])(
  'disposes declared-empty ownership on early %s failure',
  async (kind) => {
    const f = await fixture(1, 0, { snapshot: true });
    await f.files('', { 'state/old': 'old' });
    const c = await discover(f),
      empty = c.source('p0')!.nativeRoot;
    const plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
    if (kind === 'state') {
      const state = (await f.store.state()) as Value[];
      state[3] = Number(state[3]) + 1;
      state[4] = 'prepare-failed';
      await f.store.updateState(state);
    }
    if (kind === 'changed-current') await f.files('', { 'state/extra': 'extra' });
    const controller = new AbortController();
    if (kind === 'cancel') controller.abort(new Error('cancel early'));
    await expect(
      executeInstall(f.store, plan, f.budget, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(await f.store.root.stat(empty)).toBeNull();
    expect(() => c.take()).toThrow('closed');
    expect(f.budget.retained).toBe(0);
    expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
  },
);
it('keeps admission and cleanup errors together and retains an occupied owned empty location', async () => {
  const f = await fixture(1, 0, { snapshot: true }),
    c = await discover(f),
    empty = c.source('p0')!.nativeRoot;
  const plan = await freezeMetadataInstallPlan(f.store, c, f.budget),
    controller = new AbortController();
  controller.abort(new Error('admission cancelled'));
  // A foreign replacement cannot be retired by the original directory receipt.
  const { rename } = await import('node:fs/promises');
  await rename(f.store.root.resolve(empty), f.store.root.resolve(empty + '-original'));
  await mkdir(f.store.root.resolve(empty));
  await writeFile(f.store.root.resolve(empty + '/foreign'), 'foreign');
  let failure: unknown;
  try {
    await executeInstall(f.store, plan, f.budget, { signal: controller.signal });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(String(failure)).toContain('retained');
  expect((failure as AggregateError).errors.map(String).join(' ')).toContain('admission cancelled');
  expect(await readFile(f.store.root.resolve(empty + '/foreign'), 'utf8')).toBe('foreign');
  expect(() => c.take()).toThrow('closed');
  expect(f.budget.retained).toBe(0);
  // Avoid repeating the intentionally blocked ownership cleanup in afterEach; fixture root owns disposal.
  contexts.splice(contexts.indexOf(c), 1);
});
it('retires a replaced snapshot directory from its original index without constructing another facts/index copy', async () => {
  const f = await fixture(1, 0, { snapshot: true });
  await f.files('', { 'state/a': 'old', 'state/sub/b': 'old', 'state/sub/c': 'old' });
  const c = await discover(f),
    plan = await freezeMetadataInstallPlan(f.store, c, f.budget),
    builds = f.store.root.work.indexBuilds;
  await executeInstall(f.store, plan, f.budget);
  expect(await f.store.root.stat('state')).toBeNull();
  expect(f.store.root.work.indexBuilds).toBe(builds);
  expect(c.work.memberRows).toBeGreaterThan(0);
  expect(f.budget.retained).toBe(0);
});
it('counts complete four-partition/shared-coordinate discovery, install and cleanup work as units grow', async () => {
  const result = [];
  for (const units of [4, 16]) {
    const f = await fixture(4, units);
    for (const id of f.ids)
      for (let i = 0; i < units; i++)
        await f.files('', {
          ['repository/shared/unit-' + String(i).padStart(3, '0') + '/file-' + id]: 'old-' + id,
        });
    const nativeBefore = { ...f.store.root.work },
      codecBefore = { ...recordEncodingWork };
    const c = await discover(f),
      plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
    expect(c.work.memberRows).toBe(0);
    await executeInstall(f.store, plan, f.budget, { batchOperations: 8 });
    const work = difference(f.store.root.work, nativeBefore),
      codec = Object.fromEntries(
        Object.entries(recordEncodingWork).map(([k, v]) => [
          k,
          v - codecBefore[k as keyof typeof codecBefore],
        ]),
      );
    expect(work.bodyHashCalls).toBe(0);
    expect(work.bodyHashBytes).toBe(0);
    expect(work.indexBuilds).toBe(5);
    expect(work.scratchLogicalWriteBytes).toBeGreaterThan(0);
    expect(work.nativeWalks).toBe(5); // four native projections + one borrowed current capture
    expect(work.cleanupEntries).toBeGreaterThan(0);
    expect(work.scratchReadBytes).toBeGreaterThan(0);
    expect(c.work.memberRows).toBe(4 * units); // required backup file retirement only
    expect(f.budget.retained).toBe(0);
    result.push({ units, work, codec, metadata: { ...c.work } });
  }
  for (const key of [
    'stats',
    'readBytes',
    'writeBytes',
    'scratchReadBytes',
    'scratchWriteBytes',
    'scratchLogicalWriteBytes',
    'metadataRowsRead',
    'metadataRowsWritten',
    'cleanupEntries',
  ] as const)
    expect(result[1].work[key]).toBeLessThan(
      result[0].work[key] * 5 +
        (key === 'scratchReadBytes' || key === 'scratchWriteBytes' ? 65536 : 0),
    );
  for (const key of Object.keys(result[0].codec))
    expect(result[1].codec[key]).toBeLessThan(result[0].codec[key] * 5);
  await writeFile(
    'build/ls2b-current-metadata-install-counts.json',
    JSON.stringify(result, null, 2) + '\n',
  );
}, 20000);

it('uses one current-root selector with no subtree drain as snapshot descendants grow', async () => {
  for (const count of [4, 16]) {
    const f = await fixture(1, 0, { snapshot: true });
    for (let i = 0; i < count; i++)
      await f.files('', { ['state/shared/unit-' + i + '/old']: 'old' });
    const c = await discover(f),
      plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
    const native = f.store.root.work.nativeWalks,
      roots = c.work.rootSelections;
    const admission = await InstallAdmission.create(f.store, plan, f.budget);
    expect(f.store.root.work.nativeWalks - native).toBe(0); // original current index is borrowed
    expect(c.work.rootSelections - roots).toBe(1);
    expect(c.work.memberRows).toBe(0);
    await admission.close();
    await c.dispose();
    expect(f.budget.retained).toBe(0);
  }
});
it.each(['old-backup', 'new-installed'])(
  'keeps valid partial snapshot outcomes and owned cleanup after %s failure',
  async (phase) => {
    let renames = 0,
      armed = false,
      fired = false;
    const f = await fixture(1, 2, {
      snapshot: true,
      fail: async (name) => {
        if (!armed || fired) return;
        if (
          (phase === 'old-backup' && name === 'install-old-backed-up') ||
          (phase === 'new-installed' && name === 'install-rename-before-stat' && ++renames === 2)
        ) {
          fired = true;
          throw new Error('injected metadata rename failure');
        }
      },
    });
    await f.files('', { 'state/old': 'old', 'state/sub/old': 'old-sub' });
    const c = await discover(f),
      plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
    armed = true;
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow(
      'injected metadata rename failure',
    );
    expect(fired).toBe(true);
    if (phase === 'old-backup')
      expect(await readFile(f.store.root.resolve('state/old'), 'utf8')).toBe('old');
    else
      expect(await readFile(f.store.root.resolve('state/shared/unit-000/file-p0'), 'utf8')).toBe(
        'new-p0-0',
      );
    expect(() => c.take()).toThrow('closed');
    expect(f.budget.retained).toBe(0);
  },
);

it('preserves freeze and cleanup errors when declared-empty disposal is blocked', async () => {
  const f = await fixture(1, 0, { snapshot: true }),
    c = await discover(f),
    empty = c.source('p0')!.nativeRoot;
  const { rename } = await import('node:fs/promises');
  await rename(f.store.root.resolve(empty), f.store.root.resolve(empty + '-original'));
  await mkdir(f.store.root.resolve(empty));
  await writeFile(f.store.root.resolve(empty + '/foreign'), 'foreign');
  const controller = new AbortController();
  controller.abort(new Error('freeze cancelled'));
  let failure: unknown;
  try {
    await freezeMetadataInstallPlan(f.store, c, f.budget, { signal: controller.signal });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(controller.signal.reason);
  expect((failure as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
  expect(String(failure)).toContain('retained');
  expect(await readFile(f.store.root.resolve(empty + '/foreign'), 'utf8')).toBe('foreign');
  expect(() => c.take()).toThrow('closed');
  expect(f.budget.retained).toBe(0);
  contexts.splice(contexts.indexOf(c), 1);
});

it('rejects revoked staged current provenance without reconstructing even an empty plan', async () => {
  const f = await fixture(1, 0, { snapshot: true }),
    c = await discover(f),
    plan = await freezeMetadataInstallPlan(f.store, c, f.budget);
  c.close();
  const walks = f.store.root.work.nativeWalks;
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('closed/unbound');
  expect(f.store.root.work.nativeWalks).toBe(walks);
  expect(f.budget.retained).toBe(0);
});
