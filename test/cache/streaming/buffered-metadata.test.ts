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

import { setImmediate as scheduleImmediate, clearImmediate } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { writeFile, open, rm, type FileHandle } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { BufferedWriter } from '../../../src/cache/streaming/buffered-writer';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { WorkerSpool } from '../../../src/cache/streaming/worker-spool';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { encodeRecord, type Value } from '../../../src/cache/streaming/encoding';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture() {
  const f = await installFixture();
  cleanup.push(() => f.close());
  return f;
}
it('serves interleaved pending/physical rows at logical offsets without flushing per record', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  try {
    const handle = (scratch as unknown as { handle: FileHandle }).handle;
    const writes = vi.spyOn(handle, 'write');
    const offsets: number[] = [];
    for (let n = 0; n < 2048; n++) {
      const row: Value = ['row', n, 'x'.repeat(81)];
      const offset = await scratch.append(row);
      offsets.push(offset);
      if (n % 53 === 0) {
        const record = await scratch.record(offset);
        expect(record.value).toEqual(row);
        record.release();
      }
    }
    expect(writes.mock.calls.length).toBeLessThan(5);
    expect(f.store.root.work.scratchWriteCalls).toBe(writes.mock.calls.length);
    const rows: Value[] = [];
    for await (const row of scratch.rows(0, scratch.position)) {
      rows.push(row);
    }
    expect(rows).toHaveLength(2048);
    expect(offsets[1]).toBe(encodeRecord(rows[0]).length);
    expect(rows[2047]).toEqual(['row', 2047, 'x'.repeat(81)]);
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('finishes immutable local streams with block writes before returning their reference', async () => {
  const f = await fixture(),
    before = f.store.root.work.metadataWriteCalls;
  async function* rows(): AsyncGenerator<Value> {
    yield ['dir-open', ''];
    yield ['dir-open', 'data'];
    for (let n = 0; n < 1024; n++) {
      yield ['used', 'f' + String(n).padStart(4, '0'), 'data'];
    }
    yield ['dir-close', 'data'];
    yield ['dir-close', ''];
  }
  const ref = await f.store.writeStream('activity', { budget: f.budget, partition: null }, rows());
  expect(f.store.root.work.metadataWriteCalls - before).toBeLessThan(10);
  let count = 0;
  for await (const _row of f.store.rows(ref, 'activity', {
    budget: f.budget,
    partition: null,
  })) {
    expect(_row.end).toBeGreaterThan(_row.start);
    count++;
  }
  expect(count).toBe(1030);
  expect(f.budget.retained).toBe(0);
});
it('rejects a changed backing file before flushing a sealed spool and releases its buffer', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget);
  const scratch = (spool as unknown as { scratch: InstallScratch }).scratch;
  await spool.append(['row', 'original'], new AbortController().signal);
  spool.seal(new AbortController().signal);
  await writeFile(f.store.root.resolve(scratch.path), 'foreign');
  await expect(
    (async () => {
      for await (const row of spool.rows(new AbortController().signal)) {
        void row;
      }
    })(),
  ).rejects.toThrow('Changed scratch');
  await spool.dispose();
  expect(f.budget.retained).toBe(0);
});
it('handles partial writes and poisons failed buffers instead of publishing a truncated prefix', async () => {
  const budget = new WorkingBudget(),
    parts: Buffer[] = [];
  let fail = false;
  const handle = {
    async write(bytes: Buffer, offset: number, length: number) {
      if (fail) {
        throw new Error('write failed');
      }
      const n = Math.min(length, 7);
      parts.push(Buffer.from(bytes.subarray(offset, offset + n)));
      return { bytesWritten: n };
    },
  } as unknown as FileHandle;
  const writer = new BufferedWriter(handle, budget, () => {});
  await writer.append(Buffer.from('0123456789abcdef'));
  await writer.flush();
  expect(Buffer.concat(parts).toString()).toBe('0123456789abcdef');
  await writer.append(Buffer.from('later'));
  fail = true;
  await expect(writer.flush()).rejects.toThrow('write failed');
  await expect(writer.append(Buffer.from('never'))).rejects.toThrow('Unavailable');
  writer.dispose();
  expect(budget.retained).toBe(0);
});

