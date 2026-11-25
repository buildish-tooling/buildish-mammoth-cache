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

import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as encoding from '../../../src/cache/streaming/encoding';
import { describe, expect, it, vi } from 'vitest';
import {
  readWorkerArchive,
  writeWorkerArchive,
  type WorkerEvent,
  type WorkerWriter,
} from '../../../src/cache/streaming/worker-codec';
import { globalChannelKey, type WorkerContext } from '../../../src/cache/streaming/worker-state';
import { resolveModel } from '../../../src/cache/streaming/model';
import { WorkingBudget, TreeState } from '../../../src/cache/streaming/tree-state';
import { Digest, type Value } from '../../../src/cache/streaming/encoding';
import {
  byteSource,
  context,
  eventsFromTrace,
  FixtureMembership,
  modelVector,
  traceArchive,
  workerTrace,
} from './protocol-fixtures';

function expected(): WorkerContext {
  return {
    model: resolveModel(modelVector, 'vectors-', 1),
    context: [...context],
    authorizedSnapshots: ['metadata'],
    budget: new WorkingBudget(),
    membership: new FixtureMembership(),
  };
}
async function read(bytes: Buffer, options = expected()) {
  const seen: Value[] = [];
  let fileBytes = 0;
  const result = await readWorkerArchive(byteSource(bytes), {
    ...options,
    async consumeFile({ body }) {
      for await (const b of body) {
        fileBytes += b.length;
      }
    },
    async event(v) {
      seen.push(v);
    },
  });
  return { result, seen, fileBytes };
}
async function write(options: WorkerWriter, events: AsyncIterable<WorkerEvent>) {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    highWaterMark: 16384,
    write(b, _encoding, callback) {
      chunks.push(Buffer.from(b));
      callback();
    },
  });
  const result = await writeWorkerArchive(sink, options, () => events);
  return { bytes: Buffer.concat(chunks), result };
}
const guard = async () => {};
describe('independent literal worker vectors', () => {
  for (const [name, sha] of [
    ['W0', '13063138dacc3f472efdf4011d4ca6318746c4b6389620b00338032bf3674422'],
    ['W1', '1ea9434a00347f8d8bf1f0128a9bfa0e9d9ffb9d3383e583379213135056ac73'],
  ] as const) {
    it(
      'reads ' + name + ' literal headers/controls and independently derives all seals',
      async () => {
        const options = expected(),
          actual = await read(traceArchive(workerTrace(name)), options);
        expect(actual.result.eventSha).toBe(sha);
        expect(actual.fileBytes).toBe(name === 'W1' ? 3 : 0);
        expect(actual.result.counts).toEqual(name === 'W1' ? [2, 5, 1, 0, 3] : [0, 2, 0, 0, 0]);
        expect(options.budget.retained).toBe(0);
        expect((options.membership as FixtureMembership).disposed).toBe(true);
      },
    );
    it('writes ' + name + ' with exact independently specified control tuples', async () => {
      const trace = workerTrace(name),
        options = expected();
      const output = await write(
        { ...options, snapshots: name === 'W1' ? ['metadata'] : [], assertStable: guard },
        eventsFromTrace(trace),
      );
      const actual = await read(output.bytes);
      const controls = trace
        .filter((w) => w[0] !== 'file' && w[0] !== 'directory')
        .map((w) => (w[0] === 'control' ? w[2] : w[1]));
      expect(actual.seen).toEqual(controls);
      expect(actual.result.eventSha).toBe(sha);
      expect(output.result.eventSha).toBe(sha);
    });
  }
});
it.each([
  'missing-pair',
  'wrong-ordinal',
  'wrong-content',
  'old-arity',
  'old-profile',
  'body-tamper',
  'unit-count',
  'final-seal',
  'wrong-context',
  'wrong-channel',
  'extra-control',
])('rejects %s without releasing a valid contribution', async (mutation) => {
  const trace = workerTrace('W1');
  if (mutation === 'missing-pair') {
    trace.splice(
      trace.findIndex((w) => w[0] === 'control' && w[1] === 6),
      1,
    );
  }
  if (mutation === 'wrong-ordinal') {
    (trace.find((w) => w[0] === 'control' && w[1] === 6)![2] as Value[])[2] = 2;
  }
  if (mutation === 'wrong-content') {
    (trace.find((w) => w[0] === 'control' && w[1] === 6)![2] as Value[])[3] = '0'.repeat(64);
  }
  if (mutation === 'old-arity') {
    (trace.find((w) => w[0] === 'control' && w[1] === 6)![2] as Value[]).splice(
      3,
      0,
      '0'.repeat(64),
    );
  }
  if (mutation === 'old-profile') {
    (trace[0][1] as Value[])[2] = 'worker-tar-v1';
  }
  if (mutation === 'body-tamper') {
    trace.find((w) => w[0] === 'file' && w[1] === 2)![3] = '616264';
  }
  if (mutation === 'unit-count') {
    ((trace.find((w) => w[0] === 'control' && w[1] === 8)![2] as Value[])[4] as Value[])[0] = 3;
  }
  if (mutation === 'final-seal') {
    (trace[trace.length - 1][1] as Value[])[6] = '0'.repeat(64);
  }
  if (mutation === 'wrong-context') {
    ((trace[0][1] as Value[])[4] as Value[])[4] = 'B';
  }
  if (mutation === 'wrong-channel') {
    (trace[1][2] as Value[])[1] = 1;
  }
  if (mutation === 'extra-control') {
    trace.push(['control', 21, ['dir-open', 2, '']]);
  }
  const options = expected();
  await expect(read(traceArchive(trace), options)).rejects.toThrow();
  expect(options.budget.retained).toBe(0);
  expect((options.membership as FixtureMembership).disposed).toBe(true);
});
it('does not accept a valid application seal before a late gzip failure', async () => {
  const bytes = traceArchive(workerTrace('W1'));
  bytes[bytes.length - 8] ^= 1;
  let complete = false;
  await expect(
    readWorkerArchive(byteSource(bytes), {
      ...expected(),
      async consumeFile({ body }) {
        for await (const b of body) {
          void b;
        }
      },
      async event(value) {
        if ((value as Value[])[0] === 'complete') {
          complete = true;
        }
      },
    }),
  ).rejects.toThrow('CRC');
  expect(complete).toBe(true);
});
it('detects changed/truncated caller-owned upsert membership evidence', async () => {
  const spool = new FixtureMembership();
  spool.seal = async () => () => (async function* () {})();
  await expect(
    read(traceArchive(workerTrace('W1')), { ...expected(), membership: spool }),
  ).rejects.toThrow('Changed upsert');
  expect(spool.disposed).toBe(true);
});
function simple() {
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default', 0]],
    ],
    'simple-',
    1,
  );
  return {
    model,
    context: [...context.slice(0, 7), 'gradle'] as WorkerContext['context'],
    authorizedSnapshots: [],
    budget: new WorkingBudget(),
    membership: new FixtureMembership(),
  };
}
async function* simpleEvents(time = 0, used = 'b'): AsyncGenerator<WorkerEvent> {
  yield { type: 'channel-open' };
  yield { type: 'dir-open', path: '' };
  yield {
    type: 'file',
    path: 'a',
    size: 3,
    mode: 420,
    mtimeMs: time,
    bytes: (async function* () {
      yield Buffer.from('abc');
    })(),
    assertStable: guard,
  };
  yield { type: 'dir-close', path: '' };
  yield { type: 'channel-close' };
  yield { type: 'channel-open' };
  yield { type: 'dir-open', path: '' };
  yield { type: 'used', name: used };
  yield { type: 'dir-close', path: '' };
  yield { type: 'channel-close' };
}
it.each([
  [2147483647000, null],
  [2147483648000, '2147483648'],
  [1700000000123, '1700000000.123'],
  [8589934592000, '8589934592'],
  [Number.MAX_SAFE_INTEGER, '9007199254740.991'],
] as const)(
  'preserves the wire representation and exact milliseconds for timestamp %i',
  async (time, paxTime) => {
    const out = await write(
      { ...simple(), snapshots: [], assertStable: guard },
      simpleEvents(time),
    );
    const raw = gunzipSync(out.bytes);
    expect(raw.includes(' mtime=')).toBe(paxTime !== null);
    if (paxTime !== null) {
      expect(raw.includes(` mtime=${paxTime}\n`)).toBe(true);
    }
    let actual = -1;
    const opts = simple();
    await readWorkerArchive(byteSource(out.bytes), {
      ...opts,
      async consumeFile({ header, body }) {
        actual = header.mtimeMs;
        for await (const b of body) {
          void b;
        }
      },
    });
    expect(actual).toBe(time);
    expect(opts.budget.retained).toBe(0);
  },
);
it('rejects upsert/usage overlap in the actual codec and disposes evidence', async () => {
  const options = { ...simple(), snapshots: [], assertStable: guard };
  await expect(write(options, simpleEvents(0, 'a'))).rejects.toThrow('Overlapping upsert');
  expect((options.membership as FixtureMembership).disposed).toBe(true);
  expect(options.budget.retained).toBe(0);
});
it('calls guarded sources around bytes and rejects instability before completion', async () => {
  let calls = 0;
  const options = {
    ...simple(),
    snapshots: [],
    async assertStable() {
      if (++calls === 2) {
        throw new Error('tree changed');
      }
    },
  };
  await expect(write(options, simpleEvents())).rejects.toThrow('tree changed');
  expect(calls).toBe(2);
  expect(options.budget.retained).toBe(0);
});
it('propagates failed output and cleans up current input/spool', async () => {
  const options = { ...simple(), snapshots: [], assertStable: guard };
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('sink failed'));
    },
  });
  await expect(writeWorkerArchive(sink, options, () => simpleEvents())).rejects.toThrow(
    'sink failed',
  );
  expect((options.membership as FixtureMembership).disposed).toBe(true);
  expect(options.budget.retained).toBe(0);
});
it('aligns input-local snapshot IDs through model order', () => {
  const m = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      [
        ...modelVector[4],
        ['other', ['other/**'], ['.mammoth/**'], 'single-writer', 'A', 'default', 0],
      ],
    ],
    'vectors-',
    1,
  );
  expect(globalChannelKey(m, ['metadata'], 2)).toBe(3);
  expect(globalChannelKey(m, ['other'], 2)).toBe(4);
});
it('bounds hierarchical name state and rejects files-first collisions', () => {
  const budget = new WorkingBudget(),
    tree = new TreeState(budget, 3);
  tree.open('');
  tree.file('a');
  tree.file('z');
  expect(() => tree.open('a')).toThrow('colliding');
  tree.file('zz');
  expect(() => tree.file('zzz')).toThrow('breadth');
  tree.dispose();
  expect(budget.retained).toBe(0);
  const small = new WorkingBudget(150);
  const limited = new TreeState(small);
  limited.open('');
  expect(() => limited.file('a')).toThrow('budget');
  limited.dispose();
  expect(small.retained).toBe(0);
});

