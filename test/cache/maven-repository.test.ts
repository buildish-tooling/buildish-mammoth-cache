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
import { afterEach, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
import { collectCutoffGarbage } from '../../src/cache/cutoff-gc';
import {
  persistCutoffJournal,
  freezeCutoffSelection,
  cutoffModelSchema,
} from '../../src/cache/cutoff-state';
import { restoreBaseCache } from '../../src/cache/service';
import { STANDARD_BASE_CACHE_BACKEND_CAPABILITIES } from '../../src/cache/backend';
import { stageCutoffPackage } from '../../src/delta/cutoff-service';
import { mergeCutoffPackages, applyCutoffPlan } from '../../src/delta/cutoff-apply';
import { mavenFixtureModel, mavenFixtureState } from '../support/maven-cache';
const roots: string[] = [];
const directory = 'repository/test/example/1.0';
const jar = `${directory}/example-1.0.jar`,
  marker = `${directory}/_remote.repositories`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maven-directory-'));
  roots.push(root);
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, jar), 'A');
  await writeFile(path.join(root, marker), 'example-1.0.jar>origin-a=\n');
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

it('includes the old marker and unchanged sibling in a changed-directory payload', async () => {
  const root = await fixture(),
    model = await mavenFixtureModel(root);
  const snapshot = await captureCacheMetadataSnapshot(model);
  const old = 1700000000000,
    cutoff = old + 30 * 86400000;
  for (const e of snapshot.partitions.flatMap((p) => p.entries)) {
    Object.assign(e.identity, { ctimeMs: old, mtimeMs: old, atimeMs: old });
    Object.assign(e, { mtimeMs: old, atimeMs: old });
    if (e.relativePath === jar) e.identity.ctimeMs = cutoff;
  }
  const selection = selectCutoffActivity(snapshot, cutoff, cutoff, 14, true);
  expect(selection.upserts.map((e) => e.relativePath)).toEqual([marker, jar]);
  expect(selection.gc).toEqual([]);
});
it('propagates path-only artifact usage to its old marker and retains the directory with missed native atime', async () => {
  const root = await fixture(),
    model = await mavenFixtureModel(root);
  const snapshot = await captureCacheMetadataSnapshot(model);
  const old = 1700000000000,
    cutoff = old + 30 * 86400000;
  for (const e of snapshot.partitions.flatMap((p) => p.entries)) {
    Object.assign(e.identity, { ctimeMs: old, mtimeMs: old, atimeMs: old });
    Object.assign(e, { mtimeMs: old, atimeMs: old });
  }
  const selection = selectCutoffActivity(snapshot, cutoff, cutoff, 14, true, {
    upserts: [],
    used: [jar],
  });
  expect(selection.upserts).toEqual([]);
  expect(selection.used).toEqual([marker, jar]);
  expect(selection.gc).toEqual([]);
  // Losing all native and upstream activity may evict bytes, but never just provenance.
  expect(
    selectCutoffActivity(snapshot, cutoff, cutoff, 14, true).gc.map((e) => e.relativePath),
  ).toEqual([marker, jar]);
});
it('retains an old marker when a young sibling survives the GC age cutoff without activity', async () => {
  const root = await fixture(),
    snapshot = await captureCacheMetadataSnapshot(await mavenFixtureModel(root));
  const now = Date.now(),
    cutoff = now + 10000;
  for (const e of snapshot.partitions.flatMap((p) => p.entries)) {
    Object.assign(e.identity, { ctimeMs: now - 1, mtimeMs: now - 30 * 86400000, atimeMs: 0 });
    Object.assign(e, {
      mtimeMs: e.relativePath === jar ? now - 1 : now - 30 * 86400000,
      atimeMs: 0,
    });
  }
  expect(selectCutoffActivity(snapshot, cutoff, cutoff, 14, true).gc).toEqual([]);
});
it('coalesces byte-identical complete directory views and rejects origin changes even with duplicate overrides', async () => {
  const root = await fixture(),
    a = await mavenFixtureState(root);
  const pkg = await stageCutoffPackage(a.state, a.ci);
  const clone = structuredClone(pkg);
  expect(mergeCutoffPackages([pkg, clone], a.model, a.ci).upserts).toHaveLength(2);
  clone.manifest.partitions[0]!.upserts.find((e) => e.relativePath === marker)!.contentSha256 =
    'f'.repeat(64);
  expect(() => mergeCutoffPackages([pkg, clone], a.model, a.ci, true)).toThrow(
    /Conflicting Maven repository directory/u,
  );
});
it('rejects incomplete target views before changing any managed file', async () => {
  const source = await fixture(),
    target = await fixture();
  await writeFile(path.join(target, directory, 'example-1.0-sources.jar'), 'SOURCES');
  await writeFile(path.join(target, marker), 'original target provenance');
  const a = await mavenFixtureState(source),
    pkg = await stageCutoffPackage(a.state, a.ci);
  const model = await mavenFixtureModel(target);
  await expect(applyCutoffPlan(mergeCutoffPackages([pkg], model, a.ci), model)).rejects.toThrow(
    /Incomplete Maven repository directory/u,
  );
  expect(await readFile(path.join(target, marker), 'utf8')).toBe('original target provenance');
  expect(await readFile(path.join(target, jar), 'utf8')).toBe('A');
});
it('rejects excluding markers while retaining repository artifacts', async () => {
  const root = await fixture(),
    model = await mavenFixtureModel(root);
  const partitions = model.partitions.map((p) => ({
    ...p,
    relativeExcludeGlobs: [...p.relativeExcludeGlobs, '**/_remote.repositories'],
  }));
  await expect(captureCacheMetadataSnapshot({ ...model, partitions })).rejects.toThrow(
    /must include origin markers/u,
  );
});

