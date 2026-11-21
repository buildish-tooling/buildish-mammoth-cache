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

import { writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceFixture, freezeSources, cleanupSourceFixtures } from './worker-source-fixtures';
import { FrozenWorkerArchive } from '../../../src/cache/streaming/worker-package';
import { WorkerSources } from '../../../src/cache/streaming/worker-walk';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { DiskMembership } from '../../../src/cache/streaming/worker-spool';
import { withAbort } from '../../../src/cache/streaming/abort';
import { readWorkerArchive } from '../../../src/cache/streaming/worker-codec';
afterEach(cleanupSourceFixtures);
it.each([false, true])(
  'packages guarded real files directly into an immutable named raw archive (snapshot=%s)',
  async (snapshot) => {
    const f = await sourceFixture(snapshot),
      view = await freezeSources(f),
      read = NativeReadPhase.prototype.read;
    let sourceBodyBytes = 0;
    const spy = vi.spyOn(NativeReadPhase.prototype, 'read').mockImplementation(async function* (
      this: NativeReadPhase,
      ...args
    ) {
      for await (const b of read.apply(this, args)) {
        sourceBodyBytes += b.length;
        yield b;
      }
    });
    let archive: FrozenWorkerArchive;
    try {
      archive = await FrozenWorkerArchive.package(f.store, view, 'worker-A.tar.gz', f.budget);
    } finally {
      spy.mockRestore();
    }
    expect(sourceBodyBytes).toBe(7);
    expect(path.basename(archive.file)).toBe(archive.name);
    expect(archive.reference[1]).toBe('worker-archive');
    expect(Object.isFrozen(archive.reference)).toBe(true);
    expect(Object.isFrozen(archive.summary.identity)).toBe(true);
    const bytes = await readFile(archive.file);
    expect(bytes.length).toBe(archive.bytes);
    expect(gunzipSync(bytes).length).toBe(archive.work.tarBytes);
    expect(archive.work.controlMembers).toBeGreaterThan(2);
    expect(archive.work.controlBodyBytes).toBeLessThan(archive.work.tarBytes);
    let bodyBytes = 0,
      controls = 0;
    await readWorkerArchive(archive.open(), {
      model: f.model,
      context: f.store.codec.options.context,
      authorizedSnapshots: snapshot ? ['data'] : [],
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      async consumeFile({ body }) {
        for await (const b of body) bodyBytes += b.length;
      },
      async event() {
        controls++;
      },
    });
    expect(bodyBytes).toBe(7);
    expect(controls).toBe(archive.work.controlMembers);
    await writeFile(
      path.join(f.root, 'd/a'),
      'source changes after freezing do not change retries',
    );
    await archive.assertStable(new AbortController().signal);
    expect(await readFile(archive.file)).toEqual(bytes);
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects a mutated live source without exposing a completed package', async () => {
  const f = await sourceFixture(),
    view = await freezeSources(f),
    stable = WorkerSources.prototype.assertStable;
  let calls = 0;
  const spy = vi.spyOn(WorkerSources.prototype, 'assertStable').mockImplementation(async function (
    this: WorkerSources,
    s,
  ) {
    await stable.call(this, s);
    if (++calls === 1) await writeFile(path.join(f.root, 'd/a'), 'mutated');
  });
  try {
    await expect(
      FrozenWorkerArchive.package(f.store, view, 'worker-A.tar.gz', f.budget),
    ).rejects.toThrow('did not freeze');
  } finally {
    spy.mockRestore();
  }
  expect(f.budget.retained).toBe(0);
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'planning'))).toEqual([]);
});
it('does not expose a Q after failed final named publication, preserving sources', async () => {
  const f = await sourceFixture(),
    view = await freezeSources(f),
    store = await OwnedStore.bind(f.root, f.store.codec, async (event) => {
      if (event === 'immutable-publication-barrier') throw new Error('publication failed');
    });
  await expect(
    FrozenWorkerArchive.package(store, view, 'worker-A.tar.gz', f.budget),
  ).rejects.toThrow('did not freeze');
  expect(await readFile(path.join(f.root, 'd/a'), 'utf8')).toBe('abc');
  expect(f.budget.retained).toBe(0);
  for (const dir of await readdir(store.root.resolve(store.prefix + 'archives')))
    expect(await readdir(store.root.resolve(store.prefix + 'archives/' + dir))).toEqual([]);
});
it('rejects unsafe names before capture and rejects changed frozen archive identities', async () => {
  const f = await sourceFixture(),
    view = await freezeSources(f),
    before = f.store.root.work.readBytes;
  await expect(
    FrozenWorkerArchive.package(f.store, view, '../worker.tar.gz', f.budget),
  ).rejects.toThrow('filename');
  expect(f.store.root.work.readBytes).toBe(before);
  const archive = await FrozenWorkerArchive.package(f.store, view, 'worker-A.tar.gz', f.budget);
  await writeFile(archive.file, 'tampered');
  await expect(archive.assertStable(new AbortController().signal)).rejects.toThrow('changed');
  expect(f.budget.retained).toBe(0);
});

it.each(['external-abort', 'sink-failure'])(
  'settles a blocked source/writer pair on %s',
  async (failure) => {
    const f = await sourceFixture(),
      view = await freezeSources(f),
      controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const readSpy = vi
      .spyOn(NativeReadPhase.prototype, 'read')
      .mockImplementation(async function* (_path, _native, s) {
        enter();
        await withAbort(new Promise<never>(() => {}), s);
        yield* [] as Buffer[];
      });
    const sinkSpy =
      failure === 'sink-failure'
        ? vi.spyOn(f.store, 'writeNamedWorkerArchive').mockImplementation(async (_name, bytes) => {
            for await (const _ of bytes) {
              void _;
              await entered;
              throw new Error('sink failed with blocked peer');
            }
            throw new Error('unexpected early sink EOF');
          })
        : null;
    try {
      const pending = FrozenWorkerArchive.package(f.store, view, 'worker-A.tar.gz', f.budget, {
        signal: controller.signal,
      });
      await entered;
      if (failure === 'external-abort') controller.abort(new Error('cancelled blocked source'));
      await expect(pending).rejects.toThrow('did not freeze');
      expect(f.budget.retained).toBe(0);
      expect(await readdir(f.store.root.resolve(f.store.prefix + 'planning'))).toEqual([]);
    } finally {
      readSpy.mockRestore();
      sinkSpy?.mockRestore();
    }
    expect(await readFile(path.join(f.root, 'd/a'), 'utf8')).toBe('abc');
  },
);
