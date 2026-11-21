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
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import {
  FrozenMovingPublication,
  movingObjectRef,
} from '../../../src/cache/streaming/base-moving-publication';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import { NativeObjectDownload } from '../../../src/cache/streaming/base-transport';
import { sameNative, sameRename } from '../../../src/cache/streaming/native';
import { tuple } from '../../../src/cache/streaming/encoding';
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
    await executeGc(f.store, { budget: f.budget });
    const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
    cleanup.push(() => input.dispose());
    const pub = await FrozenMovingPublication.freeze(input, 'main');
    cleanup.push(() => pub.dispose());
    const choice = pub.choices.find((c) => c[1] === 'build-cache')!;
    if (choice[0] !== 'new') throw new Error('Expected default build-cache publication.');
    const roots: string[] = [],
      kinds: string[] = [];
    for await (const row of f.store.rows(choice[6], 'move-plan', {
      ...pub.options,
      partition: 'build-cache',
    })) {
      const r = tuple(row.value);
      if (r[0] === 'move') {
        roots.push(String(r[3]));
        kinds.push(String(r[5]));
      }
    }
    expect(kinds).toEqual(split ? ['file', 'file'] : ['directory']);
    const sdk = await nativeCacheBackend(),
      publisher = MovingBasePublication.open(pub);
    cleanup.push(() => publisher.close());
    const start = vi.mocked(rename).mock.calls.length;
    await publisher.saveObjects(sdk.backend);
    const moves = vi
      .mocked(rename)
      .mock.calls.slice(start)
      .filter(([a, b]) =>
        roots.some(
          (r) => String(a) === f.store.root.resolve(r) || String(b) === f.store.root.resolve(r),
        ),
      );
    expect(moves).toHaveLength(2 * roots.length);
    const after = (await f.store.root.stat(root + '/entry-a'))!;
    expect(split ? sameRename(before, after) : sameNative(before, after, true)).toBe(true);
    if (split)
      expect(await readFile(f.store.root.resolve(root + '/keep.lock'), 'utf8')).toBe('private');
    await f.store.assertNoIntents();
    await publisher.publish(sdk.backend);
    const restored = await NativeObjectDownload.restore(
      f.store,
      sdk.backend,
      movingObjectRef(choice),
      pub.options,
      true,
    );
    try {
      expect(restored.object).not.toBeNull();
      const files = [];
      for await (const e of walkNative(f.store.root, restored.object!.payload, {
        budget: f.budget,
        logicalRoot: '',
      }))
        if (e.tag === 'file') files.push(e.path);
      expect(files.sort()).toEqual([root + '/entry-a', root + '/entry-b']);
      expect(
        await readFile(
          f.store.root.resolve(restored.object!.payload + '/' + root + '/entry-a'),
          'utf8',
        ),
      ).toBe('a');
      expect(sdk.calls.find((c) => c.kind === 'save' && c.key === choice[3])?.members).toHaveLength(
        3,
      );
    } finally {
      await restored.dispose();
    }
  },
  60000,
);
