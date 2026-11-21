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

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { readLocalStream, writeLocalStream } from '../../../src/cache/streaming/local-stream';
import { Digest, type Value } from '../../../src/cache/streaming/encoding';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { localOptions } from './local-fixtures';
const section = readFileSync('docs/dev/cache-protocol-vectors.md', 'utf8').split('## L1:')[1],
  blocks = [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map((x) => Buffer.from(x[1] + '\n')),
  rows = blocks[1]
    .toString()
    .trimEnd()
    .split('\n')
    .map((s) => JSON.parse(s) as Value[]),
  codec = new LocalCodec(localOptions()),
  budget = new WorkingBudget(),
  opts = { codec, budget, partition: null, gcMode: 'shared' as const },
  reference = [
    'ref',
    'gc-evidence',
    codec.schemas.prefix + 'files/gc',
    blocks[1].length,
    section.match(/GC raw SHA-256: `([a-f0-9]{64})`/)![1],
  ] as const;
const source = (values: Value[]) =>
  (async function* () {
    yield* values;
  })();
async function write(values: Value[], shared = true) {
  const chunks: Buffer[] = [];
  for await (const b of writeLocalStream(
    source(values),
    'gc-evidence',
    {
      ...opts,
      gcMode: shared ? 'shared' : 'inline',
    },
    () => {},
  ))
    chunks.push(b);
  return Buffer.concat(chunks);
}
it('matches independently encoded observation/shared GC bytes, unit seal and raw digests', async () => {
  expect(await write(rows.slice(1, -1))).toEqual(blocks[1]);
  await readLocalStream(
    (async function* () {
      yield blocks[1];
    })(),
    'gc-evidence',
    opts,
    reference,
  );
  const context = rows[1][1] as Value[];
  await readLocalStream(
    (async function* () {
      yield blocks[0];
    })(),
    'observations',
    { codec, budget, partition: null },
    context,
  );
  expect(budget.retained).toBe(0);
});
it('default inline readers cannot interpret shared evidence and empty shared streams need context', async () => {
  await expect(write(rows.slice(1, -1), false)).rejects.toThrow();
  await expect(
    readLocalStream(
      (async function* () {
        yield blocks[1];
      })(),
      'gc-evidence',
      { ...opts, gcMode: 'inline' },
      reference,
    ),
  ).rejects.toThrow();
  await expect(write([])).rejects.toThrow('context');
  expect((await write([rows[1]])).length).toBeGreaterThan(0);
  expect(budget.retained).toBe(0);
});
it.each([
  'context',
  'duplicate',
  'foreign',
  'parent',
  'missing',
  'inline',
  'target',
  'seal',
] as const)('rejects %s mismatches with no retained working state', async (what) => {
  const r = structuredClone(rows.slice(1, -1));
  if (what === 'context') r.shift();
  if (what === 'duplicate') r.splice(1, 0, r[0]);
  if (what === 'foreign') (r[2][2] as Value[])[1] = 'b'.repeat(64);
  if (what === 'parent') r[2][1] = 'wrong';
  if (what === 'missing') r.splice(2, 1);
  if (what === 'inline')
    r[2] = [
      'directory',
      'metadata',
      (r[3][3] as Value[]).map((x, i) => (i === 2 ? 'directory' : x)),
    ];
  if (what === 'target') r[3][1] = 'metadata/b';
  // Recompute seals so a stale digest cannot conceal failed structural validation.
  const open = r.findIndex((v) => v[0] === 'gc-unit-open'),
    close = r.findIndex((v) => v[0] === 'gc-unit-close');
  if (open >= 0 && close > open)
    r[close][3] =
      what === 'seal'
        ? 'f'.repeat(64)
        : r
            .slice(open, close)
            .reduce((d, v) => d.update(v), new Digest('gc-unit'))
            .digest();
  await expect(write(r)).rejects.toThrow();
  expect(budget.retained).toBe(0);
});
it('does not admit a GC mode on unrelated streams', async () => {
  const work = async () => {
    for await (const b of writeLocalStream(source([]), 'activity', opts, () => {}))
      expect(b).toBeUndefined();
  };
  await expect(work()).rejects.toThrow('GC mode');
  expect(budget.retained).toBe(0);
});
