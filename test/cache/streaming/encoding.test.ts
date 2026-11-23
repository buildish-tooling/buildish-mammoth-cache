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

import { describe, expect, it } from 'vitest';
import { pathSchema } from '../../../src/cache/streaming/schema';
import {
  add,
  canonical,
  decodeRecord,
  decodeRecords,
  encodeRecord,
  encodeRecords,
  H,
  rawSha,
  type Value,
} from '../../../src/cache/streaming/encoding';
import {
  invocationId,
  lineageId,
  resolveModel,
  writerId,
} from '../../../src/cache/streaming/model';
import {
  ordinaryOrder,
  reduceOrdinary,
  type Candidate,
} from '../../../src/cache/streaming/reduction';
import { context, familyId, modelId, modelVector, vectors } from './protocol-fixtures';

// Protocol: docs/dev/cache-protocol-vectors.md#canonical-scalar-bytes
it('matches independent literal canonical bytes and raw hash', () => {
  const bytes = Buffer.from(
    '5b227363616c6172222c22c3a95c75303030615c225c5c5c7530303031222c302c6e756c6c5d0a',
    'hex',
  );
  const tuple: Value = ['scalar', 'é\n"\\\u0001', 0, null];
  expect(encodeRecord(tuple)).toEqual(bytes);
  expect(decodeRecord(bytes)).toEqual(tuple);
  expect(rawSha(bytes)).toBe('617ee6cbadeae76300d1e0efddc0bb8a7e657cdfb3e5dbca4ff30cab53d2c579');
  expect(canonical(['\\n', '\b', '\t'] as Value).toString()).toBe('["\\\\n","\\u0008","\\u0009"]');
});
it.each([
  '[1.0]\n',
  '[-0]\n',
  '[ 1]\n',
  '["\\u00e9"]\n',
  '["\\n"]\n',
  '[null]',
  '{}\n',
  '[true]\n',
  '[9007199254740992]\n',
])('rejects noncanonical/wrong scalars %j', (text) =>
  expect(() => decodeRecord(Buffer.from(text))).toThrow(),
);
it('rejects malformed UTF-8/BOM/lone surrogates and admission before copying huge strings', () => {
  for (const b of [
    Buffer.from([255, 10]),
    Buffer.from('\ufeff[]\n'),
    Buffer.from('["\\ud800"]\n'),
    Buffer.alloc(65537, 32),
  ])
    expect(() => decodeRecord(b)).toThrow();
  expect(() => encodeRecord(['x'.repeat(65536)])).toThrow();
  expect(() => canonical(['\ud800'])).toThrow();
  expect(() => add(Number.MAX_SAFE_INTEGER)).toThrow();
  const cycle: Value[] = [];
  cycle.push(cycle);
  expect(() => H('cycle', cycle)).toThrow('Cyclic');
});
it('streams split records with exact byte positions and no total quota', async () => {
  const source = async function* () {
    for (const byte of Buffer.from('["é"]\n[0]\n')) yield Buffer.from([byte]);
  };
  const frames = [];
  for await (const frame of decodeRecords(source())) frames.push(frame);
  expect(frames.map((f) => [f.start, f.end, f.index])).toEqual([
    [0, 7, 1],
    [7, 11, 2],
  ]);
  expect(frames[0].raw.toString()).toBe('["é"]\n');
  let count = 0;
  async function* records() {
    for (let n = 0; n < 10001; n++) yield ['x', n] as Value;
  }
  for await (const _ of decodeRecords(encodeRecords(records()))) {
    count++;
    void _;
  }
  expect(count).toBe(10001);
});
it('rejects over-limit/truncated NDJSON independently from whole stream size', async () => {
  for (const bytes of [Buffer.from('[]'), Buffer.alloc(65537, 32), Buffer.from('[]\n\n')]) {
    await expect(
      (async () => {
        for await (const frame of decodeRecords(
          (async function* () {
            yield bytes;
          })(),
        ))
          void frame;
      })(),
    ).rejects.toThrow();
  }
});
it('derives the fixed model/family and invocation identity projections', () => {
  const model = resolveModel(modelVector, 'vectors-', 1);
  expect(model.id).toBe(modelId);
  expect(model.family).toBe(familyId);
  expect(H('model', modelVector)).toBe(modelId);
  expect(model.owner('repository/g/a')[0]).toBe('data');
  expect(() => model.owner('.mammoth/evil')).toThrow();
  expect(() => resolveModel(['model', 2, ...modelVector.slice(2)], '', 1)).toThrow();
  expect(invocationId(context, '0'.repeat(32))).toBe(
    H('invocation', ['invocation', 1, context, '0'.repeat(32)]),
  );
  expect(writerId(invocationId(context, '0'.repeat(32)), context)).not.toBe(
    lineageId('refs/heads/main'),
  );
});
describe('exact configured-order reduction vectors', () => {
  const rows = vectors
    .split('Each following row is')[1]
    .match(/```text\n([\s\S]*?)\n```/)![1]
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as [string, 'strict' | 'newer-mtime', string[], Candidate[], Value[]],
    );
  for (const [name, policy, order, candidates, expected] of rows)
    it(name, () => {
      if (expected[0] === 'error')
        expect(() => reduceOrdinary(candidates, order, policy)).toThrow('conflict');
      else expect(reduceOrdinary(candidates, order, policy)).toEqual(expected.slice(1));
    });
  it('deduplicates configuration stably and rejects duplicate actual contributors', () => {
    expect(ordinaryOrder(['B', 'A', 'B'])).toEqual(['B', 'A']);
    const c: Candidate = ['A', '0'.repeat(64), 0, 0, 420];
    expect(() => reduceOrdinary([c, c], ['A'], 'strict')).toThrow('Duplicate');
    expect(reduceOrdinary([c], ['B'], 'strict')).toBeNull();
  });
});

it.each(['.MAMMOTH/state', 'a/.mammoth/x', '.mammoth./x', 'a/.Mammoth /x'])(
  'preserves reserved-path exclusion for %s',
  (name) => {
    const model = resolveModel(
      [
        'model',
        1,
        'maven',
        ['.mammoth/**'],
        [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
      ],
      '',
      1,
    );
    expect(() => model.owner(name)).toThrow('Reserved');
    expect(pathSchema.safeParse(name).success).toBe(false);
  },
);
