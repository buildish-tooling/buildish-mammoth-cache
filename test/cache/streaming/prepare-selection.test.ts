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

import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  LocalStreamGrammar,
  writeLocalStream,
  readLocalStream,
} from '../../../src/cache/streaming/local-stream';
import { handoffSchemas } from '../../../src/cache/streaming/lifecycle-handoff';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { encodeRecord, rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, directory } from './local-fixtures';
function fixture() {
  const f = localFixtures(),
    budget = new WorkingBudget(),
    rows: Value[] = [
      [
        'handoff',
        2,
        'refs/heads/main',
        null,
        null,
        7,
        'enabled',
        null,
        null,
        f.q('activity'),
        42,
        0,
      ],
      ...f.options.model.partitions.map((p) => ['partition', p[0], 'miss', null, null] as Value),
    ];
  return { ...f, budget, rows, options: { codec: f.codec, budget, partition: null } };
}
async function* records(rows: Value[]) {
  yield* rows;
}
async function encode(f: ReturnType<typeof fixture>, rows = f.rows) {
  const chunks = [];
  for await (const chunk of writeLocalStream(records(rows), 'handoff', f.options, () => {}))
    chunks.push(chunk);
  return Buffer.concat(chunks);
}
it('matches compact v2 handoff framing and hash through an independent oracle', async () => {
  const f = fixture(),
    header: Value = [
      'local-stream',
      1,
      'handoff',
      f.options.codec.options.invocation,
      f.options.codec.options.model.id,
      f.options.codec.options.model.family,
      null,
    ],
    hash = createHash('sha256').update('mammoth:local-handoff:1\0');
  for (const row of [header, ...f.rows]) {
    const bytes = Buffer.from(JSON.stringify(row)),
      size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size).update(bytes);
  }
  const end: Value = ['local-end', f.rows.length, hash.digest('hex')],
    expected = Buffer.concat([header, ...f.rows, end].map(encodeRecord)),
    bytes = await encode(f);
  expect(bytes).toEqual(expected);
  expect(
    await readLocalStream(
      (async function* () {
        yield bytes;
      })(),
      'handoff',
      f.options,
      ['ref', 'handoff', f.prefix + 'handoff', bytes.length, rawSha(bytes)],
    ),
  ).toMatchObject({ bytes: bytes.length, records: f.rows.length });
  expect(f.budget.retained).toBe(0);
});
it.each([
  'missing',
  'duplicate',
  'order',
  'old-version',
  'extra-header',
  'same-lineage',
  'invalid-outcome',
  'pinless-available',
] as const)('rejects malformed compact handoff %s', async (kind) => {
  const f = fixture(),
    rows = structuredClone(f.rows);
  if (kind === 'missing') rows.pop();
  if (kind === 'duplicate') rows.push(rows[1]);
  if (kind === 'order') [rows[1], rows[2]] = [rows[2], rows[1]];
  if (kind === 'old-version') (rows[0] as Value[])[1] = 1;
  if (kind === 'extra-header') (rows[0] as Value[]).push(null);
  if (kind === 'same-lineage') (rows[0] as Value[])[3] = (rows[0] as Value[])[2];
  if (kind === 'invalid-outcome') (rows[1] as Value[])[2] = 'pending';
  if (kind === 'pinless-available') (rows[1] as Value[])[2] = 'available';
  await expect(encode(f, rows)).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('validates snapshot descriptor data separately from executable native ownership', () => {
  const f = fixture(),
    schema = handoffSchemas(f.codec),
    root = f.prefix + 'snapshots/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/metadata',
    snapshot: Value[] = ['snapshot', root, directory, directory, ['base', null]];
  expect(schema.snapshot.parse(snapshot)).toEqual(snapshot);
  for (const path of [
    f.prefix + 'install/metadata',
    f.prefix + 'snapshots/metadata',
    f.prefix + 'snapshots/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/foreign',
  ]) {
    const bad = [...snapshot];
    bad[1] = path;
    expect(() => schema.snapshot.parse(bad)).toThrow();
  }
  const bad = structuredClone(snapshot);
  bad[4] = ['local', 'b'.repeat(64)];
  expect(() => schema.snapshot.parse(bad)).toThrow();
  const grammar = new LocalStreamGrammar('handoff', f.options);
  try {
    expect(() => grammar.accept(['prepare-selection', 1, 'refs/heads/main'])).toThrow();
  } finally {
    grammar.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
