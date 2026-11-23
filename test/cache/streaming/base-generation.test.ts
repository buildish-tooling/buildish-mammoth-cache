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

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { metadataFixture, currentRef, type MetadataFixture } from './base-publication-fixtures';
import {
  MetadataBaseRestore,
  readMetadataGeneration,
} from '../../../src/cache/streaming/metadata-base-restore';
import { encodeRecord } from '../../../src/cache/streaming/encoding';
const fixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const f = await metadataFixture();
  fixtures.push(f);
  return f;
}
const acquire = (f: MetadataFixture, options = {}) =>
  MetadataBaseRestore.acquire(f.store, f.api, { currentRef }, { budget: f.budget, ...options });
it('discovers a default-lineage v2 record once, restores exact objects and pins original metadata without body hashing', async () => {
  const f = await fixture(),
    seeded = await f.seed({
      data: { 'data/a': 'base', 'data/Grüße/資料 😀.jar': 'unicode' },
      state: { 'state/a': 'snapshot' },
    });
  const result = await MetadataBaseRestore.acquire(
    f.store,
    f.api,
    { currentRef: 'refs/heads/feature', defaultRef: currentRef },
    { budget: f.budget },
  );
  try {
    expect(result.key).toBe(seeded.generation[11]);
    expect(result.generation).toEqual(seeded.generation);
    expect(f.restore).toHaveBeenCalledTimes(3);
    expect(f.restore.mock.calls[0][2]).toHaveLength(1);
    expect(f.restore.mock.calls.slice(1).map((call) => call[2])).toEqual([[], []]);
    expect(result.entries.map((e) => e[2])).toEqual(['available', 'available']);
    expect(
      await readFile(
        f.store.root.resolve(
          result.context!.source('data')!.nativeRoot + '/data/Grüße/資料 😀.jar',
        ),
        'utf8',
      ),
    ).toBe('unicode');
    expect(result.entries[0][3]![7]).toEqual(
      seeded.entries[0][0] === 'object' ? seeded.entries[0][2] : null,
    );
    expect(f.store.root.work.nativeWalks).toBe(2);
    expect(f.store.root.work.bodyHashBytes).toBe(0);
  } finally {
    await result.dispose();
  }
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'base'))).toEqual([]);
});
it('distinguishes unavailable object groups from declared empty partitions without inventing a pin', async () => {
  const f = await fixture(),
    seeded = await f.seed({ data: { 'data/a': 'body' } });
  const object = seeded.entries[0];
  if (object[0] !== 'object') throw new Error('fixture');
  f.objects.delete(object[2][2]);
  const result = await acquire(f);
  try {
    expect(result.entries.map((e) => e[2])).toEqual(['cold', 'empty']);
    expect(result.entries[0][3]).toBeNull();
    expect(result.entries[1][3]![7]).toBeNull();
  } finally {
    await result.dispose();
  }
});
it.each(['oversize', 'malformed', 'partial', 'foreign-key', 'extra-member'] as const)(
  'rejects %s generation extraction and retires only its owned roots',
  async (mode) => {
    const f = await fixture(),
      seeded = await f.seed({ data: { 'data/a': 'body' } }),
      original = f.restore.getMockImplementation()!;
    if (mode === 'oversize')
      await writeFile(seeded.target + '/record.json', Buffer.alloc(65537, 32));
    if (mode === 'malformed') await writeFile(seeded.target + '/record.json', '[]\n');
    if (mode === 'extra-member') await writeFile(seeded.target + '/unexpected', 'foreign member');
    if (mode === 'partial' || mode === 'foreign-key')
      f.restore.mockImplementation(async (...args) => {
        await original(...args);
        return mode === 'partial' ? undefined : 'unrelated-generation';
      });
    await expect(acquire(f)).rejects.toThrow();
    expect(f.restore).toHaveBeenCalledTimes(1);
    expect(await readdir(f.store.root.resolve(f.store.prefix + 'base'))).toEqual([]);
    expect(await readFile(seeded.target + '/record.json')).toBeDefined();
  },
);
it('rejects an exact-object key mismatch rather than discovering another object', async () => {
  const f = await fixture();
  await f.seed({ data: { 'data/a': 'body' } });
  const original = f.restore.getMockImplementation()!;
  f.restore.mockImplementation(async (...args) => {
    const key = await original(...args);
    return f.restore.mock.calls.length === 2 ? 'different-object' : key;
  });
  await expect(acquire(f)).rejects.toThrow('exact-key');
  expect(f.restore).toHaveBeenCalledTimes(2);
});
it('still validates an available malformed sibling after an earlier partition is unavailable', async () => {
  const f = await fixture(),
    seeded = await f.seed({ data: { 'data/a': 'body' }, state: { 'state/a': 'snapshot' } });
  const [data, state] = seeded.entries;
  if (data[0] !== 'object' || state[0] !== 'object') throw new Error('fixture');
  f.objects.delete(data[2][2]);
  await writeFile(f.objects.get(state[2][2])! + '/envelope.json', '[]\n');
  await expect(acquire(f)).rejects.toThrow();
  expect(f.restore).toHaveBeenCalledTimes(3);
});
it('waits for uncancellable extraction settlement before cancellation cleanup', async () => {
  const f = await fixture();
  await f.seed({ data: { 'data/a': 'body' } });
  const original = f.restore.getMockImplementation()!,
    controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.restore.mockImplementation(async (...args) => {
    const key = await original(...args);
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return key;
  });
  const pending = acquire(f, { signal: controller.signal });
  void pending.catch(() => {});
  await start;
  controller.abort(new Error('cancelled extraction'));
  expect((await readdir(f.store.root.resolve(f.store.prefix + 'base'))).length).toBe(1);
  release();
  await expect(pending).rejects.toThrow('cancelled extraction');
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'base'))).toEqual([]);
});
it('bounds and binds locally retained generation control bytes without reading payloads', async () => {
  const f = await fixture(),
    seeded = await f.seed({});
  const reference = await f.store.write(
    'generation',
    (async function* () {
      yield encodeRecord(seeded.generation);
    })(),
  );
  expect(
    await readMetadataGeneration(f.store, reference, seeded.generation[11], { budget: f.budget }),
  ).toEqual(seeded.generation);
  await expect(
    readMetadataGeneration(f.store, reference, 'wrong-key', { budget: f.budget }),
  ).rejects.toThrow();
  const oversized = await f.store.write(
      'generation',
      (async function* () {
        yield Buffer.alloc(65537);
      })(),
    ),
    before = f.store.root.work.readBytes;
  await expect(
    readMetadataGeneration(f.store, oversized, seeded.generation[11], { budget: f.budget }),
  ).rejects.toThrow('exceeds admission');
  expect(f.store.root.work.readBytes).toBe(before);
});

it('surfaces an incoming backend failure instead of treating a failed extraction as a cold miss', async () => {
  const f = await fixture();
  f.restore.mockRejectedValue(new Error('incoming service failed'));
  await expect(acquire(f)).rejects.toThrow('incoming service failed');
  expect(f.restore).toHaveBeenCalledTimes(1);
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'base'))).toEqual([]);
});