const workspace = 'caches/8.10/transforms/' + 'a'.repeat(32);
async function* workspaceChannel(usage = false, missing = false): AsyncGenerator<WorkerEvent> {
  yield { type: 'channel-open' };
  const paths = ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', workspace];
  for (const path of paths) {
    yield { type: 'dir-open', path };
  }
  yield {
    type: usage ? 'used-unit-open' : 'unit-open',
    unit: ['artifact-transform', workspace, 'subtree'],
  };
  for (const name of missing ? ['metadata.bin'] : ['metadata.bin', 'results.bin']) {
    if (usage) {
      yield { type: 'used', name };
    } else {
      yield {
        type: 'file',
        path: workspace + '/' + name,
        size: 1,
        mode: 420,
        mtimeMs: 0,
        bytes: (async function* () {
          yield Buffer.from('x');
        })(),
        assertStable: guard,
      };
    }
  }
  yield { type: 'dir-open', path: workspace + '/transformed' };
  yield { type: 'dir-close', path: workspace + '/transformed' };
  yield { type: usage ? 'used-unit-close' : 'unit-close' };
  for (const path of [...paths].reverse()) {
    yield { type: 'dir-close', path };
  }
  yield { type: 'channel-close' };
}
async function* emptyChannel(): AsyncGenerator<WorkerEvent> {
  yield { type: 'channel-open' };
  yield { type: 'dir-open', path: '' };
  yield { type: 'dir-close', path: '' };
  yield { type: 'channel-close' };
}
it('checks interleaved workspace facts, meaningful directories and constant markers', async () => {
  const options = { ...simple(), snapshots: [], assertStable: guard };
  const out = await write(
    options,
    (async function* () {
      yield* workspaceChannel();
      yield* emptyChannel();
    })(),
  );
  const opts = simple(),
    seen: Value[] = [];
  await readWorkerArchive(byteSource(out.bytes), {
    ...opts,
    async consumeFile({ body }) {
      for await (const b of body) {
        void b;
      }
    },
    async event(v) {
      seen.push(v);
    },
  });
  const close = seen.find((v) => (v as Value[])[0] === 'unit-close') as Value[];
  const sha = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881';
  const semantic = new Digest('unit-semantic').update([
    'unit',
    'artifact-transform',
    workspace,
    'subtree',
  ]);
  const comparison = new Digest('unit-compare').update(['unit', 'artifact-transform']);
  semantic.update(['directory', workspace, 'open']);
  comparison.update(['directory', '', 'open']);
  for (const name of ['metadata.bin', 'results.bin']) {
    semantic.update(['file', workspace + '/' + name, 'data', 1, 420, 0, sha]);
    comparison.update(['file', name, 1, 420, sha]);
  }
  for (const phase of ['open', 'close']) {
    semantic.update(['directory', workspace + '/transformed', phase]);
    comparison.update(['directory', 'transformed', phase]);
  }
  semantic
    .update(['directory', workspace, 'close'])
    .update(['unit-end', 'artifact-transform', workspace]);
  comparison.update(['directory', '', 'close']);
  expect(close.slice(4)).toEqual([[2, 2, 1, 0, 2], semantic.digest(), comparison.digest()]);
  expect(opts.budget.retained).toBe(0);
});
it('verifies complete usage-only workspace membership without content facts', async () => {
  const out = await write(
    { ...simple(), snapshots: [], assertStable: guard },
    (async function* () {
      yield* emptyChannel();
      yield* workspaceChannel(true);
    })(),
  );
  const result = await readWorkerArchive(byteSource(out.bytes), {
    ...simple(),
    async consumeFile() {
      throw new Error('no payload');
    },
  });
  expect(result.counts).toEqual([0, 7, 1, 2, 0]);
});
it('rejects incomplete and overlapping indivisible workspaces', async () => {
  await expect(
    write(
      { ...simple(), snapshots: [], assertStable: guard },
      (async function* () {
        yield* workspaceChannel(false, true);
        yield* emptyChannel();
      })(),
    ),
  ).rejects.toThrow('required workspace');
  await expect(
    write(
      { ...simple(), snapshots: [], assertStable: guard },
      (async function* () {
        yield* workspaceChannel();
        yield* workspaceChannel(true);
      })(),
    ),
  ).rejects.toThrow('Overlapping upsert');
});
it('does not let a complete workspace split ownership across partitions', async () => {
  const options = simple();
  options.model = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [
        ['one', [workspace + '/metadata.bin'], ['.mammoth/**'], 'aggregate', null, 'default', 0],
        [
          'two',
          [workspace + '/results.bin', workspace + '/transformed/**'],
          ['.mammoth/**'],
          'aggregate',
          null,
          'default',
          0,
        ],
      ],
    ],
    '',
    1,
  );
  await expect(
    write(
      { ...options, snapshots: [], assertStable: guard },
      (async function* () {
        yield* workspaceChannel();
        yield* emptyChannel();
      })(),
    ),
  ).rejects.toThrow('Split workspace');
});