it('keeps the marker if GC stops while deleting sibling artifacts', async () => {
  const root = await fixture(),
    { state } = await mavenFixtureState(root);
  state.policy.jobMode = 'standalone';
  state.selection!.gc = state.selection!.upserts;
  state.selection!.upserts = [];
  state.selection!.members = state.selection!.members!.filter((e) => e.relativePath !== sourcesJar);
  await persistCutoffJournal(state);
  // Force the artifact guard to fail; the marker must not have been deleted first.
  await utimes(path.join(root, jar), 1700000000, 1700000000);
  await expect(collectCutoffGarbage(state)).rejects.toThrow(/Frozen GC target changed/u);
  expect(await readFile(path.join(root, marker), 'utf8')).toContain('origin-a');
});

it('retains caller exclusions for snapshots and project installs without stripping release markers', async () => {
  const root = await fixture();
  for (const name of [
    'repository/test/example/2.0-SNAPSHOT/example.jar',
    'repository/com/example/my-project/1.0/example.jar',
  ]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'excluded');
  }
  const model = await mavenFixtureModel(root, {
    'cache-partitions': JSON.stringify([
      {
        id: 'repository',
        includes: ['repository/**'],
        excludes: ['repository/**/*-SNAPSHOT/**', 'repository/com/example/my-project/**'],
      },
    ]),
  });
  const names = (await captureCacheMetadataSnapshot(model)).partitions.flatMap((p) =>
    p.entries.map((e) => e.relativePath),
  );
  expect(names).toEqual([marker, jar]);
});

const sourcesJar = `${directory}/example-1.0-sources.jar`;
const excludeSources = {
  'cache-partitions': JSON.stringify([
    {
      id: 'repository',
      includes: ['repository/**'],
      excludes: ['**/*-sources.jar'],
    },
  ]),
};

