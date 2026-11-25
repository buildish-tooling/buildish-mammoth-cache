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

import { resolveCacheModel } from '../../src/cache/streaming/model';
import { describe, expect, it } from 'vitest';

import { createCachePartitions } from '../../src/cache/model';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { fixtureCi } from '../support/ci-fixture';

const config = normalizeGradleActionConfig(readGradleActionInputs({ getInput: () => '' }), {
  phase: 'prepare',
  ciContext: fixtureCi('/cache'),
  env: { GRADLE_USER_HOME: '/cache' },
});
const gradleAdapter = new GradleBuildToolAdapter(config);

describe('partition policy', () => {
  it('inherits snapshot policy and patterns while permitting explicit file exclusions', () => {
    const preset = {
      id: 'metadata',
      displayName: 'Metadata',
      description: '',
      defaultEnabled: true,
      publication: 'single-writer' as const,
      relativeIncludeGlobs: ['metadata/**'],
      relativeExcludeGlobs: ['**/gc.properties'],
    };
    const [partition] = createCachePartitions(
      [{ id: 'metadata', writer: 'master', excludes: ['metadata/skip.bin'] }],
      [preset],
      ['**/*.lock'],
    );
    expect(partition).toMatchObject({
      publication: 'single-writer',
      writer: 'master',
      relativeIncludeGlobs: ['metadata/**'],
      relativeExcludeGlobs: ['**/*.lock', 'metadata/skip.bin'],
    });
    expect(() =>
      createCachePartitions([{ id: 'custom', includes: ['data/**'], writer: 'master' }]),
    ).toThrow(/requires single-writer/);
    expect(() => createCachePartitions([{ id: 'custom', publication: 'single-writer' }])).toThrow(
      /at least one include/,
    );
  });

  it('separates cache compatibility for publication and writer changes', () => {
    const models = [
      undefined,
      { publication: 'single-writer' as const },
      { publication: 'single-writer' as const, writer: 'one' },
      { publication: 'single-writer' as const, writer: 'two' },
    ].map((policy) =>
      resolveCacheModel(
        {
          buildToolId: 'gradle',
          hardCacheExcludeGlobs: ['.mammoth/**'],
          partitions: createCachePartitions(
            [{ id: 'extra', includes: ['extra/**'], ...policy }],
            [],
            ['.mammoth/**'],
          ),
        },
        'local-',
        8,
      ),
    );
    expect(new Set(models.map((model) => model.family)).size).toBe(4);
  });
});

