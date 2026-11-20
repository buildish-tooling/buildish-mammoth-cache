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
import {
  checkPublicationBindings,
  checkPublicationChoice,
  checkObjectReceipt,
  PinnedBaseline,
} from '../../../src/cache/streaming/local-bindings';
import { policyId } from '../../../src/cache/streaming/local-schema';
import {
  createGeneration,
  objectKey,
  type ObjectIdentity,
} from '../../../src/cache/streaming/native-records';
import { writerId, decisionId } from '../../../src/cache/streaming/model';
import { encodeRecord, rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, h } from './local-fixtures';
function fixture() {
  const f = localFixtures(),
    b = f.codec.schemas.documents.bindings.parse(f.bindings),
    d = structuredClone(f.publication[3]) as Value[];
  d[5] = policyId(b[8]);
  const decision = decisionId(d),
    writer = writerId(f.options.invocation, f.options.context),
    identity: ObjectIdentity = [
      f.options.model.family,
      f.options.model.id,
      'data',
      h,
      writer,
      decision,
    ];
  const envelope = f.q('envelope'),
    choice: Value = [
      'new',
      'data',
      identity,
      objectKey(identity),
      envelope,
      f.q('native-tree'),
      f.q('move-plan'),
    ];
  const generation = createGeneration(
    f.options.model,
    h,
    writer,
    decision,
    [
      ['object', 'data', ['object-ref', identity, objectKey(identity), 100, h]],
      ['empty', 'metadata'],
    ],
    [['data'], ['metadata']],
  );
  const generationBytes = encodeRecord(generation),
    publication = structuredClone(f.publication);
  publication[3] = d;
  publication[4] = decision;
  publication[7] = [
    'ref',
    'generation',
    f.prefix + 'record.json',
    generationBytes.length,
    rawSha(generationBytes),
  ];
  publication[8] = generation[11];
  const pbytes = f.codec.encode(publication),
    state = structuredClone(f.state);
  state[4] = 'objects-frozen';
  state[6] = f.q('observations');
  state[7] = f.q('post-sources');
  state[8] = ['ref', 'publication', f.prefix + 'publication.json', pbytes.length, rawSha(pbytes)];
  state[9] = f.q('partition-state');
  state[10] = f.q('gc-progress');
  return { ...f, publication, state, generation, generationBytes, choice, identity };
}
it('binds publication decision to frozen state, policy, source and generation refs', () => {
  const f = fixture();
  expect(
    checkPublicationBindings(f.codec, f.state, f.bindings, f.publication, f.generationBytes),
  ).toEqual(f.generation);
  expect(() =>
    checkPublicationChoice(f.codec, f.choice, f.publication, f.generation),
  ).not.toThrow();
  expect(() =>
    checkPublicationChoice(f.codec, ['empty', 'metadata'], f.publication, f.generation),
  ).not.toThrow();
  const receipt: Value = [
    'object-receipt',
    1,
    'data',
    objectKey(f.identity),
    h,
    f.identity[5],
    ['readback', objectKey(f.identity)],
  ];
  expect(() => checkObjectReceipt(f.codec, receipt, f.choice)).not.toThrow();
  (receipt as Value[])[4] = 'b'.repeat(64);
  expect(() => checkObjectReceipt(f.codec, receipt, f.choice)).toThrow('receipt');
});
it.each(['policy', 'observation', 'source', 'generation', 'choice', 'new-identity'])(
  'rejects inconsistent immutable %s bindings',
  (kind) => {
    const f = fixture();
    if (kind === 'policy') {
      const b = structuredClone(f.bindings);
      (b[8] as Value[])[10] = ['A'];
      const bytes = f.codec.encode(b);
      f.state[5] = ['ref', 'bindings', f.prefix + 'newbindings.json', bytes.length, rawSha(bytes)];
      expect(() =>
        checkPublicationBindings(f.codec, f.state, b, f.publication, f.generationBytes),
      ).toThrow('decision');
      return;
    }
    if (kind === 'observation') f.state[6] = f.q('observations', 'b'.repeat(64));
    if (kind === 'source') f.state[7] = f.q('post-sources', 'b'.repeat(64));
    if (kind === 'generation') f.generationBytes[10] ^= 1;
    if (kind === 'choice') {
      expect(() =>
        checkPublicationChoice(f.codec, ['empty', 'data'], f.publication, f.generation),
      ).toThrow('choice');
      return;
    }
    if (kind === 'new-identity') {
      const choice = structuredClone(f.choice) as Value[];
      (choice[2] as Value[])[5] = 'b'.repeat(64);
      choice[3] = objectKey(choice[2] as ObjectIdentity);
      expect(() => checkPublicationChoice(f.codec, choice, f.publication, f.generation)).toThrow(
        'publisher/decision',
      );
      return;
    }
    expect(() =>
      checkPublicationBindings(f.codec, f.state, f.bindings, f.publication, f.generationBytes),
    ).toThrow();
  },
);

