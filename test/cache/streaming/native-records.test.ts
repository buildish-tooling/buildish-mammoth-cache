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
import { encodeRecord, rawSha } from '../../../src/cache/streaming/encoding';
import { resolveModel } from '../../../src/cache/streaming/model';
import {
  objectKey,
  RecoveryGroups,
  type ObjectIdentity,
  type ObjectRef,
} from '../../../src/cache/streaming/native-records';
import {
  createMetadataGeneration as createGeneration,
  decodeMetadataGeneration as decodeGeneration,
  createMetadataDescriptor,
  decodeMetadataDescriptor,
} from '../../../src/cache/streaming/metadata-base-records';
import { modelVector } from './protocol-fixtures';
const model = () => resolveModel(modelVector, 'vectors-', 1);
const h = 'a'.repeat(64);
function identity(partition = 'data'): ObjectIdentity {
  const m = model();
  return [m.family, m.id, partition, h, h, h];
}
function ref(partition = 'data'): ObjectRef {
  const i = identity(partition);
  return ['object-ref', i, objectKey(i), 65536, h];
}
function independentlyHash(domain: string, value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value)),
    size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return createHash('sha256')
    .update('mammoth:' + domain + ':1\0')
    .update(size)
    .update(bytes)
    .digest('hex');
}
it('derives generation bytes/key using an independent single-frame oracle', () => {
  const m = model(),
    entries: ['empty', string][] = [
      ['empty', 'data'],
      ['empty', 'metadata'],
    ],
    groups = [['data'], ['metadata']];
  const g = createGeneration(m, h, h, h, entries, groups);
  const sha = independentlyHash('partition-decisions', [
    'partition-decisions',
    3,
    m.family,
    m.id,
    h,
    h,
    h,
    entries,
    groups,
    null,
  ]);
  const key = m.family + '-r-' + h + '-g-' + h + '-d-' + sha;
  expect(encodeRecord(g)).toEqual(
    Buffer.from(
      JSON.stringify([
        'generation',
        3,
        'generation-v3',
        m.family,
        m.id,
        h,
        h,
        h,
        entries,
        groups,
        sha,
        key,
        null,
      ]) + '\n',
    ),
  );
  expect(decodeGeneration(encodeRecord(g), m, key)).toEqual(g);
  expect(() => decodeGeneration(encodeRecord(g), m, 'wrong')).toThrow('pinned');
});
it('preserves inherited identity rather than relabeling it to the generation writer', () => {
  const m = model(),
    r = ref();
  const g = createGeneration(
    m,
    'b'.repeat(64),
    'c'.repeat(64),
    'd'.repeat(64),
    [
      ['object', 'data', r],
      ['empty', 'metadata'],
    ],
    [['data'], ['metadata']],
  );
  expect(decodeGeneration(encodeRecord(g), m)[8][0]).toEqual(['object', 'data', r]);
  expect(() =>
    createGeneration(
      m,
      h,
      h,
      h,
      [
        ['object', 'metadata', r],
        ['empty', 'data'],
      ],
      [['data'], ['metadata']],
    ),
  ).toThrow();
});
it('checks exact descriptor bytes and independent identity without payload assertions', () => {
  const m = model(),
    built = createMetadataDescriptor(m, identity());
  expect(decodeMetadataDescriptor(built.bytes, built.reference, m)).toEqual(built.descriptor);
  expect(() =>
    decodeMetadataDescriptor(Buffer.concat([built.bytes, Buffer.from(' ')]), built.reference, m),
  ).toThrow('reference');
  const bad = encodeRecord([
    'envelope',
    1,
    'native-tree-v1',
    identity(),
    'partition-projection',
    100,
    h,
    [0, 1, 0, 0, 0],
    h,
  ]);
  expect(() =>
    decodeMetadataDescriptor(
      bad,
      ['object-ref', identity(), objectKey(identity()), bad.length, rawSha(bad)],
      m,
    ),
  ).toThrow();
});
it('checks transitive model-bounded groups and partial availability', () => {
  const m = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      ['a', 'b', 'c', 'd'].map((id) => [
        id,
        [id + '/**'],
        ['.mammoth/**'],
        'aggregate',
        null,
        'default',
        0,
      ]),
    ],
    'groups-',
    1,
  );
  const groups = new RecoveryGroups(m);
  groups.observe(['a', 'b']);
  groups.observe(['b', 'c']);
  expect(groups.groups()).toEqual([['a', 'b', 'c'], ['d']]);
  expect(groups.check([['a', 'b', 'c'], ['d']], new Set(['a', 'c', 'd']))).toEqual([
    ['a', 'b', 'c'],
  ]);
  expect(() => groups.check([['a', 'b'], ['c'], ['d']])).toThrow('crosses');
  expect(() => groups.check([['a', 'b', 'c', 'd']], new Set(['a', 'b', 'c', 'd']))).toThrow(
    'Invented',
  );
  expect(() => groups.check([['b', 'a', 'c'], ['d']])).toThrow('order');
  expect(() => groups.check([['a', 'b', 'c'], ['c']])).toThrow('duplicate');
});
it('keeps the documented 64 maximum-width partition fixture at 65,388 bytes', () => {
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
  const g = createGeneration(
    m,
    h,
    h,
    h,
    ids.map((id) => {
      const i: ObjectIdentity = [m.family, m.id, id, h, h, h];
      return ['object', id, ['object-ref', i, objectKey(i), 65536, h]];
    }),
    ids.map((id) => [id]),
  );
  expect(encodeRecord(g).length).toBe(65388);
  expect(decodeGeneration(encodeRecord(g), m)).toEqual(g);
  expect(() => decodeGeneration(Buffer.alloc(65537, 32), m)).toThrow();
});
it.each(['version', 'decision', 'key', 'missing', 'duplicate', 'object-key'])(
  'rejects malformed generation %s',
  (kind) => {
    const m = model(),
      g = createGeneration(
        m,
        h,
        h,
        h,
        [
          ['object', 'data', ref()],
          ['empty', 'metadata'],
        ],
        [['data'], ['metadata']],
      );
    const bad = structuredClone(g) as unknown[];
    if (kind === 'version') {
      bad[1] = 1;
    }
    if (kind === 'decision') {
      bad[10] = 'b'.repeat(64);
    }
    if (kind === 'key') {
      bad[11] = 'bad';
    }
    if (kind === 'missing') {
      bad[8] = [['empty', 'data']];
    }
    if (kind === 'duplicate') {
      bad[9] = [['data'], ['data']];
    }
    if (kind === 'object-key') {
      ((bad[8] as unknown[][])[0][2] as unknown[])[2] = 'bad';
    }
    expect(() => decodeGeneration(Buffer.from(JSON.stringify(bad) + '\n'), m)).toThrow();
  },
);
