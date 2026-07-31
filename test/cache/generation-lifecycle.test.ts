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

import { createCacheGeneration, type CacheModel } from '../../src/cache/model';
import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  calculateCanonicalCacheManifestDigest,
  type CacheManifest,
} from '../../src/cache/manifest';
import { restoreBaseCache, saveBaseCache } from '../../src/cache/service';
import type { NormalizedGradleConfig } from '../../src/config/types';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';

const config: NormalizedGradleConfig = {
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

const baseModel: CacheModel = {
  buildToolId: 'gradle',
  cacheRoot: '/home/runner/.gradle',
  cacheFamilyKey: 'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd',
  currentRefToken: 'main-0d6e4079e367',
  currentRefLineagePrefix:
    'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd-ref-main-0d6e4079e367-gen-',
  fallbackRefLineagePrefixes: [],
  plannedGenerationId: 'run-101-attempt-1-job-aaaaaaaaaaaa',
  // Transitional distributed-delta identity until the v2 envelope lands in Slice 3.
  cacheKey:
    'buildish-mammoth-cache-gradle-v2-21-linux-x64-feedcafe1234abcd-ref-main-0d6e4079e367-gen-',
  javaMajor: 21,
  runnerOs: 'linux',
  runnerArch: 'x64',
  safeRefName: 'main',
  partitionFingerprint: 'feedcafe1234abcd',
  partitions: [],
  includePaths: ['/home/runner/.gradle/caches/modules-2/**'],
  excludePaths: [],
};

describe('immutable cache generation lifecycle', () => {
  it('restores generation 1, saves generation 2, then restores generation 2', async () => {
    const backend = new ImmutableCacheBackend();
    const dependencies = { cacheBackend: backend };
    const generation1 = createCacheGeneration(
      baseModel,
      calculateCanonicalCacheManifestDigest(createManifest('a'.repeat(64))),
    );

    expect((await restoreBaseCache(baseModel, dependencies)).status).toBe('miss');
    expect(
      (await saveBaseCache(config, baseModel, () => generation1, true, dependencies)).status,
    ).toBe('saved');

    const run2Model: CacheModel = {
      ...baseModel,
      plannedGenerationId: 'run-102-attempt-1-job-aaaaaaaaaaaa',
    };
    const run2Restore = await restoreBaseCache(run2Model, dependencies);
    expect(run2Restore.status).toBe('current-lineage-hit');
    expect(run2Restore.matchedKey).toBe(generation1.key);

    const generation2 = createCacheGeneration(
      run2Model,
      calculateCanonicalCacheManifestDigest(createManifest('b'.repeat(64))),
    );
    expect(
      (await saveBaseCache(config, run2Model, () => generation2, true, dependencies)).status,
    ).toBe('saved');

    const run3Restore = await restoreBaseCache(
      {
        ...baseModel,
        plannedGenerationId: 'run-103-attempt-1-job-aaaaaaaaaaaa',
      },
      dependencies,
    );
    expect(run3Restore.status).toBe('current-lineage-hit');
    expect(run3Restore.matchedKey).toBe(generation2.key);
    expect(backend.savedKeys).toEqual([generation1.key, generation2.key]);
  });

  it('rejects attempts to overwrite an immutable generation', async () => {
    const backend = new ImmutableCacheBackend();
    const generation = createCacheGeneration(
      baseModel,
      calculateCanonicalCacheManifestDigest(createManifest('a'.repeat(64))),
    );

    await backend.saveCache([], generation.key);
    await expect(backend.saveCache([], generation.key)).rejects.toThrow(/already exists/u);
  });
});

function createManifest(contentSha256: string): CacheManifest {
  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    buildToolId: 'gradle',
    cacheRoot: '/home/runner/.gradle',
    partitions: [
      {
        partitionId: 'modules',
        entries: [
          {
            relativePath: 'caches/modules-2/example.bin',
            contentSha256,
            size: 10,
            mode: 0o100644,
            atimeMs: 1_000,
            mtimeMs: 2_000,
          },
        ],
      },
    ],
  };
}
