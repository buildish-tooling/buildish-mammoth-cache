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
  LocalCodec,
  nativeIdentitySchema,
  nativePathSchema,
  policyId,
} from '../../../src/cache/streaming/local-schema';
import { rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, localOptions, native, h } from './local-fixtures';
it('matches canonical local identity bytes without losing native precision', () => {
  const f = localFixtures(),
    literal =
      '["gradle-installation",1,"' +
      f.options.invocation +
      '","/gradle","8.10","/cache","/java"]\n';
  const row: Value = [
    'gradle-installation',
    1,
    f.options.invocation,
    '/gradle',
    '8.10',
    '/cache',
    '/java',
  ];
  expect(f.codec.encode(row)).toEqual(Buffer.from(literal));
  expect(f.codec.decode(Buffer.from(literal))).toEqual(row);
  const precise = [...native];
  precise[3] = '18446744073709551615' as (typeof precise)[3];
  expect(nativeIdentitySchema.parse(precise)[3]).toBe('18446744073709551615');
});
it.each(['00', '-0', '01', '1.0', '-1'])(
  'rejects noncanonical unsigned native value %s',
  (value) => {
    const n = [...native];
    n[3] = value as (typeof n)[3];
    expect(nativeIdentitySchema.safeParse(n).success).toBe(false);
  },
);
it.each(['-0', '00', '1.1', '1e3'])('rejects noncanonical native time %s', (value) => {
  const n = [...native];
  n[7] = value as (typeof n)[7];
  expect(nativeIdentitySchema.safeParse(n).success).toBe(false);
});
it.each(['/cache', 'C:\\cache', 'C:/cache', '\\\\server\\share\\cache'])(
  'accepts absolute native path %s',
  (value) => {
    expect(nativePathSchema.safeParse(value).success).toBe(true);
  },
);
it.each(['cache', 'C:cache', '\\cache', '/cache/../escape', '/cache/./x'])(
  'rejects unbound native path %s',
  (value) => {
    expect(nativePathSchema.safeParse(value).success).toBe(false);
  },
);
it('binds immutable refs to the owned invocation and exact complete bytes', () => {
  const f = localFixtures(),
    bytes = f.codec.encode(f.bindings);
  const ref: Value = ['ref', 'bindings', f.prefix + 'bindings.json', bytes.length, rawSha(bytes)];
  expect(f.codec.decodeReferenced(bytes, ref)).toEqual(f.bindings);
  const wrong = [...ref];
  wrong[1] = 'publication';
  expect(() => f.codec.decodeReferenced(bytes, wrong)).toThrow('purpose');
  wrong[1] = 'bindings';
  wrong[2] = '.mammoth/v1/' + h + '/bindings.json';
  expect(() => f.codec.decodeReferenced(bytes, wrong)).toThrow();
  expect(() => f.codec.decodeReferenced(Buffer.concat([bytes, Buffer.from(' ')]), ref)).toThrow(
    'bytes',
  );
});
it('checks finalized cutoff/activity through the referenced bindings document', () => {
  const f = localFixtures();
  expect(() => f.codec.checkStateBindings(f.state, f.bindings)).not.toThrow();
  const bad = structuredClone(f.bindings);
  (bad[8] as Value[])[7] = null;
  const bytes = f.codec.encode(bad),
    state = structuredClone(f.state);
  state[5] = ['ref', 'bindings', f.prefix + 'candidate.json', bytes.length, rawSha(bytes)];
  expect(() => f.codec.checkStateBindings(state, bad)).toThrow('cutoff');
  state[4] = 'prepare-pending';
  expect(() => f.codec.checkStateBindings(state, bad)).not.toThrow();
});