it('rejects a source snapshot whose marker would be separated from an excluded sibling', async () => {
  const root = await fixture();
  await writeFile(path.join(root, sourcesJar), 'A-SOURCES');
  await expect(
    captureCacheMetadataSnapshot(await mavenFixtureModel(root, excludeSources)),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
});
it('rejects replacing provenance over an excluded target sibling before any managed mutation', async () => {
  const source = await fixture(),
    target = await fixture();
  await writeFile(path.join(source, jar), 'B');
  const worker = await mavenFixtureState(source),
    pkg = await stageCutoffPackage(worker.state, worker.ci);
  await writeFile(path.join(target, sourcesJar), 'A-SOURCES');
  const originalMarker = await readFile(path.join(target, marker), 'utf8');
  const model = await mavenFixtureModel(target, excludeSources);
  // Exercise application directly with only the worker's managed files in the plan.
  await expect(
    applyCutoffPlan(
      {
        upserts: pkg.manifest.partitions.flatMap((p) =>
          p.upserts.map((entry) => ({
            partitionId: p.partitionId,
            entry,
            rootDirectory: pkg.rootDirectory,
          })),
        ),
        used: [],
      },
      model,
    ),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
  expect(await readFile(path.join(target, jar), 'utf8')).toBe('A');
  expect(await readFile(path.join(target, marker), 'utf8')).toBe(originalMarker);
  expect(await readFile(path.join(target, sourcesJar), 'utf8')).toBe('A-SOURCES');
});
it('rejects a frozen GC plan that would leave an excluded sibling without its marker', async () => {
  const root = await fixture();
  await writeFile(path.join(root, sourcesJar), 'A-SOURCES');
  const { state } = await mavenFixtureState(root);
  const originalMarker = await readFile(path.join(root, marker), 'utf8');
  state.model = cutoffModelSchema.parse(await mavenFixtureModel(root, excludeSources));
  state.policy.jobMode = 'standalone';
  state.selection!.gc = state.selection!.upserts.filter((e) => e.relativePath !== sourcesJar);
  state.selection!.upserts = [];
  state.selection!.members = state.selection!.members!.filter((e) => e.relativePath !== sourcesJar);
  await persistCutoffJournal(state);
  await expect(collectCutoffGarbage(state)).rejects.toThrow(
    /Incomplete Maven repository directory/u,
  );
  expect(await readFile(path.join(root, marker), 'utf8')).toBe(originalMarker);
  expect(await readFile(path.join(root, jar), 'utf8')).toBe('A');
  expect(await readFile(path.join(root, sourcesJar), 'utf8')).toBe('A-SOURCES');
});
it('rejects a partial repository before base restore even when only an excluded sibling exists', async () => {
  const root = await fixture();
  await rm(path.join(root, jar));
  await rm(path.join(root, marker));
  await writeFile(path.join(root, sourcesJar), 'A-SOURCES');
  const model = await mavenFixtureModel(root, excludeSources);
  const restore = vi.fn(async () => undefined);
  await expect(
    restoreBaseCache(model, {
      cacheBackend: {
        capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
        isFeatureAvailable: () => true,
        isMissingPathsError: () => false,
        restoreCache: restore,
        saveCache: async () => 1,
      },
    }),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
  expect(restore).not.toHaveBeenCalled();
  expect(await readFile(path.join(root, sourcesJar), 'utf8')).toBe('A-SOURCES');
});
it('stages and forwards usage-only packages with mixed-case classifiers in canonical order', async () => {
  const root = await fixture();
  for (const classifier of ['B', 'a'])
    await writeFile(path.join(root, directory, `example-1.0-${classifier}.jar`), classifier);
  const { state, model, ci } = await mavenFixtureState(root);
  state.phase = 'build-ready';
  state.selection = null;
  state.observedAt = null;
  state.cutoff = Date.now() + 10000;
  await persistCutoffJournal(state);
  const selection = selectCutoffActivity(
    await captureCacheMetadataSnapshot(model),
    state.cutoff,
    state.cutoff,
    14,
    false,
    { upserts: [], used: [jar] },
  );
  await freezeCutoffSelection(state, selection, state.cutoff);
  const pkg = await stageCutoffPackage(state, ci);
  const expected = [
    marker,
    jar,
    `${directory}/example-1.0-B.jar`,
    `${directory}/example-1.0-a.jar`,
  ].sort((a, b) => a.localeCompare(b));
  expect(pkg.manifest.partitions[0]!.usedPaths).toEqual(expected);
  expect(pkg.manifest.partitions.every((p) => p.upserts.length === 0)).toBe(true);
  expect(pkg.files).toHaveLength(2);
  const plan = mergeCutoffPackages([pkg], model, ci);
  expect(plan.used).toEqual(expected);
  expect(await applyCutoffPlan(plan, model)).toEqual({ upserts: [], used: expected });
});

it('rejects an excluded sibling that appears after freeze before staging the marker', async () => {
  const root = await fixture(),
    { state, ci } = await mavenFixtureState(root);
  state.model = cutoffModelSchema.parse(await mavenFixtureModel(root, excludeSources));
  await persistCutoffJournal(state);
  await writeFile(path.join(root, sourcesJar), 'A-SOURCES');
  await expect(stageCutoffPackage(state, ci)).rejects.toThrow(
    /Incomplete Maven repository directory/u,
  );
});
it('permits Resolver check state and locks without treating them as excluded artifacts', async () => {
  const root = await fixture();
  for (const name of [
    'example-1.0.jar.lastUpdated',
    'resolver-status.properties',
    'repository.lock',
  ])
    await writeFile(path.join(root, directory, name), 'disposable');
  const snapshot = await captureCacheMetadataSnapshot(await mavenFixtureModel(root));
  expect(snapshot.partitions.flatMap((p) => p.entries.map((e) => e.relativePath))).toEqual([
    marker,
    jar,
  ]);
});

it('rejects shared-marker classifier views and origin conflicts before mutation even with overrides', async () => {
  const aRoot = await fixture(),
    sourcesRoot = await fixture(),
    otherRoot = await fixture();
  const sources = directory + '/example-1.0-sources.jar';
  await rm(path.join(sourcesRoot, jar));
  await writeFile(path.join(sourcesRoot, sources), 'SOURCES');
  await writeFile(path.join(sourcesRoot, marker), 'example-1.0-sources.jar>origin-a=\n');
  await writeFile(path.join(otherRoot, jar), 'B');
  await writeFile(path.join(otherRoot, marker), 'example-1.0.jar>origin-b=\n');
  const a = await mavenFixtureState(aRoot, 'worker-a');
  const source = await mavenFixtureState(sourcesRoot, 'sources');
  const other = await mavenFixtureState(otherRoot, 'other');
  const pkg = await stageCutoffPackage(a.state, a.ci);
  const target = await mavenFixtureModel(await fixture());
  for (const state of [source, other]) {
    const candidate = await stageCutoffPackage(state.state, state.ci);
    for (const override of [false, true])
      expect(() => mergeCutoffPackages([pkg, candidate], target, a.ci, override)).toThrow(
        /Conflicting Maven repository directory/u,
      );
  }
  const sourcePackage = await stageCutoffPackage(source.state, source.ci);
  await expect(
    applyCutoffPlan(mergeCutoffPackages([sourcePackage], a.model, a.ci), a.model),
  ).rejects.toThrow(/Incomplete Maven repository directory/u);
  expect(await readFile(path.join(aRoot, jar), 'utf8')).toBe('A');
  expect(await readFile(path.join(aRoot, marker), 'utf8')).toBe('example-1.0.jar>origin-a=\n');
});
