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
import { mkdir, mkdtemp, rm, readFile, writeFile, utimes, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as glob from '@actions/glob';
import * as guarded from '../../src/cache/guarded-files';
import { groovyFixtureModel, writeGroovyWorkspace } from '../support/groovy-cache';
import { cutoffFixtureCi, cutoffFixturePolicy } from '../support/cutoff-fixture';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
import {
  newCutoffJournal,
  persistCutoffJournal,
  freezeCutoffSelection,
  verifyCutoffReplay,
  loadCutoffJournal,
  cutoffJournalPath,
} from '../../src/cache/cutoff-state';
import { collectCutoffGarbage } from '../../src/cache/cutoff-gc';
import { stageCutoffPackage, verifyCutoffPackage } from '../../src/delta/cutoff-service';
import { mergeCutoffPackages, applyCutoffPlan } from '../../src/delta/cutoff-apply';
import {
  stageGroovyBase,
  restoreGroovyBase,
  resetGroovyBaseTransport,
} from '../../src/cache/groovy-base';
import { recoverGroovyApplication } from '../../src/cache/groovy-apply';
import { writeMetadata } from '../../src/cache/metadata-io';
import { createBaseCachePaths } from '../../src/cache/service';
import { GROOVY_WORKSPACE_METADATA } from '../../src/cache/groovy-workspaces';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/groovy-life-'));
  roots.push(root);
  return root;
}
async function freeze(
  root: string,
  job = 'worker-a',
  overrides: object[] = [],
  mode: 'standalone' | 'distributed-worker' = 'distributed-worker',
  cutoff = 0,
) {
  const model = await groovyFixtureModel(root, overrides),
    ci = cutoffFixtureCi(root, job);
  const state = newCutoffJournal(
    model,
    { ...cutoffFixturePolicy, jobMode: mode },
    {
      repository: ci.repository,
      workflowName: ci.workflowName,
      jobName: ci.jobName,
      runId: ci.runId,
      runAttempt: ci.runAttempt,
      sourceRevision: null,
    },
  );
  state.cutoff = cutoff;
  state.phase = 'build-ready';
  await persistCutoffJournal(state);
  const snapshot = await captureCacheMetadataSnapshot(model);
  await freezeCutoffSelection(
    state,
    selectCutoffActivity(
      snapshot,
      cutoff,
      Math.max(Date.now(), cutoff + 1),
      14,
      mode === 'standalone',
      undefined,
      model.partitions,
    ),
    Math.max(Date.now(), cutoff + 1),
  );
  return { model, ci, state };
}
async function worker(job: string, content: string, overrides: object[] = []) {
  const root = await fixture();
  await writeGroovyWorkspace(root, undefined, content);
  const frozen = await freeze(root, job, overrides);
  const pkg = await stageCutoffPackage(frozen.state, frozen.ci);
  await verifyCutoffPackage(pkg.rootDirectory);
  return { ...frozen, root, pkg };
}
it('keeps one complete winner and its empty directories while removing stale managed descendants', async () => {
  const a = await worker('worker-a', 'A'),
    b = await worker('worker-b', 'B');
  const target = await fixture(),
    unit = await writeGroovyWorkspace(target, undefined, 'old');
  await writeFile(path.join(target, unit, 'instrumented/proj/Old.class'), 'stale');
  const model = await groovyFixtureModel(target);
  const plan = mergeCutoffPackages([b.pkg, a.pkg], model, cutoffFixtureCi(target));
  expect(plan.directoryConflicts?.count).toBe(1);
  expect(
    mergeCutoffPackages([a.pkg, b.pkg], model, cutoffFixtureCi(target)).groovyWorkspaces,
  ).toEqual(plan.groovyWorkspaces);
  expect(plan.groovyWorkspaces![0]!.rootDirectory).toBe(a.pkg.rootDirectory);
  await applyCutoffPlan(plan, model);
  expect(await readFile(path.join(target, unit, 'instrumented/proj/Script.class'), 'utf8')).toBe(
    'A',
  );
  await expect(lstat(path.join(target, unit, 'instrumented/proj/Old.class'))).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
  expect((await lstat(path.join(target, unit, 'reports'))).isDirectory()).toBe(true);
  expect((await captureCacheMetadataSnapshot(model)).workspaces![0]!.workspace).toEqual(
    a.state.selection!.workspaces![0]!.workspace,
  );
});
it('rejects differences under an explicit strict policy rather than mixing workspace files', async () => {
  const strict = [{ id: 'groovy-dsl', 'conflict-handling': 'default' }];
  const a = await worker('worker-a', 'A', strict),
    b = await worker('worker-b', 'B', strict);
  expect(() => mergeCutoffPackages([a.pkg, b.pkg], a.model, a.ci, true)).toThrow(
    /Conflicting Groovy workspace/,
  );
});
it('retains distinct keys from different workers and rejects file-only imported views', async () => {
  const a = await worker('worker-a', 'A');
  const root = await fixture();
  await writeGroovyWorkspace(root, 'b'.repeat(32), 'B');
  const b = await freeze(root, 'worker-b'),
    pkg = await stageCutoffPackage(b.state, b.ci);
  const plan = mergeCutoffPackages([a.pkg, pkg], a.model, a.ci);
  expect(plan.groovyWorkspaces).toHaveLength(2);
  const incomplete = {
    ...a.pkg,
    manifest: {
      ...a.pkg.manifest,
      partitions: a.pkg.manifest.partitions.map((p) => ({ ...p, workspaces: [] })),
    },
  };
  expect(() => mergeCutoffPackages([incomplete], a.model, a.ci)).toThrow(/descriptor/);
});
it('preflights unmanaged obstacles before replacing any workspace', async () => {
  const a = await worker('worker-a', 'A'),
    target = await fixture(),
    unit = await writeGroovyWorkspace(target, undefined, 'old');
  await writeFile(path.join(target, unit, 'x.lock'), 'runner-local');
  const model = await groovyFixtureModel(target),
    plan = mergeCutoffPackages([a.pkg], model, a.ci);
  await expect(applyCutoffPlan(plan, model)).rejects.toThrow(/excluded|unmanaged/);
  expect(await readFile(path.join(target, unit, 'metadata.bin'), 'utf8')).toBe('origin-old');
});
it('does not replace a file occupying a workspace root', async () => {
  const a = await worker('worker-a', 'A'),
    target = await fixture(),
    unit = a.state.selection!.workspaces![0]!.workspace.root;
  await mkdir(path.dirname(path.join(target, unit)), { recursive: true });
  await writeFile(path.join(target, unit), 'unmanaged obstruction');
  const model = await groovyFixtureModel(target);
  await expect(applyCutoffPlan(mergeCutoffPackages([a.pkg], model, a.ci), model)).rejects.toThrow(
    /not a directory/,
  );
  expect(await readFile(path.join(target, unit), 'utf8')).toBe('unmanaged obstruction');
});
it('transfers complete units and directories through stable file-only base archive patterns', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root, undefined, undefined, true);
  const { state, model } = await freeze(root, 'standalone', [], 'standalone');
  const paths = createBaseCachePaths(model);
  await stageGroovyBase(state);
  await verifyCutoffReplay(state);
  expect(createBaseCachePaths(model)).toEqual(paths);
  const files = await (
    await glob.create(paths.join('\n'), { implicitDescendants: false, followSymbolicLinks: false })
  ).glob();
  expect(files.some((p) => p.includes('/caches/'))).toBe(false);
  const archive = await packCacheFiles(
    root,
    files.map((p) => path.relative(root, p)),
    path.join(await fixture(), 'archive'),
  );
  const target = await fixture(),
    restored = await groovyFixtureModel(target);
  await unpackCacheFiles(target, archive);
  await restoreGroovyBase(restored, true);
  expect((await lstat(path.join(target, unit, 'instrumented/proj'))).isDirectory()).toBe(true);
  expect((await captureCacheMetadataSnapshot(restored)).workspaces![0]!.workspace).toEqual(
    state.selection!.workspaces![0]!.workspace,
  );
  await resetGroovyBaseTransport(restored);
  await expect(restoreGroovyBase(restored, true)).rejects.toThrow(/metadata is missing/);
});
it('fails family and traversal sidecar checks before changing target data', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  const { model, state } = await freeze(root, 'standalone', [], 'standalone');
  await stageGroovyBase(state);
  const catalog = JSON.parse(await readFile(path.join(root, GROOVY_WORKSPACE_METADATA), 'utf8'));
  await writeMetadata(
    root,
    GROOVY_WORKSPACE_METADATA,
    { ...catalog, familyKey: 'foreign' },
    64 * 1024 * 1024,
  );
  await expect(restoreGroovyBase(model, true)).rejects.toThrow(/family/);
  catalog.units[0].workspace.emptyDirectories = ['../escape'];
  await writeMetadata(root, GROOVY_WORKSPACE_METADATA, catalog, 64 * 1024 * 1024);
  await expect(restoreGroovyBase(model, true)).rejects.toThrow();
  expect(await readFile(path.join(root, unit, 'metadata.bin'), 'utf8')).toBe('origin-compiled');
});
it('protects a whole unit if only one member was accessed and collects it only as a unit', async () => {
  const root = await fixture();
  await writeGroovyWorkspace(root);
  const model = await groovyFixtureModel(root),
    initial = await captureCacheMetadataSnapshot(model);
  for (const e of initial.partitions[0]!.entries)
    await utimes(path.join(root, e.relativePath), new Date(0), new Date(0));
  const cutoff = Date.now() + 50,
    snapshot = await captureCacheMetadataSnapshot(model),
    paths = snapshot.partitions[0]!.entries.map((e) => e.relativePath);
  const used = selectCutoffActivity(
    snapshot,
    cutoff,
    cutoff + 1,
    14,
    true,
    { upserts: [], used: [paths[0]!] },
    model.partitions,
  );
  expect(used.gc).toEqual([]);
  expect(used.used).toHaveLength(paths.length);
  const { state } = await freeze(root, 'standalone', [], 'standalone', cutoff);
  expect(state.selection!.gc).toHaveLength(paths.length);
  // A prior attempt unlinked one member before checkpointing the sweep.
  await rm(path.join(root, paths[0]!));
  await verifyCutoffReplay(state);
  await collectCutoffGarbage(state);
  await verifyCutoffReplay(state);
  await expect(
    lstat(path.join(root, state.selection!.workspaces![0]!.workspace.root)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('detects directory-only topology changes after the freeze', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  const { state } = await freeze(root);
  await mkdir(path.join(root, unit, 'new-empty-output'));
  await expect(verifyCutoffReplay(state)).rejects.toThrow(/retained content changed/);
});
it('recovers a recorded interrupted replacement as a cache miss without accepting a partial unit', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root),
    { model } = await freeze(root);
  const observation = (await captureCacheMetadataSnapshot(model)).workspaces![0]!;
  const stage = path.posix.dirname(unit) + '/.mammoth/stage-' + randomUUID();
  await mkdir(path.join(root, stage), { recursive: true });
  await writeFile(path.join(root, stage, 'partial.bin'), 'staging');
  await rm(path.join(root, unit, 'metadata.bin'));
  await writeMetadata(
    root,
    '.mammoth/groovy-apply-v1/intent.json',
    {
      schemaVersion: 1,
      familyKey: model.cacheFamilyKey,
      partitionId: 'groovy-dsl',
      root: unit,
      stage,
      allowedFiles: observation.workspace.files,
      allowedDirectories: observation.directories.map((d) => d.relativePath),
    },
    64 * 1024 * 1024,
  );
  await recoverGroovyApplication(model);
  await expect(lstat(path.join(root, unit))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.join(root, stage))).rejects.toMatchObject({ code: 'ENOENT' });
  await recoverGroovyApplication(model);
});

