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

import { retireGradleOverlay } from '../../src/cache/streaming/gradle-overlay';
import { linuxOverlayMount } from '../../src/cache/streaming/overlay-mount';
import { GRADLE_ARTIFACTS } from '../../src/cache/streaming/gradle-layer';
import { test, expect, vi } from 'vitest';
import * as nativeWalk from '../../src/cache/streaming/native-walk';
import { runStreamingPost } from '../../src/phases/streaming/post';
import { STREAMING_INVOCATION_STATE } from '../../src/phases/streaming/state';
import {
  JOB_PREPARE_FAILED_STATE,
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
} from '../../src/guard/job-single-run';
import { encodeInvocationAnchor } from '../../src/cache/streaming/invocation';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, unlink, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { metadataFixture } from '../cache/streaming/base-publication-fixtures';
import { gradleResolver } from '../cache/streaming/quiescence-fixture';
import { memoryArtifacts } from '../cache/streaming/memory-artifact-fixture';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { cleanupGradleBuildResultCapture } from '../../src/build-tool/gradle/build-results';
import { createCachePartitions } from '../../src/cache/model';
import { resolveCacheModel } from '../../src/cache/streaming/model';
import { postStreamingBase } from '../../src/cache/streaming/base-post';
import { postStreamingWorker } from '../../src/cache/streaming/worker-post';
import { postStreamingReadOnly } from '../../src/cache/streaming/passive-lifecycle';
import { gradleSeedPath } from '../../src/cache/streaming/gradle-layer';
import { fixtureCi } from '../support/ci-fixture';

const exec = promisify(execFile);
const oldBody = Buffer.from('inherited artifact body, resolved only from the read-only seed');
const newBody = Buffer.from('new artifact body, downloaded into the writable head');
const artifactPath = (name: string, body: Buffer) =>
  'caches/modules-2/files-2.1/org.example/' +
  name +
  '/1.0/' +
  createHash('sha1').update(body).digest('hex') +
  '/' +
  name +
  '-1.0.jar';

async function digests(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const member = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        await visit(member);
      } else {
        result[member] = createHash('sha256')
          .update(await readFile(path.join(root, member)))
          .digest('hex');
      }
    }
  }
  await visit('');
  return result;
}

const overlayModes: [boolean, number][] =
  process.env.MAMMOTH_TEST_OVERLAY === '1'
    ? [
        [false, 4],
        [true, 4],
        [true, 64],
      ]
    : [[false, 4]];
test.each(overlayModes)(
  'Gradle publishes a complete offline cache with writer overlay-fs=%s and %s inherited units',
  proveGradleLayerAndOverlay,
  300000,
);