describe('createCachePartitions', () => {
  it('defines the default active partitions and enforces hard excludes', () => {
    const partitions = createCachePartitions(
      [],
      gradleAdapter.getBuiltInPartitionPresets(),
      gradleAdapter.getHardCacheExcludeGlobs(),
    );

    expect(partitions.map((partition) => partition.id)).toEqual([
      'dependency-artifacts',
      'module-support',
      'dependency-metadata',
      'transforms-metadata',
      'kotlin-dsl',
      'groovy-dsl',
      'build-cache',
      'wrapper-dists',
    ]);
    expect(
      partitions.every((partition) => partition.relativeExcludeGlobs.includes('**/*.lock')),
    ).toBe(true);
    expect(
      partitions.every((partition) =>
        partition.relativeExcludeGlobs.includes('caches/*/cc-keystore'),
      ),
    ).toBe(true);
    expect(
      partitions.find((partition) => partition.id === 'module-support')?.relativeIncludeGlobs,
    ).toEqual(['caches/jars-*/**', 'caches/resources-*/**']);
    expect(partitions[0]?.relativeIncludeGlobs).toContain('caches/modules-2/files-2.1/**');
  });

  it('keeps wrapper distribution documentation and sources named configuration-cache', () => {
    const hardCacheExcludeGlobs = gradleAdapter.getHardCacheExcludeGlobs();
    const model = resolveCacheModel(
      {
        buildToolId: 'gradle',
        hardCacheExcludeGlobs,
        partitions: createCachePartitions(
          [],
          gradleAdapter.getBuiltInPartitionPresets(),
          hardCacheExcludeGlobs,
        ),
      },
      'test-',
      8,
    );
    const distribution = 'wrapper/dists/gradle-9.9.2-all/8gcrr1xgd8zr4y1n2fg3m4wzh/gradle-9.9.2';
    for (const scope of ['docs/userguide/img/configuration-cache', 'src/configuration-cache']) {
      expect(model.owner(`${distribution}/${scope}`)[0]).toBe('wrapper-dists');
      expect(model.owner(`${distribution}/${scope}/example.txt`)[0]).toBe('wrapper-dists');
    }
  });

  it('supports built-in overrides, transform selection, and custom partitions', () => {
    const partitions = createCachePartitions(
      [
        {
          id: 'dependency-artifacts',
          includes: ['caches/modules-2/files-2.1/**'],
          excludes: [],
        },
        {
          id: 'transforms-metadata',
          includes: ['caches/transforms-*/**'],
          excludes: [],
        },
        {
          id: 'kotlin-dsl',
          includes: [],
          excludes: [],
        },
        {
          id: 'custom-generated-jars',
          includes: ['caches/*/generated-gradle-jars/**'],
          excludes: [],
        },
      ],
      gradleAdapter.getBuiltInPartitionPresets(),
      gradleAdapter.getHardCacheExcludeGlobs(),
    );

    expect(partitions.map((partition) => partition.id)).toEqual([
      'dependency-artifacts',
      'module-support',
      'dependency-metadata',
      'transforms-metadata',
      'groovy-dsl',
      'build-cache',
      'wrapper-dists',
      'custom-generated-jars',
    ]);
    expect(partitions[0]?.relativeIncludeGlobs).toEqual(['caches/modules-2/files-2.1/**']);
    expect(partitions.at(-1)?.relativeIncludeGlobs).toEqual(['caches/*/generated-gradle-jars/**']);
  });

  it('rejects empty custom partitions', () => {
    expect(() =>
      createCachePartitions(
        [{ id: 'custom-empty', includes: [], excludes: [] }],
        gradleAdapter.getBuiltInPartitionPresets(),
        gradleAdapter.getHardCacheExcludeGlobs(),
      ),
    ).toThrow(/must declare at least one include glob/);
  });
});

it('resolves actual Gradle purge defaults through the adapter and honors disable overrides', () => {
  const resolve = (overrides: Parameters<typeof createCachePartitions>[0] = []) =>
    resolveCacheModel(
      {
        buildToolId: 'gradle',
        hardCacheExcludeGlobs: gradleAdapter.getHardCacheExcludeGlobs(),
        partitions: createCachePartitions(
          overrides,
          gradleAdapter.getBuiltInPartitionPresets(),
          gradleAdapter.getHardCacheExcludeGlobs(),
        ),
      },
      'purge-',
      1,
    );
  const model = resolve(),
    hash = 'a'.repeat(32);
  for (const [path, owners] of [
    ['caches/modules-2/modules-2.lock', ['dependency-artifacts', 'dependency-metadata']],
    ['caches/jars-9/jars-9.lock', ['module-support']],
    [`caches/jars-9/${hash}/source.jar.lock.lock`, ['module-support']],
    [`caches/jars-9/${hash}/source.jar.lock`, ['module-support']],
    [`caches/9.2.1/transforms/${hash}/${hash}.lock`, ['transforms-metadata']],
    [`caches/9.2.1/kotlin-dsl/scripts/${hash}/${hash}.lock`, ['kotlin-dsl']],
    [`caches/9.2.1/kotlin-dsl/accessors/${hash}/${hash}.lock`, ['kotlin-dsl']],
    ['caches/9.2.1/generated-gradle-jars/generated-gradle-jars.lock', ['kotlin-dsl']],
    [`caches/9.2.1/groovy-dsl/${hash}/${hash}.lock`, ['groovy-dsl']],
    ['caches/build-cache-1/build-cache-1.lock', ['build-cache']],
    ['caches/build-cache-2/build-cache-2.lock', []],
    ['caches/modules-2/modules-unrelated.lock', []],
    ['caches/modules-3/modules-3.lock', []],
    ['caches/jars-9/jars-unrelated.lock', []],
    ['caches/jars-8/jars-8.lock', []],
    ['caches/build-cache-1/entry', []],
    ['caches/build-cache-1/gc.properties', []],
    ['wrapper/dists/gradle/hash/gradle.zip.lck', []],
    [`caches/jars-9/${hash}/source.jar.receipt`, []],
  ] as const) {
    expect(model.purge(path), path).toEqual(owners);
  }
  expect(
    resolve([{ id: 'dependency-artifacts', purgeableGlobs: [] }]).purge(
      'caches/modules-2/modules-2.lock',
    ),
  ).toEqual(['dependency-metadata']);
  expect(
    resolve([{ id: 'dependency-artifacts', includes: [] }]).purge(
      'caches/modules-2/modules-2.lock',
    ),
  ).toEqual(['dependency-metadata']);
  expect(
    resolve([{ id: 'build-cache', purgeableGlobs: [] }]).purge(
      'caches/build-cache-1/build-cache-1.lock',
    ),
  ).toEqual([]);
});