it.each([
  'missing-handoff',
  'missing-terminal',
  'unexpected-terminal',
  'v1',
  'extra-package',
  'zero-revision',
])('rejects impossible v2 state %s', (kind) => {
  const f = localFixtures(),
    bad = structuredClone(f.state);
  if (kind === 'missing-handoff') bad[6] = null;
  if (kind === 'missing-terminal') bad[4] = 'completed';
  if (kind === 'unexpected-terminal') bad[7] = ['outcome', 'abandoned', null, null, null];
  if (kind === 'v1') bad[1] = 1;
  if (kind === 'extra-package') bad.push(f.q('worker-archive'));
  if (kind === 'zero-revision') bad[3] = 0;
  expect(() => f.codec.encode(bad)).toThrow();
});
it('keeps policy order/strictness in identity and rejects duplicates/GC ambiguity', () => {
  const f = localFixtures(),
    p = f.codec.schemas.documents.bindings.parse(f.bindings)[8];
  const original = policyId(p);
  p[10] = ['B', 'A'];
  expect(policyId(p)).not.toBe(original);
  p[10] = ['B', 'B'];
  expect(() => policyId(p)).toThrow();
  p[10] = [];
  p[6] = 0;
  expect(() => policyId(p)).toThrow();
});

it('rejects oversized local documents before schema validation', () => {
  const codec = new LocalCodec(localOptions());
  expect(() => codec.decode(Buffer.alloc(65537, 32))).toThrow();
  expect(() => codec.encode(['current', 1, 'a'.repeat(100000), 'bad'])).toThrow('record bound');
});

it('roundtrips the exact v2 documents and terminal outcomes without package authority', () => {
  const f = localFixtures();
  for (const value of [
    ['current', 1, f.options.invocation, f.prefix + 'state.json'],
    f.bindings,
    f.state,
  ] as Value[])
    expect(f.codec.decode(f.codec.encode(value))).toEqual(value);
  for (const outcome of [
    'read-only',
    'no-change',
    'skipped-not-quiescent',
    'feature-unavailable',
    'abandoned',
  ]) {
    const state = structuredClone(f.state);
    state[4] = 'completed';
    state[7] = ['outcome', outcome, null, null, null];
    expect(f.codec.decode(f.codec.encode(state))).toEqual(state);
  }
  const complete = structuredClone(f.state);
  complete[4] = 'completed';
  for (const terminal of [
    ['outcome', 'published', 'record-key', null, null],
    ['outcome', 'worker-uploaded', null, 7, 'artifact'],
  ]) {
    complete[7] = terminal;
    expect(() => f.codec.encode(complete)).not.toThrow();
    const bad = structuredClone(complete);
    (bad[7] as Value[])[3] = null;
    if (terminal[1] === 'worker-uploaded') expect(() => f.codec.encode(bad)).toThrow();
  }
});
it('binds install selectors to bounded metadata context and preserves replacement geometry', () => {
  const f = localFixtures(),
    source: Value = ['metadata-member', 'a'.repeat(32), 'source', 'metadata', 4],
    current: Value = ['metadata-member', 'a'.repeat(32), 'current', 'metadata', 8];
  expect(f.codec.schemas.installMember.parse(source)).toEqual(source);
  expect(() => f.codec.schemas.installMember.parse(f.evidence())).toThrow();
  for (const bad of [
    ['metadata-member', 'a'.repeat(64), 'source', 'metadata', 4],
    ['metadata-member', 'a'.repeat(32), 'source', 'foreign', 4],
    ['metadata-member', 'a'.repeat(32), 'source', 'metadata', -1],
  ])
    expect(() => f.codec.schemas.installMember.parse(bad)).toThrow();
  const row: Value[] = [
    'install',
    1,
    'metadata/a',
    f.prefix + 'source',
    source,
    null,
    'insert',
    null,
  ];
  expect(() => f.codec.schemas.rows.install.parse(row)).not.toThrow();
  row[6] = 'replace';
  expect(() => f.codec.schemas.rows.install.parse(row)).toThrow();
  row[5] = current;
  row[7] = f.prefix + 'backup';
  expect(() => f.codec.schemas.rows.install.parse(row)).not.toThrow();
  row[7] = f.prefix + 'source/backup';
  expect(() => f.codec.schemas.rows.install.parse(row)).toThrow();
  row[6] = 'delete';
  row[3] = null;
  row[4] = null;
  row[7] = f.prefix + 'backup';
  expect(() => f.codec.schemas.rows.install.parse(row)).not.toThrow();
});
it.each([
  'publication',
  'relocation',
  'gc-intent',
  'install-intent',
  'gc-progress',
  'install-progress',
  'quiescence',
])('rejects removed local document %s', (kind) => {
  const f = localFixtures();
  expect(() => f.codec.encode([kind, 1, f.options.invocation])).toThrow('Unknown local document');
});
