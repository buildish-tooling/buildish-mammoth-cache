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

import { NativeRoot } from '../../../src/cache/streaming/native';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import * as nativeWalk from '../../../src/cache/streaming/native-walk';
import { afterEach, expect, it, vi } from 'vitest';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { composedFixture } from './composed-fixture';
import { memoryArtifacts } from './memory-artifact-fixture';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import {
  postStreamingReadOnly,
  reconcileDisabledRoot,
} from '../../../src/cache/streaming/passive-lifecycle';
import { FrozenWorkerArchive } from '../../../src/cache/streaming/worker-package';
import { WorkerSources } from '../../../src/cache/streaming/worker-walk';
import { LocalBaseSnapshot } from '../../../src/cache/streaming/live-base-inputs';
import { readWorkerArchive } from '../../../src/cache/streaming/worker-codec';
import { localRecords } from '../../../src/cache/streaming/prepare-state';
import { DiskMembership } from '../../../src/cache/streaming/worker-spool';
import { Readable } from 'node:stream';
const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(readOnly = false, allowance = 100000) {
  const f = await composedFixture();
  fixtures.push(f);
  const ready = await prepareStreaming({
    ...f.request,
    maxDirectoryEntries: allowance,
    policy: {
      ...f.request.policy,
      role: 'distributed-worker',
      access: readOnly ? 'read-only' : 'writable',
    },
  });
  const artifacts = memoryArtifacts();
  const post = (backend = artifacts.api) =>
    postStreamingWorker({
      anchor: ready.anchor,
      budget: f.budget,
      assertCurrent: (): undefined => {},
      artifactBackend: async () => backend,
    });
  return { ...f, ready, artifacts, post };
}
it.each([false, true])(
  'uploads a real direct worker artifact including empty completion=%s, without a snapshot shadow',
  async (empty) => {
    const f = await fixture(),
      copy = vi.spyOn(LocalBaseSnapshot, 'captureAll');
    if (!empty) await f.files('', { 'data/new': 'body', 'state/mine': 'snapshot' });
    const result = await f.post();
    expect(result.outcome).toBe('worker-uploaded');
    expect(copy).not.toHaveBeenCalled();
    expect(((await f.ready.store.state()) as unknown[])[14]).toBe('worker-uploaded');
    const bytes = [...f.artifacts.objects.values()][0].bytes,
      files: string[] = [];
    await readWorkerArchive(Readable.from([bytes], { objectMode: false, highWaterMark: 65536 }), {
      model: f.model,
      context: f.request.context,
      authorizedSnapshots: ['state'],
      budget: f.budget,
      membership: await DiskMembership.create(f.ready.store, f.budget),
      consumeFile: async (file) => {
        files.push(file.path);
        for await (const _ of file.body) void _;
      },
    });
    expect(files.sort()).toEqual(empty ? [] : ['data/new', 'state/mine']);
    const before = f.artifacts.upload.mock.calls.length;
    expect(await f.post()).toEqual(result);
    expect(f.artifacts.upload).toHaveBeenCalledTimes(before);
  },
);
it('denies an unsupported raw backend after freeze and before GC or source/package traversal', async () => {
  const f = await fixture(),
    sources = vi.spyOn(WorkerSources, 'create');
  await f.files('', { 'data/new': 'body' });
  await expect(
    f.post({
      ...f.artifacts.api,
      capabilities: { ...f.artifacts.api.capabilities, supportsRawWorkerArchives: false },
    }),
  ).rejects.toThrow('raw worker');
  const state = (await f.ready.store.state()) as unknown[];
  expect(state[4]).toBe('observations-frozen');
  expect(state[7]).toBeNull();
  expect(state[12]).toBeNull();
  expect(sources).not.toHaveBeenCalled();
  expect((await f.post()).outcome).toBe('worker-uploaded');
});
it('cold reopens exact committed bytes after sources disappear and rejects altered package name/hash', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body', 'state/mine': 'snapshot' });
  const failed = {
    ...f.artifacts.api,
    uploadArtifact: vi.fn(async () => {
      throw new Error('offline');
    }),
  };
  await expect(f.post(failed)).rejects.toThrow();
  const state = f.ready.store.codec.schemas.documents['local-state'].parse(
    await f.ready.store.state(),
  );
  expect(state[4]).toBe('package-frozen');
  const ref = state[12]![0],
    original = await readFile(f.ready.store.root.resolve(ref[2]));
  await rm(f.ready.store.root.resolve('data'), { recursive: true });
  await rm(f.ready.store.root.resolve('state'), { recursive: true });
  const packageSpy = vi.spyOn(FrozenWorkerArchive, 'package');
  expect((await f.post()).outcome).toBe('worker-uploaded');
  expect(packageSpy).not.toHaveBeenCalled();
  expect([...f.artifacts.objects.values()][0].bytes).toEqual(original);
  // Re-enter the genuine committed package checkpoint to exercise its cold admission.
  const current = f.ready.store.codec.schemas.documents['local-state'].parse(
    await f.ready.store.state(),
  );
  current[3]++;
  current[4] = 'package-frozen';
  current[14] = null;
  current[12]![3] = null;
  await f.ready.store.updateState(current);
  const valid = structuredClone(current);
  current[3]++;
  current[12]![1] = 'wrong.tar.gz';
  await f.ready.store.updateState(current);
  await expect(FrozenWorkerArchive.reopen(f.ready.store, f.budget)).rejects.toThrow('name');
  valid[3] = current[3] + 1;
  await f.ready.store.updateState(valid);
  await writeFile(f.ready.store.root.resolve(ref[2]), Buffer.alloc(original.length));
  await expect(FrozenWorkerArchive.reopen(f.ready.store, f.budget)).rejects.toThrow();
});
it('read-only post has no cache traversal, daemon inspection, GC or upload and disable preserves old recovery ownership', async () => {
  const f = await fixture(true);
  await f.files('', { 'data/new': 'body' });
  const reads = vi.spyOn(NativeRoot.prototype, 'read'),
    bodies = vi.spyOn(NativeReadPhase.prototype, 'read'),
    walks = vi.spyOn(nativeWalk, 'walkNative');
  expect(
    await postStreamingReadOnly(f.ready.anchor, {
      budget: f.budget,
      assertCurrent: (): undefined => {},
    }),
  ).toEqual({ outcome: 'read-only' });
  expect(reads.mock.calls.every(([p]) => p.startsWith('.mammoth/'))).toBe(true);
  expect(bodies).not.toHaveBeenCalled();
  expect(walks).not.toHaveBeenCalled();
  expect(f.artifacts.upload).not.toHaveBeenCalled();
  await reconcileDisabledRoot(f.root, { budget: f.budget, assertCurrent: (): undefined => {} });
  expect(((await f.ready.store.state()) as unknown[])[14]).toBe('read-only');
});

