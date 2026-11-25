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

import { readFile, readdir, writeFile, mkdir, rename } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import { createCachePartitions } from '../../../src/cache/model';
import { resolveCacheModel } from '../../../src/cache/streaming/model';
import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../../src/build-tool/gradle/config';
import { fixtureCi } from '../../support/ci-fixture';
import { gradleSeedPath } from '../../../src/cache/streaming/gradle-layer';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import { gradleResolver } from './quiescence-fixture';
import { memoryArtifacts } from './memory-artifact-fixture';
import * as nativeWalk from '../../../src/cache/streaming/native-walk';
import * as observations from '../../../src/cache/streaming/observation-capture';

const ARTIFACT = 'caches/modules-2/files-2.1/g/a/1/hash/a.jar';
const METADATA = 'caches/modules-2/metadata-2.107/descriptors.bin';
const SUPPORT = 'caches/resources-2/shared/resource';
const fixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
function model(overrides: Parameters<typeof createCachePartitions>[0] = []) {
  const config = normalizeGradleActionConfig(readGradleActionInputs({ getInput: () => '' }), {
    phase: 'prepare',
    ciContext: fixtureCi('/cache'),
    env: { GRADLE_USER_HOME: '/cache' },
  });
  const adapter = new GradleBuildToolAdapter(config),
    hard = adapter.getHardCacheExcludeGlobs();
  return resolveCacheModel(
    {
      buildToolId: 'gradle',
      hardCacheExcludeGlobs: hard,
      dependencyCacheLayer: true,
      partitions: createCachePartitions(
        [{ id: 'dependency-metadata', writer: 'writer' }, ...overrides],
        adapter.getBuiltInPartitionPresets(),
        hard,
      ),
    },
    'layer-test-',
    1,
  );
}
async function fixture(
  overrides: Parameters<typeof model>[0] = [],
  metadata = METADATA,
  width = 1,
) {
  const f = await metadataFixture(model(overrides));
  fixtures.push(f);
  const seeded = await f.seed({
    'dependency-artifacts': {
      [ARTIFACT]: 'INHERITED-ARTIFACT',
      ...Object.fromEntries(
        Array.from({ length: width - 1 }, (_, i) => [ARTIFACT + '.' + i, 'body']),
      ),
    },
    'dependency-metadata': {
      [metadata]: 'inherited metadata',
      ...Object.fromEntries(
        Array.from({ length: width - 1 }, (_, i) => [metadata + '.' + i, 'metadata']),
      ),
    },
    'module-support': { [SUPPORT]: 'writable support' },
  });
  const inspect = vi.fn(async () => ({ remaining: false, uncertain: false }));
  const lifecycle = gradleResolver({ inspect });
  const prepare = (extra: Parameters<typeof f.prepare>[0] = {}) =>
    f.prepare({
      policy: { ...f.request.policy, role: 'distributed-worker' },
      gradleLayerVersion: () => '9.6.1',
      lifecycle,
      installHooks: (store, selected, version) =>
        selected.prepareCapture(store, { tempDirectory: f.directory }, async () => {}, version),
      ...extra,
    });
  return { ...f, seeded, inspect, lifecycle, prepare };
}