it('claims spool replay before the first await and refuses disposal/close during flush', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget);
  const scratch = (spool as unknown as { scratch: InstallScratch }).scratch;
  await spool.append(['row', 'kept'], new AbortController().signal);
  spool.seal(new AbortController().signal);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const stable = scratch.assertStable.bind(scratch);
  const pause = vi.spyOn(scratch, 'assertStable').mockImplementationOnce(async () => {
    entered();
    await gate;
    await stable();
  });
  const rows = spool.rows(new AbortController().signal),
    next = rows.next();
  await ready;
  await expect(spool.dispose()).rejects.toThrow('active');
  await expect(scratch.close()).rejects.toThrow('active');
  release();
  expect((await next).value).toEqual(['row', 'kept']);
  await rows.return(undefined);
  pause.mockRestore();
  await spool.dispose();
  expect(f.budget.retained).toBe(0);
});
it('rejects prior backing mutation before automatic block writes without rebasing it', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  await scratch.append(['row', 'initial']);
  await writeFile(f.store.root.resolve(scratch.path), 'unexpected tail');
  await expect(scratch.append(['row', 'x'.repeat(65520)])).rejects.toThrow('Changed scratch');
  await expect(scratch.record(0)).rejects.toThrow();
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('closes the acquired scratch handle if its first fstat fails', async () => {
  const f = await fixture(),
    name = f.store.root.resolve('handle-probe'),
    probe = await open(name, 'wx');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(name);
  let closed = false;
  const stat = vi.spyOn(prototype, 'stat').mockImplementationOnce(async function (
    this: FileHandle,
  ) {
    const close = this.close.bind(this);
    vi.spyOn(this, 'close').mockImplementation(async () => {
      await close();
      closed = true;
    });
    throw new Error('initial fstat failed');
  });
  await expect(InstallScratch.create(f.store, f.budget)).rejects.toThrow('initial fstat failed');
  expect(closed).toBe(true);
  stat.mockRestore();
  expect(f.budget.retained).toBe(0);
});

it('rejects reads during a partial flush and permits them after the writer settles', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  const row: Value = ['row', 'x'.repeat(2048)];
  await scratch.append(row);
  const handle = (scratch as unknown as { handle: FileHandle }).handle,
    write = handle.write.bind(handle);
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const spy = vi.spyOn(handle, 'write').mockImplementation(async (...args) => {
    const [bytes, offset, length, position] = args as unknown as [Buffer, number, number, number];
    if (++calls === 2) {
      entered();
      await gate;
    }
    return Reflect.apply(write, handle, [bytes, offset, calls === 1 ? 7 : length, position]);
  });
  const flush = scratch.flush();
  await ready;
  await expect(scratch.record(8)).rejects.toThrow();
  await expect(
    (async () => {
      for await (const r of scratch.rows(0, scratch.position)) {
        void r;
      }
    })(),
  ).rejects.toThrow();
  release();
  await flush;
  spy.mockRestore();
  const record = await scratch.record(0);
  expect(record.value).toEqual(row);
  record.release();
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});

it('reuses bounded scratch pages for adjacent positional records and tolerates short physical reads', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget),
    offsets: number[] = [];
  for (let i = 0; i < 2048; i++) {
    offsets.push(await scratch.append(['row', i, 'x'.repeat(81)]));
  }
  await scratch.flush();
  const handle = (scratch as unknown as { handle: FileHandle }).handle,
    read = handle.read.bind(handle);
  const spy = vi.spyOn(handle, 'read');
  for (let i = 0; i < offsets.length; i++) {
    const r = await scratch.record(offsets[i]);
    expect((r.value as Value[])[1]).toBe(i);
    r.release();
  }
  expect(spy.mock.calls.length).toBeLessThan(12);
  scratch.releaseReadCache();
  spy.mockImplementation(async (...args) => {
    const [buffer, offset, length, position] = args as unknown as [Buffer, number, number, number];
    return Reflect.apply(read, handle, [buffer, offset, Math.min(length, 4096), position]);
  });
  const r = await scratch.record(offsets[700]);
  expect((r.value as Value[])[1]).toBe(700);
  r.release();
  spy.mockRestore();
  await scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('shares first-flush readiness between concurrent spool replays and releases pages after both', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget);
  for (let i = 0; i < 128; i++) {
    await spool.append(['row', i], new AbortController().signal);
  }
  spool.seal(new AbortController().signal);
  const collect = async () => {
    const values: Value[] = [];
    for await (const row of spool.rows(new AbortController().signal)) {
      values.push(row);
    }
    return values;
  };
  const [a, b] = await Promise.all([collect(), collect()]);
  expect(a).toEqual(b);
  expect(a).toHaveLength(128);
  expect(f.budget.retained).toBe(0);
  await spool.dispose();
});

