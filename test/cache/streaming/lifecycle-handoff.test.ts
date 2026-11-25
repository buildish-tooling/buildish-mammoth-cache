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

import { policySchema } from '../../../src/cache/streaming/local-schema';
import { vectors } from './protocol-fixtures';
import { localOptions } from './local-fixtures';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { writeLocalStream, readLocalStream } from '../../../src/cache/streaming/local-stream';
import { afterEach, expect, it } from 'vitest';
import { installFixture } from './install-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import {
  LifecycleHandoff,
  checkHandoffGeneration,
  type HandoffEntry,
  type HandoffHeader,
} from '../../../src/cache/streaming/lifecycle-handoff';
import { createMetadataGeneration } from '../../../src/cache/streaming/metadata-base-records';
import {
  metadataSummaryProfile,
  emptyPartitionMetadata,
} from '../../../src/cache/streaming/partition-metadata';
import { encodeRecord, type Value } from '../../../src/cache/streaming/encoding';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
const rows = async function* (values: readonly Value[]) {
  yield* values;
};
async function fixture() {
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['data/**'], hard, 'aggregate', null, 'default', 0],
        ['state', ['state/**'], hard, 'single-writer', 'A', 'default', 0],
      ],
    ],
    'handoff-',
    1,
  );
  const f = await installFixture('maven', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const activity = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    rows([
      ['dir-open', ''],
      ['dir-close', ''],
    ]),
  );
  const header: HandoffHeader = [
    'handoff',
    4,
    'refs/heads/main',
    null,
    null,
    7,
    'enabled',
    null,
    null,
    f.store.codec.schemas.ref('activity').parse(activity),
    1234,
    0,
    null,
  ];
  const entries: HandoffEntry[] = model.partitions.map((p) => [
    'partition',
    p[0],
    'miss',
    null,
    null,
  ]);
  return {
    ...f,
    header,
    entries,
    write: (values: readonly Value[]) =>
      f.store.writeStream('handoff', { budget: f.budget, partition: null }, rows(values)),
  };
}
it('round-trips only bounded invocation handoff data with charged lifetime and strict ordered completeness', async () => {
  const f = await fixture(),
    reference = await f.write([f.header, ...f.entries]);
  const handoff = await LifecycleHandoff.read(f.store, reference, { budget: f.budget });
  try {
    expect(f.budget.retained).toBeGreaterThan(0);
    expect(handoff.header).toEqual(f.header);
    expect(handoff.entries).toEqual(f.entries);
    expect(Object.isFrozen(handoff.entries[0])).toBe(true);
    handoff.checkGeneration(f.store, null, policySchema.parse(f.bindings[8]));
  } finally {
    handoff.close();
  }
  expect(() => handoff.checkGeneration(f.store, null, policySchema.parse(f.bindings[8]))).toThrow(
    'Closed',
  );
  for (const values of [
    [f.header, f.entries[0]],
    [f.header, ...[...f.entries].reverse()],
    [f.header, ...f.entries, f.entries[0]],
    [f.header, ['file', 'data/a']],
  ])
    await expect(f.write(values)).rejects.toThrow();
});
it('binds declared-empty pins to exact v2 generation and invocation, rejecting miss and foreign provenance', async () => {
  const f = await fixture(),
    profile = metadataSummaryProfile(),
    generation = createMetadataGeneration(
      f.model,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      f.model.partitions.map((p) => ['empty', p[0]]),
      f.model.partitions.map((p) => [p[0]]),
    );
  const reference = await f.store.write('generation', rowsBytes(encodeRecord(generation)));
  f.header[8] = [generation[11], f.store.codec.schemas.ref('generation').parse(reference)];
  for (const entry of f.entries) {
    entry[2] = 'empty';
    entry[3] = [
      'pinned-partition-metadata',
      2,
      'local-v2',
      f.store.codec.options.invocation,
      f.model.family,
      f.model.id,
      entry[1],
      null,
      profile,
      emptyPartitionMetadata(profile),
    ];
  }
  const handoff = await LifecycleHandoff.read(f.store, await f.write([f.header, ...f.entries]), {
    budget: f.budget,
  });
  try {
    const different = createMetadataGeneration(
      f.model,
      'a'.repeat(64),
      'd'.repeat(64),
      'c'.repeat(64),
      generation[8],
      generation[9],
    );
    expect(() =>
      handoff.checkGeneration(f.store, different, policySchema.parse(f.bindings[8])),
    ).toThrow();
    handoff.checkGeneration(f.store, generation, policySchema.parse(f.bindings[8]));
    const cold = structuredClone(f.entries);
    cold[0][2] = 'cold';
    cold[0][3] = null;
    expect(() =>
      checkHandoffGeneration(
        f.store,
        f.header,
        cold,
        generation,
        policySchema.parse(f.bindings[8]),
      ),
    ).toThrow('Cold recovery group has no restorable object.');
    expect(() => handoff.checkGeneration(f.store, null, policySchema.parse(f.bindings[8]))).toThrow(
      'generation mismatch',
    );
  } finally {
    handoff.close();
  }
  f.entries[0][3]![3] = 'd'.repeat(64);
  await expect(f.write([f.header, ...f.entries])).rejects.toThrow('identity');
});
async function* rowsBytes(bytes: Buffer) {
  yield bytes;
}
it('matches independent H2 exact successful-main handoff bytes and whole-stream ref', async () => {
  const blocks = [...vectors.split('## H2:')[1].matchAll(/```text\n([\s\S]*?)\n```/g)],
    lines = blocks[0][1].split('\n').map((line) => JSON.parse(line) as Value),
    reference = lines.pop()!,
    expected = Buffer.concat(lines.map(encodeRecord)),
    budget = new WorkingBudget(),
    codec = new LocalCodec(localOptions()),
    options = { codec, budget, partition: null },
    encoded: Buffer[] = [];
  for await (const chunk of writeLocalStream(
    rows(lines.slice(1, -1)),
    'handoff',
    options,
    () => {},
  ))
    encoded.push(chunk);
  expect(Buffer.concat(encoded)).toEqual(expected);
  await expect(
    readLocalStream(
      (async function* () {
        yield expected;
      })(),
      'handoff',
      options,
      reference,
    ),
  ).resolves.toMatchObject({ bytes: expected.length });
  expect(budget.retained).toBe(0);
});