it('reader independently rejects upsert/usage overlap before the now-invalid trailing seal', async () => {
  const out = await write(
    { ...simple(), snapshots: [], assertStable: guard },
    simpleEvents(0, 'b'),
  );
  const raw = gunzipSync(out.bytes);
  let changed = false;
  // Bounded fixture mutation only; never a second production TAR interpretation.
  for (let at = 0; at + 512 <= raw.length;) {
    const size = parseInt(raw.toString('ascii', at + 124, at + 136), 8) || 0;
    const name = raw.toString('utf8', at, at + 100).split('\0')[0];
    if (name.startsWith('.mammoth-meta/')) {
      const tuple = JSON.parse(raw.toString('utf8', at + 512, at + 512 + size));
      if (tuple[0] === 'used') {
        tuple[2] = 'a';
        const replacement = Buffer.from(JSON.stringify(tuple) + '\n');
        expect(replacement.length).toBe(size);
        replacement.copy(raw, at + 512);
        changed = true;
        break;
      }
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(changed).toBe(true);
  await expect(
    readWorkerArchive(byteSource(gzipSync(raw)), {
      ...simple(),
      async consumeFile({ body }) {
        for await (const b of body) {
          void b;
        }
      },
    }),
  ).rejects.toThrow('Overlapping upsert');
});
it('cleans the writer when validation or iterator retirement fails', async () => {
  const invalid: WorkerWriter = {
    ...simple(),
    context: [...context],
    snapshots: [],
    assertStable: guard,
  };
  const sink = new Writable({
    write(_b, _e, cb) {
      cb();
    },
  });
  await expect(writeWorkerArchive(sink, invalid, () => simpleEvents())).rejects.toThrow(
    'build tool',
  );
  expect(sink.destroyed).toBe(true);
  expect((invalid.membership as FixtureMembership).disposed).toBe(true);
  const options = { ...simple(), snapshots: [], assertStable: guard };
  const events = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw new Error('iterator failed');
        },
        async return() {
          throw new Error('retirement failed');
        },
      };
    },
  };
  await expect(
    writeWorkerArchive(
      new Writable({
        write(_b, _e, cb) {
          cb();
        },
      }),
      options,
      () => events,
    ),
  ).rejects.toThrow();
  expect((options.membership as FixtureMembership).disposed).toBe(true);
  expect(options.budget.retained).toBe(0);
});

