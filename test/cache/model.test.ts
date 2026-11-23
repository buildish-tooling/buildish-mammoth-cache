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
      'modules',
      'dependency-metadata',
      'transforms-metadata',
      'kotlin-dsl',
      'groovy-dsl',
      'build-cache',
      'wrapper-dists',
    ]);
    expect(
      partitions.every((partition) =>
        partition.relativeExcludeGlobs.includes('**/configuration-cache/**'),
      ),
    ).toBe(true);
    expect(
      partitions.every((partition) => partition.relativeExcludeGlobs.includes('**/*.lock')),
    ).toBe(true);
    expect(
      partitions.every((partition) =>
        partition.relativeExcludeGlobs.includes('caches/*/cc-keystore'),
      ),
    ).toBe(true);
    expect(
      partitions.find((partition) => partition.id === 'modules')?.relativeExcludeGlobs,
    ).toContain('caches/modules-*/metadata-*/**');
    expect(partitions[0]?.relativeIncludeGlobs).toContain('caches/modules-*/files-*/**');
  });

  it('supports built-in overrides, transform selection, and custom partitions', () => {
    const partitions = createCachePartitions(
      [
        {
          id: 'modules',
          includes: ['caches/modules-*/files-*/**'],
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
      'modules',
      'dependency-metadata',
      'transforms-metadata',
      'groovy-dsl',
      'build-cache',
      'wrapper-dists',
      'custom-generated-jars',
    ]);
    expect(partitions[0]?.relativeIncludeGlobs).toEqual(['caches/modules-*/files-*/**']);
    expect(partitions[6]?.relativeIncludeGlobs).toEqual(['caches/*/generated-gradle-jars/**']);
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
    ['caches/modules-2/modules-2.lock', ['modules', 'dependency-metadata']],
    ['caches/jars-9/jars-9.lock', ['modules']],
    [`caches/jars-9/${hash}/source.jar.lock.lock`, ['modules']],
    [`caches/jars-9/${hash}/source.jar.lock`, ['modules']],
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
  ] as const)
    expect(model.purge(path), path).toEqual(owners);
  expect(
    resolve([{ id: 'modules', purgeableGlobs: [] }]).purge('caches/modules-2/modules-2.lock'),
  ).toEqual(['dependency-metadata']);
  expect(
    resolve([{ id: 'modules', includes: [] }]).purge('caches/modules-2/modules-2.lock'),
  ).toEqual(['dependency-metadata']);
  expect(
    resolve([{ id: 'build-cache', purgeableGlobs: [] }]).purge(
      'caches/build-cache-1/build-cache-1.lock',
    ),
  ).toEqual([]);
});
