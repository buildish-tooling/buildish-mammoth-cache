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

import type { Value } from '../../../src/cache/streaming/encoding';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodeRecord, rawSha } from '../../../src/cache/streaming/encoding';
import { resolveModel } from '../../../src/cache/streaming/model';
import { STREAMING_PROFILES } from '../../../src/cache/streaming/profiles';
import {
  objectKey,
  RecoveryGroups,
  type ObjectIdentity,
  type ObjectRef,
} from '../../../src/cache/streaming/native-records';
import {
  createMetadataDescriptor,
  decodeMetadataDescriptor,
  createMetadataGeneration,
  decodeMetadataGeneration,
} from '../../../src/cache/streaming/metadata-base-records';
import { modelVector, vectors } from './protocol-fixtures';
import {
  decodePinnedPartitionMetadata,
  emptyPartitionMetadata,
  metadataSummaryProfile,
  PartitionMetadataSummary,
} from '../../../src/cache/streaming/partition-metadata';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
const h = 'a'.repeat(64),
  familyId = 'mammoth-s1-maven-db28172d252fd67b0feb15f23ac18c39c38164039839912ff27f4d5da44be3ef';
const model = () => resolveModel(modelVector, 'vectors-', 1);
function object(partition = 'data') {
  const m = model(),
    identity: ObjectIdentity = [m.family, m.id, partition, h, h, h];
  return createMetadataDescriptor(m, identity);
}
function digest(domain: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)),
    size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return createHash('sha256')
    .update('mammoth:' + domain + ':1\0')
    .update(size)
    .update(bytes)
    .digest('hex');
}
it('activates one incompatible metadata family with the worker v2 grammar', () => {
  const old = resolveModel(modelVector, 'vectors-', 1),
    m = model();
  expect(old.family).not.toBe(familyId);
  expect(m.id).toBe(old.id);
  expect(m.family).toBe(old.family);
  expect(STREAMING_PROFILES.native).toBe('native-metadata-v2');
  expect(STREAMING_PROFILES.worker).toBe('worker-tar-v2');
  expect(m.family).toBe(
    'mammoth-s1-maven-' +
      digest('family', ['family', 1, 'vectors-', 1, m.id, ...Object.values(STREAMING_PROFILES)]),
  );
});
it('has exactly a bounded identity descriptor with reference binding, no payload assertions', () => {
  const m = model(),
    { descriptor, bytes, reference } = object();
  expect(descriptor).toEqual(['base-object', 2, 'native-metadata-v2', reference[1]]);
  expect(bytes).toEqual(Buffer.from(JSON.stringify(descriptor) + '\n'));
  expect(reference).toEqual([
    'object-ref',
    descriptor[3],
    objectKey(descriptor[3]),
    bytes.length,
    rawSha(bytes),
  ]);
  expect(decodeMetadataDescriptor(bytes, reference, m)).toEqual(descriptor);
  expect(() =>
    decodeMetadataDescriptor(Buffer.concat([bytes, Buffer.from(' ')]), reference, m),
  ).toThrow('reference');
  const appended = encodeRecord([...descriptor, ['file', 'secret', h]]);
  expect(() =>
    decodeMetadataDescriptor(
      appended,
      [...reference.slice(0, 3), appended.length, rawSha(appended)] as ObjectRef,
      m,
    ),
  ).toThrow();
  expect(() =>
    decodeMetadataDescriptor(bytes, reference, resolveModel(modelVector, 'other-', 1)),
  ).toThrow();
  const other = structuredClone(descriptor);
  other[3][3] = 'b'.repeat(64);
  const changed = encodeRecord(other);
  expect(() =>
    decodeMetadataDescriptor(
      changed,
      [...reference.slice(0, 3), changed.length, rawSha(changed)] as ObjectRef,
      m,
    ),
  ).toThrow('identity');
});
it('binds generation-v3 ordered refs/empties and groups using an independent decision oracle', () => {
  const m = model(),
    r = object().reference;
  const entries: [['object', string, ObjectRef], ['empty', string]] = [
    ['object', 'data', r],
    ['empty', 'metadata'],
  ];
  const groups = [['data'], ['metadata']];
  const g = createMetadataGeneration(m, h, 'b'.repeat(64), h, entries, groups);
  const expected = digest('partition-decisions', [
    'partition-decisions',
    3,
    m.family,
    m.id,
    h,
    'b'.repeat(64),
    h,
    entries,
    groups,
    null,
  ]);
  expect(g[10]).toBe(expected);
  expect(g[11]).toBe(m.family + '-r-' + h + '-g-' + 'b'.repeat(64) + '-d-' + expected);
  expect(decodeMetadataGeneration(encodeRecord(g), m, g[11])).toEqual(g);
  expect(g[8][0]).toEqual(['object', 'data', r]);
  expect(() => decodeMetadataGeneration(encodeRecord(g), m, 'wrong')).toThrow('pinned');
  const v1: Value[] = [...g];
  v1[1] = 1;
  v1[2] = 'generation-v1';
  expect(() => decodeMetadataGeneration(encodeRecord(v1), m)).toThrow();
  const old = { family: familyId, id: m.id };
  const oldIdentity: ObjectIdentity = [old.family, old.id, 'data', h, h, h];
  const oldRef: ObjectRef = ['object-ref', oldIdentity, objectKey(oldIdentity), 100, h];
  expect(() =>
    createMetadataGeneration(
      m,
      h,
      h,
      h,
      [
        ['object', 'data', oldRef],
        ['empty', 'metadata'],
      ],
      groups,
    ),
  ).toThrow('identity');
});
it.each(['partition-order', 'groups', 'decision', 'key', 'profile', 'version'])(
  'rejects invalid v3 generation %s',
  (kind) => {
    const m = model(),
      g: unknown[] = createMetadataGeneration(
        m,
        h,
        h,
        h,
        [
          ['empty', 'data'],
          ['empty', 'metadata'],
        ],
        [['data'], ['metadata']],
      );
    if (kind === 'partition-order')
      g[8] = [
        ['empty', 'metadata'],
        ['empty', 'data'],
      ];
    if (kind === 'groups') g[9] = [['data'], ['data']];
    if (kind === 'decision') g[10] = 'b'.repeat(64);
    if (kind === 'key') g[11] = 'bad';
    if (kind === 'profile') g[2] = 'generation-v1';
    if (kind === 'version') g[1] = 1;
    expect(() => decodeMetadataGeneration(Buffer.from(JSON.stringify(g) + '\n'), m)).toThrow();
  },
);
it('retains bounded observed connectivity and cold-group semantics without a member catalogue', () => {
  const m = model(),
    groups = new RecoveryGroups(m);
  groups.observe(['data', 'metadata']);
  expect(groups.check([['data', 'metadata']], new Set(['data']))).toEqual([['data', 'metadata']]);
  expect(() => groups.check([['data'], ['metadata']])).toThrow('crosses');
  expect(() =>
    new RecoveryGroups(m).check([['data', 'metadata']], new Set(['data', 'metadata'])),
  ).toThrow('Invented');
});
it('keeps a 64 maximum-width partition generation within the control bound', () => {
  const ids = Array.from({ length: 64 }, (_, i) => String(i).padStart(2, '0') + 'a'.repeat(62));
  const m = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      ids.map((id) => [id, [id + '/**'], ['.mammoth/**'], 'aggregate', null, 'default', 0]),
    ],
    'max-',
    1,
  );
  const g = createMetadataGeneration(
    m,
    h,
    h,
    h,
    ids.map((id) => {
      const identity: ObjectIdentity = [m.family, m.id, id, h, h, h];
      return ['object', id, createMetadataDescriptor(m, identity).reference];
    }),
    ids.map((id) => [id]),
  );
  expect(encodeRecord(g).length).toBeLessThanOrEqual(65536);
  expect(decodeMetadataGeneration(encodeRecord(g), m)).toEqual(g);
  expect(() => decodeMetadataGeneration(Buffer.alloc(65537, 32), m)).toThrow();
});
it('matches the published M2 descriptor, generation, metadata and pinned-summary vectors', () => {
  const blocks = [...vectors.split('## M2:')[1].matchAll(/```text\n([\s\S]*?)\n```/g)].map(
    (match) => match[1].split('\n'),
  );
  const m = model(),
    object = createMetadataDescriptor(m, [m.family, m.id, 'data', h, h, h]);
  expect(m.family).toBe(blocks[0][0]);
  expect(object.bytes.toString()).toBe(blocks[1][0] + '\n');
  expect(object.bytes.length).toBe(400);
  expect(object.reference).toEqual(JSON.parse(blocks[1][1]));
  const generation = createMetadataGeneration(
    m,
    h,
    h,
    h,
    [
      ['object', 'data', object.reference],
      ['empty', 'metadata'],
    ],
    [['data'], ['metadata']],
  );
  expect(encodeRecord(generation).toString()).toBe(blocks[2][0] + '\n');
  const budget = new WorkingBudget(),
    summary = new PartitionMetadataSummary(m, 'data', budget, metadataSummaryProfile('linux'));
  const directory = ['native', 1, 'directory', '1', '2', '0', 493, '0', '0', '0', null] as const;
  const file = ['native', 1, 'file', '1', '3', '3', 420, '0', '1000000000', '0', null] as const;
  summary.accept(['dir-open', '', [...directory]]);
  summary.accept(['dir-open', 'repository', [...directory]]);
  summary.accept(['file', 'repository/a.jar', [...file]]);
  summary.accept(['dir-close', 'repository', [...directory]]);
  summary.accept(['dir-close', '', [...directory]]);
  const expected = summary.finish();
  summary.dispose();
  expect(expected).toEqual(JSON.parse(blocks[3][3]));
  expect(budget.retained).toBe(0);
  const pin = decodePinnedPartitionMetadata(Buffer.from(blocks[4][0] + '\n'), m, h, [
    'object',
    'data',
    object.reference,
  ]);
  expect(pin[9]).toEqual(expected);
  pin[7] = null;
  expect(() => decodePinnedPartitionMetadata(encodeRecord(pin), m, h, ['empty', 'data'])).toThrow(
    'declared-empty',
  );
  pin[9] = emptyPartitionMetadata(pin[8]);
  expect(decodePinnedPartitionMetadata(encodeRecord(pin), m, h, ['empty', 'data'])).toEqual(pin);
});

