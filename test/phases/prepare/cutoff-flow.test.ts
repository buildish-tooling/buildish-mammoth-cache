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
import { mkdir, mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CutoffArtifacts } from '../../support/cutoff-artifacts';
import { stageCutoffPackage, uploadCutoffPackage } from '../../../src/delta/cutoff-service';
import { cutoffJob } from '../../support/cutoff-job';
import * as scanner from '../../../src/cache/manifest';
import * as fsUtil from '../../../src/util/fs';
import {
  readCutoffLifecycle,
  preflightCutoffLifecycle,
  CUTOFF_LIFECYCLE_STATE,
} from '../../../src/phases/cutoff-lifecycle';
import { createCutoffPrepareOutputs } from '../../../src/phases/prepare/cutoff-flow';
import { cutoffJournalPath, loadCutoffJournal } from '../../../src/cache/cutoff-state';
import { STANDARD_BASE_CACHE_BACKEND_CAPABILITIES } from '../../../src/cache/backend';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function root() {
  const r = await mkdtemp(path.join(os.tmpdir(), 'cutoff-prepare-'));
  roots.push(r);
  return r;
}
it('places the cutoff after all prepare reads without a baseline inventory or hash', async () => {
  const r = await root();
  let home = '';
  let touched = 0;
  const job = await cutoffJob(r, {
    provision: async () => {
      await mkdir(path.join(home, 'data'));
      await writeFile(path.join(home, 'data/a'), 'bytes');
      await readFile(path.join(home, 'data/a'));
      touched++;
    },
    hooks: async () => {
      await readFile(path.join(home, 'data/a'));
      touched++;
    },
  });
  home = job.home;
  const scan = vi.spyOn(scanner, 'captureCacheMetadataSnapshot'),
    hash = vi
      .spyOn(fsUtil, 'hashStableFileSha256')
      .mockRejectedValue(new Error('upfront content read'));
  const status = await job.prepare();
  expect(touched).toBe(2);
  expect(scan).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  expect(record.cacheEnabled).toBe(true);
  if (!record.cacheEnabled) throw new Error('enabled');
  const journal = await loadCutoffJournal(record.model, cutoffJournalPath(record.invocation));
  expect(journal.phase).toBe('build-ready');
  expect(journal.cutoff).toBe(status.cutoff);
  expect(createCutoffPrepareOutputs(status)['dependent-delta-status']).toBe('not-configured');
  expect(status).not.toHaveProperty('preBuildManifestState');
});
it('persists successful cache-disabled state without creating a journal and reconciles it without scanning', async () => {
  const job = await cutoffJob(await root(), { inputs: { 'cache-enabled': 'false' } });
  await job.prepare();
  const scan = vi.spyOn(scanner, 'captureCacheMetadataSnapshot');
  expect((await preflightCutoffLifecycle(job.deps.runtimeHost.getState)).journal).toBeNull();
  expect(scan).not.toHaveBeenCalled();
  job.state.delete(CUTOFF_LIFECYCLE_STATE);
  await expect(preflightCutoffLifecycle(job.deps.runtimeHost.getState)).rejects.toThrow(/missing/);
});
it('never establishes valid CI cutoff when prepare fails', async () => {
  const job = await cutoffJob(await root(), {
    provision: async () => {
      throw new Error('provision failed');
    },
  });
  await expect(job.prepare()).rejects.toThrow('provision failed');
  expect(job.state.has(CUTOFF_LIFECYCLE_STATE)).toBe(false);
});
it('pins restore cleanup to the original generation and records cutoff after re-restore', async () => {
  const calls: { primary: string; fallback: readonly string[] }[] = [];
  const job = await cutoffJob(await root(), {
    inputs: { 'restore-cleanup-mode': 'prune-managed' },
    cacheBackend: {
      capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
      isFeatureAvailable: () => true,
      isMissingPathsError: () => false,
      saveCache: async () => 1,
      restoreCache: async (_paths, primary, fallback = []) => {
        calls.push({ primary, fallback });
        return calls.length === 1 ? primary + 'old-generation' : primary;
      },
    },
  });
  await mkdir(path.join(job.home, 'data'));
  await writeFile(path.join(job.home, 'data/a'), 'old');
  const result = await job.prepare();
  expect(result.restoreCleanupResult?.deletedFileCount).toBe(1);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.primary).toBe(calls[0]!.primary + 'old-generation');
  expect(calls[1]!.fallback).toEqual([]);
});
it('on a hit does not invent publication evidence for untouched pre-cutoff extras', async () => {
  const job = await cutoffJob(await root());
  await mkdir(path.join(job.home, 'data'));
  await writeFile(path.join(job.home, 'data/a'), 'old');
  await utimes(path.join(job.home, 'data/a'), 1700000000, 1700000000);
  await job.prepare();
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  const state = await loadCutoffJournal(record.model, cutoffJournalPath(record.invocation));
  expect(state.workers).toEqual({ upserts: [], used: [] });
  expect(state.selection).toBeNull();
});

