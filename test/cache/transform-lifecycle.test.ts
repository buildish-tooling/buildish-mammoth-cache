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
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gradleCacheJobs, snapshotGradleJob } from '../support/gradle-cache-jobs';
import { transformFixtureModel, writeTransformWorkspace } from '../support/transform-cache';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { verifyCutoffPackage } from '../../src/delta/cutoff-service';
import { mergeCutoffPackages } from '../../src/delta/cutoff-apply';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
import {
  newCutoffJournal,
  persistCutoffJournal,
  freezeCutoffSelection,
  verifyCutoffReplay,
  cutoffJournalSchema,
} from '../../src/cache/cutoff-state';
import { cutoffFixtureCi, cutoffFixturePolicy } from '../support/cutoff-fixture';
import { collectCutoffGarbage } from '../../src/cache/cutoff-gc';
import { recoverWorkspaceApplication } from '../../src/cache/workspace-apply';
import { writeMetadata } from '../../src/cache/metadata-io';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(overrides: object[] = []) {
  const f = await gradleCacheJobs('transform-life-', [{ id: 'transforms-metadata' }, ...overrides]);
  roots.push(f.root);
  return f;
}
async function scratch() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/transform-gc-'));
  roots.push(root);
  return root;
}
it.each(['transforms-4', '9.8.1/transforms'])(
  'round-trips complete %s winners and disjoint keys, preserving gc.properties and empty directories',
  async (layout) => {
    const f = await fixture(),
      a = await f.job('worker-a', 'distributed-worker'),
      b = await f.job('worker-b', 'distributed-worker');
    await a.prepare();
    await b.prepare();
    for (const [j, content, key] of [
      [a, 'A', 'c'],
      [b, 'B', 'd'],
    ] as const) {
      await writeTransformWorkspace(j.home, layout, undefined, content);
      await writeTransformWorkspace(j.home, layout, key.repeat(32), content, true);
      await executeFinalizeAction(j.deps);
    }
    const packages = await Promise.all(
      f.artifacts.artifacts.map((p) =>
        verifyCutoffPackage(path.join(f.artifacts.storage, String(p.id)), p.name),
      ),
    );
    const aggregator = await f.job('aggregate', 'distributed-aggregator', 'worker-b,worker-a');
    const old = await writeTransformWorkspace(aggregator.home, layout, undefined, 'old');
    await writeFile(path.join(aggregator.home, old, 'transformed/stale.txt'), 'stale');
    const prepared = await aggregator.prepare(),
      model = prepared.bootstrap.cacheModel!;
    const plan = mergeCutoffPackages(packages, model, aggregator.ci);
    expect(mergeCutoffPackages([...packages].reverse(), model, aggregator.ci)).toEqual(plan);
    expect(plan.directoryConflicts?.count).toBe(1);
    expect(await readFile(path.join(aggregator.home, old, 'metadata.bin'), 'utf8')).toBe(
      'origin-A',
    );
    expect(await readFile(path.join(aggregator.home, old, 'transformed/output.txt'), 'utf8')).toBe(
      'A',
    );
    await expect(
      lstat(path.join(aggregator.home, old, 'transformed/stale.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const selected = await snapshotGradleJob(aggregator);
    expect(selected.workspaces).toHaveLength(3);
    await executeFinalizeAction(aggregator.deps);
    const reader = await f.job('reader');
    await reader.prepare();
    expect((await snapshotGradleJob(reader)).workspaces?.map((u) => u.workspace)).toEqual(
      selected.workspaces!.map((u) => u.workspace),
    );
    expect(
      await readFile(path.join(reader.home, old, 'transformed/nested/gc.properties'), 'utf8'),
    ).toBe('real-output');
    for (const u of selected.workspaces!)
      for (const directory of u.workspace.emptyDirectories)
        expect((await lstat(path.join(reader.home, directory))).isDirectory()).toBe(true);
    const saves = f.backend.savedKeys.length;
    await executeFinalizeAction(reader.deps);
    expect(f.backend.savedKeys).toHaveLength(saves);
    const duplicate = packages[0]!;
    expect(() => mergeCutoffPackages([duplicate, duplicate], model, reader.ci)).toThrow(
      /Ambiguous/,
    );
    const oldPackage = structuredClone(duplicate);
    Object.assign(oldPackage.manifest, { schemaVersion: 6 });
    expect(() => mergeCutoffPackages([oldPackage], model, reader.ci)).toThrow();
  },
);
it('honors strict transform overrides despite legacy duplicate relaxation', async () => {
  const f = await gradleCacheJobs('transform-strict-', [
    { id: 'transforms-metadata', 'conflict-handling': 'default' },
  ]);
  roots.push(f.root);
  const packages: Awaited<ReturnType<typeof verifyCutoffPackage>>[] = [];
  for (const name of ['worker-a', 'worker-b']) {
    const j = await f.job(name, 'distributed-worker');
    await j.prepare();
    await writeTransformWorkspace(j.home, undefined, undefined, name);
    await executeFinalizeAction(j.deps);
  }
  for (const p of f.artifacts.artifacts)
    packages.push(await verifyCutoffPackage(path.join(f.artifacts.storage, String(p.id)), p.name));
  const aggregator = await f.job('aggregate', 'distributed-aggregator', 'worker-a,worker-b');
  await expect(aggregator.prepare()).rejects.toThrow(/Conflicting/);
  const model = (await (await f.job('strict-model')).prepare()).bootstrap.cacheModel!;
  expect(() => mergeCutoffPackages(packages, model, aggregator.ci, true)).toThrow(/Conflicting/);
});
it('keeps custom transform partitions strict unless explicitly opted into selection', async () => {
  const root = await scratch();
  const model = await transformFixtureModel(root, [
    { id: 'transforms-metadata', includes: [] },
    { id: 'custom-transform', includes: ['caches/*/transforms/**'] },
  ]);
  expect(model.partitions[0]?.conflictHandling).toBeUndefined();
});
it('protects and collects whole transform units, including real gc.properties and empty outputs', async () => {
  const root = await scratch(),
    unit = await writeTransformWorkspace(root);
  const model = await transformFixtureModel(root),
    before = await captureCacheMetadataSnapshot(model),
    old = new Date(1);
  for (const file of before.partitions.flatMap((p) => p.entries))
    await utimes(path.join(root, file.relativePath), old, old);
  for (const dir of [...before.workspaces![0]!.directories].reverse())
    await utimes(path.join(root, dir.relativePath), old, old);
  const snapshot = await captureCacheMetadataSnapshot(model),
    now = Date.now();
  const used = selectCutoffActivity(snapshot, now, now + 1, 14, true, {
    upserts: [],
    used: [unit + '/transformed/nested/gc.properties'],
  });
  expect(used.gc).toEqual([]);
  expect(used.used).toHaveLength(snapshot.workspaces![0]!.workspace.files.length);
  const selection = selectCutoffActivity(snapshot, now, now + 1, 14, true);
  expect(selection.gc).toHaveLength(snapshot.workspaces![0]!.workspace.files.length);
  const ci = cutoffFixtureCi(root),
    state = newCutoffJournal(
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
  state.phase = 'build-ready';
  state.cutoff = now;
  await persistCutoffJournal(state);
  await freezeCutoffSelection(state, selection, now + 1);
  expect(cutoffJournalSchema.safeParse({ ...state, schemaVersion: 5 }).success).toBe(false);
  await collectCutoffGarbage(state);
  await expect(lstat(path.join(root, unit))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects directory-only changes after the freeze', async () => {
  const root = await scratch();
  await writeTransformWorkspace(root);
  const model = await transformFixtureModel(root),
    ci = cutoffFixtureCi(root);
  const state = newCutoffJournal(model, cutoffFixturePolicy, {
    repository: ci.repository,
    workflowName: ci.workflowName,
    jobName: ci.jobName,
    runId: ci.runId,
    runAttempt: ci.runAttempt,
    sourceRevision: null,
  });
  state.phase = 'build-ready';
  state.cutoff = 0;
  await persistCutoffJournal(state);
  await freezeCutoffSelection(
    state,
    selectCutoffActivity(await captureCacheMetadataSnapshot(model), 0, Date.now(), 14, false),
    Date.now(),
  );
  const unit = state.selection!.workspaces![0]!.workspace.root;
  await mkdir(path.join(root, unit, 'new-empty'));
  await expect(verifyCutoffReplay(state)).rejects.toThrow(/retained content changed/);
});
it('recovers interrupted complete-unit replacement without accepting the partial target', async () => {
  const root = await scratch(),
    unit = await writeTransformWorkspace(root),
    model = await transformFixtureModel(root);
  const observation = (await captureCacheMetadataSnapshot(model)).workspaces![0]!;
  const stage = path.posix.dirname(unit) + '/.mammoth/stage-' + randomUUID();
  await mkdir(path.join(root, stage), { recursive: true });
  await writeFile(path.join(root, stage, 'partial.bin'), 'stage');
  await rm(path.join(root, unit, 'metadata.bin'));
  await writeMetadata(
    root,
    '.mammoth/workspace-apply-v3/intent.json',
    {
      schemaVersion: 3,
      familyKey: model.cacheFamilyKey,
      partitionId: 'transforms-metadata',
      root: unit,
      stage,
      allowedFiles: observation.workspace.files,
      allowedDirectories: observation.directories.map((d) => d.relativePath),
    },
    64 * 1024 * 1024,
  );
  await recoverWorkspaceApplication(model);
  await expect(lstat(path.join(root, unit))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.join(root, stage))).rejects.toMatchObject({ code: 'ENOENT' });
  await recoverWorkspaceApplication(model);
});
it.each(['groovy-apply-v1', 'workspace-apply-v2'])(
  'rejects previous %s intent before touching cached outputs',
  async (previous) => {
    const root = await scratch(),
      unit = await writeTransformWorkspace(root),
      model = await transformFixtureModel(root);
    await writeMetadata(root, '.mammoth/' + previous + '/intent.json', { schemaVersion: 2 }, 1024);
    await expect(recoverWorkspaceApplication(model)).rejects.toThrow(/previous-format/);
    expect(await readFile(path.join(root, unit, 'metadata.bin'), 'utf8')).toBe('origin-compiled');
  },
);

it('rejects previous-family file-only packages for unchanged custom transform includes before applying files', async () => {
  const f = await gradleCacheJobs('transform-old-custom-', [
    { id: 'transforms-metadata', includes: [] },
    { id: 'custom-transforms', includes: ['caches/*/transforms/**'] },
  ]);
  roots.push(f.root);
  const producer = await f.job('worker', 'distributed-worker');
  await producer.prepare();
  const unit = await writeTransformWorkspace(producer.home);
  await executeFinalizeAction(producer.deps);
  const artifact = f.artifacts.artifacts[0]!;
  const pkg = await verifyCutoffPackage(
    path.join(f.artifacts.storage, String(artifact.id)),
    artifact.name,
  );
  const reader = await f.job('reader');
  const model = (await reader.prepare()).bootstrap.cacheModel!;
  expect(model.partitions.find((p) => p.id === 'custom-transforms')!.relativeIncludeGlobs).toEqual([
    'caches/*/transforms/**',
  ]);
  const old = structuredClone(pkg);
  old.metadata.cacheIdentity.familyKey = model.cacheFamilyKey.replace('-v8-', '-v7-');
  old.metadata.cacheIdentity.refLineagePrefix = model.currentRefLineagePrefix.replace(
    '-v8-',
    '-v7-',
  );
  for (const p of old.manifest.partitions) delete p.workspaces;
  expect(() => mergeCutoffPackages([old], model, reader.ci)).toThrow(/identity mismatch/);
  Object.assign(old.metadata, { schemaVersion: 7 });
  Object.assign(old.manifest, { schemaVersion: 6 });
  expect(() => mergeCutoffPackages([old], model, reader.ci)).toThrow();
  await expect(lstat(path.join(reader.home, unit))).rejects.toMatchObject({ code: 'ENOENT' });
});