it('routes original artifact and metadata receipts into an owned coherent seed and settles it before worker completion', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  expect(ready.gradleSeed).not.toBeNull();
  const seed = ready.gradleSeed!,
    path = gradleSeedPath(ready.store, seed);
  expect(await readFile(path + '/modules-2/files-2.1/g/a/1/hash/a.jar', 'utf8')).toBe(
    'INHERITED-ARTIFACT',
  );
  expect(await readFile(path + '/modules-2/metadata-2.107/descriptors.bin', 'utf8')).toBe(
    'inherited metadata',
  );
  expect(await ready.store.root.stat(ARTIFACT)).toBeNull();
  expect(await ready.store.root.stat(METADATA)).toBeNull();
  expect(await readFile(f.root + '/' + SUPPORT, 'utf8')).toBe('writable support');
  const opened = await OpenedInvocation.open(ready.anchor, f.budget);
  const handoff = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  try {
    expect(handoff.header[1]).toBe(4);
    expect(handoff.header[12]).toEqual(seed);
  } finally {
    handoff.close();
  }
  const added = 'caches/modules-2/files-2.1/g/b/1/hash/b.jar';
  await mkdir(f.root + '/caches/modules-2/files-2.1/g/b/1/hash', { recursive: true });
  await writeFile(f.root + '/' + added, 'NEW-DEPENDENCY');
  const artifacts = memoryArtifacts();
  const captured = vi.spyOn(observations, 'captureObservations');
  const result = await postStreamingWorker({
    anchor: ready.anchor,
    budget: f.budget,
    lifecycle: f.lifecycle,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  expect(result.outcome).toBe('worker-uploaded');
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(captured).toHaveBeenCalledTimes(1);
  expect(await ready.store.root.stat(seed[2])).toBeNull();
  const bytes = gunzipSync([...artifacts.objects.values()][0].bytes);
  expect(bytes.includes(Buffer.from('INHERITED-ARTIFACT'))).toBe(false);
  expect(bytes.includes(Buffer.from('NEW-DEPENDENCY'))).toBe(true);
  expect(bytes.includes(Buffer.from(seed[2]))).toBe(false);
});

it.each([
  'unknown-version',
  'unsupported-version',
  'writer',
  'partial',
  'opt-out',
  'layout',
] as const)(
  'keeps a complete ordinary writable restore for %s before detaching any seed source',
  async (kind) => {
    const f = await fixture(
      kind === 'opt-out' ? [{ id: 'dependency-artifacts', readOnlyLayer: false }] : [],
      kind === 'layout' ? METADATA.replace('2.107', '2.106') : METADATA,
    );
    if (kind === 'partial') {
      const entry = f.seeded.entries.find((e) => e[1] === 'dependency-metadata')!;
      if (entry[0] !== 'object') {
        throw new Error('fixture');
      }
      f.objects.delete(entry[2][2]);
    }
    const ready = await f.prepare({
      ...(kind === 'unknown-version'
        ? { gradleLayerVersion: undefined }
        : kind === 'unsupported-version'
          ? { gradleLayerVersion: () => '9.7.0' }
          : {}),
      ...(kind === 'writer'
        ? {
            context: [
              ...f.request.context.slice(0, 4),
              'writer',
              ...f.request.context.slice(5),
            ] as typeof f.request.context,
          }
        : {}),
    });
    expect(ready.gradleSeed).toBeNull();
    expect(await readFile(f.root + '/' + ARTIFACT, 'utf8')).toBe('INHERITED-ARTIFACT');
    expect(await readFile(f.root + '/' + SUPPORT, 'utf8')).toBe('writable support');
    expect(await ready.store.root.stat(ready.store.prefix + 'seed')).toBeNull();
  },
);

it.each(['seed-rename-before-stat', 'prepare-between-seed-and-live'])(
  'settles the private seed when %s fails before remaining live installation',
  async (failure) => {
    const f = await fixture();
    await expect(
      f.prepare({
        fail: async (point) => {
          if (point === failure) {
            throw new Error('between routes');
          }
        },
      }),
    ).rejects.toThrow('between routes');
    expect(await f.store.root.stat(ARTIFACT)).toBeNull();
    expect(await f.store.root.stat(SUPPORT)).toBeNull();
    expect(await readdir(f.root + '/' + f.store.prefix + 'seed')).toEqual([]);
    expect(f.inspect).toHaveBeenCalledTimes(1);
  },
);

it('retains and reports an advertised seed when worker consumers cannot settle before capture', async () => {
  const f = await fixture(),
    ready = await f.prepare(),
    seed = ready.gradleSeed!;
  f.inspect.mockResolvedValue({ remaining: false, uncertain: true });
  const capture = vi.spyOn(observations, 'captureObservations'),
    warnings: string[] = [];
  await expect(
    postStreamingWorker({
      anchor: ready.anchor,
      budget: f.budget,
      lifecycle: f.lifecycle,
      artifactBackend: async () => memoryArtifacts().api,
      assertCurrent: (): undefined => {},
      onWarning: (s) => warnings.push(s),
    }),
  ).rejects.toThrow('seed retained at');
  expect(capture).not.toHaveBeenCalled();
  expect(await ready.store.root.stat(seed[2])).not.toBeNull();
  expect(warnings.join(' ')).toContain(gradleSeedPath(ready.store, seed));
});

it('keeps shared-directory seed moves constant and post capture outside the seed as dependency counts grow', async () => {
  const metrics: {
    width: number;
    moves: number;
    rows: number;
    retirement: number;
    walks: number;
  }[] = [];
  for (const width of [4, 8, 16]) {
    const f = await fixture(
        [
          {
            id: 'custom',
            includes: ['**'],
            excludes: ['caches/**', 'init.d/**', 'wrapper/**'],
            purgeableGlobs: ['**/*.scratch'],
          },
        ],
        METADATA,
        width,
      ),
      ready = await f.prepare(),
      seed = ready.gradleSeed!;
    expect(seed).not.toBeNull();
    expect(ready.store.codec.options.model.purge(seed[2] + '/caches/secret.scratch')).toEqual([]);
    const stage = ready.store.root.work;
    expect(stage.bodyHashBytes).toBe(0);
    const original = nativeWalk.walkNative;
    let visits = 0;
    const roots = new Set<Parameters<typeof original>[0]>();
    const walk = vi.spyOn(nativeWalk, 'walkNative').mockImplementation(async function* (...args) {
      roots.add(args[0]);
      for await (const event of original(...args)) {
        expect(event.nativePath.startsWith(seed[2] + '/')).toBe(false);
        visits++;
        yield event;
      }
    });
    await postStreamingWorker({
      anchor: ready.anchor,
      budget: f.budget,
      lifecycle: f.lifecycle,
      artifactBackend: async () => memoryArtifacts().api,
      assertCurrent: (): undefined => {},
    });
    walk.mockRestore();
    const post = [...roots].map((root) => root.work);
    expect(post.reduce((n, work) => n + work.bodyHashBytes, 0)).toBe(0);
    expect(f.inspect).toHaveBeenCalledTimes(2);
    metrics.push({
      width,
      moves: stage.renames,
      rows: stage.metadataRowsRead,
      retirement: post.reduce((n, work) => n + work.cleanupFiles, 0),
      walks: visits,
    });
  }
  expect(new Set(metrics.map((m) => m.moves)).size).toBe(1);
  expect(new Set(metrics.map((m) => m.walks)).size).toBe(1);
  expect(metrics[2].rows - metrics[1].rows).toBeLessThanOrEqual(
    2 * (metrics[1].rows - metrics[0].rows) + 32,
  );
  expect(metrics[2].retirement - metrics[1].retirement).toBe(
    2 * (metrics[1].retirement - metrics[0].retirement),
  );
  expect(metrics[2].retirement).toBeGreaterThan(metrics[0].retirement);
});

it('retires the settled seed when the worker abandons publication without an artifact backend', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  const result = await postStreamingWorker({
    anchor: ready.anchor,
    budget: f.budget,
    lifecycle: f.lifecycle,
    artifactBackend: async () => {
      throw new Error('unavailable');
    },
    assertCurrent: (): undefined => {},
  });
  expect(result.outcome).toBe('abandoned');
  expect(await ready.store.root.stat(ready.gradleSeed![2])).toBeNull();
  expect(f.inspect).toHaveBeenCalledTimes(2);
});

