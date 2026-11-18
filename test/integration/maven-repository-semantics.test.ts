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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
import {
  cutoffModelSchema,
  freezeCutoffSelection,
  newCutoffJournal,
  persistCutoffJournal,
  cutoffDecisionDigest,
} from '../../src/cache/cutoff-state';
import { collectCutoffGarbage } from '../../src/cache/cutoff-gc';
import { cutoffFixturePolicy } from '../support/cutoff-fixture';
import { stageCutoffPackage } from '../../src/delta/cutoff-service';
import { mergeCutoffPackages, applyCutoffPlan } from '../../src/delta/cutoff-apply';
import { mavenFixtureModel, mavenFixtureState } from '../support/maven-cache';
import { createCacheGeneration } from '../../src/cache/model';
import {
  freezePartitionPublication,
  publishPartitionGeneration,
} from '../../src/cache/partition-publication';
import { restoreBaseCache } from '../../src/cache/service';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';

const exec = promisify(execFile);
let root: string, classpath: string;
const release = 'test:example:jar:1.0';
const artifact = 'repository/test/example/1.0/example-1.0.jar';
const marker = 'repository/test/example/1.0/_remote.repositories';

beforeAll(async () => {
  await mkdir('build', { recursive: true });
  root = await mkdtemp(path.resolve('build/integration-maven-semantics-'));
  const version = (
    await exec('mvn', ['--version'], { env: { ...process.env, MAVEN_ARGS: '', MAVEN_OPTS: '' } })
  ).stdout;
  const home = /Maven home: (.+)/u.exec(version)?.[1]?.trim();
  if (!home) throw new Error(`Cannot locate installed Maven: ${version}`);
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
  if (root) await rm(root, { recursive: true, force: true });
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
  if (options.mirrorOf) args.push(options.mirrorOf);
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

it.each([false, true])(
  'matches native origin resolution through real cache globs and tar (exclude markers: %s)',
  async (excluded) => {
    const model = await mavenFixtureModel(path.join(root, 'seed'));
    const snapshot = await captureCacheMetadataSnapshot(model);
    const files = snapshot.partitions.flatMap((p) =>
      p.entries.map((e) => path.join(model.cacheRoot, e.relativePath)),
    );
    expect(files).toContain(path.join(root, 'seed', marker));
    const selected = files.filter((f) => !excluded || !f.endsWith('/_remote.repositories'));
    const archive = await packCacheFiles(
      model.cacheRoot,
      selected.map((f) => path.relative(model.cacheRoot, f)),
      path.join(root, `archive-${excluded}`),
    );
    const local = `restored-${excluded}`;
    await unpackCacheFiles(path.join(root, local), archive);
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
    if (excluded) expect(nativeBytes).toBe('A');
    else {
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
  const worker = await mavenFixtureState(path.join(root, 'installed'));
  const pkg = await stageCutoffPackage(worker.state, worker.ci);
  const target = await mavenFixtureModel(path.join(root, 'restored-install'));
  await applyCutoffPlan(mergeCutoffPackages([pkg], target, worker.ci), target);
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
  const a = await mavenFixtureState(path.join(root, 'worker-a'), 'worker-a');
  const b = await mavenFixtureState(path.join(root, 'worker-b'), 'worker-b');
  const packages = [
    await stageCutoffPackage(a.state, a.ci),
    await stageCutoffPackage(b.state, b.ci),
  ];
  const model = await mavenFixtureModel(path.join(root, 'aggregator'));
  await applyCutoffPlan(mergeCutoffPackages(packages, model, a.ci), model);
  expect(await resolve('aggregator', release, { offline: true })).toBe('A');
  expect(await resolve('aggregator', 'test:other:jar:1.0', { offline: true })).toBe('OTHER');
  await expect(
    resolve('aggregator', release, { offline: true, id: 'origin-b', remote: 'remote-b' }),
  ).rejects.toThrow(/offline mode/u);
});
it('rejects shared marker/disjoint classifier views and conflicting origins before managed mutation', async () => {
  await publish('remote-a', 'example', '1.0', 'SOURCES', '-sources');
  await resolve('classifier-worker', 'test:example:jar:sources:1.0');
  await resolve('origin-worker', release, { id: 'origin-b', remote: 'remote-b' });
  const a = await mavenFixtureState(path.join(root, 'worker-a'), 'worker-a');
  const sources = await mavenFixtureState(path.join(root, 'classifier-worker'), 'sources');
  const other = await mavenFixtureState(path.join(root, 'origin-worker'), 'other');
  const pkg = await stageCutoffPackage(a.state, a.ci);
  const target = await mavenFixtureModel(path.join(root, 'rejected'));
  for (const state of [sources, other]) {
    const candidate = await stageCutoffPackage(state.state, state.ci);
    for (const override of [false, true])
      expect(() => mergeCutoffPackages([pkg, candidate], target, a.ci, override)).toThrow(
        /Conflicting Maven repository directory/u,
      );
  }
  await expect(readFile(path.join(target.cacheRoot, artifact))).rejects.toThrow();
  // Applying a classifier-only worker over an aggregator with a JAR must also fail.
  const model = await mavenFixtureModel(path.join(root, 'seed'));
  const sourcePackage = await stageCutoffPackage(sources.state, sources.ci);
  await expect(
    applyCutoffPlan(mergeCutoffPackages([sourcePackage], model, a.ci), model),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
  expect(await readFile(path.join(model.cacheRoot, artifact), 'utf8')).toBe('A');
});

it('GC preserves origin checks with old marker timestamps and evicts the whole inactive directory', async () => {
  await cloneSeed('gc');
  const model = await mavenFixtureModel(path.join(root, 'gc'));
  for (const name of [artifact, marker])
    await utimes(path.join(model.cacheRoot, name), 1700000000, 1700000000);
  const cutoff = Date.now() + 10000;
  const snapshot = await captureCacheMetadataSnapshot(model);
  const selected = selectCutoffActivity(snapshot, cutoff, cutoff, 14, true, {
    upserts: [],
    used: [artifact],
  });
  expect(selected.gc).toEqual([]);
  expect(selected.used).toContain(marker);
  await expect(
    resolve('gc', release, { offline: true, id: 'origin-b', remote: 'remote-b' }),
  ).rejects.toThrow(/offline mode/u);
  // Reset atime after the real resolution attempt, then deliberately model a native activity miss.
  for (const name of [artifact, marker])
    await utimes(path.join(model.cacheRoot, name), 1700000000, 1700000000);
  const ci = (await mavenFixtureState(path.join(root, 'gc'))).ci;
  const journal = newCutoffJournal(
    model,
    { ...cutoffFixturePolicy, jobMode: 'standalone' },
    {
      repository: ci.repository,
      workflowName: ci.workflowName,
      jobName: ci.jobName,
      runId: ci.runId,
      runAttempt: ci.runAttempt,
      sourceRevision: null,
    },
  );
  journal.phase = 'build-ready';
  journal.cutoff = cutoff;
  await persistCutoffJournal(journal);
  await freezeCutoffSelection(
    journal,
    selectCutoffActivity(await captureCacheMetadataSnapshot(model), cutoff, cutoff, 14, true),
    cutoff,
  );
  expect((await collectCutoffGarbage(journal))!.deletedFileCount).toBe(2);
  await expect(readFile(path.join(model.cacheRoot, marker))).rejects.toThrow();
  await expect(resolve('gc', release, { offline: true })).rejects.toThrow(/offline mode/u);
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

it('rejects a B marker over excluded A sources before aggregation changes any bytes', async () => {
  await publish('remote-a', 'example', '1.0', 'A-SOURCES', '-sources');
  await publish('remote-b', 'example', '1.0', 'B-SOURCES', '-sources');
  await resolve('excluded-target');
  expect(await resolve('excluded-target', sourcesCoordinates)).toBe('A-SOURCES');
  await resolve('excluded-worker', release, { id: 'origin-b', remote: 'remote-b' });
  expect(
    await resolve('excluded-worker', sourcesCoordinates, { id: 'origin-b', remote: 'remote-b' }),
  ).toBe('B-SOURCES');
  // A missing artifact can still have an entry in Resolver's marker. The destination may
  // retain an excluded copy, so source-side validation alone cannot protect aggregation.
  await rm(path.join(root, 'excluded-worker', sourcesArtifact));
  const worker = await mavenFixtureState(
    path.join(root, 'excluded-worker'),
    'excluded-worker',
    excludeSources,
  );
  const pkg = await stageCutoffPackage(worker.state, worker.ci);
  expect(
    pkg.manifest.partitions.flatMap((p) => p.upserts.map((e) => e.relativePath)),
  ).not.toContain(sourcesArtifact);
  const model = await mavenFixtureModel(path.join(root, 'excluded-target'), excludeSources);
  const before = await readFile(path.join(model.cacheRoot, marker), 'utf8');
  await expect(
    applyCutoffPlan(mergeCutoffPackages([pkg], model, worker.ci), model),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
  expect(await readFile(path.join(model.cacheRoot, marker), 'utf8')).toBe(before);
  expect(await readFile(path.join(model.cacheRoot, artifact), 'utf8')).toBe('A');
  expect(await resolve('excluded-target', sourcesCoordinates, { offline: true })).toBe('A-SOURCES');
  await expect(
    resolve('excluded-target', sourcesCoordinates, {
      offline: true,
      id: 'origin-b',
      remote: 'remote-b',
    }),
  ).rejects.toThrow(/offline mode/u);
});

it('refuses GC of a marker when real excluded sources would survive', async () => {
  await publish('remote-a', 'example', '1.0', 'A-SOURCES', '-sources');
  await resolve('excluded-gc');
  expect(await resolve('excluded-gc', sourcesCoordinates)).toBe('A-SOURCES');
  const home = path.join(root, 'excluded-gc');
  const { state } = await mavenFixtureState(home);
  state.model = cutoffModelSchema.parse(await mavenFixtureModel(home, excludeSources));
  state.policy.jobMode = 'standalone';
  state.selection!.gc = state.selection!.upserts.filter((e) => e.relativePath !== sourcesArtifact);
  state.selection!.upserts = [];
  state.selection!.members = state.selection!.members!.filter(
    (e) => e.relativePath !== sourcesArtifact,
  );
  await persistCutoffJournal(state);
  const before = await readFile(path.join(home, marker), 'utf8');
  await expect(collectCutoffGarbage(state)).rejects.toThrow(
    /Incomplete Maven repository directory/u,
  );
  expect(await readFile(path.join(home, marker), 'utf8')).toBe(before);
  expect(await readFile(path.join(home, artifact), 'utf8')).toBe('A');
  expect(await resolve('excluded-gc', sourcesCoordinates, { offline: true })).toBe('A-SOURCES');
  await expect(
    resolve('excluded-gc', sourcesCoordinates, {
      offline: true,
      id: 'origin-b',
      remote: 'remote-b',
    }),
  ).rejects.toThrow(/offline mode/u);
  await expect(captureCacheMetadataSnapshot(state.model)).rejects.toThrow(
    /Incomplete Maven repository directory/u,
  );
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
    if (!different) await publish(remote, 'example', '1.0', 'A');
    expect(await resolve(winner)).toBe('A');
    expect(await resolve(loser, release, { id: 'origin-b', remote })).toBe(different ? 'B' : 'A');
    if (different) {
      await publish(remote, 'example', '1.0', 'LOSER-SOURCES', '-sources');
      expect(await resolve(loser, sourcesCoordinates, { id: 'origin-b', remote })).toBe(
        'LOSER-SOURCES',
      );
    }
    const a = await mavenFixtureState(path.join(root, winner), 'a-worker', chooseDirectory);
    const b = await mavenFixtureState(path.join(root, loser), 'z-worker', chooseDirectory);
    const packages = [
      await stageCutoffPackage(b.state, b.ci),
      await stageCutoffPackage(a.state, a.ci),
    ];
    const targetName = `policy-target-${different}`;
    const target = await mavenFixtureModel(path.join(root, targetName), chooseDirectory);
    const plan = mergeCutoffPackages(packages, target, a.ci);
    expect(plan.directoryConflicts?.count).toBe(1);
    await applyCutoffPlan(plan, target);
    expect(await readFile(path.join(target.cacheRoot, marker), 'utf8')).toBe(
      await readFile(path.join(root, winner, marker), 'utf8'),
    );
    for (const local of [winner, targetName]) {
      expect(await resolve(local, release, { offline: true })).toBe('A');
      await expect(
        resolve(local, release, { offline: true, id: 'origin-b', remote }),
      ).rejects.toThrow(/offline mode/u);
      if (different)
        await expect(resolve(local, sourcesCoordinates, { offline: true })).rejects.toThrow(
          /offline mode/u,
        );
    }
    if (different)
      await expect(readFile(path.join(target.cacheRoot, sourcesArtifact))).rejects.toThrow();
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
  const a = await mavenFixtureState(
    path.join(root, 'policy-remote-winner'),
    'a-remote',
    chooseDirectory,
  );
  const b = await mavenFixtureState(
    path.join(root, 'policy-local-loser'),
    'z-local',
    chooseDirectory,
  );
  const packages = [
    await stageCutoffPackage(b.state, b.ci),
    await stageCutoffPackage(a.state, a.ci),
  ];
  const model = await mavenFixtureModel(path.join(root, 'policy-install-target'), chooseDirectory);
  await applyCutoffPlan(mergeCutoffPackages(packages, model, a.ci), model);
  expect(await resolve('policy-install-target', release, { offline: true })).toBe('A');
  await expect(resolve('policy-install-target', coordinates, { offline: true })).rejects.toThrow(
    /offline mode/u,
  );
  await expect(resolve('policy-install-target', coordinates)).rejects.toThrow(
    /Could not find artifact/u,
  );
  expect(await readFile(path.join(model.cacheRoot, marker), 'utf8')).toBe(
    await readFile(path.join(root, 'policy-remote-winner', marker), 'utf8'),
  );
});

it('preserves native Maven origin resolution through independent partition-object archives', async () => {
  const { state, model } = await mavenFixtureState(path.join(root, 'seed'));
  state.policy.jobMode = 'standalone';
  const backend = new ImmutableCacheBackend(path.join(root, 'partition-archives'));
  const generation = createCacheGeneration(model, cutoffDecisionDigest(state));
  await freezePartitionPublication(state, generation);
  await publishPartitionGeneration(state, backend);
  const target = await mavenFixtureModel(path.join(root, 'partition-restored'));
  expect((await restoreBaseCache(target, { cacheBackend: backend })).status).toBe(
    'current-lineage-hit',
  );
  expect(await resolve('partition-restored', release, { offline: true })).toBe('A');
});
