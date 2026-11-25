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

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import {
  buildInstallIndex,
  indexedNode,
  indexedChildren,
} from '../../../src/cache/streaming/install-index';
import { installCurrentRows } from '../../../src/cache/streaming/install-current';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { localFixtures, directory, native } from './local-fixtures';
import type { LocalRow } from '../../../src/cache/streaming/local-stream';
import { encodeRecord, type Value } from '../../../src/cache/streaming/encoding';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.resolve('build/install-index-'));
  roots.push(root);
  const f = localFixtures(),
    store = await OwnedStore.bind(root, f.codec),
    budget = new WorkingBudget();
  return { ...f, root, store, budget };
}
it('indexes source subtrees with exact spans using name-order immediate pages', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  const rows: Value[] = [
    ['directory', '', directory],
    ['directory', 'metadata', directory],
    ['file', 'metadata/z', native],
    ['directory', 'metadata/a', directory],
    ['file', 'metadata/a/x', native],
    ['directory', 'metadata/c', directory],
    ['file', 'metadata/c/y', native],
  ];
  const q = await provisional(
    (async function* () {
      yield* rows;
    })(),
  );
  try {
    const index = await buildInstallIndex(scratch, frames(q), f.options.model, 'metadata');
    const rootLease = await indexedNode(scratch, index),
      root = rootLease.node,
      children = [];
    for await (const child of indexedChildren(scratch, root)) {
      children.push(child);
    }
    expect(children.map((c) => c[0])).toEqual(['metadata']);
    const metadataLease = await indexedNode(scratch, children[0][1]),
      metadata = metadataLease.node;
    const childrenMetadata: (readonly [string, number])[] = [];
    for await (const child of indexedChildren(scratch, metadata)) {
      childrenMetadata.push(child);
    }
    expect(childrenMetadata.map((c) => c[0])).toEqual(['a', 'c', 'z']);
    const checked: LocalRow[] = [];
    for await (const row of frames(q)) {
      checked.push(row);
    }
    const position = (path: string) =>
      checked.find((row) => Array.isArray(row.value) && row.value[1] === path)!;
    for (const name of ['a', 'z']) {
      const lease = await indexedNode(scratch, childrenMetadata.find((c) => c[0] === name)![1]);
      try {
        expect(lease.node[4]).toBeNull();
        expect(lease.node.slice(9, 11)).toEqual(
          name === 'a'
            ? [position('metadata/a').start, position('metadata/c').start]
            : [position('metadata/z').start, position('metadata/z').end],
        );
      } finally {
        lease.release();
      }
    }
    expect(metadata[5]).toBe('2');
    expect(metadata[6]).toBe(0);
    expect(metadata[10]).toBeGreaterThan(metadata[9]);
    metadataLease.release();
    rootLease.release();
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('captures complete mixed ownership without hashing current bodies', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, 'metadata'));
  await writeFile(path.join(f.root, 'metadata/a'), 'body');
  await writeFile(path.join(f.root, 'unowned'), 'untouched');
  const scratch = await InstallScratch.create(f.store, f.budget);
  try {
    const offset = await buildInstallIndex(
      scratch,
      frames(await provisional(installCurrentRows(f.store, { budget: f.budget }))),
      f.options.model,
      null,
    );
    const rootLease = await indexedNode(scratch, offset),
      root = rootLease.node;
    expect(root[5]).toBe('2');
    expect(root[6]).toBe(1); // unowned entry
    rootLease.release();
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('does bounded linear metadata work without retaining whole file records', async () => {
  const f = await fixture(),
    counts = [];
  for (const width of [32, 128]) {
    const scratch = await InstallScratch.create(f.store, f.budget),
      rows: Value[] = [
        ['directory', '', directory],
        ['directory', 'metadata', directory],
      ];
    for (let i = 0; i < width; i++) {
      rows.push(['file', 'metadata/' + String(i).padStart(4, '0'), native]);
    }
    const q = await provisional(
      (async function* () {
        yield* rows;
      })(),
    );
    try {
      await buildInstallIndex(scratch, frames(q), f.options.model, 'metadata');
      counts.push(scratch.work.writes);
      expect(scratch.work.reads).toBeLessThan(width * 3 + 20);
    } finally {
      await scratch.close();
    }
  }
  expect(counts[1] - counts[0]).toBe((128 - 32) * 3);
  expect(f.budget.retained).toBe(0);
});

it('always closes a scratch handle when its final stat fails', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  const handle = (scratch as unknown as { handle: FileHandle }).handle;
  const closed = vi.spyOn(handle, 'close');
  vi.spyOn(handle, 'stat').mockRejectedValueOnce(new Error('stat failure'));
  await expect(scratch.close()).rejects.toThrow('stat failure');
  expect(closed).toHaveBeenCalledOnce();
  await expect(handle.stat()).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('poisons a partial failed append and leases every decoded random-access record', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  const at = await scratch.append(['record', 'data']),
    record = await scratch.record(at);
  expect(record.value).toEqual(['record', 'data']);
  expect(f.budget.retained).toBeGreaterThan(0);
  record.release();
  const handle = (scratch as unknown as { handle: FileHandle }).handle;
  const writes = vi.spyOn(handle, 'write');
  writes
    .mockResolvedValueOnce({ bytesWritten: 1, buffer: 'unconsumed partial-write return' })
    .mockRejectedValueOnce(new Error('partial write failure'));
  await expect(scratch.append(['next', 'x'.repeat(65520)])).rejects.toThrow('partial write');
  await expect(scratch.append(['forbidden'])).rejects.toThrow('failed');
  await expect(scratch.record(at)).rejects.toThrow();
  writes.mockRestore();
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('claims a whole build so concurrent callers cannot interleave directory pages', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  const q = await provisional(
    (async function* () {
      yield ['directory', '', directory];
    })(),
  );
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const first = buildInstallIndex(
    scratch,
    (async function* () {
      enter();
      await gate;
      yield* frames(q);
    })(),
    f.options.model,
    'metadata',
  );
  await entered;
  await expect(buildInstallIndex(scratch, frames(q), f.options.model, 'metadata')).rejects.toThrow(
    'claimed',
  );
  await expect(scratch.append(['interleave'])).rejects.toThrow('claimed');
  release();
  await first;
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('cancels a wide postorder close between bounded scratch reads and retires its source', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget),
    controller = new AbortController();
  const q = await provisional(
    (async function* () {
      yield ['directory', '', directory];
      yield ['directory', 'metadata', directory];
      for (let i = 0; i < 16; i++) {
        yield ['file', 'metadata/' + String(i).padStart(2, '0'), native];
      }
    })(),
  );
  const original = scratch.record.bind(scratch);
  let retired = false;
  let finishRetirement!: () => void;
  const retirement = new Promise<void>((resolve) => {
    finishRetirement = resolve;
  });
  const reads = vi.spyOn(scratch, 'record').mockImplementation(async (at) => {
    const record = await original(at);
    controller.abort(new Error('cancel closing index'));
    return record;
  });
  await expect(
    buildInstallIndex(
      scratch,
      (async function* () {
        try {
          yield* frames(q);
        } finally {
          retired = true;
          finishRetirement();
        }
      })(),
      f.options.model,
      'metadata',
      controller.signal,
    ),
  ).rejects.toThrow('cancel closing index');
  reads.mockRestore();
  await retirement;
  expect(retired).toBe(true);
  expect(f.budget.retained).toBe(65536 + 20480); // Owner raw buffer plus one bounded typed-row cache.
  scratch.releaseReadCache();
  expect(f.budget.retained).toBe(65536); // Cancellation released traversal frames and active reads.
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});

it('cancels a pending source read and releases the whole-build claim', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget),
    controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const retire = vi.fn(async () => ({ done: true as const, value: undefined }));
  const source: AsyncIterable<LocalRow> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        started();
        return new Promise<IteratorResult<LocalRow>>(() => {});
      },
      return: retire,
    }),
  };
  const pending = buildInstallIndex(
    scratch,
    source,
    f.options.model,
    'metadata',
    controller.signal,
  );
  await entered;
  controller.abort(new Error('cancel pending index source'));
  await expect(pending).rejects.toThrow('cancel pending index source');
  expect(retire).toHaveBeenCalledOnce();
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});

async function provisional(source: AsyncIterable<Value>): Promise<LocalRow[]> {
  const result: LocalRow[] = [];
  let at = 0;
  for await (const value of source) {
    const end = at + encodeRecord(value).length;
    result.push({ value, start: at, end, record: result.length });
    at = end;
  }
  result.push({ value: ['local-end'], start: at, end: at, record: result.length });
  return result;
}
async function* frames(rows: LocalRow[]) {
  yield* rows;
}
