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

import { describe, expect, it } from 'vitest';

import {
  createCacheGeneration,
  createCacheModel,
  createCachePartitions,
  createCacheRefToken,
  renderCacheFamilyKey,
} from '../../src/cache/model';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import type { CiJobContext } from '../../src/ci/types';
import type { NormalizedGradleConfig } from '../../src/config/types';

const baseConfig: NormalizedGradleConfig = {
  phase: 'prepare',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  allowDuplicateDependentDeltaPaths: false,
  cacheKeyPrefix: 'buildish-mammoth-cache-',
  cachePartitions: [],
  cacheSchemaVersion: 2,
  wrapperSelectionMode: 'default',
  wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
  defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
  wrapperPropertiesFiles: [],
  cleanupEnabled: true,
  restoreCleanupMode: 'none',
  cacheGcMode: 'off',
  cacheGcOlderThanDays: 14,
  gradleUserHome: '/home/runner/.gradle',
};

/** Shared Gradle adapter instance for cache model tests. Constructed from baseConfig so the cacheRoot matches. */
const gradleAdapter = new GradleBuildToolAdapter(baseConfig);

const baseCiContext: CiJobContext = {
  eventName: 'push',
  resolvedRefName: 'feature/cache model',
  safeRefName: 'feature-cache-model',
  runnerOs: 'linux',
  runnerArch: 'x64',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'buildish-tooling/buildish',
  workflowName: 'CI',
  jobName: 'check',
  runId: 123,
  runAttempt: 1,
  sourceRevision: null,
  tempDirectory: null,
  workspace: '/workspace',
  actionPath: '/workspace',
};

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
      '/cache',
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
      createCachePartitions('/cache', [{ id: 'custom', includes: ['data/**'], writer: 'master' }]),
    ).toThrow(/requires single-writer/);
    expect(() =>
      createCachePartitions('/cache', [{ id: 'custom', publication: 'single-writer' }]),
    ).toThrow(/at least one include/);
  });

  it('separates cache compatibility for publication and writer changes', async () => {
    const model = async (publication: 'aggregate' | 'single-writer', writer?: string) =>
      createCacheModel(
        {
          ...baseConfig,
          cachePartitions: [
            { id: 'extra', includes: ['extra/**'], publication, ...(writer ? { writer } : {}) },
          ],
        },
        baseCiContext,
        gradleAdapter,
      );
    const models = await Promise.all([
      model('aggregate'),
      model('single-writer'),
      model('single-writer', 'one'),
      model('single-writer', 'two'),
    ]);
    expect(new Set(models.map((m) => m.partitionFingerprint)).size).toBe(4);
  });
});

describe('cache identity rendering', () => {
  it('renders an action-owned cache family without ref or generation identity', () => {
    expect(renderCacheFamilyKey(baseConfig, 'gradle', 'feedcafe1234abcd')).toBe(
      'buildish-mammoth-cache-gradle-v2-partitioned-v2-feedcafe1234abcd',
    );
  });

  it.each(['gradle', 'maven'])(
    'keeps explicit namespaces and structural compatibility for %s',
    (tool) => {
      const key = renderCacheFamilyKey(baseConfig, tool, 'feedcafe1234abcd');
      expect(
        renderCacheFamilyKey(
          { ...baseConfig, cacheKeyPrefix: 'project-java21-linux-' },
          tool,
          'feedcafe1234abcd',
        ),
      ).not.toBe(key);
      expect(
        renderCacheFamilyKey({ ...baseConfig, cacheSchemaVersion: 99 }, tool, 'feedcafe1234abcd'),
      ).not.toBe(key);
      expect(renderCacheFamilyKey(baseConfig, tool, 'different-layout')).not.toBe(key);
      expect(
        renderCacheFamilyKey(
          baseConfig,
          tool === 'gradle' ? 'maven' : 'gradle',
          'feedcafe1234abcd',
        ),
      ).not.toBe(key);
    },
  );

  it.each(['gradle', 'maven'])(
    'constructs %s families without reading JAVA_HOME or launching Java',
    async (tool) => {
      const capture = { ...process.env };
      // Trap inherited environment reads without changing the caller's actual JAVA_HOME.
      const env = new Proxy(capture, {
        get(target, key) {
          if (key === 'JAVA_HOME') throw new Error('Cache identity must not inspect Java');
          return Reflect.get(target, key);
        },
      });
      const adapter = new GradleBuildToolAdapter(baseConfig);
      adapter.getBuildToolId = () => tool;
      if (tool === 'maven') adapter.getBuiltInPartitionPresets = () => [];
      const previousEnv = process.env;
      process.env = env;
      try {
        const model = await createCacheModel(baseConfig, baseCiContext, adapter);
        expect(model.cacheFamilyKey).toMatch(
          new RegExp('^buildish-mammoth-cache-' + tool + '-v2-partitioned-v2-[a-f0-9]{16}$', 'u'),
        );
        expect(model).not.toHaveProperty('javaMajor');
      } finally {
        process.env = previousEnv;
      }
    },
  );

  it('keeps lossy slug collisions in different ref lineages', () => {
    const slashToken = createCacheRefToken('feature/cache');
    const dashToken = createCacheRefToken('feature-cache');

    expect(slashToken).toMatch(/^feature-cache-[a-f0-9]{12}$/u);
    expect(dashToken).toMatch(/^feature-cache-[a-f0-9]{12}$/u);
    expect(slashToken).not.toBe(dashToken);
  });

  it('creates a generation beneath the current ref lineage', () => {
    const model = {
      cacheFamilyKey: 'family',
      currentRefLineagePrefix: 'family-ref-main-000000000000-gen-',
      plannedGenerationId: 'run-1-attempt-1-job-aaaaaaaaaaaa',
    };

    expect(createCacheGeneration(model, 'b'.repeat(64)).key).toBe(
      'family-ref-main-000000000000-gen-run-1-attempt-1-job-aaaaaaaaaaaa-bbbbbbbbbbbb',
    );
  });

  it('rejects a malformed canonical content digest', () => {
    expect(() =>
      createCacheGeneration(
        {
          cacheFamilyKey: 'family',
          currentRefLineagePrefix: 'family-ref-main-000000000000-gen-',
          plannedGenerationId: 'run-1-attempt-1-job-aaaaaaaaaaaa',
        },
        'not-a-sha256',
      ),
    ).toThrow(/lowercase SHA-256/u);
  });
});

