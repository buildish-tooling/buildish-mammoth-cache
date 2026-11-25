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

import { utimes } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { GcSurvivorOwner } from '../../../src/cache/streaming/gc-execute';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { sameNative } from '../../../src/cache/streaming/native';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});
it.each([false, true])(
  'borrows original survivor hierarchy with mutation=%s and no additional index or capture',
  async (changed) => {
    const f = await observationFixture();
    fixtures.push(f);
    const files = ['expired-a', 'expired-b', 'retained'];
    await f.files('', Object.fromEntries(files.map((name) => [`data/shared/${name}`, name])));
    if (changed) {
      for (const name of files.slice(0, 2)) {
        await utimes(f.store.root.resolve(`data/shared/${name}`), 1.234, 1.234);
      }
      await utimes(f.store.root.resolve('data/shared'), 2.345, 2.345);
    }
    const original = (await f.store.root.stat('data/shared'))!;
    const captured = await captureObservations(f.store, { budget: f.budget, retainIndex: true });
    const builds = f.store.root.work.indexBuilds;
    const owner = await GcSurvivorOwner.execute(captured.index!, {
      budget: f.budget,
      batchOperations: 1,
    });
    const survivingNative = (await f.store.root.stat('data/shared'))!;
    expect(sameNative(original, survivingNative, true)).toBe(!changed);
    let source: MetadataPublicationSource | undefined;
    try {
      expect(owner.index).toBe(captured.index);
      expect(f.store.root.work.indexBuilds).toBe(builds);
      source = await MetadataPublicationSource.survivors(owner);
      expect(f.store.root.work.indexBuilds).toBe(builds);
      expect(source.summary('data')[3]).toBe(changed ? 1 : 3);
      await expect(owner.dispose()).rejects.toThrow('still borrowed');
      const names: string[] = [];
      async function visit(offset: number): Promise<void> {
        const lease = await source!.node(offset);
        try {
          if (lease.node[1] === 'file') {
            names.push(lease.node[2]);
          }
          if (lease.node[2] === 'data/shared') {
            expect(lease.node[3]).toEqual(survivingNative);
          }
          for await (const edge of source!.children(lease.node)) {
            await visit(edge[2]);
          }
        } finally {
          lease.release();
        }
      }
      await visit(source.index);
      expect(names).toEqual(
        (changed ? files.slice(2) : files).map((name) => `data/shared/${name}`),
      );
    } finally {
      await source?.dispose();
      await owner.dispose();
    }
    expect(() => owner.assert()).toThrow('Unavailable');
    await f.finish();
    expect(f.budget.retained).toBe(0);
  },
);
it('never grants survivor authority after cancellation during actual GC', async () => {
  const controller = new AbortController();
  const f = await observationFixture('maven', {
    fail: async (name) => {
      if (name === 'gc-target-deleted') {
        controller.abort(new Error('cancel survivor'));
      }
    },
  });
  fixtures.push(f);
  await f.files('', { 'data/expired': 'old' });
  await utimes(f.store.root.resolve('data/expired'), 1.234, 1.234);
  const captured = await captureObservations(f.store, { budget: f.budget, retainIndex: true });
  await expect(
    GcSurvivorOwner.execute(captured.index!, { budget: f.budget, signal: controller.signal }),
  ).rejects.toThrow();
  expect(() => captured.index!.work).not.toThrow();
  await expect(captured.index!.node(captured.index!.root)).rejects.toThrow('Unavailable');
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('rejects absent, copied and fabricated GC owners before publication fields or borrowed methods', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', { 'data/a': 'body' });
  const captured = await captureObservations(f.store, { budget: f.budget, retainIndex: true }),
    owner = await GcSurvivorOwner.execute(captured.index!, { budget: f.budget });
  const forged = { ...owner, assert: vi.fn(), borrow: vi.fn() };
  await expect(
    MetadataPublicationSource.survivors(forged as unknown as typeof owner),
  ).rejects.toThrow('original GC survivor receipt');
  expect(forged.assert).not.toHaveBeenCalled();
  expect(forged.borrow).not.toHaveBeenCalled();
  await expect(MetadataPublicationSource.survivors(undefined as never)).rejects.toThrow(
    'original GC survivor receipt',
  );
  await owner.dispose();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