it('confirms an upload whose acknowledgement was lost through exact service readback', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body' });
  const backend = {
    ...f.artifacts.api,
    uploadArtifact: async (...args: Parameters<typeof f.artifacts.api.uploadArtifact>) => {
      await f.artifacts.api.uploadArtifact(...args);
      throw new Error('lost acknowledgement');
    },
  };
  expect((await f.post(backend)).outcome).toBe('worker-uploaded');
  expect(f.artifacts.get).toHaveBeenCalledTimes(1);
});

it('rejects a completely valid same-context archive omitting a frozen snapshot channel', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body', 'state/mine': 'snapshot' });
  const pack = FrozenWorkerArchive.package;
  vi.spyOn(FrozenWorkerArchive, 'package').mockImplementation(
    async (store, view, name, budget, options) => {
      const empty = await store.writeStream(
        'worker-sources',
        { budget, partition: null },
        localRecords([]),
      );
      return pack(store, { ...view, workerSources: empty }, name, budget, options);
    },
  );
  await expect(
    f.post({
      ...f.artifacts.api,
      uploadArtifact: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow();
  vi.restoreAllMocks();
  await expect(FrozenWorkerArchive.reopen(f.ready.store, f.budget)).rejects.toThrow(
    'exact frozen worker snapshot scope',
  );
});

it('disabled reconciliation accepts an absent root without creating it and blocks corrupt existing ownership', async () => {
  const f = await fixture(),
    missing = f.root + '/absent/managed';
  await reconcileDisabledRoot(missing, { budget: f.budget, assertCurrent: (): undefined => {} });
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(f.ready.store.root.resolve('.mammoth/v1/current.json'), 'invalid');
  await expect(
    reconcileDisabledRoot(f.root, { budget: f.budget, assertCurrent: (): undefined => {} }),
  ).rejects.toThrow();
});

it('worker capture and archive retry use the original nondefault directory allowance', async () => {
  const f = await fixture(false, 11);
  await f.files('', { 'data/new': 'body' });
  await expect(
    f.post({
      ...f.artifacts.api,
      uploadArtifact: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow();
  expect((await f.post()).outcome).toBe('worker-uploaded');
});

it('disabled prepare without a new owner cannot ignore legacy destructive intent', async () => {
  const f = await composedFixture();
  fixtures.push(f);
  await f.store.makeParents(
    '.mammoth/v1/' + f.store.codec.options.invocation + '/files/placeholder',
  );
  const { mkdir } = await import('node:fs/promises');
  await mkdir(f.root + '/.mammoth', { recursive: true });
  await writeFile(f.root + '/.mammoth/restore-move-v1.json', '{}');
  await expect(
    reconcileDisabledRoot(f.root, { budget: f.budget, assertCurrent: (): undefined => {} }),
  ).rejects.toThrow('legacy');
});