it('binds meaningful empty-directory owners as well as workspace file owners', async () => {
  const options = simple();
  options.model = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [
        [
          'data',
          [workspace + '/**'],
          ['.mammoth/**', workspace + '/transformed/**'],
          'aggregate',
          null,
          'default',
          0,
        ],
        [
          'outputs',
          [workspace + '/transformed/**'],
          ['.mammoth/**'],
          'aggregate',
          null,
          'default',
          0,
        ],
      ],
    ],
    '',
    1,
  );
  await expect(
    write(
      { ...options, snapshots: [], assertStable: guard },
      (async function* () {
        yield* workspaceChannel();
        yield* emptyChannel();
      })(),
    ),
  ).rejects.toThrow('Split workspace');
  expect(options.budget.retained).toBe(0);
});
it('rejects unowned empty branches while preserving an explicit empty channel root', async () => {
  const options = expected();
  await expect(
    write(
      { ...options, snapshots: [], assertStable: guard },
      (async function* (): AsyncGenerator<WorkerEvent> {
        yield { type: 'channel-open' };
        yield { type: 'dir-open', path: '' };
        yield { type: 'dir-open', path: 'unowned' };
        yield { type: 'dir-close', path: 'unowned' };
      })(),
    ),
  ).rejects.toThrow('Unowned');
  expect(options.budget.retained).toBe(0);
});

