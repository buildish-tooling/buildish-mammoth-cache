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
it('encodes empty cursor and all fixed document kinds without native operations', () => {
  const f = localFixtures(),
    i = f.options.invocation;
  const rows: Value[] = [
    ['current', 1, i, f.prefix + 'state.json'],
    f.bindings,
    f.state,
    f.publication,
    f.relocation,
    ['quiescence', 1, i, f.q('installations'), 'all-exited', 1],
    ...(['gc', 'install'] as const).flatMap(
      (kind) =>
        [
          [
            kind + '-progress',
            1,
            i,
            f.q(kind === 'gc' ? 'observations' : 'install-plan'),
            f.cursor(),
            null,
          ],
          [
            kind + '-intent',
            1,
            i,
            f.q(kind === 'gc' ? 'observations' : 'install-plan'),
            f.cursor(),
            f.cursor(1),
            f.q(kind === 'gc' ? 'gc-evidence' : 'install-evidence'),
          ],
        ] as Value[],
    ),
  ];
  for (const row of rows) expect(f.codec.decode(f.codec.encode(row))).toEqual(row);
});
it.each([
  'outcome',
  'missing-observations',
  'missing-publication',
  'worker-base',
  'read-only',
  'initial-revision',
])('rejects impossible state %s', (kind) => {
  const options = { ...localOptions() };
  if (kind === 'worker-base') options.role = 'distributed-worker';
  if (kind === 'read-only') options.access = 'read-only';
  const f = localFixtures(options),
    bad = structuredClone(f.state);
  if (kind === 'outcome') bad[14] = 'published';
  if (kind === 'missing-observations') bad[4] = 'observations-frozen';
  if (kind === 'missing-publication' || kind === 'worker-base' || kind === 'read-only')
    bad[4] = 'objects-frozen';
  if (kind === 'initial-revision') bad[3] = 0;
  expect(() => f.codec.encode(bad)).toThrow();
});
it('validates interrupted outbound ownership and normalized return high-water', () => {
  const f = localFixtures(),
    r = structuredClone(f.relocation);
  r[8] = f.cursor(16384);
  r[10] = ['outbound', f.cursor(16384), f.cursor(30000)];
  expect(() => f.codec.encode(r)).not.toThrow();
  r[7] = 'returning';
  r[8] = f.cursor(30000);
  expect(() => f.codec.encode(r)).not.toThrow();
  r[9] = f.cursor(30001);
  expect(() => f.codec.encode(r)).toThrow();
  r[9] = f.cursor(30000);
  r[7] = 'sources-returned';
  r[10] = null;
  r[13] = f.q('adjustments');
  expect(() => f.codec.encode(r)).not.toThrow();
  r[9] = f.cursor(100);
  expect(() => f.codec.encode(r)).toThrow();
});
it('rejects wrong-purpose intents and malformed cursor ranges', () => {
  const f = localFixtures(),
    row: Value[] = [
      'gc-intent',
      1,
      f.options.invocation,
      f.q('observations'),
      f.cursor(),
      f.cursor(1),
      f.q('gc-evidence'),
    ];
  row[6] = f.q('install-evidence');
  expect(() => f.codec.encode(row)).toThrow();
  row[6] = f.q('gc-evidence');
  row[5] = ['cursor', 'b'.repeat(64), 1, 1, 1, null];
  expect(() => f.codec.encode(row)).toThrow();
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
it('checks exact relocation marker paths, receipt/marker exclusion and install variants', () => {
  const f = localFixtures();
  expect(() =>
    f.codec.schemas.rows.partitionState.parse([
      'partition-state',
      'data',
      ['baseline-partition', 'empty', null],
      null,
      null,
      null,
      f.prefix + 'other.json',
    ]),
  ).toThrow();
  const insert: Value[] = [
    'install',
    1,
    'repository/a',
    f.prefix + 'source',
    f.q('native-evidence'),
    null,
    'insert',
    null,
  ];
  expect(() => f.codec.schemas.rows.install.parse(insert)).not.toThrow();
  insert[6] = 'replace';
  expect(() => f.codec.schemas.rows.install.parse(insert)).toThrow();
  insert[5] = f.q('native-evidence');
  insert[7] = f.prefix + 'backup';
  expect(() => f.codec.schemas.rows.install.parse(insert)).not.toThrow();
  insert[7] = f.prefix + 'source/backup';
  expect(() => f.codec.schemas.rows.install.parse(insert)).toThrow();
  insert[6] = 'delete';
  insert[3] = null;
  insert[4] = null;
  insert[7] = f.prefix + 'backup';
  expect(() => f.codec.schemas.rows.install.parse(insert)).not.toThrow();
});
it('rejects oversized local documents before schema validation', () => {
  const codec = new LocalCodec(localOptions());
  expect(() => codec.decode(Buffer.alloc(65537, 32))).toThrow();
  expect(() => codec.encode(['current', 1, 'a'.repeat(100000), 'bad'])).toThrow('record bound');
});

it('requires a frozen base decision for no-change and prevents worker completion skips', () => {
  const f = localFixtures(),
    s = structuredClone(f.state);
  s[4] = 'completed';
  s[14] = 'no-change';
  s[6] = f.q('observations');
  s[10] = f.q('gc-progress');
  expect(() => f.codec.encode(s)).toThrow('publication');
  s[7] = f.q('post-sources');
  s[8] = f.q('publication');
  s[9] = f.q('partition-state');
  expect(() => f.codec.encode(s)).not.toThrow();
  const worker = localFixtures({ ...localOptions(), role: 'distributed-worker' });
  for (const outcome of ['no-change', 'skipped-not-quiescent']) {
    const state = structuredClone(worker.state);
    state[4] = 'completed';
    state[14] = outcome;
    expect(() => worker.codec.encode(state)).toThrow();
  }
});
it('requires sealed adjustment ownership at sources-returned', () => {
  const f = localFixtures(),
    r = structuredClone(f.relocation);
  r[7] = 'sources-returned';
  expect(() => f.codec.encode(r)).toThrow();
  r[13] = ['prefix', 'adjustments', f.prefix + 'adjustments.ndjson', 100, 1, h];
  expect(() => f.codec.encode(r)).toThrow();
  r[13] = f.q('adjustments');
  expect(() => f.codec.encode(r)).not.toThrow();
});