it('preserves disjoint Gradle module coverage and single-writer metadata authority', () => {
  const hard = gradleAdapter.getHardCacheExcludeGlobs();
  const partitions = createCachePartitions(
    [{ id: 'dependency-metadata', writer: 'metadata-writer', excludes: [] }],
    gradleAdapter.getBuiltInPartitionPresets(),
    hard,
  );
  const model = resolveCacheModel(
    { buildToolId: 'gradle', hardCacheExcludeGlobs: hard, partitions },
    'layer-',
    1,
  );
  for (const [path, id, eligible] of [
    ['caches/modules-2/files-2.1/g/a/1/hash/a.jar', 'dependency-artifacts', 1],
    ['caches/jars-9/hash/plugin.jar', 'module-support', 0],
    ['caches/resources-2/hash/resource', 'module-support', 0],
    ['caches/modules-2/metadata-2.107/descriptors.bin', 'dependency-metadata', 1],
  ] as const) {
    expect(model.owner(path)[0], path).toBe(id);
    expect(model.owner(path)[6], path).toBe(eligible);
  }
  for (const id of ['dependency-metadata']) {
    expect(partitions.find((p) => p.id === id)).toMatchObject({
      publication: 'single-writer',
      writer: 'metadata-writer',
    });
  }
  for (const path of [
    'caches/modules-2/resources-2/uncaptured',
    'caches/modules-3/files-9/g/a.jar',
    'caches/modules-2/files-3/g/a.jar',
    'caches/modules-3/metadata-9/descriptors.bin',
  ]) {
    expect(() => model.owner(path)).toThrow('Unowned');
  }
  expect(() => model.owner('caches/modules-2/metadata-2.107/gc.properties')).toThrow('excluded');
});

it('rejects retired Gradle overrides and allows disabling both artifact replacements', () => {
  const presets = gradleAdapter.getBuiltInPartitionPresets(),
    hard = gradleAdapter.getHardCacheExcludeGlobs();
  expect(() => createCachePartitions([{ id: 'modules', includes: [] }], presets, hard)).toThrow(
    /dependency-artifacts.*module-support/,
  );
  const partitions = createCachePartitions(
    [
      { id: 'dependency-artifacts', includes: [] },
      { id: 'module-support', includes: [] },
      { id: 'dependency-metadata', includes: [] },
    ],
    presets,
    hard,
  );
  expect(partitions.some((p) => p.id.startsWith('dependency-metadata'))).toBe(false);
  const model = resolveCacheModel(
    { buildToolId: 'gradle', hardCacheExcludeGlobs: hard, partitions },
    'layer-',
    1,
  );
  for (const path of [
    'caches/modules-2/files-2.1/a.jar',
    'caches/modules-3/files-9/a.jar',
    'caches/jars-9/a.jar',
    'caches/resources-2/a',
  ]) {
    expect(() => model.owner(path), path).toThrow('Unowned');
  }
});

