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

import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as encoding from '../../../src/cache/streaming/encoding';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { resolveModel } from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { writeWorkerArchive, type WorkerEvent } from '../../../src/cache/streaming/worker-codec';
import { WorkerFrontier } from '../../../src/cache/streaming/worker-frontier';
import { mergeWorkerArchives } from '../../../src/cache/streaming/worker-merge';
import { WorkerStage } from '../../../src/cache/streaming/worker-stage';
import { WorkerSpool, DiskMembership } from '../../../src/cache/streaming/worker-spool';
import { tuple } from '../../../src/cache/streaming/encoding';
import { localOptions } from './local-fixtures';
import { byteSource } from './protocol-fixtures';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(path.resolve('build/worker-merge-'));
  roots.push(root);
  const model = resolveModel(
      [
        'model',
        1,
        'gradle',
        ['.mammoth/**'],
        [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default', 0]],
      ],
      'v2-',
      1,
    ),
    options = localOptions();
  options.context[7] = 'gradle';
  const store = await OwnedStore.bind(root, new LocalCodec({ ...options, model })),
    budget = new WorkingBudget();
  return { root, store, budget, model };
}
async function archive(
  f: Awaited<ReturnType<typeof fixture>>,
  job: string,
  body = 'abc',
  time = 1000,
  mode = 0o644,
  count = 1,
) {
  const context = [...f.store.codec.options.context] as typeof f.store.codec.options.context;
  context[4] = job;
  async function* events(): AsyncGenerator<WorkerEvent> {
    yield { type: 'channel-open' };
    yield { type: 'dir-open', path: '' };
    for (let i = 0; i < count; i++) {
      yield {
        type: 'file',
        path: 'f' + String(i).padStart(3, '0'),
        size: Buffer.byteLength(body),
        mode,
        mtimeMs: time,
        bytes: (async function* () {
          if (body) {
            yield Buffer.from(body);
          }
        })(),
        assertStable: async () => {},
      };
    }
    yield { type: 'dir-close', path: '' };
    yield { type: 'channel-close' };
    yield { type: 'channel-open' };
    yield { type: 'dir-open', path: '' };
    yield { type: 'dir-close', path: '' };
    yield { type: 'channel-close' };
  }
  const chunks: Buffer[] = [];
  await writeWorkerArchive(
    new Writable({
      write(b, _e, cb) {
        chunks.push(Buffer.from(b));
        cb();
      },
    }),
    {
      model: f.model,
      context,
      authorizedSnapshots: [],
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      snapshots: [],
      assertStable: async () => {},
    },
    () => events(),
  );
  return { job, context, source: byteSource(Buffer.concat(chunks)), bytes: Buffer.concat(chunks) };
}
it.each(['', 'x'])(
  'uses distinct body and validated metadata acknowledgements for tiny same-chunk body %j',
  async (body) => {
    const f = await fixture(),
      input = await archive(f, 'A', body),
      reader = new WorkerFrontier(
        input.source,
        {
          model: f.model,
          context: input.context,
          authorizedSnapshots: [],
          budget: f.budget,
          membership: await DiskMembership.create(f.store, f.budget),
        },
        signal(),
      );
    let head = await reader.next();
    while (head?.type !== 'file') {
      head = await reader.next();
    }
    expect(reader.work.peakPending).toBe(1);
    let count = 0;
    for await (const b of head.file.body) {
      count += b.length;
    }
    expect(count).toBe(body.length);
    const meta = await reader.next();
    expect(meta?.type === 'control' && tuple(meta.value)[0]).toBe('file-meta');
    let settled = false;
    void reader.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    while (await reader.next()) {
      void 0;
    }
    await reader.completion;
    await reader.close();
    expect(f.budget.retained).toBe(0);
  },
);
it.each(['body', 'metadata'])(
  'cancels a paused %s rendezvous and joins its reader',
  async (phase) => {
    const f = await fixture(),
      input = await archive(f, 'A'),
      reader = new WorkerFrontier(
        input.source,
        {
          model: f.model,
          context: input.context,
          authorizedSnapshots: [],
          budget: f.budget,
          membership: await DiskMembership.create(f.store, f.budget),
        },
        signal(),
      );
    let head = await reader.next();
    while (head?.type !== 'file') {
      head = await reader.next();
    }
    if (phase === 'metadata') {
      for await (const b of head.file.body) {
        void b;
      }
      await reader.next();
    }
    reader.cancel(new Error('cancelled frontier'));
    await expect(reader.completion).rejects.toThrow();
    await reader.close();
    expect(f.budget.retained).toBe(0);
  },
);
it('stages only provisional winners, hashes losers and repairs equivalent mode/time before sealing', async () => {
  const hashes = vi.spyOn(encoding, 'H');
  const f = await fixture(),
    a = await archive(f, 'A', 'abc', 1000, 0o755),
    b = await archive(f, 'B', 'abc', 2000, 0o644);
  const result = await mergeWorkerArchives(f.store, [b, a], {
    budget: f.budget,
    ordinaryOrder: ['A', 'B'],
    ordinaryPolicy: 'strict',
  });
  expect(hashes.mock.calls.filter(([domain]) => domain === 'header')).toEqual([]);
  hashes.mockRestore();
  expect(result.stage.work.bodyBytes).toBe(3);
  expect(result.readers.map((r) => r.work.bodyBytes)).toEqual([3, 3]);
  expect(result.readers.map((r) => r.work.archivePasses)).toEqual([1, 1]);
  expect(result.readers.every((r) => r.work.peakPending === 1)).toBe(true);
  const part = result.partitions[0],
    rows = [];
  for await (const r of part.facts.rows(signal())) {
    rows.push(tuple(r));
  }
  expect(rows[0].slice(4)).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 3, 0o755, 2000]);
  expect(await readFile(f.store.root.resolve(part.nativeRoot + '/f000'), 'utf8')).toBe('abc');
  expect(await f.store.root.stat('f000')).toBe(null);
  await result.dispose();
  expect(f.budget.retained).toBe(0);
});
it('keeps timestamp-tie conflict sticky even with a later newer producer and cleans private staging', async () => {
  const f = await fixture(),
    a = await archive(f, 'A', 'aaa'),
    b = await archive(f, 'B', 'bbb'),
    c = await archive(f, 'C', 'ccc', 2000);
  await expect(
    mergeWorkerArchives(f.store, [c, b, a], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B', 'C'],
      ordinaryPolicy: 'newer-mtime',
    }),
  ).rejects.toThrow('Prohibited ordinary-file');
  expect(await f.store.root.stat('f000')).toBe(null);
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'worker'))).toEqual([]);
  expect(f.budget.retained).toBe(0);
});
it('rejects late transport failure without any live source/install publication', async () => {
  const f = await fixture(),
    a = await archive(f, 'A'),
    b = await archive(f, 'B');
  b.bytes[b.bytes.length - 8] ^= 1;
  await expect(
    mergeWorkerArchives(f.store, [a, { ...b, source: byteSource(b.bytes) }], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    }),
  ).rejects.toThrow();
  expect(await f.store.root.stat('f000')).toBe(null);
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBe(null);
  expect(f.budget.retained).toBe(0);
});
it('has linear aggregate selected writes, stats, spooling and checkpoints across a shared directory', async () => {
  const observed = [];
  for (const count of [4, 16]) {
    const f = await fixture(),
      a = await archive(f, 'A', 'abc', 1000, 0o644, count),
      b = await archive(f, 'B', 'abc', 2000, 0o755, count),
      before = { ...f.store.root.work };
    const result = await mergeWorkerArchives(f.store, [a, b], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    });
    observed.push({
      count,
      stats: f.store.root.work.stats - before.stats,
      spool: f.store.root.work.scratchWriteBytes - before.scratchWriteBytes,
    });
    expect(result.stage.work.bodyBytes).toBe(count * 3);
    expect(result.readers.reduce((n, r) => n + r.work.bodyBytes, 0)).toBe(count * 6);
    await result.dispose();
    expect(f.budget.retained).toBe(0);
  }
  expect(observed[1].stats).toBeLessThanOrEqual(observed[0].stats + 12 * 20);
  expect(observed[1].spool).toBeLessThan(observed[0].spool * 5);
});