describe('createCachePartitions', () => {
  it('defines the default active partitions and enforces hard excludes', () => {
    const partitions = createCachePartitions(
      '/home/runner/.gradle',
      [],
      gradleAdapter.getBuiltInPartitionPresets(),
      gradleAdapter.getHardCacheExcludeGlobs(),
    );

    expect(partitions.map((partition) => partition.id)).toEqual([
      'modules',
      'dependency-metadata',
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
    expect(partitions[0]?.absoluteIncludeGlobs).toContain(
      '/home/runner/.gradle/caches/modules-*/files-*/**',
    );
    expect(partitions[0]?.absoluteExcludeGlobs).toContain('/home/runner/.gradle/**/*.lock');
    expect(partitions[0]?.absoluteExcludeGlobs).toContain(
      '/home/runner/.gradle/caches/*/cc-keystore',
    );
    expect(partitions[0]?.absoluteExcludeGlobs).toContain(
      '/home/runner/.gradle/caches/modules-*/metadata-*/**',
    );
  });

  it('supports built-in overrides, opt-in transforms, and custom partitions', () => {
    const partitions = createCachePartitions(
      '/home/runner/.gradle',
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
        '/home/runner/.gradle',
        [{ id: 'custom-empty', includes: [], excludes: [] }],
        gradleAdapter.getBuiltInPartitionPresets(),
        gradleAdapter.getHardCacheExcludeGlobs(),
      ),
    ).toThrow(/must declare at least one include glob/);
  });
});

describe('createCacheModel', () => {
  it('derives the cache model from the normalized config and ci context', async () => {
    const cacheModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {});

    expect(cacheModel.cacheFamilyKey).toMatch(
      /^buildish-mammoth-cache-gradle-v2-partitioned-v2-[a-f0-9]{16}$/u,
    );
    expect(cacheModel.currentRefLineagePrefix).toMatch(
      /^buildish-mammoth-cache-gradle-v2-partitioned-v2-[a-f0-9]{16}-ref-feature-cache-model-[a-f0-9]{12}-gen-$/u,
    );
    expect(cacheModel.fallbackRefLineagePrefixes).toHaveLength(1);
    expect(cacheModel.plannedGenerationId).toMatch(/^run-123-attempt-1-job-[a-f0-9]{12}$/u);
    expect(cacheModel.cacheRoot).toBe('/home/runner/.gradle');
    expect(cacheModel.partitionFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(cacheModel.partitions).toHaveLength(6);
    expect(cacheModel.includePaths).toContain('/home/runner/.gradle/wrapper/dists/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/configuration-cache/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/*.lock');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/caches/*/cc-keystore');
    expect(cacheModel.excludePaths).toContain(
      '/home/runner/.gradle/caches/modules-*/metadata-*/**',
    );
  });

  it('changes the partition fingerprint and cache family when the partition layout changes', async () => {
    const defaultModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {});
    const customizedConfig = {
      ...baseConfig,
      cachePartitions: [
        {
          id: 'transforms-metadata',
          includes: ['caches/transforms-*/**'],
          excludes: [],
        },
      ],
    };
    const customizedAdapter = new GradleBuildToolAdapter(customizedConfig);
    const customizedModel = await createCacheModel(
      customizedConfig,
      baseCiContext,
      customizedAdapter,
      {},
    );

    expect(customizedModel.partitions.map((partition) => partition.id)).toContain(
      'transforms-metadata',
    );
    expect(customizedModel.partitionFingerprint).not.toBe(defaultModel.partitionFingerprint);
    expect(customizedModel.cacheFamilyKey).not.toBe(defaultModel.cacheFamilyKey);
  });

  it('uses a supplied UUID seed and omits fallback when the current ref is the default branch', async () => {
    const cacheModel = await createCacheModel(
      baseConfig,
      {
        ...baseCiContext,
        resolvedRefName: 'main',
        safeRefName: 'main',
        runId: null,
        runAttempt: null,
      },
      gradleAdapter,
      {
        randomUuid: () => '123e4567-e89b-12d3-a456-426614174000',
      },
    );

    expect(cacheModel.plannedGenerationId).toBe('uuid-123e4567-e89b-12d3-a456-426614174000');
    expect(cacheModel.fallbackRefLineagePrefixes).toEqual([]);
  });
});