it('expands a seeded one-file change into a complete verified worker view', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  const model = await groovyFixtureModel(root),
    initial = await captureCacheMetadataSnapshot(model);
  const old = new Date(Date.now() - 30 * 86400_000);
  for (const entry of initial.partitions[0]!.entries)
    await utimes(path.join(root, entry.relativePath), old, old);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cutoff = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(root, unit, 'metadata.bin'), 'new origin only');
  const { state, ci } = await freeze(root, 'seeded-worker', [], 'distributed-worker', cutoff);
  const inherited = state.selection!.upserts.filter(
    (e) => e.relativePath !== unit + '/metadata.bin',
  );
  expect(inherited).toHaveLength(initial.partitions[0]!.entries.length - 1);
  expect(inherited.every((e) => e.identity.ctimeMs < cutoff)).toBe(true);
  expect(state.selection!.upserts).toHaveLength(initial.partitions[0]!.entries.length);
  const pkg = await stageCutoffPackage(state, ci);
  await verifyCutoffPackage(pkg.rootDirectory);
  const target = await fixture(),
    restored = await groovyFixtureModel(target);
  await applyCutoffPlan(mergeCutoffPackages([pkg], restored, ci), restored);
  expect(await readFile(path.join(target, unit, 'metadata.bin'), 'utf8')).toBe('new origin only');
  expect(await readFile(path.join(target, unit, 'instrumented/proj/Script.class'), 'utf8')).toBe(
    'compiled',
  );
  expect((await lstat(path.join(target, unit, 'reports'))).isDirectory()).toBe(true);
});