it('rejects a genuine prior worker-profile family even when its native descriptor shape is unchanged', () => {
  const m = model(),
    priorProjection = [...m.familyProjection];
  priorProjection[5] = 'worker-tar-v1';
  const priorFamily = 'mammoth-s1-maven-' + digest('family', priorProjection),
    identity: ObjectIdentity = [priorFamily, m.id, 'data', h, h, h];
  expect(priorFamily).not.toBe(m.family);
  const bytes = encodeRecord(['base-object', 2, 'native-metadata-v2', identity]),
    reference: ObjectRef = [
      'object-ref',
      identity,
      objectKey(identity),
      bytes.length,
      rawSha(bytes),
    ];
  expect(() => decodeMetadataDescriptor(bytes, reference, m)).toThrow();
});

it.each(['gradle', 'maven'] as const)(
  'round trips generation-v3 and binds reserved sweep state for %s',
  (tool) => {
    const m = resolveModel(['model', 1, tool, ...modelVector.slice(3)], 'v3-', 1);
    const g = createMetadataGeneration(
      m,
      h,
      h,
      h,
      [
        ['empty', 'data'],
        ['empty', 'metadata'],
      ],
      [['data'], ['metadata']],
    );
    expect(g).toHaveLength(13);
    expect(g.slice(0, 3)).toEqual(['generation', 3, 'generation-v3']);
    expect(g[12]).toBeNull();
    expect(decodeMetadataGeneration(encodeRecord(g), m, g[11])).toEqual(g);
    const changed = structuredClone(g);
    changed[12] = 1700000000000;
    expect(() => decodeMetadataGeneration(encodeRecord(changed), m)).toThrow('decision/key');
    changed[10] = digest('partition-decisions', [
      'partition-decisions',
      3,
      ...changed.slice(3, 10),
      changed[12],
    ]);
    changed[11] = m.family + '-r-' + h + '-g-' + h + '-d-' + changed[10];
    expect(decodeMetadataGeneration(encodeRecord(changed), m)[12]).toBe(1700000000000);
    const prior = [...g.slice(0, 12)];
    prior[1] = 2;
    prior[2] = 'generation-v2';
    expect(() => decodeMetadataGeneration(encodeRecord(prior), m)).toThrow();
  },
);
