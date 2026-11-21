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
import { parseCachePartitionsInput } from '../../src/config/shared';
import { createCachePartitions } from '../../src/cache/model';
import { resolveCacheModel, resolveModel } from '../../src/cache/streaming/model';
import { LocalCodec } from '../../src/cache/streaming/local-schema';
import { cutoffModelSchema } from '../../src/cache/cutoff-state';
import { writeLocalStream, readLocalStream } from '../../src/cache/streaming/local-stream';
import { WorkingBudget } from '../../src/cache/streaming/tree-state';
import { rawSha, type Value } from '../../src/cache/streaming/encoding';
import { localOptions } from './streaming/local-fixtures';

const preset = {
  id: 'data',
  displayName: 'Data',
  description: '',
  defaultEnabled: true,
  relativeIncludeGlobs: ['data/**'],
  relativeExcludeGlobs: ['data/ordinary'],
  purgeableGlobs: ['data/*.tmp'],
};
it('resolves inherited, disabled, replacement and custom purge configuration in existing input', () => {
  for (const [input, expected] of [
    [{ id: 'data' }, ['data/*.tmp']],
    [{ id: 'data', purgeableGlobs: [] }, []],
    [{ id: 'data', purgeableGlobs: ['data/*.bak'] }, ['data/*.bak']],
  ] as const) {
    const [part] = createCachePartitions(
      '/cache',
      parseCachePartitionsInput(JSON.stringify([input])),
      [preset],
    );
    expect(part.purgeableGlobs ?? []).toEqual(expected);
    expect(part.relativeExcludeGlobs).toEqual(['data/ordinary', ...expected]);
    if (expected.length) expect(part.ordinaryExcludeGlobs).toEqual(['data/ordinary']);
  }
  expect(createCachePartitions('/cache', [{ id: 'data', includes: [] }], [preset])).toEqual([]);
  const [custom] = createCachePartitions(
    '/cache',
    parseCachePartitionsInput(
      '[{"id":"custom","includes":["custom/**"],"purgeableGlobs":["custom/*.tmp"]}]',
    ),
  );
  expect(custom.purgeableGlobs).toEqual(['custom/*.tmp']);
  expect(custom.absoluteExcludeGlobs).toEqual(['/cache/custom/*.tmp']);
  expect(
    createCachePartitions('/cache', [{ id: 'custom', includes: ['custom/**'] }])[0].purgeableGlobs,
  ).toBeUndefined();
});
it.each(['../x', '/outside', '~/.x', '!data/x', 'data/{a,b}'])(
  'rejects unsafe purge glob %s with existing input validation',
  (rule) => {
    expect(() =>
      parseCachePartitionsInput(JSON.stringify([{ id: 'data', purgeableGlobs: [rule] }])),
    ).toThrow();
  },
);
function model(purge: string[] = []) {
  return resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**', '**/*.lock'],
      [
        [
          'data',
          ['data/**'],
          ['.mammoth/**', '**/*.lock'],
          'aggregate',
          null,
          'default',
          ...(purge.length ? [purge] : []),
        ],
        ['other', ['other/**'], ['.mammoth/**', '**/*.lock'], 'aggregate', null, 'default'],
      ],
    ],
    'purge-',
    1,
  );
}
it('binds deletion permission separately even when effective upload exclusions are identical', () => {
  const off = model(),
    on = model(['data/runtime.lock']);
  expect(() => off.owner('data/runtime.lock')).toThrow();
  expect(() => on.owner('data/runtime.lock')).toThrow();
  expect(off.purge('data/runtime.lock')).toEqual([]);
  expect(on.purge('data/runtime.lock')).toEqual(['data']);
  expect(on.id).not.toBe(off.id);
  const options = localOptions();
  const a = new LocalCodec({ ...options, model: off }),
    b = new LocalCodec({ ...options, model: on });
  expect(a.options.model.id).not.toBe(b.options.model.id);
});
it('rejects conflicting original ownership rather than hiding it behind a derived exclusion', () => {
  const m = model(['other/*.tmp']);
  expect(() => m.purge('other/a.tmp')).toThrow('original partition ownership');
  expect(() => m.owner('other/a.tmp')).not.toThrow();
  expect(m.purge('data/keep')).toEqual([]);
});
it('deduplicates matching claims, excludes purgeable payloads and refuses opaque/reserved rules', () => {
  const m = resolveModel(
    [
      'model',
      1,
      'maven',
      ['.mammoth/**'],
      [
        [
          'data',
          ['data/**'],
          ['.mammoth/**'],
          'aggregate',
          null,
          'default',
          ['data/*.tmp', 'shared/*.tmp'],
        ],
        ['other', ['other/**'], ['.mammoth/**'], 'aggregate', null, 'default', ['shared/*.tmp']],
      ],
    ],
    'purge-',
    1,
  );
  expect(m.purge('shared/a.tmp')).toEqual(['data', 'other']);
  expect(() => m.owner('data/a.tmp')).toThrow();
  for (const rule of ['.mammoth/secret', 'caches/journal-1/file'])
    expect(() =>
      resolveModel(
        [
          'model',
          1,
          'gradle',
          ['.mammoth/**', 'caches/journal-1/**'],
          [
            [
              'data',
              ['**'],
              ['.mammoth/**', 'caches/journal-1/**'],
              'aggregate',
              null,
              'default',
              [rule],
            ],
          ],
        ],
        'purge-',
        1,
      ),
    ).toThrow('opaque');
});

