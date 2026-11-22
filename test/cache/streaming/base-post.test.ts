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

import { gradleResolver } from './quiescence-fixture';
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, utimes, writeFile, open } from 'node:fs/promises';
import { composedFixture } from './composed-fixture';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingBase, type BasePostRequest } from '../../../src/cache/streaming/base-post';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { BaselineMetadata } from '../../../src/cache/streaming/baseline-metadata';
import { baselineGeneration } from '../../../src/cache/streaming/base-publication';
import * as nativeTree from '../../../src/cache/streaming/native-tree';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { InstallParentPhase } from '../../../src/cache/streaming/install-parent-phase';
import { LiveNativeView } from '../../../src/cache/streaming/live-base-inputs';
import * as gcProjection from '../../../src/cache/streaming/gc-projection';
import { FrozenBaseTree } from '../../../src/cache/streaming/base-frozen-tree';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { PrepareFacts } from '../../../src/cache/streaming/prepare-state';
const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
  await cleanupBaseFixtures();
});
async function fixture(
  overrides: Parameters<typeof composedFixture>[0] = {},
  model?: Parameters<typeof composedFixture>[1],
) {
  const f = await composedFixture(overrides, model);
  fixtures.push(f);
  return f;
}
function post(
  f: Awaited<ReturnType<typeof composedFixture>>,
  anchor: BasePostRequest['anchor'],
  backend: BasePostRequest['cacheBackend'],
  options: Partial<BasePostRequest> = {},
) {
  return postStreamingBase({
    anchor,
    budget: f.budget,
    assertCurrent: (): undefined => {},
    cacheBackend: backend,
    removeHooks: async () => {},
    ...options,
  });
}
// Native/SDK cases include external TAR round trips and process-restart ordering.
it('runs real prepare/build/base save/return/record completion and cold completion retry', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend });
  const probe = await open(f.store.root.resolve('flush-probe'), 'wx');
  vi.spyOn(Object.getPrototypeOf(probe), 'sync').mockRejectedValue(
    new Error('Unexpected storage flush'),
  );
  vi.spyOn(Object.getPrototypeOf(probe), 'datasync').mockRejectedValue(
    new Error('Unexpected storage flush'),
  );
  await probe.close();
  await rm(f.store.root.resolve('flush-probe'));
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'build', 'state/local': 'mine' });
  const projections = vi.spyOn(gcProjection, 'checkGcProjection');
  const result = await post(f, ready.anchor, async () => sdk.backend);
  expect(result.outcome).toBe('published');
  expect(projections).toHaveBeenCalledTimes(2);
  expect(result.key).toBeTruthy();
  expect(await readFile(f.store.root.resolve('data/new'), 'utf8')).toBe('build');
  expect(await readFile(f.store.root.resolve('state/local'), 'utf8')).toBe('mine');
  expect(((await f.store.state()) as unknown[])[14]).toBe('published');
  expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(3);
  const backend = vi.fn(async () => sdk.backend);
  expect(await post(f, ready.anchor, backend)).toEqual(result);
  expect(backend).not.toHaveBeenCalled();
}, 20000);
it('retains baseline metadata without payloads and earns exact no-change on the next invocation', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend });
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'build' });
  await utimes(f.store.root.resolve('data/new'), 123, 123);
  const first = await post(f, ready.anchor, async () => sdk.backend);
  const next = await prepareStreaming({ ...f.request, nonce: 'b'.repeat(32) });
  const facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    const generation = await baselineGeneration(next.store, facts.bindings);
    for (const e of generation![8])
      if (e[0] === 'object') {
        await BaselineMetadata.open(next.store, e[2], { budget: f.budget });
        expect(
          await next.store.root.stat(next.store.prefix + 'baseline/' + e[1] + '/payload'),
        ).toBeNull();
      }
  } finally {
    facts.close();
  }
  const before = sdk.calls.filter((c) => c.kind === 'save').length;
  const render = vi.spyOn(FrozenBaseTree, 'fromDraft'),
    resume = vi.spyOn(FrozenMovingPublication, 'resume'),
    indexes = vi.spyOn(ObservationIndex, 'open'),
    sweeps = vi.spyOn(LiveNativeView.prototype, 'assertStable'),
    projections = vi.spyOn(gcProjection, 'checkGcProjection'),
    checkpoints = vi.spyOn(InstallParentPhase.prototype, 'created');
  const result = await post(f, next.anchor, async () => sdk.backend);
  expect(render).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(indexes).not.toHaveBeenCalled();
  expect(checkpoints).not.toHaveBeenCalled();
  expect(sweeps).not.toHaveBeenCalled();
  // Post-GC capture supplies initial source facts; final common barrier rechecks them.
  expect(projections).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ outcome: 'no-change', key: first.key });
  expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(before);
}, 20000);
it('an aggregator without a configured writer preserves prepared state over local changes', async () => {
  const sdk = await nativeCacheBackend(),
    hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['data/**'], hard, 'aggregate', null, 'default'],
          ['state', ['state/**'], hard, 'single-writer', null, 'default'],
        ],
      ],
      'install-fixture-',
      1,
    ),
    f = await fixture({ cacheBackend: async () => sdk.backend }, model);
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/a': 'a', 'state/original': 'original' });
  await post(f, ready.anchor, async () => sdk.backend);
  const next = await prepareStreaming({
    ...f.request,
    nonce: 'b'.repeat(32),
    policy: { ...f.request.policy, role: 'distributed-aggregator' },
  });
  await f.files('', { 'state/ignored': 'local' });
  await post(f, next.anchor, async () => sdk.backend);
  await rm(f.store.root.resolve('state'), { recursive: true });
  await prepareStreaming({ ...f.request, nonce: 'c'.repeat(32) });
  expect(await readFile(f.store.root.resolve('state/original'), 'utf8')).toBe('original');
  expect(await f.store.root.stat('state/ignored')).toBeNull();
}, 20000);
it('does not observe or create a backend when initial Gradle quiescence is unavailable', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', ['data/**'], hard, 'aggregate', null, 'default']]],
      'install-fixture-',
      1,
    ),
    f = await fixture({}, model),
    ready = await prepareStreaming(f.request),
    backend = vi.fn(async () => f.backend);
  const result = await post(f, ready.anchor, backend, {
    lifecycle: gradleResolver({
      inspect: async () => ({ remaining: false, uncertain: true, reason: 'unavailable' }),
    }),
  });
  expect(result.outcome).toBe('skipped-not-quiescent');
  expect(backend).not.toHaveBeenCalled();
  expect(((await f.store.state()) as unknown[])[6]).toBeNull();
});
it('resumes an immutable frozen publication after a backend failure without recapture or hook removal', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend }),
    ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'build' });
  const removeHooks = vi.fn(async () => {}),
    backend = {
      ...sdk.backend,
      saveCache: vi.fn(async () => {
        throw new Error('service offline');
      }),
    };
  await expect(post(f, ready.anchor, async () => backend, { removeHooks })).rejects.toThrow();
  const state = (await f.store.state()) as unknown[];
  expect(state[8]).not.toBeNull();
  const result = await post(f, ready.anchor, async () => sdk.backend, { removeHooks });
  expect(result.outcome).toBe('published');
  expect(removeHooks).toHaveBeenCalledTimes(1);
}, 20000);

it('rejects retained baseline corruption before purging or creating a post backend', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend });
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  await post(f, ready.anchor, async () => sdk.backend);
  const next = await prepareStreaming({ ...f.request, nonce: 'b'.repeat(32) });
  await writeFile(
    next.store.root.resolve(next.store.prefix + 'baseline/data/tree.ndjson'),
    'invalid',
  );
  const backend = vi.fn(async () => sdk.backend);
  await expect(post(f, next.anchor, backend)).rejects.toThrow();
  expect(backend).not.toHaveBeenCalled();
  expect(((await next.store.state()) as unknown[])[6]).toBeNull();
}, 20000);
it('rejects a final effective-source mutation and never saves the generation record', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend }),
    ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  let injected = false;
  const backend = {
    ...sdk.backend,
    saveCache: async (...args: Parameters<typeof sdk.backend.saveCache>) => {
      const id = await sdk.backend.saveCache(...args);
      if (args[0].some((p) => p.replaceAll('\\', '/').includes('/objects/'))) {
        injected = true;
        await f.files('', { 'data/injected': 'concurrent' });
      }
      return id;
    },
  };
  await expect(post(f, ready.anchor, async () => backend)).rejects.toThrow();
  expect(injected).toBe(true);
  expect(
    sdk.calls.filter(
      (c) => c.kind === 'save' && c.paths[0].replaceAll('\\', '/').endsWith('/record.json'),
    ),
  ).toHaveLength(0);
}, 20000);

it('pins baseline identity before awaiting verification and exposes deeply immutable metadata', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend });
  const ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  await post(f, ready.anchor, async () => sdk.backend);
  const next = await prepareStreaming({ ...f.request, nonce: 'b'.repeat(32) }),
    facts = await PrepareFacts.open(next.store, { budget: f.budget });
  try {
    const prior = await baselineGeneration(next.store, facts.bindings),
      entry = prior![8].find((e) => e[0] === 'object')!;
    if (entry[0] !== 'object') throw new Error('missing fixture object');
    const ref = structuredClone(entry[2]),
      original = structuredClone(ref);
    const readNativeTree = nativeTree.readNativeTree;
    vi.spyOn(nativeTree, 'readNativeTree').mockImplementation(async (...args) => {
      ref[1][2] = 'state';
      return readNativeTree(...args);
    });
    const proof = await BaselineMetadata.open(next.store, ref, { budget: f.budget });
    expect(proof.reference).toEqual(original);
    expect(ref[1][2]).toBe('state');
    expect(() => {
      proof.reference[1][2] = 'state';
    }).toThrow();
    expect(() => {
      proof.envelope[3][2] = 'state';
    }).toThrow();
    const controller = new AbortController();
    let events = 0;
    vi.mocked(nativeTree.readNativeTree).mockImplementation(
      async (source, options, envelope, event, signal) => {
        expect(signal).toBe(controller.signal);
        return readNativeTree(
          source,
          options,
          envelope,
          async (row) => {
            events++;
            controller.abort(new Error('cancel retained tree'));
            await event?.(row);
          },
          signal,
        );
      },
    );
    await expect(
      BaselineMetadata.open(next.store, original, { budget: f.budget, signal: controller.signal }),
    ).rejects.toThrow('cancel retained tree');
    expect(events).toBe(1);
  } finally {
    facts.close();
  }
}, 20000);

it('derives the post directory allowance from frozen bindings rather than a new default', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ maxDirectoryEntries: 11, cacheBackend: async () => sdk.backend }),
    ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  expect((await post(f, ready.anchor, async () => sdk.backend)).outcome).toBe('published');
}, 20000);

it('records unavailable optional completion before GC and replays without a backend or receipt', async () => {
  const f = await fixture(),
    ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  const unavailable = { ...f.backend, isFeatureAvailable: () => false };
  expect(await post(f, ready.anchor, async () => unavailable)).toEqual({
    outcome: 'feature-unavailable',
    key: null,
  });
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  expect(state[6]).not.toBeNull();
  expect(state[10]).not.toBeNull();
  for (const cell of [7, 8, 9, 12] as const) expect(state[cell]).toBeNull();
  const backend = vi.fn(async () => {
    throw new Error('Unexpected backend');
  });
  expect(await post(f, ready.anchor, backend)).toEqual({
    outcome: 'feature-unavailable',
    key: null,
  });
  expect(backend).not.toHaveBeenCalled();
  expect(await readFile(f.store.root.resolve('data/new'), 'utf8')).toBe('body');
});
it('does not convert a resumed publication failure into an unavailable skip', async () => {
  const sdk = await nativeCacheBackend(),
    f = await fixture({ cacheBackend: async () => sdk.backend }),
    ready = await prepareStreaming(f.request);
  await f.files('', { 'data/new': 'body' });
  await expect(
    post(f, ready.anchor, async () => ({
      ...sdk.backend,
      saveCache: async () => {
        throw new Error('offline');
      },
    })),
  ).rejects.toThrow('Moving object save remains unconfirmed');
  const before = await f.store.state();
  await expect(
    post(f, ready.anchor, async () => ({ ...sdk.backend, isFeatureAvailable: () => false })),
  ).rejects.toThrow('Native base backend cannot publish');
  expect(await f.store.state()).toEqual(before);
  expect(await readFile(f.store.root.resolve('data/new'), 'utf8')).toBe('body');
}, 20000);

it.each([false, true])(
  'keeps post-GC parent N on exact reuse without a selected tree (mutated=%s)',
  async (mutated) => {
    const sdk = await nativeCacheBackend(),
      f = await fixture({ cacheBackend: async () => sdk.backend });
    const ready = await prepareStreaming(f.request);
    await f.files('', { 'data/recent': 'body' });
    const first = await post(f, ready.anchor, async () => sdk.backend);
    await f.files('', { 'data/stale': 'expired' });
    await utimes(f.store.root.resolve('data/stale'), 1.234, 1.234);
    const next = await prepareStreaming({
      ...f.request,
      nonce: 'd'.repeat(32),
      now: () => Date.now() + 1000,
      policy: { ...f.request.policy, gcAgeMs: 3600000 },
    });
    const freeze = FrozenMovingPublication.freeze;
    vi.spyOn(FrozenMovingPublication, 'freeze').mockImplementation(async (...args) => {
      const result = await freeze(...args);
      try {
        expect(await f.store.root.stat('data/stale')).toBeNull();
        expect(result.choices.map((c) => c.slice(0, 2))).toEqual([
          ['reuse', 'data'],
          ['empty', 'state'],
        ]);
        if (mutated) await utimes(f.store.root.resolve('data'), 1.234, 1.234);
        return result;
      } catch (error) {
        result.dispose();
        throw error;
      }
    });
    const pending = post(f, next.anchor, async () => sdk.backend);
    if (mutated) await expect(pending).rejects.toThrow('context changed');
    else expect(await pending).toEqual({ outcome: 'no-change', key: first.key });
    expect(await readFile(f.store.root.resolve('data/recent'), 'utf8')).toBe('body');
  },
  20000,
);