it('reuses scratch assembly storage across cached/cross-page random lookups', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  try {
    const offsets: number[] = [];
    for (let i = 0; i < 140; i++) {
      offsets.push(await scratch.append(['row', i, 'x'.repeat(900)]));
    }
    await scratch.flush();
    for await (const row of scratch.rows(0, scratch.position)) {
      expect((row as readonly Value[])[0]).toBe('row');
    }
    const before = f.store.root.work.scratchDecoderAllocations;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < offsets.length; i++) {
        const r = await scratch.record(offsets[i]);
        expect(r.value).toEqual(['row', i, 'x'.repeat(900)]);
        r.release();
      }
    }
    expect(f.store.root.work.scratchDecoderAllocations - before).toBeLessThanOrEqual(1);
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('preserves batched spool bytes/digests and yields to real timers within bounded batches', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget),
    signal = new AbortController().signal;
  let timer = false;
  const scheduled = setTimeout(() => {
    timer = true;
  }, 0);
  try {
    for (let group = 0; group < 4; group++) {
      await spool.appendBatch(
        Array.from({ length: 200 }, (_, i) => ['row', group * 200 + i, 'é🙂'.repeat(8)] as Value),
        signal,
      );
    }
    expect(timer).toBe(true);
    spool.seal(signal);
    let count = 0;
    for await (const batch of spool.batches(signal)) {
      expect(batch.length).toBeLessThanOrEqual(256);
      for (const row of batch) {
        expect((row as readonly Value[])[1]).toBe(count++);
      }
    }
    expect(count).toBe(800);
    expect(f.store.root.work.metadataBatches).toBeLessThan(20);
  } finally {
    clearTimeout(scheduled);
    await spool.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('poisons a canceled batch instead of publishing its partial metadata', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget),
    abort = new AbortController();
  const scheduled = scheduleImmediate(() => abort.abort(new Error('batch canceled')));
  try {
    await expect(
      spool.appendBatch(
        Array.from({ length: 200 }, (_, i) => ['row', i, 'x'.repeat(200)]),
        abort.signal,
      ),
    ).rejects.toThrow('batch canceled');
    expect(() => spool.seal(new AbortController().signal)).toThrow();
  } finally {
    clearImmediate(scheduled);
    await spool.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it('rejects an oversized batch before writing any of its records', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  try {
    const before = f.store.root.work.writeBytes;
    await expect(
      scratch.appendBatch([
        ['row', 'x'.repeat(40000)],
        ['row', 'y'.repeat(40000)],
      ]),
    ).rejects.toThrow('byte allowance');
    expect(scratch.position).toBe(0);
    expect(f.store.root.work.writeBytes).toBe(before);
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});

it('keeps the scratch write transaction busy during encoded callbacks', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget);
  try {
    let closing: Promise<void> | undefined;
    expect(
      scratch.tryAppend(['outer'], undefined, () => {
        expect(() => scratch.tryAppend(['nested'])).toThrow('unavailable');
        closing = scratch.close();
      }),
    ).toBe(0);
    await expect(closing).rejects.toThrow('active scratch');
    expect(scratch.tryAppend(['next'])).not.toBeNull();
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('rejects pre-aborted scratch batches without reading even an empty span', async () => {
  const f = await fixture(),
    scratch = await InstallScratch.create(f.store, f.budget),
    abort = new AbortController();
  try {
    await scratch.append(['row']);
    await scratch.flush();
    const before = f.store.root.work.scratchReadCalls;
    abort.abort(new Error('already canceled'));
    await expect(scratch.batches(0, scratch.position, abort.signal).next()).rejects.toThrow(
      'already canceled',
    );
    await expect(scratch.batches(0, 0, abort.signal).next()).rejects.toThrow('already canceled');
    expect(f.store.root.work.scratchReadCalls).toBe(before);
  } finally {
    await scratch.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('checks cancellation between legacy rows of one batch', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget),
    abort = new AbortController();
  try {
    await spool.appendBatch([['one'], ['two']], abort.signal);
    spool.seal(abort.signal);
    const rows = spool.rows(abort.signal);
    expect((await rows.next()).value).toEqual(['one']);
    abort.abort(new Error('row canceled'));
    await expect(rows.next()).rejects.toThrow('row canceled');
  } finally {
    await spool.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it('consumes strict local streams in charged byte and row bounded batches', async () => {
  const f = await fixture();
  async function* values(): AsyncGenerator<Value> {
    yield ['dir-open', ''];
    yield ['dir-open', 'data'];
    for (let i = 0; i < 800; i++) {
      yield ['used', 'f' + String(i).padStart(4, '0'), 'data'];
    }
    yield ['dir-close', 'data'];
    yield ['dir-close', ''];
  }
  const ref = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    values(),
  );
  let count = 0,
    batches = 0;
  for await (const batch of f.store.rowBatches(ref, 'activity', {
    budget: f.budget,
    partition: null,
  })) {
    batches++;
    expect(batch.length).toBeLessThanOrEqual(256);
    expect(batch.reduce((sum, row) => sum + row.end - row.start, 0)).toBeLessThanOrEqual(65536);
    count += batch.length;
  }
  expect(count).toBe(806);
  expect(batches).toBeLessThan(12);
  expect(f.budget.retained).toBe(0);
});
