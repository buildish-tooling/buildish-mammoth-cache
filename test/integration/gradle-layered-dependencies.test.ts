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

import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
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

test('Gradle resolves an old dependency only from its immutable seed, contributes a writable miss, and publishes a complete offline cache', async () => {
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
        gradleLayerVersion: () => '9.6.1',
        lifecycle,
        artifactBackend: async () => artifacts.api,
        installHooks: (store, selected, layerVersion) =>
          selected.prepareCapture(
            store,
            { tempDirectory: f.directory },
            async () => {},
            layerVersion,
          ),
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
    const writer = await prepare('writer', 'distributed-worker');
    expect(writer.gradleSeed).toBeNull();
    expect(await readFile(writer.store.root.resolve(old))).toEqual(oldBody);
    await build(writer.store.root.path, 'resolveMiss');
    expect((await workerPost(writer)).outcome).toBe('worker-uploaded');
    const aggregator = await prepare('aggregator', 'distributed-aggregator', {
      now: () => Date.now() + 10000,
    });
    expect(aggregator.workerCount).toBe(2);
    const published = await basePost(aggregator);
    expect(published.outcome).toBe('published');
    expect(await readFile(aggregator.store.root.resolve(old))).toEqual(oldBody);
    const consumer = await prepare('consumer', 'standalone', {
      policy: { ...f.request.policy, role: 'standalone', access: 'read-only' },
    });
    expect(consumer.restoredKey).toBe(published.key);
    await build(consumer.store.root.path, 'resolveBoth', '', true);
    await postStreamingReadOnly(consumer.anchor, {
      budget: f.budget,
      assertCurrent: (): undefined => {},
    });
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
}, 300000);
