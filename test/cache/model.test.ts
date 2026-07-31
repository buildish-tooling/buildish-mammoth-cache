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

import { describe, expect, it, vi } from 'vitest';

import {
  createCacheGeneration,
  createCacheModel,
  createCachePartitions,
  createCacheRefToken,
  parseJavaMajor,
  renderCacheFamilyKey,
  renderCacheJavaMajor,
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
  tempDirectory: null,
  workspace: '/workspace',
  actionPath: '/workspace',
};

describe('parseJavaMajor', () => {
  it('parses current java version output', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2024-07-16\n')).toBe(21);
  });

  it('parses legacy java 8 version output', () => {
    expect(parseJavaMajor('java version "1.8.0_432"\n')).toBe(8);
  });

  it('rejects unsupported java versions', () => {
    expect(() => parseJavaMajor('openjdk version "1.7.0_80"\n')).toThrow(/Java 8 or newer/);
  });
});

describe('cache identity rendering', () => {
  it('renders an action-owned cache family without ref or generation identity', () => {
    expect(renderCacheFamilyKey(baseConfig, 'gradle', baseCiContext, 21, 'feedcafe1234abcd')).toBe(
      'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd',
    );
  });

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
      'kotlin-dsl',
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
      'transforms-metadata',
      'build-cache',
      'wrapper-dists',
      'custom-generated-jars',
    ]);
    expect(partitions[0]?.relativeIncludeGlobs).toEqual(['caches/modules-*/files-*/**']);
    expect(partitions[4]?.relativeIncludeGlobs).toEqual(['caches/*/generated-gradle-jars/**']);
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

// Env that disables JAVA_HOME-based detection so tests relying on captureCommandOutput
// injection are not accidentally short-circuited by the local developer's JAVA_HOME.
const envWithoutJavaHome: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: '' };

describe('createCacheModel', () => {
  it('derives the cache model from the normalized config and ci context', async () => {
    const cacheModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {
      captureCommandOutput: async () => 'openjdk version "21.0.4" 2024-07-16\n',
      env: envWithoutJavaHome,
    });

    expect(cacheModel.cacheFamilyKey).toMatch(
      /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}$/u,
    );
    expect(cacheModel.currentRefLineagePrefix).toMatch(
      /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}-ref-feature-cache-model-[a-f0-9]{12}-gen-$/u,
    );
    expect(cacheModel.fallbackRefLineagePrefixes).toHaveLength(1);
    expect(cacheModel.plannedGenerationId).toMatch(/^run-123-attempt-1-job-[a-f0-9]{12}$/u);
    expect(cacheModel.cacheRoot).toBe('/home/runner/.gradle');
    expect(cacheModel.javaMajor).toBe(21);
    expect(cacheModel.partitionFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(cacheModel.partitions).toHaveLength(4);
    expect(cacheModel.includePaths).toContain('/home/runner/.gradle/wrapper/dists/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/configuration-cache/**');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/**/*.lock');
    expect(cacheModel.excludePaths).toContain('/home/runner/.gradle/caches/*/cc-keystore');
    expect(cacheModel.excludePaths).toContain(
      '/home/runner/.gradle/caches/modules-*/metadata-*/**',
    );
  });

  it('reads the Java version from $JAVA_HOME/release without spawning a subprocess', async () => {
    // Use the real JAVA_HOME from the test environment if available.
    const javaHome = process.env.JAVA_HOME?.trim();
    if (!javaHome) {
      return; // skip when JAVA_HOME is not set in the test environment
    }

    const captureCommandOutput = vi.fn(async () => {
      throw new Error('captureCommandOutput should not be called when release file is present');
    });

    const cacheModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {
      captureCommandOutput,
    });

    expect(cacheModel.javaMajor).toBeGreaterThanOrEqual(8);
    expect(captureCommandOutput).not.toHaveBeenCalled();
  });

  it('changes the partition fingerprint and cache family when the partition layout changes', async () => {
    const captureCommandOutput = async () => 'openjdk version "21.0.4" 2024-07-16\n';

    const defaultModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {
      captureCommandOutput,
      env: envWithoutJavaHome,
    });
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
      { captureCommandOutput, env: envWithoutJavaHome },
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
        captureCommandOutput: async () => 'openjdk version "21.0.4" 2024-07-16\n',
        env: envWithoutJavaHome,
        randomUuid: () => '123e4567-e89b-12d3-a456-426614174000',
      },
    );

    expect(cacheModel.plannedGenerationId).toBe('uuid-123e4567-e89b-12d3-a456-426614174000');
    expect(cacheModel.fallbackRefLineagePrefixes).toEqual([]);
  });

  it('sets javaMajor to null and uses 0 in the cache family when no Java runtime is available', async () => {
    const cacheModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {
      captureCommandOutput: async () => {
        throw new Error('ENOENT: java not found');
      },
      env: envWithoutJavaHome,
    });

    expect(cacheModel.javaMajor).toBeNull();
    expect(renderCacheJavaMajor(cacheModel.javaMajor)).toBe('0');
    expect(cacheModel.cacheFamilyKey).toMatch(/-v2-0-linux-/u);
  });

  it('sets javaMajor to null when java -version exits non-zero', async () => {
    const cacheModel = await createCacheModel(baseConfig, baseCiContext, gradleAdapter, {
      captureCommandOutput: async () => {
        throw new Error("'java -version' failed with exit code 2.");
      },
      env: envWithoutJavaHome,
    });

    expect(cacheModel.javaMajor).toBeNull();
    expect(cacheModel.cacheFamilyKey).toMatch(/-v2-0-linux-/u);
  });
});
