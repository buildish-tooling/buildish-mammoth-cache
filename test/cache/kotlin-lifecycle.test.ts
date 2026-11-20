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
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { mergeCutoffPackages } from '../../src/delta/cutoff-apply';
import { verifyCutoffPackage } from '../../src/delta/cutoff-service';
import { resolveWorkspaceConflicts } from '../../src/delta/workspace-conflicts';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { CutoffArtifacts } from '../support/cutoff-artifacts';
import { cutoffJob } from '../support/cutoff-job';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';
import { writeKotlinWorkspace } from '../support/kotlin-cache';
import { captureWorkspaceEvidence } from '../support/gradle-workspace-evidence';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(overrides: object[] = []) {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/kotlin-life-'));
  roots.push(root);
  const backend = new ImmutableCacheBackend(path.join(root, 'archives')),
    artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  async function job(name: string, mode = 'standalone', dependencies = '') {
    const j = await cutoffJob(path.join(root, name), {
      name,
      cacheBackend: backend,
      artifactBackend: artifacts,
      inputs: {
        'job-mode': mode,
        'dependent-jobs': dependencies,
        'cache-gc-mode': 'off',
        'cache-partitions': JSON.stringify(overrides),
      },
    });
    const config = normalizeGradleActionConfig(readGradleActionInputs(j.deps.runtimeHost), {
        phase: 'prepare',
        ciContext: j.ci,
        env: { GRADLE_USER_HOME: j.home },
      }),
      adapter = new GradleBuildToolAdapter(config);
    j.adapter.getBuildToolId = () => 'gradle';
    j.adapter.getBuiltInPartitionPresets = () => adapter.getBuiltInPartitionPresets();
    j.adapter.getHardCacheExcludeGlobs = () => adapter.getHardCacheExcludeGlobs();
    return j;
  }
  return { root, backend, artifacts, job };
}
type Job = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['job']>>;
async function put(j: Job, name: string, content: string) {
  await mkdir(path.dirname(path.join(j.home, name)), { recursive: true });
  await writeFile(path.join(j.home, name), content);
}
const shared = 'caches/build-cache-1/' + '1'.repeat(32);
const modeOnly = 'caches/build-cache-1/' + '2'.repeat(32);
const ordinary = [
  'caches/9.8.1/generated-gradle-jars/api[one]!.jar',
  'caches/9.8.1/scripts/legacy/gc.properties',
  'caches/9.8.1/scripts/legacy/name]!.class',
];
it('selects complete independent units and unchanged archives through artifact and native backend round trips', async () => {
  const f = await fixture(),
    a = await f.job('worker-a', 'distributed-worker'),
    b = await f.job('worker-b', 'distributed-worker');
  await a.prepare();
  await b.prepare();
  const kinds = [
    'kotlin-script',
    'kotlin-accessor-jars',
    'kotlin-accessor-directories',
    'kotlin-plugin-spec-accessors',
  ] as const;
  for (const j of [a, b]) {
    for (const kind of kinds)
      await writeKotlinWorkspace(
        j.home,
        kind,
        kind === 'kotlin-accessor-directories' ? 'e'.repeat(32) : undefined,
        j === a ? 'A' : 'B',
        true,
      );
    await put(j, shared, j === a ? 'archive-A' : 'archive-B');
    await put(j, modeOnly, 'same-archive');
    await put(
      j,
      'caches/build-cache-1/' + (j === a ? 'a' : 'b').repeat(32),
      'disjoint-' + (j === a ? 'a' : 'b'),
    );
    await writeKotlinWorkspace(
      j.home,
      'kotlin-script',
      (j === a ? 'c' : 'd').repeat(32),
      'disjoint',
    );
    for (const name of ordinary) await put(j, name, 'ordinary');
  }
  await chmod(path.join(a.home, shared), 0o755);
  await chmod(path.join(b.home, modeOnly), 0o755);
  await executeFinalizeAction(b.deps);
  await executeFinalizeAction(a.deps);
  const packages = await Promise.all(
    f.artifacts.artifacts.map((p) =>
      verifyCutoffPackage(path.join(f.artifacts.storage, String(p.id)), p.name),
    ),
  );
  const aggregator = await f.job('aggregator', 'distributed-aggregator', 'worker-b,worker-a');
  const old = await writeKotlinWorkspace(aggregator.home);
  await put(aggregator, old + '/classes/Stale.class', 'stale');
  const prepared = await aggregator.prepare();
  const model = prepared.bootstrap.cacheModel!;
  const forward = mergeCutoffPackages(packages, model, aggregator.ci),
    reverse = mergeCutoffPackages([...packages].reverse(), model, aggregator.ci);
  expect(reverse).toEqual(forward);
  // Instrument a mutable copy; verified package manifests are deliberately immutable.
  const indexedPackages = structuredClone(packages);
  const workspacePartitions = indexedPackages.flatMap((pkg) =>
    pkg.manifest.partitions.filter((p) => (p.workspaces?.length ?? 0) > 1),
  );
  expect(workspacePartitions).toHaveLength(2);
  const indexBuilds = workspacePartitions.map((p) => vi.spyOn(p.upserts, 'map'));
  const resolved = resolveWorkspaceConflicts(indexedPackages, model);
  expect(resolved.chosen).toEqual(forward.workspaces);
  for (const build of indexBuilds) expect(build).toHaveBeenCalledTimes(1);
  expect(forward.directoryConflicts?.count).toBe(5);
  await expect(lstat(path.join(aggregator.home, old, 'classes/Stale.class'))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
  expect(await readFile(path.join(aggregator.home, shared), 'utf8')).toBe('archive-A');
  expect((await lstat(path.join(aggregator.home, shared))).mode & 0o777).toBe(0o755);
  expect((await lstat(path.join(aggregator.home, modeOnly))).mode & 0o777).toBe(0o644);
  for (const kind of kinds) {
    const suffix =
      kind === 'kotlin-script'
        ? 'scripts/' + 'a'.repeat(32)
        : 'accessors/' +
          (kind === 'kotlin-accessor-directories' ? 'e' : 'a').repeat(32) +
          (kind === 'kotlin-plugin-spec-accessors' ? '-PS' : '');
    expect(
      await readFile(
        path.join(aggregator.home, 'caches/9.8.1/kotlin-dsl', suffix, 'metadata.bin'),
        'utf8',
      ),
    ).toBe('origin-A');
  }
  const snapshot = await captureCacheMetadataSnapshot(model);
  expect(snapshot.workspaces).toHaveLength(6);
  await executeFinalizeAction(aggregator.deps);
  const reader = await f.job('reader');
  await reader.prepare();
  const restored = await captureCacheMetadataSnapshot({ ...model, cacheRoot: reader.home });
  expect(restored.workspaces!.map((u) => u.workspace)).toEqual(
    snapshot.workspaces!.map((u) => u.workspace),
  );
  for (const name of ordinary)
    expect(await readFile(path.join(reader.home, name), 'utf8')).toBe('ordinary');
  expect(await readFile(path.join(reader.home, shared), 'utf8')).toBe('archive-A');
  for (const key of ['a', 'b'])
    expect(
      await readFile(path.join(reader.home, 'caches/build-cache-1/' + key.repeat(32)), 'utf8'),
    ).toBe('disjoint-' + key);
  for (const unit of restored.workspaces!)
    for (const name of unit.workspace.emptyDirectories)
      expect((await lstat(path.join(reader.home, name))).isDirectory()).toBe(true);
  // Duplicate producer identities are ambiguous even for byte-identical packages.
  const duplicate = packages.find((p) => p.metadata.producer.jobName === 'worker-a')!;
  expect(() => mergeCutoffPackages([duplicate, duplicate], model, reader.ci)).toThrow(/Ambiguous/);
  const broken = structuredClone(duplicate);
  Object.assign(broken.manifest, { schemaVersion: 5 });
  expect(() => mergeCutoffPackages([broken], model, reader.ci)).toThrow();
});
it('round-trips an ordinary-only Kotlin partition with literal punctuation and reuses it unchanged', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  for (const name of ordinary) await put(seed, name, 'exact');
  await executeFinalizeAction(seed.deps);
  const before = f.backend.savedKeys.length,
    next = await f.job('next');
  await next.prepare();
  for (const name of ordinary)
    expect(await readFile(path.join(next.home, name), 'utf8')).toBe('exact');
  await executeFinalizeAction(next.deps);
  expect(f.backend.savedKeys).toHaveLength(before);
  const paths = f.backend.transfers.filter((t) => t.key.includes('-partition-kotlin-dsl-'));
  const normalized = paths.map((t) => {
    const first = t.paths[0]!,
      base = first.slice(0, first.indexOf('/caches/'));
    return t.paths.map((p) => p.replace(base, '<cache>'));
  });
  expect(normalized.length).toBeGreaterThan(1);
  for (const paths of normalized) expect(paths).toEqual(normalized[0]);
});
it.each(['kotlin-dsl', 'build-cache'])(
  'honors strict overrides for %s even with legacy duplicate relaxation',
  async (id) => {
    const f = await fixture([{ id, 'conflict-handling': 'default' }]),
      a = await f.job('worker-a', 'distributed-worker'),
      b = await f.job('worker-b', 'distributed-worker');
    await a.prepare();
    await b.prepare();
    for (const j of [a, b]) {
      if (id === 'kotlin-dsl')
        await writeKotlinWorkspace(j.home, undefined, undefined, j === a ? 'A' : 'B');
      else await put(j, shared, j === a ? 'A' : 'B');
      await executeFinalizeAction(j.deps);
    }
    const pkgs = await Promise.all(
      f.artifacts.artifacts.map((p) =>
        verifyCutoffPackage(path.join(f.artifacts.storage, String(p.id))),
      ),
    );
    const model = (await a.prepare()).bootstrap.cacheModel!;
    expect(() => mergeCutoffPackages(pkgs, model, a.ci, true)).toThrow(/Conflicting/);
  },
);
it.each([
  'caches/9.8.1/generated-gradle-jars/ordinary.jar',
  'caches/build-cache-1/not-a-key',
  'caches/modules-2/files-2.1/ordinary.jar',
  'custom/data',
])('keeps unrelated duplicate %s strict', async (name) => {
  const f = await fixture([{ id: 'extra', includes: ['custom/**'] }]),
    a = await f.job('worker-a', 'distributed-worker'),
    b = await f.job('worker-b', 'distributed-worker');
  await a.prepare();
  await b.prepare();
  for (const j of [a, b]) {
    await put(j, name, j === a ? 'A' : 'B');
    await executeFinalizeAction(j.deps);
  }
  const agg = await f.job('aggregator', 'distributed-aggregator', 'worker-a,worker-b');
  await expect(agg.prepare()).rejects.toThrow(/Conflicting/);
});

