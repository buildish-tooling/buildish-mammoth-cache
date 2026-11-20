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

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  readNativeTree,
  writeNativeTree,
  type NativeTreeOptions,
} from '../../../src/cache/streaming/native-tree';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { resolveModel } from '../../../src/cache/streaming/model';
import { type Envelope } from '../../../src/cache/streaming/native-records';
import { encodeRecord, type Value, rawSha } from '../../../src/cache/streaming/encoding';
const h = 'a'.repeat(64),
  empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function options(tool = 'gradle'): NativeTreeOptions {
  const model = resolveModel(
    [
      'model',
      1,
      tool,
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
    ],
    'tree-',
    1,
  );
  return {
    model,
    identity: [model.family, model.id, 'data', h, h, h],
    budget: new WorkingBudget(),
  };
}
// Deliberately independent from the codec's canonical/framed accumulator.
function hash(domain: string, records: Value[]): string {
  const hash = createHash('sha256').update('mammoth:' + domain + ':1\0');
  for (const record of records) {
    const bytes = Buffer.from(JSON.stringify(record)),
      n = Buffer.alloc(8);
    n.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(n).update(bytes);
  }
  return hash.digest('hex');
}
async function* records(rows: Value[]): AsyncGenerator<Value> {
  yield* rows;
}
async function* chunks(bytes: Buffer): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += 17) yield bytes.subarray(i, i + 17);
}
function fixture(
  opts: NativeTreeOptions,
  body: Value[],
  facts: Value[],
  counts: Envelope[7],
): { bytes: Buffer; envelope: Envelope } {
  const header: Value = ['tree', 1, 'native-tree-v1', opts.identity, 'partition-projection'];
  const semantic = hash('base-tree-semantic', facts),
    events = hash('base-tree-events', [header, ...body]);
  const bytes = Buffer.from(
    [...[header, ...body, ['end', counts, semantic, events]]]
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  return {
    bytes,
    envelope: [
      'envelope',
      1,
      'native-tree-v1',
      opts.identity,
      'partition-projection',
      bytes.length,
      rawSha(bytes),
      counts,
      semantic,
    ],
  };
}
async function write(rows: Value[], opts: NativeTreeOptions) {
  let envelope!: Envelope;
  const output: Buffer[] = [];
  for await (const bytes of writeNativeTree(records(rows), opts, (e) => {
    envelope = e;
  }))
    output.push(bytes);
  return { bytes: Buffer.concat(output), envelope };
}
it.each([false, true])(
  'matches independent ordinary native tree framing (empty=%s)',
  async (noFile) => {
    const opts = options(),
      body: Value[] = [
        ['dir-open', ''],
        ...(noFile ? [] : [['file', 'cache.bin', 0, 420, 1700000000123, empty]]),
        ['dir-close', ''],
      ];
    const facts: Value[] = [
      ['directory', '', 'open'],
      ...(noFile ? [] : [['file', 'cache.bin', 'data', 0, 420, 1700000000123, empty]]),
      ['directory', '', 'close'],
    ];
    const literal = fixture(opts, body, facts, [noFile ? 0 : 1, 1, 0, 0, 0]);
    if (!noFile)
      expect(literal.envelope[8]).toBe(
        '408e19330670b462569fd67c400a42d95aadc73375042edc5c8889fe7e831698',
      );
    const actual = await write(body, opts);
    expect(actual).toEqual(literal);
    const readOpts = options();
    await readNativeTree(chunks(literal.bytes), readOpts, literal.envelope);
    expect(readOpts.budget.retained).toBe(0);
  },
);
it('checks Maven projection summary-first and close against independently framed facts', async () => {
  const opts = options('maven'),
    root = 'repository/g',
    unit: Value = ['unit', 'maven-directory', root, 'direct', 'partition-projection', 'data'];
  const file: Value = ['file', root + '/a.jar', 'data', 0, 420, 0, empty],
    counts: Envelope[7] = [1, 0, 1, 0, 0];
  const semantic = hash('base-unit-semantic', [unit, file, ['unit-end', 'maven-directory', root]]);
  const compare = hash('base-unit-compare', [
    ['unit', 'maven-directory', 'partition-projection', 'data'],
    ['file', 'a.jar', 0, empty],
  ]);
  const body: Value[] = [
    ['dir-open', ''],
    ['dir-open', 'repository'],
    ['dir-open', root],
    [
      'unit-open',
      'maven-directory',
      root,
      'direct',
      'partition-projection',
      counts,
      semantic,
      compare,
    ],
    ['file', 'a.jar', 0, 420, 0, empty],
    ['unit-close', 'maven-directory', root, counts, semantic, compare],
    ['dir-close', root],
    ['dir-close', 'repository'],
    ['dir-close', ''],
  ];
  const facts: Value[] = [
    ['directory', '', 'open'],
    ['directory', 'repository', 'open'],
    ['directory', root, 'open'],
    unit,
    file,
    ['unit-end', 'maven-directory', root],
    ['directory', root, 'close'],
    ['directory', 'repository', 'close'],
    ['directory', '', 'close'],
  ];
  const literal = fixture(opts, body, facts, [1, 3, 1, 0, 0]);
  expect(await write(body, opts)).toEqual(literal);
  await readNativeTree(chunks(literal.bytes), options('maven'), literal.envelope);
  const bad = structuredClone(body);
  (bad[3] as Value[])[7] = 'b'.repeat(64);
  await expect(write(bad, options('maven'))).rejects.toThrow('opening assertion');
});
it('checks a full projected transform including an empty meaningful directory', async () => {
  const opts = options(),
    root = 'caches/8.10/transforms/' + 'a'.repeat(32),
    paths = ['', 'caches', 'caches/8.10', 'caches/8.10/transforms', root];
  const unit: Value = [
    'unit',
    'artifact-transform',
    root,
    'subtree',
    'partition-projection',
    'data',
  ];
  const unitFacts: Value[] = [
    unit,
    ['directory', root, 'open'],
    ...['metadata.bin', 'results.bin'].map(
      (n) => ['file', root + '/' + n, 'data', 0, 420, 0, empty] as Value,
    ),
    ['directory', root + '/transformed', 'open'],
    ['directory', root + '/transformed', 'close'],
    ['directory', root, 'close'],
    ['unit-end', 'artifact-transform', root],
  ];
  const comparison: Value[] = [
    ['unit', 'artifact-transform', 'partition-projection', 'data'],
    ['directory', '', 'open'],
    ...['metadata.bin', 'results.bin'].map((n) => ['file', n, 0, 420, empty] as Value),
    ['directory', 'transformed', 'open'],
    ['directory', 'transformed', 'close'],
    ['directory', '', 'close'],
  ];
  const uc: Envelope[7] = [2, 2, 1, 0, 0],
    us = hash('base-unit-semantic', unitFacts),
    cs = hash('base-unit-compare', comparison);
  const body: Value[] = [
    ...paths.map((p) => ['dir-open', p] as Value),
    ['unit-open', 'artifact-transform', root, 'subtree', 'partition-projection', uc, us, cs],
    ...['metadata.bin', 'results.bin'].map((n) => ['file', n, 0, 420, 0, empty] as Value),
    ['dir-open', root + '/transformed'],
    ['dir-close', root + '/transformed'],
    ['unit-close', 'artifact-transform', root, uc, us, cs],
    ...[...paths].reverse().map((p) => ['dir-close', p] as Value),
  ];
  const facts: Value[] = [
    ...paths.map((p) => ['directory', p, 'open'] as Value),
    unit,
    ...unitFacts.slice(2, -2),
    ['unit-end', 'artifact-transform', root],
    ...[...paths].reverse().map((p) => ['directory', p, 'close'] as Value),
  ];
  const literal = fixture(opts, body, facts, [2, 6, 1, 0, 0]);
  expect(await write(body, opts)).toEqual(literal);
  await readNativeTree(chunks(literal.bytes), options(), literal.envelope);
});
it.each([
  'truncated',
  'trailing',
  'raw-hash',
  'unbalanced',
  'end-count',
  'reserved',
  'owner',
  'missing-unit',
])('rejects native tree %s', async (kind) => {
  const opts = options(kind === 'missing-unit' ? 'maven' : 'gradle');
  const body: Value[] = [
    ['dir-open', ''],
    ['file', 'cache.bin', 0, 420, 0, empty],
    ['dir-close', ''],
  ];
  const facts: Value[] = [
    ['directory', '', 'open'],
    ['file', 'cache.bin', 'data', 0, 420, 0, empty],
    ['directory', '', 'close'],
  ];
  const valid = fixture(opts, body, facts, [1, 1, 0, 0, 0]);
  let bytes = valid.bytes;
  if (kind === 'truncated') bytes = bytes.subarray(0, -1);
  if (kind === 'trailing') bytes = Buffer.concat([bytes, encodeRecord(['dir-close', ''])]);
  if (kind === 'raw-hash') valid.envelope[6] = 'b'.repeat(64);
  if (kind === 'unbalanced')
    bytes = Buffer.from(bytes.toString().replace('["dir-close",""]', '["dir-close","x"]'));
  if (kind === 'end-count')
    bytes = Buffer.from(bytes.toString().replace('["end",[1,1,0,0,0]', '["end",[2,1,0,0,0]'));
  if (kind === 'reserved') bytes = Buffer.from(bytes.toString().replace('cache.bin', '.mammoth'));
  if (kind === 'owner') opts.identity[2] = 'unknown';
  if (kind === 'missing-unit')
    bytes = Buffer.from(
      bytes
        .toString()
        .replace('["file","cache.bin"', '["dir-open","repository"]\n["file","cache.bin"'),
    );
  await expect(readNativeTree(chunks(bytes), opts, valid.envelope)).rejects.toThrow();
  expect(opts.budget.retained).toBe(0);
});

it('streams Unicode/long paths and exact safe millisecond times', async () => {
  const opts = options(),
    name = 'é'.repeat(80) + '.bin',
    rows: Value[] = [
      ['dir-open', ''],
      ['file', name, 0, 493, Number.MAX_SAFE_INTEGER, empty],
      ['dir-close', ''],
    ];
  const out = await write(rows, opts);
  const seen: Value[] = [];
  await readNativeTree(chunks(out.bytes), options(), out.envelope, async (row) => {
    seen.push(row);
  });
  expect(seen[2]).toEqual(rows[1]);
});
it('keeps observations provisional when raw binding fails after the valid end', async () => {
  const opts = options(),
    out = await write(
      [
        ['dir-open', ''],
        ['dir-close', ''],
      ],
      opts,
    );
  out.envelope[5]++;
  let sawEnd = false;
  await expect(
    readNativeTree(chunks(out.bytes), options(), out.envelope, async (row) => {
      if (Array.isArray(row) && row[0] === 'end') sawEnd = true;
    }),
  ).rejects.toThrow('envelope tree binding');
  expect(sawEnd).toBe(true);
});
it('releases tree state and withholds envelope on cancelled writer', async () => {
  const opts = options(),
    controller = new AbortController();
  let sealed = false;
  const iterator = writeNativeTree(
    (async function* () {
      yield ['dir-open', ''] as Value;
      controller.abort(new Error('cancel native'));
      yield ['dir-close', ''] as Value;
    })(),
    opts,
    () => {
      sealed = true;
    },
    controller.signal,
  );
  await expect(
    (async () => {
      for await (const row of iterator) void row;
    })(),
  ).rejects.toThrow('cancel native');
  expect(sealed).toBe(false);
  expect(opts.budget.retained).toBe(0);
});

it('retires input on early writer return without a sealed envelope', async () => {
  const opts = options();
  let retired = false,
    sealed = false;
  const writer = writeNativeTree(
    (async function* () {
      try {
        yield ['dir-open', ''] as Value;
        yield ['dir-close', ''] as Value;
      } finally {
        retired = true;
      }
    })(),
    opts,
    () => {
      sealed = true;
    },
  );
  await writer.next();
  await writer.next();
  expect(opts.budget.retained).toBeGreaterThan(0);
  await writer.return(undefined);
  expect(retired).toBe(true);
  expect(sealed).toBe(false);
  expect(opts.budget.retained).toBe(0);
});
it('releases native reader names when its provisional consumer fails', async () => {
  const out = await write(
      [
        ['dir-open', ''],
        ['dir-close', ''],
      ],
      options(),
    ),
    opts = options();
  await expect(
    readNativeTree(chunks(out.bytes), opts, out.envelope, async (row) => {
      if (Array.isArray(row) && row[0] === 'dir-open') throw new Error('consumer failed');
    }),
  ).rejects.toThrow('consumer failed');
  expect(opts.budget.retained).toBe(0);
});