async function proveGradleLayerAndOverlay(useOverlay: boolean, width: number) {
  const overlayMount = linuxOverlayMount();

  const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
  if (!executable) {
    throw new Error(
      'Set BUILDISH_TEST_GRADLE_EXECUTABLE to an already installed Gradle 9.6.1 executable.',
    );
  }
  const config = normalizeGradleActionConfig(readGradleActionInputs({ getInput: () => '' }), {
    phase: 'prepare',
    ciContext: fixtureCi('/cache'),
    env: { GRADLE_USER_HOME: '/cache' },
  });
  const adapter = new GradleBuildToolAdapter(config),
    hard = adapter.getHardCacheExcludeGlobs();
  const model = resolveCacheModel(
    {
      buildToolId: 'gradle',
      hardCacheExcludeGlobs: hard,
      dependencyCacheLayer: true,
      partitions: createCachePartitions(
        [{ id: 'dependency-metadata', writer: 'writer' }],
        adapter.getBuiltInPartitionPresets(),
        hard,
      ),
    },
    'real-gradle-layer-',
    1,
  );
  const f = await metadataFixture(model),
    artifacts = memoryArtifacts();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const member = request.url ?? '';
    requests.push((request.method ?? '') + ' ' + member);
    const match = /^\/repository\/org\/example\/(seeded|miss)\/1\.0\/\1-1\.0\.(pom|jar)$/.exec(
      member,
    );
    if (!match) {
      response.writeHead(404);
      response.end();
      return;
    }
    const name = match[1],
      body =
        match[2] === 'jar'
          ? name === 'seeded'
            ? oldBody
            : newBody
          : Buffer.from(
              '<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>' +
                name +
                '</artifactId><version>1.0</version></project>',
            );
    response.writeHead(200, {
      'Content-Length': body.length,
      'Last-Modified': 'Wed, 01 Jan 2020 00:00:00 GMT',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  let completed = false;
  let writerMount: Awaited<ReturnType<typeof f.prepare>> | undefined;
  const homes = new Set<string>();
  try {
    const version = await exec(executable, ['--version'], {
      env: {
        ...process.env,
        GRADLE_USER_HOME: f.directory + '/version-home',
        GRADLE_RO_DEP_CACHE: '',
      },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    expect(version.stdout).toMatch(/^Gradle 9\.6\.1$/m);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Local repository address unavailable');
    }
    const project = f.directory + '/project';
    await mkdir(project);
    await writeFile(project + '/settings.gradle', "rootProject.name = 'layer-proof'\n");
    await writeFile(
      project + '/build.gradle',
      `
repositories { maven { url = uri('http://127.0.0.1:${address.port}/repository'); allowInsecureProtocol = true } }
configurations { seeded; missing }
dependencies { seeded 'org.example:seeded:1.0'; missing 'org.example:miss:1.0' }
tasks.register('resolveSeed') { doLast { assert configurations.seeded.singleFile.bytes.length > 0 } }
tasks.register('resolveLayeredSeed') { doLast {
  def seed = System.getenv('GRADLE_RO_DEP_CACHE')
  assert seed : 'Missing read-only dependency seed'
  def store = new File(seed, 'modules-2/files-2.1').canonicalFile.toPath()
  def artifact = configurations.seeded.singleFile.canonicalFile
  assert artifact.toPath().startsWith(store) : "Resolved outside seed: $artifact"
  assert artifact.bytes.length > 0 : 'Empty seed artifact'
  println("resolved seed artifact: $artifact")
} }
tasks.register('resolveMiss') { doLast { assert configurations.missing.singleFile.bytes.length > 0 } }
tasks.register('resolveBoth') { dependsOn 'resolveSeed', 'resolveMiss' }
`,
    );
    const lifecycle = gradleResolver({
      inspect: async () => ({ remaining: false, uncertain: false }),
    });
    async function prepare(
      name: string,
      role: 'standalone' | 'distributed-worker' | 'distributed-aggregator',
      extra: Parameters<typeof f.prepare>[0] = {},
    ) {
      const home = f.directory + '/' + name;
      homes.add(home);
      return f.prepare({
        root: home,
        context: ['github', 'fixture/repo', 'proof', '42', name, 1, 'revision', 'gradle'],
        policy: {
          ...f.request.policy,
          role,
          gcAgeMs: 14 * 86400000,
          ordinaryOrder: role === 'distributed-aggregator' ? ['worker', 'writer'] : [],
        },
        hasGradleWrapper: () => true,
        lifecycle,
        artifactBackend: async () => artifacts.api,
        installHooks: (store, selected, layered) =>
          selected.prepareCapture(store, { tempDirectory: f.directory }, async () => {}, layered),
        ...extra,
      });
    }
    async function build(home: string, task: string, seed = '', offline = false) {
      const logs = await exec(
        executable!,
        [
          '--no-daemon',
          '--max-workers=2',
          '--console=plain',
          ...(offline ? ['--offline'] : []),
          task,
        ],
        {
          cwd: project,
          env: { ...process.env, GRADLE_USER_HOME: home, GRADLE_RO_DEP_CACHE: seed },
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      expect(logs.stdout + logs.stderr).toContain('BUILD SUCCESSFUL');
    }
    async function basePost(ready: Awaited<ReturnType<typeof prepare>>) {
      return postStreamingBase({
        anchor: ready.anchor,
        budget: f.budget,
        lifecycle,
        cacheBackend: async () => f.api,
        removeHooks: async () => {
          await cleanupGradleBuildResultCapture(ready.store.root.path);
        },
        assertCurrent: (): undefined => {},
      });
    }
    async function workerPost(ready: Awaited<ReturnType<typeof prepare>>) {
      return postStreamingWorker({
        overlayMount,
        anchor: ready.anchor,
        budget: f.budget,
        lifecycle,
        artifactBackend: async () => artifacts.api,
        removeHooks: async () => {
          await cleanupGradleBuildResultCapture(ready.store.root.path);
        },
        assertCurrent: (): undefined => {},
      });
    }
    const producer = await prepare('producer', 'standalone');
    await build(producer.store.root.path, 'resolveSeed');
    const old = artifactPath('seeded', oldBody),
      fresh = artifactPath('miss', newBody);
    const aged = new Date(Date.now() - 30 * 86400000);
    await utimes(producer.store.root.resolve(old), aged, aged);
    const inherited = (i: number) =>
      GRADLE_ARTIFACTS + '/fixture/retained-' + i + '/1/hash/artifact.jar';
    for (let i = 0; i < width; i++) {
      const member = producer.store.root.resolve(inherited(i));
      await mkdir(path.dirname(member), { recursive: true });
      await writeFile(member, 'inherited fixture ' + i);
      await utimes(member, aged, aged);
    }
    const initial = await basePost(producer);
    expect(initial.outcome).toBe('published');
    const worker = await prepare('worker', 'distributed-worker');
    expect(worker.restoredKey).toBe(initial.key);
    expect(worker.gradleSeed).not.toBeNull();
    const seed = gradleSeedPath(worker.store, worker.gradleSeed!);
    expect(await worker.store.root.stat(old)).toBeNull();
    const before = await digests(seed),
      priorRequests = requests.length;
    await build(worker.store.root.path, 'resolveLayeredSeed', seed, true);
    expect(requests).toHaveLength(priorRequests);
    expect(await worker.store.root.stat(old)).toBeNull();
    await build(worker.store.root.path, 'resolveMiss', seed);
    expect(requests.some((r) => r === 'GET /repository/org/example/miss/1.0/miss-1.0.jar')).toBe(
      true,
    );
    expect(await readFile(worker.store.root.resolve(fresh))).toEqual(newBody);
    expect(await digests(seed)).toEqual(before);
    expect((await workerPost(worker)).outcome).toBe('worker-uploaded');
    const raw = gunzipSync([...artifacts.objects.values()][0].bytes);
    expect(raw.includes(oldBody)).toBe(false);
    expect(raw.includes(newBody)).toBe(true);
    expect(await worker.store.root.stat(worker.gradleSeed![2])).toBeNull();
    const writer = await prepare('writer', 'distributed-worker', {
      overlayFs: useOverlay,
      overlayMount,
    });
    writerMount = writer;
    const mountedPath = path.join(writer.store.root.path, GRADLE_ARTIFACTS);
    expect(!!writer.gradleOverlay).toBe(useOverlay);
    expect(!!(await overlayMount?.inspect(mountedPath))).toBe(useOverlay);

    expect(writer.gradleSeed).toBeNull();
    expect(await readFile(writer.store.root.resolve(old))).toEqual(oldBody);
    await build(writer.store.root.path, 'resolveSeed', '', true);
    await build(writer.store.root.path, 'resolveMiss');
    if (useOverlay) {
      await unlink(writer.store.root.resolve(inherited(0)));
      const opaque = path.dirname(inherited(1));
      await rm(writer.store.root.resolve(opaque), { recursive: true });
      await mkdir(writer.store.root.resolve(opaque));
      await writeFile(writer.store.root.resolve(opaque + '/replacement.jar'), 'opaque replacement');
      await (await open(writer.store.root.resolve(inherited(2)), 'r+')).close();
      const empty = path.dirname(inherited(3)) + '/empty.jar';
      await writeFile(writer.store.root.resolve(empty), '');

      if (width === 4) {
        await expect(
          retireGradleOverlay(writer.store, writer.gradleOverlay!, {
            ...overlayMount!,
            unmount: async () => {
              throw new Error('mount is busy');
            },
          }),
        ).rejects.toThrow('mount is busy');
        expect(await overlayMount!.inspect(mountedPath)).not.toBeNull();
        expect(await writer.store.root.stat(writer.gradleOverlay![2])).not.toBeNull();
      }
      const visited: string[] = [];
      const walk = nativeWalk.walkNative;
      const observation = vi.spyOn(nativeWalk, 'walkNative').mockImplementation(async function* (
        ...args
      ) {
        for await (const event of walk(...args)) {
          if (
            args[0].path === writer.store.root.path &&
            event.tag === 'file' &&
            event.path.startsWith(GRADLE_ARTIFACTS + '/')
          ) {
            visited.push(event.path);
          }
          yield event;
        }
      });
      try {
        expect((await workerPost(writer)).outcome).toBe('worker-uploaded');
      } finally {
        observation.mockRestore();
      }
      expect(visited.filter((member) => member.endsWith('/miss-1.0.pom'))).toHaveLength(1);
      expect(visited.filter((member) => member.endsWith('.jar')).sort()).toEqual(
        [fresh, opaque + '/replacement.jar', inherited(2), empty].sort(),
      );
      expect(visited).toHaveLength(5);
    } else {
      expect((await workerPost(writer)).outcome).toBe('worker-uploaded');
    }
    expect((await overlayMount?.inspect(mountedPath)) ?? null).toBeNull();
    if (useOverlay) {
      const writerArchive = gunzipSync([...artifacts.objects.values()][1].bytes);
      expect(writerArchive.includes(oldBody)).toBe(false);
      expect(writerArchive.includes(newBody)).toBe(true);
    }
    const aggregator = await prepare('aggregator', 'distributed-aggregator', {
      now: () => Date.now() + 10000,
    });
    expect(aggregator.workerCount).toBe(2);
    const published = await basePost(aggregator);
    expect(published.outcome).toBe('published');
    expect(await readFile(aggregator.store.root.resolve(old))).toEqual(oldBody);
    expect(await readFile(aggregator.store.root.resolve(inherited(0)), 'utf8')).toBe(
      'inherited fixture 0',
    );
    expect(await readFile(aggregator.store.root.resolve(inherited(1)), 'utf8')).toBe(
      'inherited fixture 1',
    );
    const consumer = await prepare('consumer', 'standalone', {
      policy: { ...f.request.policy, role: 'standalone', access: 'read-only' },
    });
    expect(consumer.restoredKey).toBe(published.key);
    await build(consumer.store.root.path, 'resolveBoth', '', true);
    await postStreamingReadOnly(consumer.anchor, {
      budget: f.budget,
      assertCurrent: (): undefined => {},
    });
    if (useOverlay && width === 4) {
      // Simulate failure of the first host advertisement write after successful core prepare.
      const failed = await prepare('writer', 'distributed-worker', {
        root: f.directory + '/failed-writer',
        overlayFs: true,
        overlayMount,
      });
      writerMount = failed;
      expect(failed.gradleOverlay).not.toBeNull();
      const state = new Map([
        [JOB_PREPARE_FAILED_STATE, 'true'],
        [JOB_SINGLE_RUN_OWNER_TOKEN_STATE, 'fixture-owner'],
        [STREAMING_INVOCATION_STATE, encodeInvocationAnchor(failed.anchor)],
      ]);
      await expect(
        runStreamingPost({
          overlayMount,
          lifecycle,
          budget: f.budget,
          assertCurrent: (): undefined => {},
          runtimeHost: {
            getState: (name) => state.get(name) ?? '',
            saveState: (name, value) => {
              state.set(name, value);
            },
            info: () => {},
            warning: () => {},
          },
          cacheBackend: async () => {
            throw new Error('unexpected cache backend');
          },
          artifactBackend: async () => {
            throw new Error('unexpected artifact backend');
          },
          loadReport: async () => {
            throw new Error('unexpected report');
          },
          removeHooks: async (root) => {
            await cleanupGradleBuildResultCapture(root);
            return [];
          },
        }),
      ).resolves.toEqual({ outcome: 'skipped' });
      expect(
        await overlayMount!.inspect(path.join(failed.store.root.path, GRADLE_ARTIFACTS)),
      ).toBeNull();
    }
    completed = true;
  } finally {
    if (!completed) {
      for (const home of homes) {
        try {
          await exec(executable, ['--stop'], {
            env: { ...process.env, GRADLE_USER_HOME: home, GRADLE_RO_DEP_CACHE: '' },
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
        } catch {
          /* Preserve the original fixture failure. */
        }
      }
    }
    if (
      overlayMount &&
      writerMount?.gradleOverlay &&
      (await overlayMount.inspect(path.join(writerMount.store.root.path, GRADLE_ARTIFACTS)))
    ) {
      await retireGradleOverlay(writerMount.store, writerMount.gradleOverlay, overlayMount);
    }
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    const retained = f.budget.retained;
    await f.close();
    expect(retained).toBe(0);
  }
}