it('round trips resolved rules in existing strict snapshots and exact modelRef streams', async () => {
  const partitions = createCachePartitions('/cache', [], [preset], ['.mammoth/**']);
  const frozen = {
    cacheRoot: '/cache',
    cacheFamilyKey: 'family',
    currentRefToken: 'main',
    currentRefLineagePrefix: 'family-main',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'writer',
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'id',
    buildToolId: 'maven',
    partitions,
    includePaths: partitions.flatMap((p) => p.absoluteIncludeGlobs),
    excludePaths: partitions.flatMap((p) => p.absoluteExcludeGlobs),
    hardCacheExcludeGlobs: ['.mammoth/**'],
  };
  const parsed = cutoffModelSchema.parse(frozen);
  expect(parsed).toEqual(frozen);
  const resolved = resolveCacheModel(parsed, 'purge-', 1),
    codec = new LocalCodec({ ...localOptions(), model: resolved }),
    budget = new WorkingBudget();
  const records: Value[] = [
    ['model-header', resolved.tuple[2], resolved.tuple[3]],
    ...resolved.partitions.map((p) => ['partition', ...p]),
  ];
  const chunks = [];
  for await (const bytes of writeLocalStream(
    (async function* () {
      yield* records;
    })(),
    'model',
    { codec, budget, partition: null },
    () => {},
  ))
    chunks.push(bytes);
  const bytes = Buffer.concat(chunks),
    ref = ['ref', 'model', codec.schemas.prefix + 'model.ndjson', bytes.length, rawSha(bytes)];
  await readLocalStream(
    (async function* () {
      yield bytes;
    })(),
    'model',
    { codec, budget, partition: null },
    ref,
  );
  const changed = resolveCacheModel(
    {
      ...parsed,
      partitions: createCachePartitions(
        '/cache',
        [{ id: 'data', purgeableGlobs: [] }],
        [preset],
        ['.mammoth/**'],
      ),
    },
    'purge-',
    1,
  );
  await expect(
    readLocalStream(
      (async function* () {
        yield bytes;
      })(),
      'model',
      { codec: new LocalCodec({ ...localOptions(), model: changed }), budget, partition: null },
      ref,
    ),
  ).rejects.toThrow();
  expect(budget.retained).toBe(0);
});

it('matches the independently calculated P0 frozen purge model vector', () => {
  const value = [
    'model',
    1,
    'maven',
    ['.mammoth/**'],
    [['data', ['data/**'], ['.mammoth/**'], 'aggregate', null, 'default', ['data/*.tmp']]],
  ];
  expect(resolveModel(value, 'purge-', 1).id).toBe(
    'bd2038f6837e6be40ec90eab8a8b0f7ba8e509cbfb98b0aded28621d79716475',
  );
  expect(readFileSync('docs/dev/cache-protocol-vectors.md', 'utf8')).toContain(
    'bd2038f6837e6be40ec90eab8a8b0f7ba8e509cbfb98b0aded28621d79716475',
  );
});