it('rejects a replaced seed owner before capture and preserves the replacement contents', async () => {
  const f = await fixture(),
    ready = await f.prepare(),
    seed = ready.gradleSeed!;
  const root = ready.store.root.resolve(seed[2]);
  await rename(root, root + '.original');
  await mkdir(root);
  await writeFile(root + '/caller-data', 'preserve');
  const capture = vi.spyOn(observations, 'captureObservations');
  await expect(
    postStreamingWorker({
      anchor: ready.anchor,
      budget: f.budget,
      lifecycle: f.lifecycle,
      artifactBackend: async () => memoryArtifacts().api,
      assertCurrent: (): undefined => {},
    }),
  ).rejects.toThrow('seed owner missing or changed');
  expect(capture).not.toHaveBeenCalled();
  expect(await readFile(root + '/caller-data', 'utf8')).toBe('preserve');
});

it('does not adopt or retire a replacement installed after the original seed staging barrier', async () => {
  const f = await fixture();
  let root = '';
  await expect(
    f.prepare({
      fail: async (point) => {
        if (point !== 'seed-before-owner-seal') {
          return;
        }
        const [id] = await readdir(f.root + '/' + f.store.prefix + 'seed');
        root = f.root + '/' + f.store.prefix + 'seed/' + id;
        await rename(root, root + '.original');
        await mkdir(root);
        await writeFile(root + '/caller-data', 'preserve replacement');
      },
    }),
  ).rejects.toThrow('Private Gradle seed retained at');
  expect(await readFile(root + '/caller-data', 'utf8')).toBe('preserve replacement');
  expect(
    await readFile(root + '.original/caches/modules-2/files-2.1/g/a/1/hash/a.jar', 'utf8'),
  ).toBe('INHERITED-ARTIFACT');
  expect(await f.store.root.stat(SUPPORT)).toBeNull();
});