it('rejects target changes during staging before replacing the managed workspace', async () => {
  const a = await worker('worker-a', 'A'),
    target = await fixture(),
    unit = await writeGroovyWorkspace(target, undefined, 'old');
  const model = await groovyFixtureModel(target),
    copy = guarded.copyGuardedFile;
  vi.spyOn(guarded, 'copyGuardedFile').mockImplementationOnce(async (...args) => {
    await writeFile(path.join(target, unit, 'metadata.bin'), 'concurrent target update');
    return copy(...args);
  });
  await expect(applyCutoffPlan(mergeCutoffPackages([a.pkg], model, a.ci), model)).rejects.toThrow(
    /target changed during staging/,
  );
  expect(await readFile(path.join(target, unit, 'metadata.bin'), 'utf8')).toBe(
    'concurrent target update',
  );
});

it('preserves directory-only winner membership when a selected workspace is forwarded', async () => {
  const a = await worker('worker-a', 'same'),
    bRoot = await fixture();
  await writeGroovyWorkspace(bRoot, undefined, 'same');
  await mkdir(path.join(bRoot, 'caches/9.8.1/groovy-dsl', 'a'.repeat(32), 'reports', 'extra'));
  const b = await freeze(bRoot, 'worker-b'),
    bPkg = await stageCutoffPackage(b.state, b.ci),
    target = await fixture(),
    model = await groovyFixtureModel(target);
  const plan = mergeCutoffPackages([bPkg, a.pkg], model, cutoffFixtureCi(target));
  expect(plan.directoryConflicts?.count).toBe(1);
  await applyCutoffPlan(plan, model);
  const forwarded = await freeze(target, 'worker-forward'),
    forwardedPkg = await stageCutoffPackage(forwarded.state, forwarded.ci);
  await verifyCutoffPackage(forwardedPkg.rootDirectory);
  expect(
    forwardedPkg.manifest.partitions.find((p) => p.partitionId === 'groovy-dsl')?.workspaces,
  ).toEqual(a.pkg.manifest.partitions.find((p) => p.partitionId === 'groovy-dsl')?.workspaces);
  expect(forwardedPkg.metadata.producer.jobName).toBe('worker-forward');
});