it('requires new-object lineage and exact pinned baseline provenance for reuse', () => {
  const f = fixture(),
    row = structuredClone(f.choice) as Value[];
  (row[2] as Value[])[3] = 'b'.repeat(64);
  row[3] = objectKey(row[2] as ObjectIdentity);
  expect(() => checkPublicationChoice(f.codec, row, f.publication, f.generation)).toThrow(
    'publisher/decision',
  );
  const entry = f.generation[8][0];
  if (entry[0] !== 'object') throw Error('fixture');
  const reuse: Value = ['reuse', 'data', entry[2]];
  expect(() => checkPublicationChoice(f.codec, reuse, f.publication, f.generation)).toThrow(
    'pinned reuse',
  );
  const bindings = structuredClone(f.bindings);
  bindings[9] = [
    'baseline',
    f.generation[11],
    [
      'ref',
      'generation',
      f.prefix + 'baseline.json',
      f.generationBytes.length,
      rawSha(f.generationBytes),
    ],
  ];
  const baseline = PinnedBaseline.decode(f.codec, bindings, f.generationBytes);
  (f.publication[3] as Value[])[7] = f.generation[11];
  f.publication[4] = decisionId(f.publication[3]);
  const candidate = createGeneration(
    f.options.model,
    h,
    writerId(f.options.invocation, f.options.context),
    String(f.publication[4]),
    f.generation[8],
    f.generation[9],
  );
  expect(() =>
    checkPublicationChoice(f.codec, reuse, f.publication, candidate, baseline),
  ).not.toThrow();
  const empty = createGeneration(
      f.options.model,
      h,
      h,
      h,
      [
        ['empty', 'data'],
        ['empty', 'metadata'],
      ],
      [['data'], ['metadata']],
    ),
    bytes = encodeRecord(empty);
  bindings[9] = [
    'baseline',
    empty[11],
    ['ref', 'generation', f.prefix + 'empty.json', bytes.length, rawSha(bytes)],
  ];
  const other = PinnedBaseline.decode(f.codec, bindings, bytes);
  expect(() => checkPublicationChoice(f.codec, reuse, f.publication, candidate, other)).toThrow(
    'pinned baseline decision key',
  );
});

it('rejects a changed reuse ref even when its candidate generation agrees', () => {
  const f = fixture(),
    bindings = structuredClone(f.bindings);
  bindings[9] = [
    'baseline',
    f.generation[11],
    [
      'ref',
      'generation',
      f.prefix + 'baseline.json',
      f.generationBytes.length,
      rawSha(f.generationBytes),
    ],
  ];
  const baseline = PinnedBaseline.decode(f.codec, bindings, f.generationBytes);
  (f.publication[3] as Value[])[7] = f.generation[11];
  f.publication[4] = decisionId(f.publication[3]);
  const entry = f.generation[8][0];
  if (entry[0] !== 'object') throw Error('fixture');
  const changed = structuredClone(entry[2]);
  changed[4] = 'b'.repeat(64);
  const candidate = createGeneration(
    f.options.model,
    h,
    writerId(f.options.invocation, f.options.context),
    String(f.publication[4]),
    [
      ['object', 'data', changed],
      ['empty', 'metadata'],
    ],
    [['data'], ['metadata']],
  );
  expect(() =>
    checkPublicationChoice(f.codec, ['reuse', 'data', changed], f.publication, candidate, baseline),
  ).toThrow('pinned reused object');
});