it('retires a partially acquired partition spool after the next acquisition fails', async () => {
  const f = await fixture(),
    stage = await WorkerStage.create(f.store, f.budget);
  stage.enter('');
  let calls = 0;
  const create = WorkerSpool.create,
    spy = vi.spyOn(WorkerSpool, 'create').mockImplementation(async (...args) => {
      if (++calls === 2) {
        throw new Error('second acquisition failed');
      }
      return create(...args);
    });
  try {
    await expect(stage.ensure('data', signal())).rejects.toThrow('second acquisition');
  } finally {
    spy.mockRestore();
    await stage.dispose();
  }
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'planning'))).toEqual([]);
  expect(f.budget.retained).toBe(0);
});
it('validates directory limits before acquiring a candidate and closes rejected input streams', async () => {
  const f = await fixture(),
    input = await archive(f, 'A'),
    spy = vi.spyOn(WorkerStage, 'create');
  try {
    await expect(
      mergeWorkerArchives(f.store, [input], {
        budget: f.budget,
        ordinaryOrder: ['A'],
        ordinaryPolicy: 'strict',
        maxDirectoryEntries: 0,
      }),
    ).rejects.toThrow('directory entry');
    expect(spy).not.toHaveBeenCalled();
    expect(input.source.destroyed).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(await f.store.root.stat(f.store.prefix + 'worker')).toBe(null);
  expect(f.budget.retained).toBe(0);
});
it('pins producer descriptors and policy before asynchronous candidate creation', async () => {
  const f = await fixture(),
    a = await archive(f, 'A', 'aaa'),
    b = await archive(f, 'B', 'bbb', 2000),
    inputs = [a, b],
    order = ['A', 'B'],
    options = {
      budget: f.budget,
      ordinaryOrder: order,
      ordinaryPolicy: 'strict' as 'strict' | 'newer-mtime',
    };
  const pending = mergeWorkerArchives(f.store, inputs, options);
  options.ordinaryPolicy = 'newer-mtime';
  a.context[4] = 'mutated';
  a.job = 'mutated';
  order.reverse();
  inputs.reverse();
  await expect(pending).rejects.toThrow('Prohibited ordinary-file');
  expect(f.budget.retained).toBe(0);
});
it('attempts independent cleanup after one spool disposal fails', async () => {
  const f = await fixture(),
    input = await archive(f, 'A'),
    result = await mergeWorkerArchives(f.store, [input], {
      budget: f.budget,
      ordinaryOrder: ['A'],
      ordinaryPolicy: 'strict',
    }),
    part = result.partitions[0];
  const spy = vi.spyOn(part.facts, 'dispose').mockRejectedValue(new Error('blocked facts cleanup'));
  try {
    await expect(result.stage.dispose()).rejects.toThrow('candidate cleanup');
    expect(await f.store.root.stat(result.stage.path)).toBe(null);
  } finally {
    spy.mockRestore();
    await result.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it('destroys unstarted owned streams when the second membership acquisition fails', async () => {
  const f = await fixture(),
    inputs = [await archive(f, 'A'), await archive(f, 'B'), await archive(f, 'C')],
    create = DiskMembership.create;
  let count = 0;
  const spy = vi.spyOn(DiskMembership, 'create').mockImplementation(async (...args) => {
    if (++count === 2) {
      throw new Error('membership acquisition failed');
    }
    return create(...args);
  });
  try {
    await expect(
      mergeWorkerArchives(f.store, inputs, {
        budget: f.budget,
        ordinaryOrder: ['A', 'B', 'C'],
        ordinaryPolicy: 'strict',
      }),
    ).rejects.toThrow('membership acquisition');
    expect(inputs.every((i) => i.source.destroyed)).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(f.budget.retained).toBe(0);
});

it('rejects a corrupt losing body before accepting either contribution under the five-field metadata grammar', async () => {
  const f = await fixture(),
    a = await archive(f, 'A'),
    b = await archive(f, 'B'),
    tar = gunzipSync(b.bytes),
    header = tar.indexOf(Buffer.from('payload/aggregate/f000\0'));
  expect(header).toBeGreaterThanOrEqual(0);
  expect(header % 512).toBe(0);
  tar[header + 512] ^= 1;
  await expect(
    mergeWorkerArchives(f.store, [a, { ...b, source: byteSource(gzipSync(tar)) }], {
      budget: f.budget,
      ordinaryOrder: ['A', 'B'],
      ordinaryPolicy: 'strict',
    }),
  ).rejects.toThrow('file metadata');
  expect(f.budget.retained).toBe(0);
});