it.each(['gc.properties', 'instrumented/proj/workspace.lock'])(
  'collects a workspace around excluded %s and checkpoints a retryable result',
  async (bookkeeping) => {
    const root = await fixture(),
      unit = await writeGroovyWorkspace(root),
      excluded = path.join(root, unit, bookkeeping);
    await writeFile(excluded, 'local bookkeeping');
    const model = await groovyFixtureModel(root),
      snapshot = await captureCacheMetadataSnapshot(model);
    for (const entry of snapshot.partitions[0]!.entries)
      await utimes(path.join(root, entry.relativePath), new Date(0), new Date(0));
    const { state } = await freeze(root, 'standalone', [], 'standalone', Date.now() + 50);
    const managed = state.selection!.gc.map((entry) => entry.relativePath);
    expect(managed).toHaveLength(snapshot.partitions[0]!.entries.length);
    expect(managed).not.toContain(unit + '/' + bookkeeping);
    // Simulate an interrupted sweep before its completion checkpoint.
    await rm(path.join(root, managed[0]!));
    await verifyCutoffReplay(state);
    expect((await collectCutoffGarbage(state))!.deletedFileCount).toBe(managed.length);
    const recovered = await loadCutoffJournal(model, cutoffJournalPath(state.invocation));
    expect(recovered.deletedPaths).toEqual([...managed].sort());
    await verifyCutoffReplay(recovered);
    expect((await collectCutoffGarbage(recovered))!.deletedFileCount).toBe(managed.length);
    for (const name of managed)
      await expect(lstat(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(excluded, 'utf8')).toBe('local bookkeeping');
    await stageGroovyBase(recovered);
    const catalog = JSON.parse(await readFile(path.join(root, GROOVY_WORKSPACE_METADATA), 'utf8'));
    expect(catalog.units).toEqual([]);
  },
);