it('forwards imported old upserts and usage across worker-to-worker-to-aggregator chains', async () => {
  const r = await root(),
    artifacts = new CutoffArtifacts(path.join(r, 'artifacts'));
  const a = await cutoffJob(path.join(r, 'a'), {
    name: 'worker-a',
    inputs: { 'job-mode': 'distributed-worker' },
    artifactBackend: artifacts,
  });
  await mkdir(path.join(a.home, 'data'));
  await writeFile(path.join(a.home, 'data/used'), 'unchanged');
  await a.prepare();
  await writeFile(path.join(a.home, 'data/new'), 'newbytes');
  await utimes(path.join(a.home, 'data/new'), 1700000000, 1700000000);
  const record = readCutoffLifecycle(a.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  const actual = scanner.captureCacheMetadataSnapshot;
  const spy = vi
    .spyOn(scanner, 'captureCacheMetadataSnapshot')
    .mockImplementation(async (...args) => {
      const snap = await actual(...args);
      const entry = snap.partitions[0]!.entries.find((e) => e.relativePath === 'data/used')!;
      Object.assign(entry, { atimeMs: record.cutoff + 1 });
      entry.identity.atimeMs = record.cutoff + 1;
      entry.identity.ctimeMs = Math.min(entry.identity.ctimeMs, record.cutoff - 1);
      return snap;
    });
  const first = await preflightCutoffLifecycle(a.deps.runtimeHost.getState);
  spy.mockRestore();
  const pkg = await stageCutoffPackage(first.journal!, a.ci);
  await uploadCutoffPackage(artifacts, pkg);
  await rm(pkg.rootDirectory, { recursive: true });
  for (const [name, dependency, mode] of [
    ['worker-b', 'worker-a', 'distributed-worker'],
    ['aggregate', 'worker-b', 'distributed-aggregator'],
  ] as const) {
    const job = await cutoffJob(path.join(r, name), {
      name,
      inputs: { 'job-mode': mode, 'dependent-jobs': dependency },
      artifactBackend: artifacts,
    });
    job.deps.now = () => Date.now() + 10000;
    await mkdir(path.join(job.home, 'data'));
    if (mode === 'distributed-aggregator')
      await writeFile(path.join(job.home, 'data/used'), 'unchanged');
    const prepared = await job.prepare();
    expect(prepared.dependentDeltaResult).toMatchObject({
      upsertCount: 1,
      usedCount: mode === 'distributed-worker' ? 0 : 1,
    });
    expect(await readFile(path.join(job.home, 'data/new'), 'utf8')).toBe('newbytes');
    if (mode === 'distributed-worker') {
      // Missing during apply, present later with clocks older than C: retain upstream usage.
      await writeFile(path.join(job.home, 'data/used'), 'unchanged');
      await utimes(path.join(job.home, 'data/used'), 1700000000, 1700000000);
      const pre = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
      const forwarded = await stageCutoffPackage(pre.journal!, job.ci);
      expect(forwarded.manifest.partitions[0]!.usedPaths).toEqual(['data/used']);
      await uploadCutoffPackage(artifacts, forwarded);
      await rm(forwarded.rootDirectory, { recursive: true });
    }
  }
  expect(artifacts.artifacts).toHaveLength(2);
});
it('excludes real Gradle capture scripts and report scratch through finalize cleanup with custom includes', async () => {
  const job = await cutoffJob(await root());
  const { GradleBuildToolAdapter } = await import('../../../src/build-tool/gradle/adapter');
  const { readGradleActionInputs, normalizeGradleActionConfig } =
    await import('../../../src/build-tool/gradle/config');
  const { executeFinalizeAction } = await import('../../../src/phases/finalize/flow');
  const { INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME } =
    await import('../../../src/build-tool/gradle/build-result-capture-scripts');
  const config = normalizeGradleActionConfig(
    readGradleActionInputs({
      getInput: (key) =>
        key === 'cache-partitions'
          ? JSON.stringify([
              { id: 'custom', includes: ['init.d/**', 'data/**', '.buildish-mammoth-cache/**'] },
            ])
          : '',
    }),
    { phase: 'prepare', ciContext: job.ci, env: { GRADLE_USER_HOME: job.home } },
  );
  const adapter = new GradleBuildToolAdapter(config);
  vi.spyOn(adapter, 'provision').mockResolvedValue({
    items: [],
    warnings: [],
    additionalOutputs: {},
  });
  const ci = { ...job.ci, tempDirectory: job.home };
  const deps = {
    ...job.deps,
    config,
    ciProvider: { ...job.deps.ciProvider, context: ci },
    buildToolAdapterFactory: () => adapter,
  };
  const { executeCutoffPrepareAction } = await import('../../../src/phases/prepare/cutoff-flow');
  await executeCutoffPrepareAction(deps);
  expect(await readFile(path.join(job.home, 'init.d', INIT_SCRIPT_FILE_NAME), 'utf8')).not.toBe('');
  await mkdir(path.join(job.home, '.buildish-mammoth-cache/test'), { recursive: true });
  await writeFile(path.join(job.home, '.buildish-mammoth-cache/test/scratch'), 'transient');
  await mkdir(path.join(job.home, 'data'), { recursive: true });
  await writeFile(path.join(job.home, 'data/retained'), 'data');
  const result = await executeFinalizeAction(deps);
  expect(result.bootstrap.baseCacheResult?.status).toBe('saved');
  for (const name of [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME])
    await expect(readFile(path.join(job.home, 'init.d', name))).rejects.toThrow();
  const state = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!state.cacheEnabled) throw new Error('enabled');
  const saved = await loadCutoffJournal(state.model, cutoffJournalPath(state.invocation));
  expect(saved.selection?.upserts.map((e) => e.relativePath)).toEqual(['data/retained']);
});