it('publishes complete standalone Kotlin units through native archives and reuses them unchanged', async () => {
  const f = await fixture(),
    seed = await f.job('standalone-seed');
  const prepared = await seed.prepare();
  expect(prepared.bootstrap.baseCacheResult?.status).toBe('miss');
  const kinds = [
    'kotlin-script',
    'kotlin-accessor-jars',
    'kotlin-accessor-directories',
    'kotlin-plugin-spec-accessors',
  ] as const;
  for (const [i, kind] of kinds.entries())
    await writeKotlinWorkspace(seed.home, kind, String(i).repeat(32), 'standalone');
  await put(seed, shared, 'standalone-task-archive');
  const expected = await captureWorkspaceEvidence(prepared.bootstrap.cacheModel!);
  expect([...expected.units.values()].map((u) => u.workspace.kind).sort()).toEqual(
    [...kinds].sort(),
  );
  await executeFinalizeAction(seed.deps);
  const saves = f.backend.savedKeys.length;
  const reader = await f.job('standalone-reader');
  const restored = await reader.prepare();
  expect(restored.bootstrap.baseCacheResult?.status).toBe('current-lineage-hit');
  const actual = await captureWorkspaceEvidence(restored.bootstrap.cacheModel!);
  expect(actual.units).toEqual(expected.units);
  expect(actual.archives).toEqual(expected.archives);
  for (const unit of expected.units.values())
    for (const directory of unit.workspace.emptyDirectories)
      expect((await lstat(path.join(reader.home, directory))).isDirectory()).toBe(true);
  await executeFinalizeAction(reader.deps);
  expect(f.backend.savedKeys).toHaveLength(saves);
});
