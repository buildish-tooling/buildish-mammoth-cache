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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { linuxOverlayMount } from '../../src/cache/streaming/overlay-mount';
import { postStreamingBase } from '../../src/cache/streaming/base-post';
import { WorkingBudget } from '../../src/cache/streaming/tree-state';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import * as nativeWalk from '../../src/cache/streaming/native-walk';
import { streamingIntegrationJob } from '../support/streaming-integration';
import { nativeCacheBackend, cleanupBaseFixtures } from '../cache/streaming/native-cache-fixture';
import { memoryArtifacts } from '../cache/streaming/memory-artifact-fixture';

const exec = promisify(execFile);
let root: string, classpath: string;
let cache: Awaited<ReturnType<typeof nativeCacheBackend>>;
const release = 'test:example:jar:1.0';
const artifact = 'repository/test/example/1.0/example-1.0.jar';
const marker = 'repository/test/example/1.0/_remote.repositories';

beforeAll(async () => {
  await mkdir('build', { recursive: true });
  root = await mkdtemp(path.resolve('build/integration-maven-semantics-'));
  cache = await nativeCacheBackend();
  const version = (
    await exec('mvn', ['--version'], { env: { ...process.env, MAVEN_ARGS: '', MAVEN_OPTS: '' } })
  ).stdout;
  const home = /Maven home: (.+)/u.exec(version)?.[1]?.trim();
  if (!home) {
    throw new Error(`Cannot locate installed Maven: ${version}`);
  }
  classpath = [root, path.join(home, 'lib', '*'), path.join(home, 'boot', '*')].join(
    path.delimiter,
  );
  const libraries = await readdir(path.join(home, 'lib'));
  console.log(
    `${version.trim()}\nResolver: ${libraries.find((f) => /^maven-resolver-impl-.*\.jar$/u.test(f))}`,
  );
  await exec('javac', [
    '-cp',
    classpath,
    '-d',
    root,
    'test/fixtures/integration/maven-resolver/ResolverProbe.java',
  ]);
  await publish('remote-a', 'example', '1.0', 'A');
  await publish('remote-b', 'example', '1.0', 'B');
  await resolve('seed', release);
}, 30_000);
afterAll(async () => {
  await cleanupBaseFixtures();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

async function publish(remote: string, name: string, version: string, bytes: string, suffix = '') {
  const directory = path.join(root, remote, 'test', name, version);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}-${version}${suffix}.jar`);
  await writeFile(file, bytes);
  return file;
}
async function resolve(
  local: string,
  coordinates = release,
  options: {
    offline?: boolean;
    id?: string;
    remote?: string;
    policy?: string;
    mirrorOf?: string;
  } = {},
) {
  const args = [
    path.join(root, local, 'repository'),
    coordinates,
    String(options.offline ?? false),
    options.id ?? 'origin-a',
    pathToFileURL(path.join(root, options.remote ?? 'remote-a')).href + '/',
    options.policy ?? 'always',
  ];
  if (options.mirrorOf) {
    args.push(options.mirrorOf);
  }
  const { stdout } = await exec(
    'java',
    [`-Duser.home=${path.join(root, 'home')}`, '-cp', classpath, 'ResolverProbe', ...args],
    { timeout: 30_000 },
  );
  expect(stdout).toContain('LRM=org.eclipse.aether.internal.impl.EnhancedLocalRepositoryManager');
  return /RESULT=(.*)/u.exec(stdout)![1];
}
async function cloneSeed(name: string) {
  await cp(path.join(root, 'seed'), path.join(root, name), { recursive: true });
}

function scenario(
  scope: string,
  inputs: Record<string, string> = {},
  overlayMount?: ReturnType<typeof linuxOverlayMount>,
) {
  const artifacts = memoryArtifacts();
  function action(
    local: string,
    name: string,
    overrides: Record<string, string> = {},
    now?: () => number,
  ) {
    return streamingIntegrationJob({
      root: path.join(root, 'jobs', scope, name),
      home: path.join(root, local),
      tool: 'maven',
      name,
      inputs: { 'cache-key-prefix': 'maven-semantics-' + scope + '-', ...inputs, ...overrides },
      cache: cache.backend,
      artifacts: artifacts.api,
      now,
      overlayMount,
    });
  }
  return {
    action,
    artifacts,
    async worker(source: string, name: string) {
      const job = await action('worker-home-' + scope + '-' + name, name, {
        'job-mode': 'distributed-worker',
      });
      await job.prepare();
      await cp(path.join(root, source, 'repository'), path.join(job.home, 'repository'), {
        recursive: true,
      });
      expect((await job.post()).outcome).toBe('worker-uploaded');
    },
    aggregator(local: string, names: string) {
      return action(local, 'aggregator', {
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': names,
      });
    },
  };
}

it.runIf(process.platform === 'linux' && process.env.MAMMOTH_TEST_OVERLAY === '1').each([
  [4, true],
  [40, true],
  [4, false],
])(
  'publishes complete touched coordinates with %i inherited versions and overlay-fs=%s',
  async (width, useOverlay) => {
    const mount = linuxOverlayMount()!;
    const suffix = width + '-' + useOverlay;
    const f = scenario('overlay-' + suffix, { 'overlay-fs': String(useOverlay) }, mount);
    const seedLocal = 'overlay-seed-' + suffix;
    const workerLocal = 'overlay-worker-' + suffix;
    const readerLocal = 'overlay-reader-' + suffix;
    const producer = await f.action(seedLocal, 'producer');
    await producer.prepare();
    await cloneSeed(seedLocal);
    await publish('remote-a', 'example', '1.1', 'second inherited artifact');
    expect(await resolve(seedLocal, 'test:example:jar:1.1')).toBe('second inherited artifact');
    const unchanged = 'repository/test/example/2.0/example-2.0.jar';
    for (let i = 0; i < width; i++) {
      const member = path.join(producer.home, unchanged.replaceAll('2.0', '2.' + i));
      await mkdir(path.dirname(member), { recursive: true });
      await writeFile(member, 'unchanged inherited version');
    }
    const wrapper = 'wrapper/dists/wrapper.zip';
    await mkdir(path.dirname(path.join(producer.home, wrapper)), { recursive: true });
    await writeFile(path.join(producer.home, wrapper), 'unchanged inherited wrapper');
    expect((await producer.post()).outcome).toBe('published');

    const worker = await f.action(workerLocal, 'worker', { 'job-mode': 'distributed-worker' });
    const target = path.join(worker.home, 'repository');
    await worker.prepare();
    expect(worker.outputs['base-cache-restore-status']).toBe('current-lineage-hit');
    expect(!!(await mount.inspect(target))).toBe(useOverlay);
    await publish('remote-a', 'example', '1.0', 'new classifier payload', '-overlay');
    await publish('remote-a', 'example', '1.1', 'second classifier payload', '-overlay');
    const classifier = 'test:example:jar:overlay:1.0';
    const secondClassifier = 'test:example:jar:overlay:1.1';
    expect(await resolve(workerLocal, classifier)).toBe('new classifier payload');
    expect(await resolve(workerLocal, secondClassifier)).toBe('second classifier payload');
    const origin = (await readFile(path.join(worker.home, marker), 'utf8'))
      .split(/\r?\n/u)
      .find((line) => line.startsWith('example-1.0.jar>'))!;
    await writeFile(path.join(worker.home, unchanged + '.lastUpdated'), 'transient only');
    const lastFile = unchanged.replaceAll('2.0', '2.1');
    const removedDirectoryMember = unchanged.replaceAll('2.0', '2.2');
    await rm(path.join(worker.home, lastFile));
    await rm(path.dirname(path.join(worker.home, removedDirectoryMember)), { recursive: true });
    const directories: string[] = [];
    const listings: string[] = [];
    const walk = nativeWalk.walkNative;
    const spy = vi.spyOn(nativeWalk, 'walkNative').mockImplementation(async function* (...args) {
      const list = args[2].listDirectory;
      if (list) {
        args[2] = {
          ...args[2],
          listDirectory(relative, open) {
            return list(relative, (source) => {
              listings.push(relative);
              return open(source);
            });
          },
        };
      }
      for await (const event of walk(...args)) {
        if (
          args[2].listDirectory &&
          event.tag === 'directory-open' &&
          event.path.startsWith('repository/')
        ) {
          directories.push(event.path);
        }
        yield event;
      }
    });
    try {
      expect((await worker.post()).outcome).toBe('worker-uploaded');
    } finally {
      spy.mockRestore();
    }
    if (useOverlay) {
      expect(directories.filter((entry) => entry.startsWith('repository/test'))).toEqual([
        'repository/test',
        'repository/test/example',
        'repository/test/example/1.0',
        'repository/test/example/1.1',
        'repository/test/example/2.0',
        'repository/test/example/2.1',
      ]);
      expect(
        listings.filter((entry) => entry === 'repository' || entry.startsWith('repository/test')),
      ).toEqual([
        'repository',
        'repository/test',
        'repository/test/example',
        'repository/test/example/1.0',
        'repository/test/example/1.0',
        'repository/test/example/1.1',
        'repository/test/example/1.1',
        'repository/test/example/2.0',
        'repository/test/example/2.1',
      ]);
    }
    expect(await mount.inspect(target)).toBeNull();
    const classifierPath = path.join(
      worker.home,
      'repository/test/example/1.0/example-1.0-overlay.jar',
    );
    if (useOverlay) {
      await expect(readFile(classifierPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(classifierPath, 'utf8')).toBe('new classifier payload');
    }

    const archive = gunzipSync([...f.artifacts.objects.values()][0].bytes);
    expect(archive.includes('new classifier payload')).toBe(true);
    expect(origin).toContain('origin-a');
    expect(archive.includes(origin)).toBe(true);
    expect(archive.includes('unchanged inherited version')).toBe(false);
    expect(archive.includes(unchanged)).toBe(false);
    expect(archive.includes('unchanged inherited wrapper')).toBe(false);
    expect(archive.includes('transient only')).toBe(false);
    if (useOverlay) {
      expect(archive.includes('repository/test/example/2.1')).toBe(false);
      expect(archive.includes('repository/test/example/2.2')).toBe(false);
    }

    const aggregatorLocal = 'overlay-aggregator-' + suffix;
    const aggregator = await f.action(aggregatorLocal, 'aggregator', {
      'job-mode': 'distributed-aggregator',
      'dependent-jobs': 'worker',
      'cache-gc-mode': 'timestamp',
    });
    await aggregator.prepare();
    expect(aggregator.outputs['dependent-delta-artifact-count']).toBe('1');
    expect(!!(await mount.inspect(path.join(aggregator.home, 'repository')))).toBe(useOverlay);
    const localClassifier = 'test:example:jar:aggregator:1.0';
    if (width === 40) {
      await publish('remote-a', 'example', '1.0', 'aggregator classifier', '-aggregator');
      expect(await resolve(aggregatorLocal, localClassifier)).toBe('aggregator classifier');
    }
    expect((await aggregator.post()).outcome).toBe('published');
    expect(await mount.inspect(path.join(aggregator.home, 'repository'))).toBeNull();
    const reader = await f.action(readerLocal, 'reader', { 'read-only': 'true' });
    await reader.prepare();
    for (const member of [lastFile, removedDirectoryMember]) {
      expect(await readFile(path.join(reader.home, member), 'utf8')).toBe(
        'unchanged inherited version',
      );
    }
    expect(await resolve(readerLocal, release, { offline: true })).toBe('A');
    expect(await resolve(readerLocal, classifier, { offline: true })).toBe(
      'new classifier payload',
    );
    expect(await resolve(readerLocal, secondClassifier, { offline: true })).toBe(
      'second classifier payload',
    );
    if (width === 40) {
      expect(await resolve(readerLocal, localClassifier, { offline: true })).toBe(
        'aggregator classifier',
      );
    }
    await expect(
      resolve(readerLocal, classifier, {
        offline: true,
        id: 'origin-b',
        remote: 'remote-b',
      }),
    ).rejects.toThrow(/offline mode/u);
    expect((await reader.post()).outcome).toBe('read-only');
  },
);

it
  .runIf(process.platform === 'linux' && process.env.MAMMOTH_TEST_OVERLAY === '1')
  .each([true, false])(
  'reuses an unchanged standalone generation and publishes authoritative deletions with overlay-fs=%s',
  async (useOverlay) => {
    const mount = linuxOverlayMount()!;
    const suffix = 'publisher-' + useOverlay;
    const f = scenario(
      suffix,
      {
        'overlay-fs': String(useOverlay),
        'cache-partitions': JSON.stringify([{ id: 'repository', publication: 'single-writer' }]),
      },
      mount,
    );
    const seed = await f.action(suffix + '-seed', 'producer');
    await seed.prepare();
    await cloneSeed(suffix + '-seed');
    await publish('remote-a', 'publisher-other', '1.0', 'retained publisher dependency');
    const retained = 'test:publisher-other:jar:1.0';
    expect(await resolve(suffix + '-seed', retained)).toBe('retained publisher dependency');
    const published = await seed.post();
    if (published.outcome !== 'published') {
      throw new Error('Expected the seed generation to publish.');
    }

    const idle = await f.action(suffix + '-idle', 'idle');
    await idle.prepare();
    expect(!!(await mount.inspect(path.join(idle.home, 'repository')))).toBe(useOverlay);
    const walk = vi.spyOn(nativeWalk, 'walkNative');
    try {
      expect(await idle.post()).toMatchObject({ outcome: 'no-change', key: published.key });
      expect(
        walk.mock.calls.some(([native, member]) => native.path === idle.home && member === ''),
      ).toBe(!useOverlay);
    } finally {
      walk.mockRestore();
    }
    expect(await mount.inspect(path.join(idle.home, 'repository'))).toBeNull();

    const deleting = await f.action(suffix + '-deleting', 'deleting');
    await deleting.prepare();
    expect(!!(await mount.inspect(path.join(deleting.home, 'repository')))).toBe(useOverlay);
    await rm(path.dirname(path.join(deleting.home, artifact)), { recursive: true });
    const changed = await deleting.post();
    if (changed.outcome !== 'published') {
      throw new Error('Expected the authoritative deletion to publish.');
    }
    expect(changed.key).not.toBe(published.key);
    expect(await mount.inspect(path.join(deleting.home, 'repository'))).toBeNull();

    const reader = await f.action(suffix + '-reader', 'reader', { 'read-only': 'true' });
    await reader.prepare();
    expect(reader.outputs['restored-cache-key']).toBe(changed.key);
    await expect(resolve(suffix + '-reader', release, { offline: true })).rejects.toThrow(
      /offline mode/u,
    );
    expect(await resolve(suffix + '-reader', retained, { offline: true })).toBe(
      'retained publisher dependency',
    );
    expect((await reader.post()).outcome).toBe('read-only');
  },
);

it.runIf(process.platform === 'linux' && process.env.MAMMOTH_TEST_OVERLAY === '1')(
  'retires publisher mounts when the cache backend is unavailable or save is unconfirmed',
  async () => {
    const mount = linuxOverlayMount()!;
    const f = scenario('publisher-unavailable', {}, mount);
    const seed = await f.action('publisher-unavailable-seed', 'producer');
    await seed.prepare();
    await cloneSeed('publisher-unavailable-seed');
    expect((await seed.post()).outcome).toBe('published');

    for (const available of [false, true]) {
      const job = await f.action('publisher-unavailable-' + available, 'publisher-' + available);
      const ready = await job.prepare();
      if (!('anchor' in ready) || !ready.overlay) {
        throw new Error('Expected a warm publisher with an active overlay.');
      }
      const target = path.join(job.home, 'repository');
      if (available) {
        await writeFile(path.join(job.home, artifact), 'changed but unconfirmed payload');
      }
      const budget = new WorkingBudget();
      const result = await postStreamingBase({
        anchor: ready.anchor,
        overlayMount: mount,
        budget,
        cacheBackend: async () => ({
          ...cache.backend,
          isFeatureAvailable: () => available,
          saveCache: async () => -1,
        }),
        removeHooks: async () => {},
        assertCurrent: () => undefined,
      });
      expect(result.outcome).toBe(available ? 'abandoned' : 'feature-unavailable');
      expect(await mount.inspect(target)).toBeNull();
      expect(await readFile(path.join(job.home, artifact), 'utf8')).toBe('A');
      expect(budget.retained).toBe(0);
    }
  },
);

it.each([false, true])(
  'matches native origin resolution through streaming partition-object archives (exclude markers: %s)',
  async (excluded) => {
    const inputs = {
      'cache-partitions': JSON.stringify(
        excluded ? [{ id: 'repository', excludes: ['**/_remote.repositories'] }] : [],
      ),
    };
    const f = scenario('archived-' + excluded, inputs);
    const writer = await f.action('writer-' + excluded, 'writer');
    await writer.prepare();
    await cp(path.join(root, 'seed/repository'), path.join(writer.home, 'repository'), {
      recursive: true,
    });
    expect((await writer.post()).outcome).toBe('published');
    const local = `restored-${excluded}`;
    const reader = await f.action(local, 'reader', { 'read-only': 'true' });
    await reader.prepare();
    expect(reader.outputs['base-cache-restore-status']).toBe('current-lineage-hit');
    expect((await reader.post()).outcome).toBe('read-only');
    const native = `native-${excluded}`;
    // Resolve independently: this control has never passed through Mammoth or an archive.
    expect(await resolve(native)).toBe('A');
    if (excluded) {
      await rm(path.join(root, native, marker));
      await expect(readFile(path.join(root, local, marker))).rejects.toThrow();
    } else {
      expect(await readFile(path.join(root, local, marker), 'utf8')).toBe(
        await readFile(path.join(root, 'seed', marker), 'utf8'),
      );
    }
    for (const repository of [native, local]) {
      expect(await resolve(repository, release, { offline: true })).toBe('A');
      const differentOrigin = { id: 'origin-b', remote: 'remote-b' };
      if (excluded) {
        expect(await resolve(repository, release, { ...differentOrigin, offline: true })).toBe('A');
      } else {
        await expect(
          resolve(repository, release, { ...differentOrigin, offline: true }),
        ).rejects.toThrow(/offline mode/u);
      }
    }
    // A fresh B repository proves that the controlled remote serves distinct bytes.
    const differentOrigin = { id: 'origin-b', remote: 'remote-b' };
    expect(await resolve(`fresh-b-${excluded}`, release, differentOrigin)).toBe('B');
    // Resolver 1.9.27 can relabel A after an existence check; 2.0.24 downloads B.
    // Mammoth must preserve the installed Resolver's native behavior in either case.
    const nativeBytes = await resolve(native, release, differentOrigin);
    expect(await resolve(local, release, differentOrigin)).toBe(nativeBytes);
    if (excluded) {
      expect(nativeBytes).toBe('A');
    } else {
      const entries = async (repository: string) =>
        (await readFile(path.join(root, repository, marker), 'utf8'))
          .split(/\r?\n/u)
          .filter((line) => line && !line.startsWith('#'))
          .sort();
      // Ignore Resolver's generated timestamp comment, retaining every origin entry.
      expect(await entries(local)).toEqual(await entries(native));
    }
    for (const repository of [native, local]) {
      expect(await readFile(path.join(root, repository, artifact), 'utf8')).toBe(nativeBytes);
      expect(await resolve(repository, release, { ...differentOrigin, offline: true })).toBe(
        nativeBytes,
      );
    }
  },
);
it('records same-ID changed-URL fallback and changed effective mirror-ID behavior', async () => {
  await cloneSeed('url-change');
  // Resolver 2.0.24 defaults to a same-ID fallback despite URL-qualified tracking keys.
  expect(await resolve('url-change', release, { remote: 'remote-b' })).toBe('A');
  await resolve('mirrored', release, { id: 'mirror-a', mirrorOf: 'logical' });
  await expect(
    resolve('mirrored', release, { offline: true, id: 'mirror-b', mirrorOf: 'logical' }),
  ).rejects.toThrow(/offline mode/u);
});
it('keeps locally installed artifacts available across active repository changes', async () => {
  const source = await publish('installed-source', 'example', '1.0', 'LOCAL');
  await exec('java', [
    `-Duser.home=${path.join(root, 'home')}`,
    '-cp',
    classpath,
    'ResolverProbe',
    path.join(root, 'installed/repository'),
    release,
    'install',
    source,
  ]);
  expect(await readFile(path.join(root, 'installed', marker), 'utf8')).toContain(
    'example-1.0.jar>=',
  );
  expect(
    await resolve('installed', release, { offline: true, id: 'origin-b', remote: 'remote-b' }),
  ).toBe('LOCAL');
  const f = scenario('installed');
  await f.worker('installed', 'installer');
  const target = await f.aggregator('restored-install', 'installer');
  await target.prepare();
  expect(
    await resolve('restored-install', release, {
      offline: true,
      id: 'origin-b',
      remote: 'remote-b',
    }),
  ).toBe('LOCAL');
});
it('leaves timestamped snapshot refresh to Resolver update policy', async () => {
  const directory = path.join(root, 'remote-a/test/snapshot/1.0-SNAPSHOT');
  await mkdir(directory, { recursive: true });
  async function publishSnapshot(n: number) {
    const stamp = `20261118.07000${n}`,
      value = `1.0-${stamp}-${n}`;
    await writeFile(path.join(directory, `snapshot-${value}.jar`), `SNAP-${n}`);
    await writeFile(
      path.join(directory, 'maven-metadata.xml'),
      `<metadata><groupId>test</groupId><artifactId>snapshot</artifactId><version>1.0-SNAPSHOT</version><versioning><snapshot><timestamp>${stamp}</timestamp><buildNumber>${n}</buildNumber></snapshot><lastUpdated>2026111807000${n}</lastUpdated><snapshotVersions><snapshotVersion><extension>jar</extension><value>${value}</value><updated>2026111807000${n}</updated></snapshotVersion></snapshotVersions></versioning></metadata>`,
    );
  }
  const coordinates = 'test:snapshot:jar:1.0-SNAPSHOT';
  await publishSnapshot(1);
  expect(await resolve('snapshots', coordinates)).toBe('SNAP-1');
  await publishSnapshot(2);
  expect(await resolve('snapshots', coordinates, { policy: 'never' })).toBe('SNAP-1');
  expect(await resolve('snapshots', coordinates, { policy: 'always' })).toBe('SNAP-2');
});
it('merges disjoint real worker directories and resolves their artifacts offline', async () => {
  await publish('remote-a', 'other', '1.0', 'OTHER');
  await resolve('worker-a');
  await resolve('worker-b', 'test:other:jar:1.0');
  const f = scenario('disjoint');
  await f.worker('worker-a', 'worker-a');
  await f.worker('worker-b', 'worker-b');
  const parent = await f.aggregator('aggregator', 'worker-a,worker-b');
  await parent.prepare();
  expect(parent.outputs['dependent-delta-artifact-count']).toBe('2');
  expect(await resolve('aggregator', release, { offline: true })).toBe('A');
  expect(await resolve('aggregator', 'test:other:jar:1.0', { offline: true })).toBe('OTHER');
  await expect(
    resolve('aggregator', release, { offline: true, id: 'origin-b', remote: 'remote-b' }),
  ).rejects.toThrow(/offline mode/u);
});

it('GC preserves protected coordinates with old marker timestamps and evicts inactive coordinates', async () => {
  const cutoff = Date.now() + 10000;
  const old = 1700000000;
  for (const [local, used] of [
    ['gc-used', true],
    ['gc-inactive', false],
  ] as const) {
    const f = scenario(local);
    const owner = await f.action(local, 'owner', { 'cache-gc-mode': 'timestamp' }, () => cutoff);
    await owner.prepare();
    await cloneSeed(local);
    for (const name of [artifact, marker]) {
      await utimes(path.join(owner.home, name), old, old);
    }
    if (used) {
      // Model a visible access on a noatime filesystem without changing mtime.
      await utimes(path.join(owner.home, artifact), Math.ceil(cutoff / 1000) + 1, old);
      await owner.post();
      expect(await resolve(local, release, { offline: true })).toBe('A');
      await expect(
        resolve(local, release, { offline: true, id: 'origin-b', remote: 'remote-b' }),
      ).rejects.toThrow(/offline mode/u);
    } else {
      await owner.post();
      await expect(readFile(path.join(owner.home, marker))).rejects.toThrow();
      await expect(readFile(path.join(owner.home, artifact))).rejects.toThrow();
      await expect(resolve(local, release, { offline: true })).rejects.toThrow(/offline mode/u);
    }
  }
});

const excludeSources = {
  'cache-partitions': JSON.stringify([
    {
      id: 'repository',
      includes: ['repository/**'],
      excludes: ['**/*-sources.jar'],
    },
  ]),
};
const sourcesArtifact = 'repository/test/example/1.0/example-1.0-sources.jar';
const sourcesCoordinates = 'test:example:jar:sources:1.0';

// Immutable native prerequisites; clone before each independent mutation experiment.
const sourcesSeeds = new Map<string, string>();
async function cloneSourcesSeed(local: string, origin: 'a' | 'b') {
  let seed = sourcesSeeds.get(origin);
  if (!seed) {
    seed = 'sources-seed-' + origin;
    const options = { id: 'origin-' + origin, remote: 'remote-' + origin };
    await publish(options.remote, 'example', '1.0', origin.toUpperCase() + '-SOURCES', '-sources');
    expect(await resolve(seed, release, options)).toBe(origin.toUpperCase());
    expect(await resolve(seed, sourcesCoordinates, options)).toBe(
      origin.toUpperCase() + '-SOURCES',
    );
    sourcesSeeds.set(origin, seed);
  }
  await cp(path.join(root, seed), path.join(root, local), { recursive: true });
}

it('rejects a worker coordinate over excluded local sources before changing repository bytes', async () => {
  await cloneSourcesSeed('excluded-target', 'a');
  await cloneSourcesSeed('excluded-worker', 'b');
  // The fresh managed area can contain excluded artifacts. A marker from another origin
  // must never be installed alongside those protected artifacts.
  await rm(path.join(root, 'excluded-target', marker));
  await rm(path.join(root, 'excluded-target', artifact));
  await rm(path.join(root, 'excluded-worker', sourcesArtifact));
  const f = scenario('excluded-merge', excludeSources);
  await f.worker('excluded-worker', 'excluded-worker');
  const parent = await f.aggregator('excluded-target', 'excluded-worker');
  await expect(parent.prepare()).rejects.toThrow(/Incomplete Maven repository directory/u);
  await expect(readFile(path.join(parent.home, marker))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(parent.home, artifact))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(path.join(parent.home, sourcesArtifact), 'utf8')).toBe('A-SOURCES');
});

it('retains the complete Maven coordinate when excluded sources would survive GC', async () => {
  const cutoff = Date.now() + 10000;
  const f = scenario('excluded-gc', excludeSources);
  const owner = await f.action(
    'excluded-gc',
    'owner',
    { 'cache-gc-mode': 'timestamp' },
    () => cutoff,
  );
  await owner.prepare();
  await cloneSourcesSeed('excluded-gc', 'a');
  for (const file of [artifact, marker, sourcesArtifact]) {
    await utimes(path.join(owner.home, file), 1700000000, 1700000000);
  }
  const before = await readFile(path.join(owner.home, marker), 'utf8');
  expect((await owner.post()).outcome).toBe('published');
  expect(await readFile(path.join(owner.home, sourcesArtifact), 'utf8')).toBe('A-SOURCES');
  expect(await readFile(path.join(owner.home, marker), 'utf8')).toBe(before);
  expect(await readFile(path.join(owner.home, artifact), 'utf8')).toBe('A');
  expect(await resolve('excluded-gc', sourcesCoordinates, { offline: true })).toBe('A-SOURCES');
  await expect(
    resolve('excluded-gc', sourcesCoordinates, {
      offline: true,
      id: 'origin-b',
      remote: 'remote-b',
    }),
  ).rejects.toThrow(/offline mode/u);
});

const chooseDirectory = {
  'cache-partitions': JSON.stringify([
    { id: 'repository', 'conflict-handling': 'choose-worker-directory' },
  ]),
};

it.each([false, true])(
  'selects a native worker directory with different origins (different bytes/membership: %s)',
  async (different) => {
    const winner = `policy-winner-${different}`,
      loser = `policy-loser-${different}`;
    const remote = different ? 'remote-b' : 'policy-same-bytes';
    if (!different) {
      await publish(remote, 'example', '1.0', 'A');
    }
    expect(await resolve(winner)).toBe('A');
    expect(await resolve(loser, release, { id: 'origin-b', remote })).toBe(different ? 'B' : 'A');
    if (different) {
      await publish(remote, 'example', '1.0', 'LOSER-SOURCES', '-sources');
      expect(await resolve(loser, sourcesCoordinates, { id: 'origin-b', remote })).toBe(
        'LOSER-SOURCES',
      );
    }
    const f = scenario('policy-' + different, chooseDirectory);
    await f.worker(loser, 'z-worker');
    await f.worker(winner, 'a-worker');
    const targetName = `policy-target-${different}`;
    const target = await f.aggregator(targetName, 'a-worker,z-worker');
    await target.prepare();
    expect(target.warnings.join('\n')).toContain('Worker merge selected winners');
    expect(await readFile(path.join(target.home, marker), 'utf8')).toBe(
      await readFile(path.join(root, winner, marker), 'utf8'),
    );
    for (const local of [winner, targetName]) {
      expect(await resolve(local, release, { offline: true })).toBe('A');
      await expect(
        resolve(local, release, { offline: true, id: 'origin-b', remote }),
      ).rejects.toThrow(/offline mode/u);
      if (different) {
        await expect(resolve(local, sourcesCoordinates, { offline: true })).rejects.toThrow(
          /offline mode/u,
        );
      }
    }
    if (different) {
      await expect(readFile(path.join(target.home, sourcesArtifact))).rejects.toThrow();
    }
  },
);

it('can discard an unretrievable local install when the remote worker wins its directory', async () => {
  const coordinates = 'test:example:jar:local-only:1.0';
  const source = await publish(
    'policy-install-source',
    'example',
    '1.0',
    'LOCAL-ONLY',
    '-local-only',
  );
  await resolve('policy-remote-winner');
  await exec('java', [
    `-Duser.home=${path.join(root, 'home')}`,
    '-cp',
    classpath,
    'ResolverProbe',
    path.join(root, 'policy-local-loser/repository'),
    coordinates,
    'install',
    source,
  ]);
  expect(await resolve('policy-local-loser', coordinates, { offline: true })).toBe('LOCAL-ONLY');
  const f = scenario('policy-installed', chooseDirectory);
  await f.worker('policy-local-loser', 'z-local');
  await f.worker('policy-remote-winner', 'a-remote');
  const target = await f.aggregator('policy-install-target', 'a-remote,z-local');
  await target.prepare();
  expect(await resolve('policy-install-target', release, { offline: true })).toBe('A');
  await expect(resolve('policy-install-target', coordinates, { offline: true })).rejects.toThrow(
    /offline mode/u,
  );
  await expect(resolve('policy-install-target', coordinates)).rejects.toThrow(
    /Could not find artifact/u,
  );
  expect(await readFile(path.join(target.home, marker), 'utf8')).toBe(
    await readFile(path.join(root, 'policy-remote-winner', marker), 'utf8'),
  );
});
