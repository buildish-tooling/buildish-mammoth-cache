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

import { afterEach, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { installFixture } from './install-fixture';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
let directory: string, bundle: string;
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('build/retirement-child-'));
  bundle = path.join(directory, 'fixture.mjs');
  await build({
    entryPoints: ['test/cache/streaming/install-process-fixture.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function pair() {
  const old = await installFixture();
  fixtures.push(old);
  const next = await installFixture('gradle', { root: old.root, nonce: 'b'.repeat(32) });
  return { old, next };
}
async function complete(old: Awaited<ReturnType<typeof installFixture>>) {
  const state = old.store.codec.schemas.documents['local-state'].parse(await old.store.state());
  state[3]++;
  state[4] = 'completed';
  state[14] = 'abandoned';
  await old.store.updateState(state);
}
function crash(root: string, point: string, nth = 1) {
  let status: unknown;
  try {
    execFileSync(process.execPath, [bundle, 'retire-start', root, point, String(nth)], {
      stdio: 'pipe',
    });
  } catch (error) {
    status = (error as { status: unknown }).status;
  }
  expect(status).toBe(73);
}
it('detaches only the completed superseded private namespace and preserves live/new data', async () => {
  const { old, next } = await pair();
  await old.store.initialize(old.bindings);
  await old.files('', { 'data/live': 'live', [old.store.prefix + 'orphan/file']: 'old-private' });
  await complete(old);
  await next.files('', { [next.store.prefix + 'new-private']: 'new-private' });
  await next.store.initialize(next.bindings, old.store);
  expect(await old.store.root.stat(old.store.prefix.slice(0, -1))).toBeNull();
  expect(await readFile(old.store.root.resolve('data/live'), 'utf8')).toBe('live');
  expect(await readFile(next.store.root.resolve(next.store.prefix + 'new-private'), 'utf8')).toBe(
    'new-private',
  );
  expect(await readdir(next.store.root.resolve(next.store.prefix + 'retired'))).toEqual([]);
  expect(await readdir(next.store.root.resolve(next.store.prefix + 'retirements'))).toEqual([]);
  await next.store.resumeRetirements(next.budget);
  expect(next.budget.retained).toBe(0);
});
it.each([
  'retirement-owner-published',
  'retired-container-renamed',
  'retired-container-detached',
  'retired-member-retired',
  'retired-container-retired',
  'retirement-record-retired',
])('resumes namespace retirement in another process after %s', async (point) => {
  const { old, next } = await pair();
  crash(old.root, point);
  execFileSync(process.execPath, [bundle, 'retire-resume', old.root, 'unused', '1'], {
    stdio: 'pipe',
  });
  expect(await old.store.root.stat(old.store.prefix.slice(0, -1))).toBeNull();
  expect(await readdir(next.store.root.resolve(next.store.prefix + 'retirements'))).toEqual([]);
});
it('rejects changed terminal state before source detachment', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retirement-owner-published');
  const file = old.store.root.resolve(old.store.prefix + 'state.json'),
    state = JSON.parse(await readFile(file, 'utf8'));
  state[3]++;
  await writeFile(file, JSON.stringify(state) + '\n');
  await expect(next.store.resumeRetirements()).rejects.toThrow('terminal state changed');
  expect(await old.store.root.stat(old.store.prefix + 'orphan/a')).not.toBeNull();
});
it('blocks both present endpoints and changed source/target identities', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retired-container-renamed');
  await mkdir(old.store.root.resolve(old.store.prefix.slice(0, -1)));
  await expect(next.store.resumeRetirements()).rejects.toThrow('source and target');
  await rm(old.store.root.resolve(old.store.prefix.slice(0, -1)), { recursive: true });
  const target = next.store.prefix + 'retired/' + old.store.codec.options.invocation;
  await rename(old.store.root.resolve(target), old.store.root.resolve('.mammoth/held'));
  await mkdir(old.store.root.resolve(target));
  await expect(next.store.resumeRetirements()).rejects.toThrow('container replaced');
});
it('drains prior retirements before completion so garbage never nests', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retired-container-renamed');
  await complete(next);
  expect(await readdir(next.store.root.resolve(next.store.prefix + 'retired'))).toEqual([]);
  const third = await installFixture('gradle', { root: old.root, nonce: 'c'.repeat(32) });
  await third.store.initialize(third.bindings, next.store);
  expect(await third.store.root.stat(next.store.prefix.slice(0, -1))).toBeNull();
  expect(await readdir(third.store.root.resolve(third.store.prefix + 'retired'))).toEqual([]);
});
it('does not allow active old owners, unrecorded garbage, or retired live references', async () => {
  const { old, next } = await pair();
  await old.store.initialize(old.bindings);
  await expect(next.store.initialize(next.bindings, old.store)).rejects.toThrow('not complete');
  await complete(old);
  await next.store.initialize(next.bindings, old.store);
  await mkdir(next.store.root.resolve(next.store.prefix + 'retired/' + 'd'.repeat(64)));
  await expect(next.store.resumeRetirements()).rejects.toThrow('Unrecorded');
  expect(
    next.store.codec.schemas.owned.safeParse(
      next.store.prefix + 'retired/' + 'd'.repeat(64) + '/file',
    ).success,
  ).toBe(false);
  await expect(old.store.resumeRetirements()).rejects.toThrow('not current');
});
it('streams terminal namespace deletion under a small shared budget with linear native work', async () => {
  async function measure(count: number) {
    const { old, next } = await pair();
    await old.store.initialize(old.bindings);
    await old.files(
      '',
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [old.store.prefix + 'orphan/' + i, 'body']),
      ),
    );
    await complete(old);
    // Interrupt before detachment, then measure only replay/deletion work.
    const hook = vi.spyOn(next.store, 'fail').mockImplementation(async (name) => {
      if (name === 'retirement-owner-published') throw new Error('interrupted');
    });
    await expect(next.store.initialize(next.bindings, old.store)).rejects.toThrow('interrupted');
    hook.mockRestore();
    const budget = new WorkingBudget(256 * 1024),
      before = { ...next.store.root.work };
    await next.store.resumeRetirements(budget);
    expect(budget.retained).toBe(0);
    expect(budget.peakRetained).toBeLessThan(256 * 1024);
    return {
      stats: next.store.root.work.stats - before.stats,
      unlinks: next.store.root.work.unlinks - before.unlinks,
    };
  }
  const a = await measure(4),
    b = await measure(40);
  expect(b.stats).toBeLessThan(a.stats * 10);
  expect(b.unlinks - a.unlinks).toBe(36);
});

