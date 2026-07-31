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
  createBaseCachePaths,
  createBaseCacheRestoreCandidates,
  restoreBaseCache,
  saveBaseCache,
} from '../../src/cache/service';
import { createCacheGeneration, type CacheModel } from '../../src/cache/model';
import type { NormalizedGradleConfig } from '../../src/config/types';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';

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

const cacheModel: CacheModel = {
  buildToolId: 'gradle',
  cacheRoot: '/home/runner/.gradle',
  cacheFamilyKey: 'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd',
  currentRefToken: 'feature-cache-model-111111111111',
  currentRefLineagePrefix:
    'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd-ref-feature-cache-model-111111111111-gen-',
  fallbackRefLineagePrefixes: [
    'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd-ref-main-222222222222-gen-',
  ],
  plannedGenerationId: 'run-123-attempt-1-job-aaaaaaaaaaaa',
  javaMajor: 21,
  runnerOs: 'linux',
  runnerArch: 'x64',
  safeRefName: 'feature-cache-model',
  partitionFingerprint: 'feedcafe1234abcd',
  partitions: [],
  includePaths: ['/home/runner/.gradle/caches/modules-2/**'],
  excludePaths: [
    '/home/runner/.gradle/**/configuration-cache/**',
    '/home/runner/.gradle/**/*.lock',
  ],
};

const generation = createCacheGeneration(cacheModel, 'a'.repeat(64));

function createCacheBackend(
  backend: Pick<BaseCacheBackend, 'isFeatureAvailable' | 'restoreCache' | 'saveCache'> &
    Partial<Pick<BaseCacheBackend, 'isMissingPathsError'>>,
  capabilities = STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
): BaseCacheBackend {
  return {
    capabilities,
    isFeatureAvailable: backend.isFeatureAvailable,
    restoreCache: backend.restoreCache,
    saveCache: backend.saveCache,
    isMissingPathsError: backend.isMissingPathsError ?? (() => false),
  };
}

describe('createBaseCachePaths', () => {
  it('appends exclude globs as negated cache patterns', () => {
    expect(createBaseCachePaths(cacheModel)).toEqual([
      '/home/runner/.gradle/caches/modules-2/**',
      '!/home/runner/.gradle/**/configuration-cache/**',
      '!/home/runner/.gradle/**/*.lock',
    ]);
  });
});

describe('createBaseCacheRestoreCandidates', () => {
  it('orders the current-ref lineage before the default-branch fallback', () => {
    expect(createBaseCacheRestoreCandidates(cacheModel)).toEqual([
      { lineage: 'current-ref', keyPrefix: cacheModel.currentRefLineagePrefix },
      { lineage: 'default-branch', keyPrefix: cacheModel.fallbackRefLineagePrefixes[0] },
    ]);
  });
});

describe('restoreBaseCache', () => {
  it('classifies current-lineage cache hits', async () => {
    const result = await restoreBaseCache(cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => generation.key,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('current-lineage-hit');
    expect(result.restoreCandidates).toEqual([
      { lineage: 'current-ref', keyPrefix: cacheModel.currentRefLineagePrefix },
      { lineage: 'default-branch', keyPrefix: cacheModel.fallbackRefLineagePrefixes[0] },
    ]);
  });

  it('classifies default-branch fallback hits', async () => {
    const fallbackGenerationKey = `${cacheModel.fallbackRefLineagePrefixes[0]}run-100-attempt-1-job-bbbbbbbbbbbb-${'b'.repeat(12)}`;
    const result = await restoreBaseCache(cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => fallbackGenerationKey,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('fallback-lineage-hit');
    expect(result.matchedKey).toBe(fallbackGenerationKey);
    expect(result.matchedLineagePrefix).toBe(cacheModel.fallbackRefLineagePrefixes[0]);
  });

  it('returns a miss when no base cache is restored', async () => {
    const result = await restoreBaseCache(cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('miss');
  });

  it('reports unavailable when the backend cannot restore the newest prefix match', async () => {
    let restoreCalls = 0;
    const result = await restoreBaseCache(cacheModel, {
      cacheBackend: createCacheBackend(
        {
          isFeatureAvailable: () => true,
          restoreCache: async () => {
            restoreCalls += 1;
            return undefined;
          },
          saveCache: async () => 0,
        },
        {
          ...STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
          supportsNewestPrefixRestore: false,
        },
      ),
    });

    expect(restoreCalls).toBe(0);
    expect(result.status).toBe('feature-unavailable');
  });

  it('checks backend availability once when restore is unavailable', async () => {
    let availabilityChecks = 0;
    const result = await restoreBaseCache(cacheModel, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => {
          availabilityChecks += 1;
          return false;
        },
        restoreCache: async () => undefined,
        saveCache: async () => 0,
      }),
    });

    expect(result.status).toBe('feature-unavailable');
    expect(availabilityChecks).toBe(1);
  });

  it('rejects a lineage prefix returned as though it were a saved generation', async () => {
    await expect(
      restoreBaseCache(cacheModel, {
        cacheBackend: createCacheBackend({
          isFeatureAvailable: () => true,
          restoreCache: async () => cacheModel.currentRefLineagePrefix,
          saveCache: async () => 0,
        }),
      }),
    ).rejects.toThrow(/outside the requested cache lineages/u);
  });
});

