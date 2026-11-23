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

import type * as Fs from 'node:fs/promises';
import { readFile, rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../../src/config/types';
import { createCachePartitions } from '../../../src/cache/model';
import { resolveCacheModel } from '../../../src/cache/streaming/model';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { executeFixtureGc as executeGc } from './observation-fixtures';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
import { MetadataBaseRestore } from '../../../src/cache/streaming/metadata-base-restore';
import { lineageId } from '../../../src/cache/streaming/model';
import { sameNative, sameRename } from '../../../src/cache/streaming/native';
import { walkNative } from '../../../src/cache/streaming/native-walk';
import { observationFixture } from './observation-fixtures';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  await cleanupBaseFixtures();
});
const config: NormalizedGradleConfig = {
  phase: 'prepare',
  baseDirectory: '.',
  cacheEnabled: true,
  readOnly: false,
  jobMode: 'standalone',
  dependentJobs: [],
  workerArtifactRetentionDays: 7,
  allowDuplicateDependentDeltaPaths: false,
  cacheKeyPrefix: 'test-',
  cachePartitions: [],
  cacheSchemaVersion: 2,
  cleanupEnabled: true,
  restoreCleanupMode: 'none',
  cacheGcMode: 'off',
  cacheGcOlderThanDays: 14,
  wrapperSelectionMode: 'default',
  wrapperPropertiesGlob: '**/gradle-wrapper.properties',
  defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
  wrapperPropertiesFiles: [],
  gradleUserHome: '/cache',
};
it.each([false, true])(
  'purges an actual default lock, returns sources and excludes preserved unknown siblings; split=%s',
  async (split) => {
    const adapter = new GradleBuildToolAdapter(config),
      model = resolveCacheModel(
        {
          buildToolId: 'gradle',
          hardCacheExcludeGlobs: adapter.getHardCacheExcludeGlobs(),
          partitions: createCachePartitions(
            '/cache',
            [],
            adapter.getBuiltInPartitionPresets(),
            adapter.getHardCacheExcludeGlobs(),
          ),
        },
        'purge-',
        1,
      ),
      f = await observationFixture('gradle', { model }),
      root = 'caches/build-cache-1',
      lock = root + '/build-cache-1.lock';
    cleanup.push(async () => {
      await f.finish();
      expect(f.budget.retained).toBe(0);
      await f.close();
    });
    await f.files('', {
      [root + '/entry-a']: 'a',
      [root + '/entry-b']: 'b',
      [lock]: 'runtime',
      ...(split ? { [root + '/keep.lock']: 'private' } : {}),
    });
    const before = (await f.store.root.stat(root + '/entry-a'))!;
    const out = await captureObservations(f.store, {
      budget: f.budget,
      purgeWindow: {
        root: f.store.root,
        invocation: f.store.codec.options.invocation,
        assertCurrent: (): undefined => {},
      },
    });
    expect(out.purge.deleted).toBe(1);
    expect(await f.store.root.stat(lock)).toBeNull();
    const result = await executeGc(f.store, { budget: f.budget }),
      input = await MetadataPublicationSource.survivors(result.owner),
      sdk = await nativeCacheBackend();
    cleanup.push(() => input.dispose());
    const start = vi.mocked(rename).mock.calls.length;
    const published = await publishMetadataBase(input, sdk.backend, {
      lineage: lineageId('main'),
      writer: 'a'.repeat(64),
      decision: 'b'.repeat(64),
    });
    expect(published.outcome).toBe('published');
    const managedMoves = vi
      .mocked(rename)
      .mock.calls.slice(start)
      .filter(([a, b]) =>
        [a, b].some(
          (p) =>
            String(p) === f.store.root.resolve('caches') ||
            String(p) === f.store.root.resolve(root) ||
            String(p).startsWith(f.store.root.resolve(root) + '/entry-'),
        ),
      );
    expect(managedMoves).toHaveLength(split ? 4 : 2);
    const after = (await f.store.root.stat(root + '/entry-a'))!;
    expect(split ? sameRename(before, after) : sameNative(before, after, true)).toBe(true);
    if (split)
      expect(await readFile(f.store.root.resolve(root + '/keep.lock'), 'utf8')).toBe('private');
    const restored = await MetadataBaseRestore.acquire(
      f.store,
      sdk.backend,
      { currentRef: 'main' },
      { budget: f.budget },
    );
    try {
      const source = restored.context?.source('build-cache');
      expect(source).toBeDefined();
      const files = [];
      for await (const e of walkNative(f.store.root, source!.nativeRoot, {
        budget: f.budget,
        logicalRoot: '',
      }))
        if (e.tag === 'file') files.push(e.path);
      expect(files.sort()).toEqual([root + '/entry-a', root + '/entry-b']);
      expect(
        await readFile(f.store.root.resolve(source!.nativeRoot + '/' + root + '/entry-a'), 'utf8'),
      ).toBe('a');
      for (const call of sdk.calls.filter((c) => c.kind === 'save'))
        expect(call.members).not.toContain('tree.ndjson');
    } finally {
      await restored.dispose();
    }
  },
  60000,
);