it('rejects same-invocation initialization before replacing terminal state or locator', async () => {
  const { old } = await pair();
  await old.store.initialize(old.bindings);
  await complete(old);
  const state = await readFile(old.store.root.resolve(old.store.prefix + 'state.json'));
  const locator = await readFile(old.store.root.resolve('.mammoth/v1/current.json'));
  await expect(old.store.initialize(old.bindings, old.store)).rejects.toThrow('same invocation');
  expect(await readFile(old.store.root.resolve(old.store.prefix + 'state.json'))).toEqual(state);
  expect(await readFile(old.store.root.resolve('.mammoth/v1/current.json'))).toEqual(locator);
});

it.each(['retired', 'ReTiReD', 'retired.', 'RETIRED  ', 'retıred'])(
  'rejects %s aliases in owned references and native snapshot sources',
  async (segment) => {
    const { old } = await pair();
    const schema = old.store.codec.schemas;
    const path = old.store.prefix + segment + '/' + 'd'.repeat(64) + '/body';
    const q = [
      'ref',
      'native-evidence',
      old.store.prefix + 'files/evidence',
      1,
      'a'.repeat(64),
    ] as const;
    expect(schema.owned.safeParse(path).success).toBe(false);
    expect(
      schema.ref('native-evidence').safeParse(['ref', 'native-evidence', path, 1, 'a'.repeat(64)])
        .success,
    ).toBe(false);
    expect(
      schema.source.safeParse([
        'state',
        'local-writer',
        ['local-writer', old.store.codec.options.invocation],
        q,
        path,
      ]).success,
    ).toBe(false);
  },
);

it('does not grant unpublished bootstrap records retirement authority', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retirement-record-published');
  await expect(next.store.resumeRetirements()).rejects.toThrow('not current');
  expect(((await old.store.state()) as readonly unknown[])[4]).toBe('completed');
  expect(await readFile(old.store.root.resolve(old.store.prefix + 'orphan/a'), 'utf8')).toBe('a');
});
it('keeps disposal authority after old state and bindings have already retired', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retired-container-detached');
  const target = next.store.prefix + 'retired/' + old.store.codec.options.invocation;
  const state = JSON.parse(await readFile(next.store.root.resolve(target + '/state.json'), 'utf8'));
  const relativeBindings = String(state[5][2]).slice(old.store.prefix.length);
  const { unlink } = await import('node:fs/promises');
  await unlink(next.store.root.resolve(target + '/state.json'));
  await unlink(next.store.root.resolve(target + '/' + relativeBindings));
  await next.store.resumeRetirements(next.budget);
  expect(await next.store.root.stat(target)).toBeNull();
  expect(next.budget.retained).toBe(0);
});
it('never follows a link out of detached private garbage', async () => {
  const { old, next } = await pair();
  await old.store.initialize(old.bindings);
  await old.files('', { 'data/live': 'preserved', [old.store.prefix + 'orphan/file']: 'private' });
  const { symlink } = await import('node:fs/promises');
  await symlink(
    old.store.root.resolve('data'),
    old.store.root.resolve(old.store.prefix + 'orphan/link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await complete(old);
  await expect(next.store.initialize(next.bindings, old.store)).rejects.toThrow(
    'never following links',
  );
  expect(await readFile(next.store.root.resolve('data/live'), 'utf8')).toBe('preserved');
});
it('binds the handoff digest to exact completed-state bytes including LF', async () => {
  const { old, next } = await pair();
  crash(old.root, 'retirement-owner-published');
  const { createHash } = await import('node:crypto');
  const bytes = await readFile(old.store.root.resolve(old.store.prefix + 'state.json'));
  const value = await next.store.readFixed(
    next.store.prefix + 'retirements/' + old.store.codec.options.invocation + '.json',
  );
  const record = next.store.codec.schemas.documents.retirement.parse(value);
  expect(record[5]).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(next.store.codec.decode(next.store.codec.encode(record))).toEqual(record);
  await expect(next.store.writeDocument(record)).rejects.toThrow('Fixed document');
});

it.each(['install', 'INSTALL', 'Install.', 'install ', 'ınstall'])(
  'keeps consumable %s staging out of retained snapshot source tuples',
  async (segment) => {
    const { old } = await pair(),
      schema = old.store.codec.schemas;
    const q = [
      'ref',
      'native-evidence',
      old.store.prefix + 'files/evidence',
      1,
      'a'.repeat(64),
    ] as const;
    const source = (root: string) => [
      'state',
      'local-writer',
      ['local-writer', old.store.codec.options.invocation],
      q,
      root,
    ];
    expect(schema.source.safeParse(source(old.store.prefix + 'snapshots/state')).success).toBe(
      true,
    );
    expect(schema.owned.safeParse(old.store.prefix + segment + '/state').success).toBe(true);
    expect(schema.source.safeParse(source(old.store.prefix + segment + '/state')).success).toBe(
      false,
    );
  },
);