describe('saveBaseCache', () => {
  it('skips saving when no material generation is required', async () => {
    let saveCalls = 0;
    const result = await saveBaseCache(baseConfig, cacheModel, () => null, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => {
          saveCalls += 1;
          return 77;
        },
      }),
    });

    expect(saveCalls).toBe(0);
    expect(result.status).toBe('not-required');
    expect(result.generationKey).toBeNull();
  });

  it('rejects a generation that does not belong to the current writer and lineage', async () => {
    await expect(
      saveBaseCache(
        baseConfig,
        cacheModel,
        () => ({ ...generation, generationId: 'run-999-attempt-1-job-bbbbbbbbbbbb' }),
        {
          cacheBackend: createCacheBackend({
            isFeatureAvailable: () => true,
            restoreCache: async () => undefined,
            saveCache: async () => 77,
          }),
        },
      ),
    ).rejects.toThrow(/does not belong to the current cache family and ref lineage/u);
  });

  it('skips saving in read-only mode', async () => {
    let generationCalls = 0;
    const result = await saveBaseCache(
      { ...baseConfig, readOnly: true },
      cacheModel,
      () => {
        generationCalls += 1;
        return generation;
      },
      {
        cacheBackend: createCacheBackend({
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => 999,
        }),
      },
    );

    expect(result.status).toBe('read-only');
    expect(result.generationKey).toBeNull();
    expect(generationCalls).toBe(0);
  });

  it('skips saving for distributed workers', async () => {
    const result = await saveBaseCache(
      { ...baseConfig, jobMode: 'distributed-worker' },
      cacheModel,
      () => generation,
      {
        cacheBackend: createCacheBackend({
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => 999,
        }),
      },
    );

    expect(result.status).toBe('distributed-worker');
  });

  it('reports saved cache IDs for eligible saves', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, () => generation, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 77,
      }),
    });

    expect(result.status).toBe('saved');
    expect(result.cacheId).toBe(77);
  });

  it('skips saving when the cache backend does not support explicit saves', async () => {
    let saveCalls = 0;

    const result = await saveBaseCache(baseConfig, cacheModel, () => generation, {
      cacheBackend: createCacheBackend(
        {
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => {
            saveCalls += 1;
            return 77;
          },
        },
        {
          ...STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
          supportsExplicitSave: false,
        },
      ),
    });

    expect(saveCalls).toBe(0);
    expect(result.status).toBe('feature-unavailable');
    expect(result.message).toMatch(/does not support explicit save operations/i);
  });

  it('skips saving when no cache paths currently exist on disk', async () => {
    const missingPathsError = new Error(
      'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.',
    );
    const result = await saveBaseCache(baseConfig, cacheModel, () => generation, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => {
          throw missingPathsError;
        },
        // Simulates the same detection logic as createGitHubBaseCacheBackend so the service
        // maps the provider-specific error to the generic 'missing-paths' result status.
        isMissingPathsError: (error) =>
          error instanceof Error && error.message.includes('Path Validation Error'),
      }),
    });

    expect(result.status).toBe('missing-paths');
    expect(result.message).toMatch(/none of the configured cache paths exist yet/i);
  });

  it('returns not-saved when the toolkit declines to create a new cache entry', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, () => generation, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => -1,
      }),
    });

    expect(result.status).toBe('not-saved');
  });

  it('reports unrelated save failures without claiming the generation was saved', async () => {
    const result = await saveBaseCache(baseConfig, cacheModel, () => generation, {
      cacheBackend: createCacheBackend({
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => {
          throw new Error('boom');
        },
      }),
    });

    expect(result.status).toBe('failed');
    expect(result.generationKey).toBe(generation.key);
    expect(result.cacheId).toBeNull();
    expect(result.message).toContain('publication failed');
    expect(result.message).toContain('boom');
  });
});