it('rejects a directory-only workspace without its complete-unit wrapper', async () => {
  await expect(
    write(
      { ...simple(), snapshots: [], assertStable: guard },
      (async function* () {
        yield { type: 'channel-open' };
        for (const path of ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', workspace]) {
          yield { type: 'dir-open', path };
        }
        yield { type: 'dir-close', path: workspace };
      })(),
    ),
  ).rejects.toThrow('complete unit wrapper');
});
it('rejects unsupported workspace surfaces instead of treating them as ordinary files', async () => {
  await expect(
    write(
      { ...simple(), snapshots: [], assertStable: guard },
      (async function* () {
        yield { type: 'channel-open' };
        const root = 'caches/8.10/transforms/not-a-hash';
        for (const path of ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', root]) {
          yield { type: 'dir-open', path };
        }
        yield {
          type: 'file',
          path: root + '/file',
          size: 0,
          mode: 420,
          mtimeMs: 0,
          bytes: (async function* () {})(),
          assertStable: guard,
        };
      })(),
    ),
  ).rejects.toThrow('Unsupported workspace');
});
it('disposes replay storage even if iterator retirement throws', async () => {
  const spool = new FixtureMembership();
  spool.seal = async () => () => ({
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          return index < spool.rows.length
            ? { done: false, value: spool.rows[index++] }
            : { done: true, value: undefined };
        },
        async return(): Promise<IteratorResult<Value>> {
          throw new Error('retirement');
        },
      };
    },
  });
  const options = { ...expected(), membership: spool };
  await expect(read(traceArchive(workerTrace('W1')), options)).rejects.toThrow('retirement');
  expect(spool.disposed).toBe(true);
  expect(options.budget.retained).toBe(0);
});
it('aborts a pending membership read and disposes its storage', async () => {
  const spool = new FixtureMembership(),
    controller = new AbortController();
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  spool.seal = async () => () => ({
    [Symbol.asyncIterator]() {
      return {
        next() {
          entered();
          return new Promise<IteratorResult<Value>>(() => {});
        },
        async return() {
          return { done: true as const, value: undefined };
        },
      };
    },
  });
  const options = { ...expected(), membership: spool };
  const operation = readWorkerArchive(
    byteSource(traceArchive(workerTrace('W1'))),
    {
      ...options,
      async consumeFile({ body }) {
        for await (const chunk of body) {
          void chunk;
        }
      },
    },
    controller.signal,
  );
  const assertion = expect(operation).rejects.toThrow('stop replay');
  await pending;
  controller.abort(new Error('stop replay'));
  await assertion;
  expect(spool.disposed).toBe(true);
  expect(options.budget.retained).toBe(0);
});
it('aborts a pending body producer and retires the iterator', async () => {
  const controller = new AbortController();
  let entered!: () => void,
    retired = false;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const options = { ...simple(), snapshots: [], assertStable: guard };
  const operation = writeWorkerArchive(
    new Writable({
      write(_b, _e, cb) {
        cb();
      },
    }),
    options,
    async function* () {
      yield { type: 'channel-open' };
      yield { type: 'dir-open', path: '' };
      yield {
        type: 'file',
        path: 'file',
        size: 1,
        mode: 420,
        mtimeMs: 0,
        assertStable: guard,
        bytes: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                entered();
                return new Promise<IteratorResult<Uint8Array>>(() => {});
              },
              async return() {
                retired = true;
                return { done: true as const, value: undefined };
              },
            };
          },
        },
      };
    },
    controller.signal,
  );
  const assertion = expect(operation).rejects.toThrow();
  await pending;
  controller.abort(new Error('stop body'));
  await assertion;
  expect(retired).toBe(true);
  expect(options.budget.retained).toBe(0);
});
it.each([true, false])(
  'checks Maven cross-channel publication roots (overlap=%s)',
  async (overlap) => {
    const model = resolveModel(
      [
        'model',
        1,
        'maven',
        ['.mammoth/**'],
        [
          ['data', ['repository/**/*.jar'], ['.mammoth/**'], 'aggregate', null, 'default', 0],
          [
            'metadata',
            ['repository/**/_remote.repositories'],
            ['.mammoth/**'],
            'single-writer',
            'A',
            'default',
            0,
          ],
        ],
      ],
      'mixed-',
      1,
    );
    const options = { ...expected(), model, snapshots: ['metadata'], assertStable: guard };
    async function* channel(root: string, name: string): AsyncGenerator<WorkerEvent> {
      yield { type: 'channel-open' };
      for (const path of ['', 'repository', root]) {
        yield { type: 'dir-open', path };
      }
      yield { type: 'unit-open', unit: ['maven-directory', root, 'direct'] };
      yield {
        type: 'file',
        path: root + '/' + name,
        size: 0,
        mode: 420,
        mtimeMs: 0,
        bytes: (async function* () {})(),
        assertStable: guard,
      };
      yield { type: 'unit-close' };
      for (const path of [root, 'repository', '']) {
        yield { type: 'dir-close', path };
      }
      yield { type: 'channel-close' };
    }
    const operation = write(
      options,
      (async function* () {
        yield* channel('repository/g', 'a.jar');
        yield* emptyChannel();
        yield* channel(overlap ? 'repository/g' : 'repository/h', '_remote.repositories');
      })(),
    );
    if (overlap) {
      await expect(operation).rejects.toThrow('Mixed Maven publication');
    } else {
      const out = await operation;
      await read(out.bytes, { ...expected(), model });
    }
  },
);

