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

import { retireOverlay } from '../../src/cache/streaming/overlay';
import { linuxOverlayMount } from '../../src/cache/streaming/overlay-mount';
import { GRADLE_ARTIFACTS } from '../../src/build-tool/gradle/dependency-layer';
import { test, expect, vi } from 'vitest';
import * as nativeWalk from '../../src/cache/streaming/native-walk';
import { runStreamingPost } from '../../src/phases/streaming/post';
import { STREAMING_INVOCATION_STATE } from '../../src/phases/streaming/state';
import {
  JOB_PREPARE_FAILED_STATE,
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
} from '../../src/guard/job-single-run';
import { encodeInvocationAnchor, OpenedInvocation } from '../../src/cache/streaming/invocation';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { metadataFixture } from '../cache/streaming/base-publication-fixtures';
import { gradleResolver } from '../cache/streaming/quiescence-fixture';
import { memoryArtifacts } from '../cache/streaming/memory-artifact-fixture';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import { stopGradleInstallation } from '../../src/build-tool/gradle/stop-client';
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
import { gradleSeedPath } from '../../src/build-tool/gradle/dependency-layer';
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
    const stop = vi.fn(stopGradleInstallation);
    const lifecycle = gradleResolver({
      inspect: async () => ({ remaining: false, uncertain: false }),
      stop,
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
        hasWrapper: () => true,
        lifecycle,
        artifactBackend: async () => artifacts.api,
        installHooks: (store, selected, layered) =>
          selected.prepareCapture(store, { tempDirectory: f.directory }, async () => {}, layered),
        ...extra,
      });
    }
    async function build(home: string, task: string | string[], seed = '', offline = false) {
      const logs = await exec(
        executable!,
        [
          '--no-daemon',
          '--max-workers=2',
          '--console=plain',
          ...(offline ? ['--offline'] : []),
          ...[task].flat(),
        ],
        {
          cwd: project,
          env: { ...process.env, GRADLE_USER_HOME: home, GRADLE_RO_DEP_CACHE: seed },
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      expect(logs.stdout + logs.stderr).toContain('BUILD SUCCESSFUL');
      return logs.stdout;
    }
    async function basePost(
      ready: Awaited<ReturnType<typeof prepare>>,
      extra: Partial<Parameters<typeof postStreamingBase>[0]> = {},
    ) {
      return postStreamingBase({
        overlayMount,
        anchor: ready.anchor,
        budget: f.budget,
        lifecycle,
        cacheBackend: async () => f.api,
        removeHooks: async () => {
          await cleanupGradleBuildResultCapture(ready.store.root.path);
        },
        assertCurrent: (): undefined => {},
        ...extra,
      });
    }
    async function workerPost(ready: Awaited<ReturnType<typeof prepare>>, backend = artifacts.api) {
      return postStreamingWorker({
        overlayMount,
        anchor: ready.anchor,
        budget: f.budget,
        lifecycle,
        artifactBackend: async () => backend,
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
    const workspace = 'caches/transforms-4/' + 'a'.repeat(32);
    const untouchedWorkspace = 'caches/transforms-4/' + 'b'.repeat(32);
    const inheritedMetadata = 'caches/modules-2/metadata-proof/retained.bin';
    const put = async (home: string, relative: string, body: string) => {
      const file = path.join(home, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
      return file;
    };
    for (const unit of [workspace, untouchedWorkspace]) {
      await put(producer.store.root.path, unit + '/metadata.bin', 'transform metadata');
      await put(producer.store.root.path, unit + '/results.bin', 'transform results');
      await put(
        producer.store.root.path,
        unit + '/transformed/retained',
        unit === workspace ? 'inherited workspace member' : 'untouched workspace member',
      );
    }
    for (const member of ['metadata.bin', 'results.bin', 'transformed/retained']) {
      await utimes(
        producer.store.root.resolve(untouchedWorkspace + '/' + member),
        new Date(),
        aged,
      );
    }
    await put(producer.store.root.path, inheritedMetadata, 'untouched metadata member');
    const initial = await basePost(producer);
    expect(initial.outcome).toBe('published');
    const disabledProbe = vi.fn(overlayMount?.inspect);
    const worker = await prepare('worker', 'distributed-worker', {
      overlayFs: false,
      overlayMount: overlayMount && { ...overlayMount, inspect: disabledProbe },
    });
    expect(worker.restoredKey).toBe(initial.key);
    expect(worker.dependencyLayer).not.toBeNull();
    expect(worker.overlay).toBeNull();
    expect(disabledProbe).not.toHaveBeenCalled();
    const seed = gradleSeedPath(worker.store, worker.dependencyLayer!);
    expect(await worker.store.root.stat(old)).toBeNull();
    // The first builds of this installation: registering it must not invalidate the entry.
    const configurationCache = ['help', '--configuration-cache'];
    expect(await build(worker.store.root.path, configurationCache, seed, true)).toContain(
      'Configuration cache entry stored',
    );
    expect(await build(worker.store.root.path, configurationCache, seed, true)).toContain(
      'Configuration cache entry reused',
    );
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
    expect(await worker.store.root.stat(worker.dependencyLayer![2])).toBeNull();
    const unmanaged = await put(
      f.directory + '/writer',
      'local/settings',
      'inherited local settings',
    );
    const writer = await prepare('writer', 'distributed-worker', {
      overlayFs: useOverlay,
      overlayMount,
    });
    writerMount = writer;
    const mountedPath = writer.store.root.path;
    expect(!!writer.overlay).toBe(useOverlay);
    expect(!!(await overlayMount?.inspect(mountedPath))).toBe(useOverlay);

    expect(writer.dependencyLayer).toBeNull();
    expect(await readFile(unmanaged, 'utf8')).toBe('inherited local settings');
    const untouchedMember = untouchedWorkspace + '/transformed/retained';
    expect(await readFile(writer.store.root.resolve(untouchedMember), 'utf8')).toBe(
      'untouched workspace member',
    );
    expect(await readFile(writer.store.root.resolve(old))).toEqual(oldBody);
    await build(writer.store.root.path, 'resolveSeed', '', true);
    await build(writer.store.root.path, 'resolveMiss');
    if (useOverlay) {
      await writeFile(unmanaged, 'temporary local settings');
      await symlink('settings', path.join(path.dirname(unmanaged), 'temp-link'));
      await put(writer.store.root.path, workspace + '/transformed/added', 'new workspace member');
      const staged = 'wrapper/dists/fixture/download-tmp';
      const distribution = 'wrapper/dists/fixture/downloaded';
      await put(writer.store.root.path, staged + '/member', 'wrapper distribution member');
      await rename(writer.store.root.resolve(staged), writer.store.root.resolve(distribution));
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
          retireOverlay(writer.store, writer.overlay!, {
            ...overlayMount!,
            unmount: async () => {
              throw new Error('mount is busy');
            },
          }),
        ).rejects.toThrow('mount is busy');
        expect(await overlayMount!.inspect(mountedPath)).not.toBeNull();
        expect(await writer.store.root.stat(writer.overlay![2])).not.toBeNull();
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
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({ gradleUserHome: mountedPath }),
        expect.any(AbortSignal),
        expect.any(Number),
      );
      const writerArchive = gunzipSync([...artifacts.objects.values()][1].bytes);
      expect(writerArchive.includes(oldBody)).toBe(false);
      expect(writerArchive.includes(newBody)).toBe(true);
      expect(writerArchive.includes('inherited workspace member')).toBe(true);
      expect(writerArchive.includes('new workspace member')).toBe(true);
      expect(writerArchive.includes('untouched workspace member')).toBe(false);
      expect(writerArchive.includes('untouched metadata member')).toBe(true);
      expect(writerArchive.includes('wrapper distribution member')).toBe(true);
      expect(writerArchive.includes('temporary local settings')).toBe(false);
      expect(await readFile(unmanaged, 'utf8')).toBe('inherited local settings');
      await expect(lstat(writer.store.root.resolve('local/temp-link'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(lstat(writer.store.root.resolve(writer.overlay![2]))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await OpenedInvocation.open(writer.anchor, f.budget)).state[4]).toBe('completed');
    }
    const aggregator = await prepare('aggregator', 'distributed-aggregator', {
      now: () => Date.now() + 10000,
    });
    expect(aggregator.workerCount).toBe(2);
    expect((await OpenedInvocation.open(aggregator.anchor, f.budget)).bindings[8][5]).toBe(
      useOverlay ? 'off' : 'timestamp',
    );
    const published = await basePost(aggregator);
    expect(published.outcome).toBe('published');
    if (useOverlay) {
      expect(await readFile(aggregator.store.root.resolve(untouchedMember), 'utf8')).toBe(
        'untouched workspace member',
      );
    }
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
      const publishOverlay = await prepare('standalone-overlay', 'standalone', {
        overlayFs: true,
        overlayMount,
        cleanupEnabled: false,
        policy: { ...f.request.policy, role: 'standalone', gcAgeMs: null },
      });
      writerMount = publishOverlay;
      expect(publishOverlay.overlay).not.toBeNull();
      expect(await overlayMount!.inspect(publishOverlay.store.root.path)).not.toBeNull();
      expect(await basePost(publishOverlay)).toMatchObject({
        outcome: 'no-change',
        key: published.key,
      });
      expect(await overlayMount!.inspect(publishOverlay.store.root.path)).toBeNull();

      const unsettledPublisher = await prepare('unsettled-publisher', 'standalone', {
        overlayFs: true,
        overlayMount,
        cleanupEnabled: false,
        policy: { ...f.request.policy, role: 'standalone', gcAgeMs: null },
      });
      writerMount = unsettledPublisher;
      const warnings: string[] = [];
      await expect(
        basePost(unsettledPublisher, {
          lifecycle: gradleResolver({
            inspect: async () => ({ remaining: false, uncertain: true }),
          }),
          onWarning: (message) => warnings.push(message),
        }),
      ).rejects.toThrow('not quiescent');
      expect(warnings.join('\n')).toContain('OverlayFS state retained');
      expect(await overlayMount!.inspect(unsettledPublisher.store.root.path)).not.toBeNull();
      // No build ran for this fixture invocation.
      await retireOverlay(unsettledPublisher.store, unsettledPublisher.overlay!, overlayMount!);

      const idleArtifacts = memoryArtifacts();
      const idle = await prepare('writer', 'distributed-worker', {
        root: f.directory + '/idle-writer',
        overlayFs: true,
        overlayMount,
      });
      writerMount = idle;
      expect(idle.overlay).not.toBeNull();
      expect(await idle.store.root.stat(idle.overlay![2] + '/upper/caches')).toBeNull();
      expect((await workerPost(idle, idleArtifacts.api)).outcome).toBe('worker-uploaded');
      const idleArchive = gunzipSync([...idleArtifacts.objects.values()][0].bytes);
      expect(idleArchive.includes('untouched metadata member')).toBe(true);
      expect(idleArchive.includes(oldBody)).toBe(false);

      // Simulate failure of the first host advertisement write after successful core prepare.
      const failed = await prepare('writer', 'distributed-worker', {
        root: f.directory + '/failed-writer',
        overlayFs: true,
        overlayMount,
      });
      writerMount = failed;
      expect(failed.overlay).not.toBeNull();
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
      expect(await overlayMount!.inspect(failed.store.root.path)).toBeNull();

      const dueProbe = vi.fn(overlayMount!.inspect);
      const dueWorker = await prepare('due-worker', 'distributed-worker', {
        dependencyGc: config,
        overlayFs: true,
        overlayMount: { ...overlayMount!, inspect: dueProbe },
      });
      expect(dueWorker.dependencyGc?.due).toBe('true');
      expect(dueWorker.overlay).toBeNull();
      expect(dueWorker.dependencyLayer).toBeNull();
      expect(dueProbe).not.toHaveBeenCalled();
      expect(await readFile(dueWorker.store.root.resolve(old))).toEqual(oldBody);
      expect((await workerPost(dueWorker, memoryArtifacts().api)).outcome).toBe('worker-uploaded');

      const sweep = await prepare('sweep', 'standalone', {
        dependencyGc: config,
        policy: { ...f.request.policy, role: 'standalone', gcAgeMs: 100 * 365 * 86400000 },
      });
      expect(sweep.dependencyGc?.due).toBe('true');
      const swept = await basePost(sweep);
      expect(swept.outcome).toBe('published');

      const workerArtifacts = memoryArtifacts();
      const nonwriter = await prepare('overlay-worker', 'distributed-worker', {
        dependencyGc: config,
        overlayFs: true,
        overlayMount,
      });
      writerMount = nonwriter;
      expect(nonwriter.restoredKey).toBe(swept.key);
      expect(nonwriter.dependencyGc?.due).toBe('false');
      expect(nonwriter.dependencyLayer).toBeNull();
      expect(nonwriter.overlay).not.toBeNull();
      await build(nonwriter.store.root.path, 'resolveSeed', '', true);
      const upperMember = workspace + '/transformed/worker-added';
      await put(nonwriter.store.root.path, upperMember, 'nonwriter workspace addition');
      expect((await workerPost(nonwriter, workerArtifacts.api)).outcome).toBe('worker-uploaded');
      const upperArchive = gunzipSync([...workerArtifacts.objects.values()][0].bytes);
      expect(upperArchive.includes('nonwriter workspace addition')).toBe(true);
      expect(upperArchive.includes('inherited workspace member')).toBe(true);
      expect(upperArchive.includes('untouched workspace member')).toBe(false);
      expect(upperArchive.includes('untouched metadata member')).toBe(false);
      expect(upperArchive.includes('incomplete-usage')).toBe(true);
      expect(await overlayMount!.inspect(nonwriter.store.root.path)).toBeNull();
      await expect(lstat(nonwriter.store.root.resolve(upperMember))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const mount = vi.fn(async () => {
        throw new Error('mount unavailable');
      });
      const fallback = await prepare('mount-fallback', 'distributed-worker', {
        dependencyGc: config,
        overlayFs: true,
        overlayMount: { ...overlayMount!, mount },
      });
      expect(fallback.dependencyGc?.due).toBe('false');
      expect(mount).toHaveBeenCalledOnce();
      expect(fallback.overlay).toBeNull();
      expect(fallback.dependencyLayer).toBeNull();
      expect(await overlayMount!.inspect(fallback.store.root.path)).toBeNull();
      expect(await readFile(fallback.store.root.resolve(old))).toEqual(oldBody);
      expect((await workerPost(fallback, memoryArtifacts().api)).outcome).toBe('worker-uploaded');
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
      writerMount?.overlay &&
      (await overlayMount.inspect(writerMount.store.root.path))
    ) {
      await retireOverlay(writerMount.store, writerMount.overlay, overlayMount);
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