it('preserves explicit custom metadata coverage and its configured writer', () => {
  const partitions = createCachePartitions(
    [{ id: 'dependency-metadata', includes: ['caches/modules-*/metadata-*/**'], writer: 'writer' }],
    gradleAdapter.getBuiltInPartitionPresets(),
    gradleAdapter.getHardCacheExcludeGlobs(),
  );
  expect(partitions.find((p) => p.id === 'dependency-metadata')?.relativeIncludeGlobs).toEqual([
    'caches/modules-*/metadata-*/**',
  ]);
  expect(partitions.find((p) => p.id === 'dependency-metadata')?.writer).toBe('writer');
});

it('inherits seed eligibility, honors false overrides and isolates custom selections canonically', () => {
  const presets = gradleAdapter.getBuiltInPartitionPresets(),
    hard = gradleAdapter.getHardCacheExcludeGlobs();
  const resolve = (readOnlyLayer: boolean) =>
    resolveCacheModel(
      {
        buildToolId: 'gradle',
        hardCacheExcludeGlobs: hard,
        partitions: createCachePartitions(
          [
            { id: 'dependency-artifacts', readOnlyLayer },
            { id: 'extra', includes: ['extra/**'] },
            { id: 'custom-layer', includes: ['custom/**'], readOnlyLayer: true },
          ],
          presets,
          hard,
        ),
      },
      'layer-',
      1,
    );
  const enabled = resolve(true),
    disabled = resolve(false);
  expect(enabled.owner('caches/modules-2/files-2.1/a.jar')[6]).toBe(1);
  expect(disabled.owner('caches/modules-2/files-2.1/a.jar')[6]).toBe(0);
  expect(enabled.owner('extra/a')[6]).toBe(0);
  expect(enabled.owner('custom/a')[6]).toBe(1);
  expect(enabled.family).not.toBe(disabled.family);
  expect(
    resolveCacheModel(
      {
        buildToolId: 'maven',
        hardCacheExcludeGlobs: hard,
        partitions: createCachePartitions([{ id: 'extra', includes: ['extra/**'] }], [], hard),
      },
      'layer-',
      1,
    ).partitions[0][6],
  ).toBe(0);
});

it.each([{ excludes: [] }, { excludes: ['caches/jars-9/ignored.jar'] }])(
  'keeps artifact ownership disjoint when module-support exclusions are overridden with $excludes',
  ({ excludes }) => {
    const hard = gradleAdapter.getHardCacheExcludeGlobs();
    const partitions = createCachePartitions(
      [{ id: 'module-support', excludes }],
      gradleAdapter.getBuiltInPartitionPresets(),
      hard,
    );
    const model = resolveCacheModel(
      { buildToolId: 'gradle', hardCacheExcludeGlobs: hard, partitions },
      'layer-',
      1,
    );
    expect(model.owner('caches/modules-2/files-2.1/g/a/1/hash/a.jar')[0]).toBe(
      'dependency-artifacts',
    );
    expect(() => model.owner('caches/modules-3/files-9/g/a.jar')).toThrow('Unowned');
    expect(model.owner('caches/jars-9/kept.jar')[0]).toBe('module-support');
    if (excludes.length) {
      expect(() => model.owner(excludes[0])).toThrow('Unowned');
    }
  },
);

it('allows explicit module-support include remapping after disabling dependency-artifacts', () => {
  const hard = gradleAdapter.getHardCacheExcludeGlobs();
  const partitions = createCachePartitions(
    [
      { id: 'dependency-artifacts', includes: [] },
      { id: 'module-support', includes: ['caches/modules-2/files-2.1/**'], excludes: [] },
    ],
    gradleAdapter.getBuiltInPartitionPresets(),
    hard,
  );
  const model = resolveCacheModel(
    { buildToolId: 'gradle', hardCacheExcludeGlobs: hard, partitions },
    'layer-',
    1,
  );
  expect(model.owner('caches/modules-2/files-2.1/g/a/1/hash/a.jar')[0]).toBe('module-support');
});