it('rejects a missing workspace wrapper on the independent reader path', async () => {
  const options = simple();
  const trace: Value[][] = [
    [
      'identity',
      [
        'identity',
        1,
        'worker-tar-v2',
        'gzip',
        options.context,
        options.model.id,
        options.model.family,
        [],
      ],
    ],
    ['control', 1, ['channel-open', 0, 'aggregate', null]],
  ];
  let sequence = 1;
  for (const path of ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', workspace]) {
    trace.push(['directory', ['header', 0, path, 'directory', 0, 493, 0]]);
    trace.push(['control', ++sequence, ['dir-open', 0, path]]);
  }
  trace.push(['control', sequence + 1, ['dir-close', 0, workspace]]);
  await expect(read(traceArchive(trace), options)).rejects.toThrow('complete unit wrapper');
  expect(options.budget.retained).toBe(0);
});

it('owns retained basenames without retaining each long full-path backing string', () => {
  const program = buildSync({
    stdin: {
      contents: `
    import {WorkingBudget,TreeState} from './src/cache/streaming/tree-state';
    global.gc(); const before=process.memoryUsage().heapUsed;
    const tree=new TreeState(new WorkingBudget());
    const parent='p'.repeat(14000); tree.open(''); tree.open(parent);
    for(let i=0;i<1000;i++) tree.file(parent+'/'+String(i).padStart(19,'0'));
    global.gc(); const growth=process.memoryUsage().heapUsed-before;
    if(growth>6*1024*1024) throw Error('Retained full paths: '+growth);
    tree.dispose();
  `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  execFileSync(process.execPath, ['--expose-gc'], {
    input: program.outputFiles[0].contents,
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
});
it('rejects an unsupported workspace-surface empty leaf', async () => {
  await expect(
    write(
      { ...simple(), snapshots: [], assertStable: guard },
      (async function* () {
        yield { type: 'channel-open' };
        const paths = [
          '',
          'caches',
          'caches/8.10',
          'caches/8.10/transforms',
          'caches/8.10/transforms/not-a-hash',
        ];
        for (const path of paths) {
          yield { type: 'dir-open', path };
        }
        yield { type: 'dir-close', path: paths[4] };
      })(),
    ),
  ).rejects.toThrow('Unsupported workspace');
});

it('rejects snapshot upsert overlapping an aggregate usage-only Maven unit', async () => {
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      [
        ['data', ['repository/**/*.jar'], ['.mammoth/**'], 'aggregate', null, 'default', 0],
        [
          'metadata',
          ['repository/**/_remote.repositories'],
          ['.mammoth/**'],
          'single-writer',
          'A',
          'default',
          0,
        ],
      ],
    ],
    'mixed-',
    1,
  );
  await expect(
    write(
      { ...expected(), model, snapshots: ['metadata'], assertStable: guard },
      (async function* (): AsyncGenerator<WorkerEvent> {
        yield* emptyChannel();
        for (const usage of [true, false]) {
          yield { type: 'channel-open' };
          for (const path of ['', 'repository', 'repository/g']) {
            yield { type: 'dir-open', path };
          }
          yield {
            type: usage ? 'used-unit-open' : 'unit-open',
            unit: ['maven-directory', 'repository/g', 'direct'],
          };
          if (usage) {
            yield { type: 'used', name: 'a.jar' };
          } else {
            yield {
              type: 'file',
              path: 'repository/g/_remote.repositories',
              size: 0,
              mode: 420,
              mtimeMs: 0,
              bytes: (async function* () {})(),
              assertStable: guard,
            };
          }
          yield { type: usage ? 'used-unit-close' : 'unit-close' };
          for (const path of ['repository/g', 'repository', '']) {
            yield { type: 'dir-close', path };
          }
          yield { type: 'channel-close' };
        }
      })(),
    ),
  ).rejects.toThrow('Mixed Maven publication');
});

it('rejects unknown Gradle layouts in imported archives rather than applying local discovery filtering', async () => {
  const options = simple();
  // Valid framing/hierarchy; the unknown ordinary file must fail before any trailing seal.
  const trace: Value[][] = [
    [
      'identity',
      [
        'identity',
        1,
        'worker-tar-v2',
        'gzip',
        [...options.context],
        options.model.id,
        options.model.family,
        [],
      ],
    ],
    ['control', 1, ['channel-open', 0, 'aggregate', null]],
  ];
  for (const [i, path] of ['', 'caches', 'caches/transforms-3'].entries()) {
    trace.push(['directory', ['header', 0, path, 'directory', 0, 493, 0]]);
    trace.push(['control', i + 2, ['dir-open', 0, path]]);
  }
  trace.push(['file', 0, ['header', 0, 'caches/transforms-3/body', 'file', 0, 420, 0], '']);
  await expect(read(traceArchive(trace), options)).rejects.toThrow(
    'Unsupported workspace-surface contribution',
  );
  expect(options.budget.retained).toBe(0);
});

// Separate framed-JSON oracle: ordinary vector values contain no control scalars.
function eventDigest(domain: string, rows: Value[]) {
  const hash = createHash('sha256').update('mammoth:' + domain + ':1\0');
  for (const row of rows) {
    const bytes = Buffer.from(JSON.stringify(row)),
      size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size).update(bytes);
  }
  return hash.digest('hex');
}
it.each(['channel', 'archive'] as const)(
  'binds a valid-looking changed effective header through the %s seal without a standalone header hash',
  async (boundary) => {
    const trace = workerTrace('W1'),
      files = trace.filter((row) => row[0] === 'file');
    (files[1][2] as Value[])[6] = 1700000000124;
    const unitClose = trace.find(
      (row) => row[0] === 'control' && (row[2] as Value[])[0] === 'unit-close',
    )![2] as Value[];
    const facts: Value[] = [['unit', 'maven-directory', 'repository/g', 'direct']];
    for (const wrapped of files) {
      const header = wrapped[2] as Value[];
      facts.push([
        'file',
        header[2],
        'data',
        header[4],
        header[5],
        header[6],
        createHash('sha256')
          .update(Buffer.from(String(wrapped[3]), 'hex'))
          .digest('hex'),
      ]);
    }
    facts.push(['unit-end', 'maven-directory', 'repository/g']);
    unitClose[5] = eventDigest('unit-semantic', facts);
    if (boundary === 'archive') {
      const rows: Value[] = [];
      let collecting = false,
        sha = '';
      for (const wrapped of trace) {
        if (wrapped[0] === 'control') {
          const control = wrapped[2] as Value[];
          if (control[0] === 'channel-open' && control[1] === 0) {
            collecting = true;
          }
          if (collecting && control[0] === 'channel-close') {
            sha = eventDigest('channel-events', rows);
            control[3] = sha;
            break;
          }
          if (collecting) {
            rows.push(control);
          }
        } else if (collecting && (wrapped[0] === 'file' || wrapped[0] === 'directory')) {
          rows.push(wrapped[0] === 'file' ? wrapped[2] : wrapped[1]);
        }
      }
      ((trace.at(-1)![1] as Value[])[5] as Value[][])[0][4] = sha;
    }
    const options = expected();
    await expect(read(traceArchive(trace), options)).rejects.toThrow(
      boundary === 'channel' ? 'channel summary' : 'final seal',
    );
    expect(options.budget.retained).toBe(0);
  },
);
it('writes and reads empty and nonempty files with zero standalone header-domain hashes and unchanged body bytes', async () => {
  const options = expected(),
    hash = vi.spyOn(encoding, 'H');
  let bodyStreamsStarted = 0,
    bodyBytes = 0;
  async function* countedEvents(): AsyncGenerator<WorkerEvent> {
    for await (const event of eventsFromTrace(workerTrace('W1'))) {
      if (event.type !== 'file') {
        yield event;
        continue;
      }
      const source = event.bytes;
      yield {
        ...event,
        bytes: (async function* () {
          bodyStreamsStarted++;
          for await (const chunk of source) {
            bodyBytes += chunk.length;
            yield chunk;
          }
        })(),
      };
    }
  }
  const work = { tarBytes: 0, controlMembers: 0, controlBodyBytes: 0 };
  try {
    const output = await write(
        { ...options, snapshots: ['metadata'], assertStable: guard, work },
        countedEvents(),
      ),
      decoded = await read(output.bytes);
    expect(bodyStreamsStarted).toBe(2);
    expect(bodyBytes).toBe(3);
    const controls = workerTrace('W1')
      .filter((row) => row[0] !== 'file' && row[0] !== 'directory')
      .map((row) => (row[0] === 'control' ? row[2] : row[1]));
    expect(work.controlMembers).toBe(controls.length);
    expect(work.controlBodyBytes).toBe(
      controls.reduce<number>((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0),
    );
    expect(decoded.fileBytes).toBe(3);
    expect(decoded.result.counts[0]).toBe(2);
    expect(decoded.result.counts[4]).toBe(3);
    const metadata = workerTrace('W1').find(
      (row) => row[0] === 'control' && (row[2] as Value[])[0] === 'file-meta',
    )![2] as Value[];
    expect(metadata).toHaveLength(5);
    const old = [...metadata];
    old.splice(3, 0, '0'.repeat(64));
    expect(encoding.encodeRecord(old).length - encoding.encodeRecord(metadata).length).toBe(67);
    expect(hash.mock.calls.filter(([domain]) => domain === 'header')).toEqual([]);
    expect(options.budget.retained).toBe(0);
  } finally {
    hash.mockRestore();
  }
});
