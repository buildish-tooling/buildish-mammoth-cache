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
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cutoffJob } from '../../support/cutoff-job';
import { CutoffArtifacts } from '../../support/cutoff-artifacts';
import { executeFinalizeAction } from '../../../src/phases/finalize/flow';
import {
  preflightCutoffLifecycle,
  readCutoffLifecycle,
} from '../../../src/phases/cutoff-lifecycle';
import * as scans from '../../../src/cache/manifest';
import { cutoffJournalPath, loadCutoffJournal } from '../../../src/cache/cutoff-state';
const roots: string[] = [];
async function root() {
  const r = await mkdtemp(path.join(os.tmpdir(), 'cutoff-final-'));
  roots.push(r);
  return r;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function data(job: Awaited<ReturnType<typeof cutoffJob>>, name: string, value = 'bytes') {
  await mkdir(path.dirname(path.join(job.home, name)), { recursive: true });
  await writeFile(path.join(job.home, name), value);
}
async function journal(job: Awaited<ReturnType<typeof cutoffJob>>) {
  const r = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!r.cacheEnabled) throw new Error('enabled');
  return loadCutoffJournal(r.model, cutoffJournalPath(r.invocation));
}
it('freezes before report content reads, publishes new bytes, and reuses local successful receipt', async () => {
  const job = await cutoffJob(await root());
  await job.prepare();
  await data(job, 'data/new');
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  const scan = vi.spyOn(scans, 'captureCacheManifest');
  job.adapter.collectBuildReport = async () => {
    expect((await journal(job)).phase).not.toBe('build-ready');
    await readFile(path.join(job.home, 'data/new'));
    return {
      anyBuildFailed: false,
      warnings: [],
      summaryLines: ['retained build report'],
      logLines: [],
      builds: [],
    };
  };
  const first = await executeFinalizeAction(job.deps);
  expect(first.bootstrap.baseCacheResult?.status).toBe('saved');
  expect(save).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
  expect(first.cacheStatistics?.upsertCount).toBe(1);
  expect(job.summaries.join('\n')).toContain('retained build report');
  await executeFinalizeAction(job.deps);
  expect(save).toHaveBeenCalledTimes(1);
});
it.each(['off', 'timestamp'])(
  'retains only one completed local journal across repeated %s lifecycles',
  async (mode) => {
    const job = await cutoffJob(await root(), { inputs: { 'cache-gc-mode': mode } });
    await data(job, 'data/a');
    for (let i = 0; i < 5; i++) {
      await job.prepare();
      await executeFinalizeAction(job.deps);
    }
    const files = await readdir(path.join(job.home, '.mammoth/cutoff-state-v1'));
    expect(files.filter((f) => f.startsWith('journal-'))).toHaveLength(1);
  },
);
it.each(['read-only', 'worker', 'cleanup-off', 'gc-off'])(
  'honors %s deletion and publication gates',
  async (mode) => {
    const inputs: Record<string, string> =
      mode === 'read-only'
        ? { 'read-only': 'true' }
        : mode === 'worker'
          ? { 'job-mode': 'distributed-worker' }
          : mode === 'cleanup-off'
            ? { 'cleanup-enabled': 'false' }
            : { 'cache-gc-mode': 'off' };
    const r = await root(),
      artifacts = new CutoffArtifacts(path.join(r, 'artifacts'));
    const job = await cutoffJob(r, { inputs, artifactBackend: artifacts });
    await data(job, 'data/old');
    await utimes(path.join(job.home, 'data/old'), 1700000000, 1700000000);
    job.deps.now = () => Date.now() + 10000;
    await job.prepare();
    const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
    const result = await executeFinalizeAction(job.deps);
    expect(result.cacheGcResult).toBeNull();
    expect(await readFile(path.join(job.home, 'data/old'), 'utf8')).toBe('bytes');
    if (mode === 'read-only' || mode === 'worker') expect(save).not.toHaveBeenCalled();
  },
);
it('deletes frozen old targets despite Mammoth report atime and publishes an empty generation', async () => {
  const job = await cutoffJob(await root());
  await data(job, 'data/old');
  await utimes(path.join(job.home, 'data/old'), 1700000000, 1700000000);
  job.deps.now = () => Date.now() + 10000;
  await job.prepare();
  job.adapter.collectBuildReport = async () => {
    await readFile(path.join(job.home, 'data/old'));
    return { anyBuildFailed: false, warnings: [], summaryLines: [], logLines: [], builds: [] };
  };
  const result = await executeFinalizeAction(job.deps);
  expect(result.cacheGcResult?.deletedFileCount).toBe(1);
  expect(result.bootstrap.baseCacheResult?.status).toBe('saved');
  await expect(readFile(path.join(job.home, 'data/old'))).rejects.toThrow();
  expect(
    JSON.parse(await readFile(path.join(job.home, '.mammoth/empty-generation-v1'), 'utf8')),
  ).toBe('mammoth-empty-v1');
});
it('keeps imported paths protected before aggregate cutoff, including upstream used-only records', async () => {
  const r = await root(),
    artifacts = new CutoffArtifacts(path.join(r, 'artifacts'));
  const worker = await cutoffJob(path.join(r, 'worker'), {
    name: 'worker',
    inputs: { 'job-mode': 'distributed-worker' },
    artifactBackend: artifacts,
  });
  await worker.prepare();
  await data(worker, 'data/imported');
  await utimes(path.join(worker.home, 'data/imported'), 1700000000, 1700000000);
  const published = await executeFinalizeAction(worker.deps);
  expect(published.deltaArtifactResult?.status).toBe('uploaded');
  // Same invocation retries retain envelope and stable identity.
  await executeFinalizeAction(worker.deps);
  expect(artifacts.artifacts).toHaveLength(1);
  const aggregate = await cutoffJob(path.join(r, 'aggregate'), {
    inputs: { 'job-mode': 'distributed-aggregator', 'dependent-jobs': 'worker' },
    artifactBackend: artifacts,
  });
  aggregate.deps.now = () => Date.now() + 10000;
  await aggregate.prepare();
  const final = await executeFinalizeAction(aggregate.deps);
  expect(final.cacheGcResult?.deletedFileCount).toBe(0);
  expect(final.bootstrap.baseCacheResult?.status).toBe('saved');
  expect(await readFile(path.join(aggregate.home, 'data/imported'), 'utf8')).toBe('bytes');
  // Fresh aggregator replay still succeeds and republishes applied upserts.
  await aggregate.prepare();
  await executeFinalizeAction(aggregate.deps);
  expect(artifacts.artifacts).toHaveLength(1);
});
it.each([0, -1])(
  'fails aggregation on required publication decline %s and retries the frozen key',
  async (decline) => {
    const job = await cutoffJob(await root(), { inputs: { 'job-mode': 'distributed-aggregator' } });
    await job.prepare();
    await data(job, 'data/new');
    const save = vi.spyOn(job.deps.cacheBackend, 'saveCache').mockResolvedValue(decline);
    await expect(executeFinalizeAction(job.deps)).rejects.toThrow(/required a durable/);
    const state = await journal(job);
    expect(state.phase).toBe('publication-intent');
    save.mockResolvedValue(11);
    await executeFinalizeAction(job.deps);
    expect(save.mock.calls[0]![1]).toBe(save.mock.calls[1]![1]);
    expect((await journal(job)).saved).toBe(true);
  },
);
it('warns standalone failed publication and retains recovery; rejects changed retained metadata on retry', async () => {
  const job = await cutoffJob(await root());
  await job.prepare();
  await data(job, 'data/new');
  vi.spyOn(job.deps.cacheBackend, 'saveCache').mockRejectedValue(new Error('network'));
  expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe('failed');
  expect(job.warnings.join(' ')).toContain('network');
  await data(job, 'data/new', 'different');
  await expect(executeFinalizeAction(job.deps)).rejects.toThrow(/changed/);
});
it('requires intact current lifecycle and rejects policy drift before report or publication', async () => {
  const job = await cutoffJob(await root());
  await job.prepare();
  const report = vi.spyOn(job.adapter, 'collectBuildReport');
  const preflight = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  await expect(
    executeFinalizeAction({
      ...job.deps,
      preflight,
      config: { ...job.deps.config, cacheGcMode: 'off' },
    }),
  ).rejects.toThrow(/drift/);
  expect(report).not.toHaveBeenCalled();
  job.state.clear();
  await expect(executeFinalizeAction(job.deps)).rejects.toThrow(/missing/);
});
it('handles cache-disabled reports without journal, cache, or artifact operations', async () => {
  const job = await cutoffJob(await root(), { inputs: { 'cache-enabled': 'false' } });
  await job.prepare();
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  const final = await executeFinalizeAction(job.deps);
  expect(final.cacheStatistics).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
it('replays GC with the original decisions after the sweep checkpoint write fails', async () => {
  const job = await cutoffJob(await root(), { inputs: { 'job-mode': 'distributed-aggregator' } });
  await data(job, 'data/a');
  await data(job, 'data/b');
  for (const p of ['a', 'b']) await utimes(path.join(job.home, 'data', p), 1700000000, 1700000000);
  job.deps.now = () => Date.now() + 10000;
  await job.prepare();
  const io = await import('../../../src/cache/metadata-io');
  const original = io.writeMetadata;
  let failed = false;
  const spy = vi.spyOn(io, 'writeMetadata').mockImplementation(async (...args) => {
    const value = args[2];
    if (
      !failed &&
      typeof value === 'object' &&
      value !== null &&
      'deletedPaths' in value &&
      Array.isArray(value.deletedPaths) &&
      value.deletedPaths.length === 2
    ) {
      failed = true;
      throw new Error('disk failure after unlink');
    }
    await original(...args);
  });
  await expect(executeFinalizeAction(job.deps)).rejects.toThrow('disk failure');
  const frozen = await journal(job);
  expect(frozen.selection?.gc).toHaveLength(2);
  await expect(readFile(path.join(job.home, 'data/a'))).rejects.toThrow();
  spy.mockRestore();
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  const recovered = await executeFinalizeAction(job.deps);
  expect(recovered.cacheGcResult?.deletedFileCount).toBe(2);
  expect(save).toHaveBeenCalledTimes(1);
  expect((await journal(job)).selection).toEqual(frozen.selection);
});
it('refuses recreated or changed planned GC targets and never publishes an incomplete aggregate', async () => {
  const job = await cutoffJob(await root(), { inputs: { 'job-mode': 'distributed-aggregator' } });
  await data(job, 'data/a');
  await utimes(path.join(job.home, 'data/a'), 1700000000, 1700000000);
  job.deps.now = () => Date.now() + 10000;
  await job.prepare();
  const pre = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  expect(pre.journal?.selection?.gc).toHaveLength(1);
  await rm(path.join(job.home, 'data/a'));
  await data(job, 'data/a', 'replacement');
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  await expect(executeFinalizeAction({ ...job.deps, preflight: pre })).rejects.toThrow(/changed/);
  expect(save).not.toHaveBeenCalled();
  expect(await readFile(path.join(job.home, 'data/a'), 'utf8')).toBe('replacement');
});
it('does not publish an empty pristine miss or invent an empty marker', async () => {
  const job = await cutoffJob(await root());
  await job.prepare();
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
  expect(save).not.toHaveBeenCalled();
  await expect(readFile(path.join(job.home, '.mammoth/empty-generation-v1'))).rejects.toThrow();
});
it('keeps an unchanged cache hit and a usage-only hit without publishing replacements', async () => {
  const job = await cutoffJob(await root(), { inputs: { 'cache-gc-mode': 'off' } });
  vi.spyOn(job.deps.cacheBackend, 'restoreCache').mockImplementation(
    async (_paths, primary) => primary + 'seed',
  );
  await data(job, 'data/old');
  await utimes(path.join(job.home, 'data/old'), 1700000000, 1700000000);
  job.deps.now = () => Date.now() + 10000;
  await job.prepare();
  const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
  expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
  expect(save).not.toHaveBeenCalled();
  await job.prepare();
  const actual = scans.captureCacheMetadataSnapshot;
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  const scan = vi
    .spyOn(scans, 'captureCacheMetadataSnapshot')
    .mockImplementation(async (...args) => {
      const snapshot = await actual(...args);
      const e = snapshot.partitions[0]!.entries[0]!;
      Object.assign(e, { atimeMs: record.cutoff + 1 });
      e.identity.atimeMs = record.cutoff + 1;
      return snapshot;
    });
  const used = await executeFinalizeAction(job.deps);
  expect(used.cacheStatistics).toMatchObject({ upsertCount: 0, usedCount: 1 });
  expect(used.bootstrap.baseCacheResult?.status).toBe('not-required');
  expect(save).not.toHaveBeenCalled();
  scan.mockRestore();
});
it.each([true, false])(
  'records warm-fixture operation counts with readOnly=%s (not a scale benchmark)',
  async (readOnly) => {
    const job = await cutoffJob(await root(), {
      inputs: { 'cache-gc-mode': 'off', 'read-only': String(readOnly) },
    });
    vi.spyOn(job.deps.cacheBackend, 'restoreCache').mockImplementation(
      async (_paths, primary) => primary + 'seed',
    );
    const payload = Buffer.alloc(16 * 1024, 42);
    await mkdir(path.join(job.home, 'data'), { recursive: true });
    await Promise.all(
      Array.from({ length: 512 }, async (_, i) => {
        const file = path.join(job.home, 'data', String(i).padStart(4, '0'));
        await writeFile(file, payload);
        await utimes(file, 1700000000, 1700000000);
      }),
    );
    const scan = vi.spyOn(scans, 'captureCacheMetadataSnapshot');
    const hash = vi.spyOn(scans, 'captureCacheManifest');
    const guarded = await import('../../../src/cache/guarded-files');
    const copy = vi.spyOn(guarded, 'copyGuardedFile');
    const save = vi.spyOn(job.deps.cacheBackend, 'saveCache');
    const started = performance.now();
    job.deps.now = () => Date.now() + 10000;
    await job.prepare();
    const prepared = performance.now();
    expect(scan).not.toHaveBeenCalled();
    const result = await executeFinalizeAction(job.deps);
    const finalized = performance.now();
    expect(result.cacheStatistics?.fileCount).toBe(512);
    expect(copy).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(3); // Initial selection, post-report validation, pre-publication validation.
    const state = await journal(job);
    const io = await import('node:fs/promises');
    const journalBytes = (await io.stat(path.join(job.home, cutoffJournalPath(state.invocation))))
      .size;
    console.log(
      'CUTOFF_OPERATION_FIXTURE',
      JSON.stringify({
        readOnly,
        files: 512,
        sourceBytes: 512 * payload.length,
        prepareMs: Math.round(prepared - started),
        finalizeMs: Math.round(finalized - prepared),
        metadataPasses: scan.mock.calls.length,
        selectedSourceCopies: copy.mock.calls.length,
        baseSaves: save.mock.calls.length,
        retainedJournalBytes: journalBytes,
        processLifetimeMaxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  },
  10000,
);
it.each(['exception', 'decline'])(
  'recovers a fresh aggregate after %s using retained envelopes and cleans temporary staging',
  async (failure) => {
    const r = await root(),
      artifacts = new CutoffArtifacts(path.join(r, 'artifacts'));
    const worker = await cutoffJob(path.join(r, 'worker'), {
      name: 'worker',
      inputs: { 'job-mode': 'distributed-worker' },
      artifactBackend: artifacts,
    });
    await worker.prepare();
    await data(worker, 'data/recovered', 'worker bytes');
    await executeFinalizeAction(worker.deps);
    const envelope = artifacts.artifacts[0]!;
    const inputs = { 'job-mode': 'distributed-aggregator', 'dependent-jobs': 'worker' };
    const first = await cutoffJob(path.join(r, 'failed'), { inputs, artifactBackend: artifacts });
    const prepared = await first.prepare();
    expect(prepared.dependentDeltaResult?.selectedProducers.map((p) => p.jobName)).toEqual([
      'worker',
    ]);
    const save = vi.spyOn(first.deps.cacheBackend, 'saveCache');
    if (failure === 'exception') save.mockRejectedValue(new Error('backend unavailable'));
    else save.mockResolvedValue(0);
    await expect(executeFinalizeAction(first.deps)).rejects.toThrow(/required a durable/);
    expect(artifacts.artifacts).toEqual([envelope]);
    const fresh = await cutoffJob(path.join(r, 'fresh'), { inputs, artifactBackend: artifacts });
    const restored = await fresh.prepare();
    expect(restored.dependentDeltaResult?.selectedProducers.map((p) => p.jobName)).toEqual([
      'worker',
    ]);
    expect(await readFile(path.join(fresh.home, 'data/recovered'), 'utf8')).toBe('worker bytes');
    expect((await executeFinalizeAction(fresh.deps)).bootstrap.baseCacheResult?.status).toBe(
      'saved',
    );
    expect(artifacts.artifacts).toEqual([envelope]);
    const fs = await import('node:fs/promises');
    for (const download of artifacts.downloads) await expect(fs.stat(download)).rejects.toThrow();
    const staging = path.join(worker.home, '.mammoth/cutoff-state-v1/staging');
    expect((await readdir(staging)).filter((p) => p.startsWith('package-'))).toEqual([]);
  },
);
