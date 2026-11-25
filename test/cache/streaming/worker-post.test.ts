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
import { MetadataSnapshot } from '../../../src/cache/streaming/metadata-snapshot';
import { readWorkerArchive } from '../../../src/cache/streaming/worker-codec';
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
  const logs: string[] = [];
  const timing = { now: () => 0, info: (s: string) => logs.push(s) };
  const ready = await prepareStreaming({
    timing,
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
      timing,
      anchor: ready.anchor,
      budget: f.budget,
      assertCurrent: (): undefined => {},
      artifactBackend: async () => backend,
    });
  return { ...f, ready, artifacts, post, logs };
}
it.each([false, true])(
  'uploads a real direct worker artifact including empty completion=%s, without a snapshot shadow',
  async (empty) => {
    const f = await fixture(),
      copy = vi.spyOn(MetadataSnapshot, 'copy');
    if (!empty) {
      await f.files('', { 'data/new': 'body', 'state/mine': 'snapshot' });
    }
    const result = await f.post();
    expect(result.outcome).toBe('worker-uploaded');
    expect(f.logs.some((s) => s.includes('Finished worker package construction'))).toBe(true);
    expect(
      f.logs.some(
        (s) => s.includes('Finished outgoing worker SDK save') && s.includes('(confirmed)'),
      ),
    ).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    const uploadedState = f.ready.store.codec.schemas.documents['local-state'].parse(
      await f.ready.store.state(),
    );
    expect(uploadedState[7]?.[1]).toBe('worker-uploaded');
    expect(uploadedState).toHaveLength(8);
    await expect(readFile(f.artifacts.upload.mock.calls[0][1][0])).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const bytes = [...f.artifacts.objects.values()][0].bytes,
      files: string[] = [];
    const summary = await readWorkerArchive(
      Readable.from([bytes], { objectMode: false, highWaterMark: 65536 }),
      {
        model: f.model,
        context: f.request.context,
        authorizedSnapshots: ['state'],
        budget: f.budget,
        membership: await DiskMembership.create(f.ready.store, f.budget),
        consumeFile: async (file) => {
          files.push(file.path);
          for await (const _ of file.body) {
            void _;
          }
        },
      },
    );
    expect(summary.identity.at(-1)).toEqual(['state']);
    expect(files.sort()).toEqual(empty ? [] : ['data/new', 'state/mine']);
    const before = f.artifacts.upload.mock.calls.length;
    expect(await f.post()).toEqual(result);
    expect(f.artifacts.upload).toHaveBeenCalledTimes(before);
  },
);
it('abandons an unsupported outgoing backend after freeze and before GC or source/package traversal', async () => {
  const f = await fixture(),
    sources = vi.spyOn(WorkerSources, 'create');
  await f.files('', { 'data/new': 'body' });
  expect(
    await f.post({
      ...f.artifacts.api,
      capabilities: { ...f.artifacts.api.capabilities, supportsRawWorkerArchives: false },
    }),
  ).toEqual({ outcome: 'abandoned' });
  const state = (await f.ready.store.state()) as unknown[];
  expect(state[4]).toBe('completed');
  expect((state[7] as unknown[])[1]).toBe('abandoned');
  expect(state).toHaveLength(8);
  expect(state[7]).toEqual(['outcome', 'abandoned', null, null, null]);
  expect(sources).not.toHaveBeenCalled();
  expect(await f.post()).toEqual({ outcome: 'abandoned' });
});
it('abandons failed upload without retry while retaining only the current immutable package', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body', 'state/mine': 'snapshot' });
  let packagePath = '';
  const failed = {
    ...f.artifacts.api,
    uploadArtifact: vi.fn(async (_name: string, files: readonly string[]) => {
      packagePath = files[0];
      throw new Error('offline');
    }),
  };
  expect(await f.post(failed)).toEqual({ outcome: 'abandoned' });
  const state = f.ready.store.codec.schemas.documents['local-state'].parse(
    await f.ready.store.state(),
  );
  expect(state[4]).toBe('completed');
  expect((state[7] as unknown[])[1]).toBe('abandoned');
  expect(state).toHaveLength(8);
  const original = await readFile(packagePath);
  await rm(f.ready.store.root.resolve('data'), { recursive: true });
  await rm(f.ready.store.root.resolve('state'), { recursive: true });
  const packageSpy = vi.spyOn(FrozenWorkerArchive, 'package');
  expect(await f.post()).toEqual({ outcome: 'abandoned' });
  expect(failed.uploadArtifact).toHaveBeenCalledTimes(1);
  expect(packageSpy).not.toHaveBeenCalled();
  expect(f.artifacts.objects.size).toBe(0);
  expect(await readFile(packagePath)).toEqual(original);
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
  expect(((await f.ready.store.state()) as unknown[])[7]).toEqual([
    'outcome',
    'read-only',
    null,
    null,
    null,
  ]);
});

it('abandons a lost acknowledgement without service readback or retry', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body' });
  const backend = {
    ...f.artifacts.api,
    uploadArtifact: async (...args: Parameters<typeof f.artifacts.api.uploadArtifact>) => {
      await f.artifacts.api.uploadArtifact(...args);
      throw new Error('lost acknowledgement');
    },
  };
  expect((await f.post(backend)).outcome).toBe('abandoned');
  expect((await f.post(backend)).outcome).toBe('abandoned');
  expect(f.artifacts.upload).toHaveBeenCalledTimes(1);
  expect(f.artifacts.get).not.toHaveBeenCalled();
  expect(f.artifacts.download).not.toHaveBeenCalled();
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

it('worker capture uses the original nondefault allowance and upload failure remains terminal', async () => {
  const f = await fixture(false, 11);
  await f.files('', { 'data/new': 'body' });
  expect(
    await f.post({
      ...f.artifacts.api,
      uploadArtifact: async () => {
        throw new Error('offline');
      },
    }),
  ).toEqual({ outcome: 'abandoned' });
  expect(await f.post()).toEqual({ outcome: 'abandoned' });
});

it('disabled prepare without a new owner cannot ignore a pending sibling intent', async () => {
  const f = await composedFixture();
  fixtures.push(f);
  await f.store.makeParents(
    '.mammoth/v1/' + f.store.codec.options.invocation + '/files/placeholder',
  );
  await writeFile(f.store.root.resolve(f.store.prefix + 'install-intent.json'), '{}');
  await expect(
    reconcileDisabledRoot(f.root, { budget: f.budget, assertCurrent: (): undefined => {} }),
  ).rejects.toThrow('Pending root-local destructive intent');
});

it('propagates local confirmed-package cleanup failures instead of warning and abandoning them', async () => {
  const f = await fixture();
  await f.files('', { 'data/new': 'body' });
  vi.spyOn(FrozenWorkerArchive.prototype, 'retireUploaded').mockRejectedValue(
    new Error('local package cleanup failed'),
  );
  await expect(f.post()).rejects.toThrow('local package cleanup failed');
  expect(f.artifacts.upload).toHaveBeenCalledTimes(1);
  expect(f.artifacts.get).not.toHaveBeenCalled();
});
