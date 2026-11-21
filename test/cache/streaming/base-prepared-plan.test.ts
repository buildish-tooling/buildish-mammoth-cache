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
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import {
  readLocalStream,
  writeLocalStream,
  type LocalStreamSeal,
} from '../../../src/cache/streaming/local-stream';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { localOptions } from './local-fixtures';
import type { Value } from '../../../src/cache/streaming/encoding';
const section = readFileSync('docs/dev/cache-protocol-vectors.md', 'utf8').split('## L0:')[1],
  bytes = Buffer.from(section.match(/```text\n([\s\S]*?)\n```/)![1] + '\n'),
  rows = bytes
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Value),
  hash = section.match(/raw SHA-256: `([a-f0-9]{64})`/)![1];
const codec = new LocalCodec(localOptions()),
  budget = new WorkingBudget(),
  options = { codec, budget, partition: 'metadata', moveMode: 'prepared' as const };
async function write(values: Value[], prepared = true) {
  const chunks: Buffer[] = [];
  let seal: LocalStreamSeal | undefined;
  for await (const chunk of writeLocalStream(
    (async function* () {
      yield* values;
    })(),
    'move-plan',
    { ...options, moveMode: prepared ? 'prepared' : 'transfer' },
    (s) => {
      seal = s;
    },
  ))
    chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), seal: seal! };
}
it('matches independent normative prepared-plan bytes/digests and one-record seal', async () => {
  const out = await write([rows[1]]);
  expect(out.bytes).toEqual(bytes);
  expect(out.seal.records).toBe(1);
  expect(out.seal.sha).toBe(hash);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  const ref = [
    'ref',
    'move-plan',
    codec.schemas.prefix + 'files/plan',
    bytes.length,
    hash,
  ] as const;
  const seal = await readLocalStream(
    (async function* () {
      yield bytes;
    })(),
    'move-plan',
    options,
    ref,
  );
  expect(seal.records).toBe(1);
  expect(budget.retained).toBe(0);
});
it.each(
  [
    [],
    [rows[1], rows[1]],
    [rows[1], ['move-unit-open', 'file', 'x', 'file']],
    [['move-unit-open', 'file', 'x', 'file'], rows[1]],
  ].map((values) => ({ values })),
)('rejects missing/duplicate/mixed prepared rows: %j', async ({ values }) => {
  await expect(write(values as Value[])).rejects.toThrow();
  expect(budget.retained).toBe(0);
});
it('default transfer readers/writers cannot treat a prepared row as a completed empty move plan', async () => {
  await expect(write([rows[1]], false)).rejects.toThrow('not a relocation');
  const ref = [
    'ref',
    'move-plan',
    codec.schemas.prefix + 'files/plan',
    bytes.length,
    hash,
  ] as const;
  await expect(
    readLocalStream(
      (async function* () {
        yield bytes;
      })(),
      'move-plan',
      { ...options, moveMode: 'transfer' },
      ref,
    ),
  ).rejects.toThrow('not a relocation');
});
