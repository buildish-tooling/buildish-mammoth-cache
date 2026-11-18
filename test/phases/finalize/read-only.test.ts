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
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cutoffJob } from '../../support/cutoff-job';
import { CutoffArtifacts } from '../../support/cutoff-artifacts';
import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';
import { MavenBuildToolAdapter } from '../../../src/build-tool/maven/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../../src/build-tool/gradle/config';
import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
} from '../../../src/build-tool/maven/config';
import { executeCutoffPrepareAction } from '../../../src/phases/prepare/cutoff-flow';
import { executeFinalizeAction } from '../../../src/phases/finalize/flow';
import { runGuardedCutoffPost } from '../../../src/phases/finalize/preflight';
import {
  CUTOFF_LIFECYCLE_STATE,
  preflightCutoffLifecycle,
  readCutoffLifecycle,
} from '../../../src/phases/cutoff-lifecycle';
import { JOB_SINGLE_RUN_OWNER_TOKEN_STATE } from '../../../src/guard/job-single-run';
import * as state from '../../../src/cache/cutoff-state';
import * as scans from '../../../src/cache/manifest';
import * as snapshots from '../../../src/cache/partition-snapshots';
import * as lifecycle from '../../../src/cache/snapshot-lifecycle';
import * as gc from '../../../src/cache/cutoff-gc';
import * as packages from '../../../src/delta/cutoff-service';
import * as model from '../../../src/cache/model';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function jobFor(
  tool: 'gradle' | 'maven' = 'gradle',
  inputs: Record<string, string> = {},
  pr = false,
) {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/read-only-'));
  roots.push(root);
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  const job = await cutoffJob(root, {
    inputs: { ...(pr ? {} : { 'read-only': 'true' }), ...inputs },
    artifactBackend: artifacts,
  });
  Object.assign(job.ci, { isPullRequest: pr, eventName: pr ? 'pull_request' : 'push' });
  const options = { phase: 'prepare' as const, ciContext: job.ci, env: {} };
  const config =
    tool === 'gradle'
      ? normalizeGradleActionConfig(readGradleActionInputs(job.deps.runtimeHost), options)
      : normalizeMavenActionConfig(readMavenActionInputs(job.deps.runtimeHost), options);
  const adapter =
    'gradleUserHome' in config
      ? new GradleBuildToolAdapter(config)
      : new MavenBuildToolAdapter(config);
  const deps = { ...job.deps, config };
  job.adapter.getName = () => adapter.getName();
  job.adapter.getBuildToolId = () => adapter.getBuildToolId();
  job.adapter.getBuiltInPartitionPresets = () => adapter.getBuiltInPartitionPresets();
  job.adapter.getHardCacheExcludeGlobs = () => adapter.getHardCacheExcludeGlobs();
  return { ...job, deps, prepare: () => executeCutoffPrepareAction(deps), artifacts };
}
async function put(job: Awaited<ReturnType<typeof jobFor>>, name: string, bytes = 'bytes') {
  await mkdir(path.dirname(path.join(job.home, name)), { recursive: true });
  await writeFile(path.join(job.home, name), bytes);
}
async function journal(job: Awaited<ReturnType<typeof jobFor>>) {
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  return state.loadCutoffJournal(record.model, state.cutoffJournalPath(record.invocation));
}
function forbidPublicationWork(job: Awaited<ReturnType<typeof jobFor>>) {
  const fail = () => {
    throw new Error('Publication-only work in read-only finalize');
  };
  const spies = [
    vi.spyOn(scans, 'captureCacheMetadataSnapshot').mockImplementation(fail),
    vi.spyOn(scans, 'captureCacheManifest').mockImplementation(fail),
    vi.spyOn(state, 'freezeCutoffSelection').mockImplementation(fail),
    vi.spyOn(state, 'verifyCutoffReplay').mockImplementation(fail),
    vi.spyOn(state, 'cutoffDecisionDigest').mockImplementation(fail),
    vi.spyOn(gc, 'collectCutoffGarbage').mockImplementation(fail),
    vi.spyOn(lifecycle, 'captureLocalPartitionSnapshots').mockImplementation(fail),
    vi.spyOn(lifecycle, 'projectedSnapshotStatistics').mockImplementation(fail),
    vi.spyOn(snapshots, 'readPartitionSnapshot').mockImplementation(fail),
    vi.spyOn(snapshots, 'stagePartitionSnapshot').mockImplementation(fail),
    vi.spyOn(snapshots, 'verifySnapshotTransport').mockImplementation(fail),
    vi.spyOn(packages, 'stageCutoffPackage').mockImplementation(fail),
    vi.spyOn(model, 'createCacheGeneration').mockImplementation(fail),
    vi.spyOn(job.deps.cacheBackend, 'saveCache').mockImplementation(fail),
    ...(
      [
        'listArtifacts',
        'getArtifact',
        'downloadArtifact',
        'uploadArtifact',
        'deleteArtifact',
      ] as const
    ).map((name) => vi.spyOn(job.artifacts, name).mockImplementation(fail)),
  ];
  return () => spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
}

it.each(['gradle', 'maven'] as const)(
  '%s preserves reports and read-only precedence in every mode',
  async (tool) => {
    for (const mode of ['standalone', 'distributed-worker', 'distributed-aggregator']) {
      for (const pr of [false, true]) {
        const job = await jobFor(
          tool,
          {
            'job-mode': mode,
            ...(mode === 'standalone' ? {} : { 'dependent-jobs': 'missing-worker' }),
          },
          pr,
        );
        const provision = vi.spyOn(job.adapter, 'provision');
        const hooks = vi.spyOn(job.adapter, 'installBuildHooks');
        const prepare = await job.prepare();
        expect(job.deps.config.readOnly).toBe(true);
        if (mode !== 'standalone')
          expect(prepare.dependentDeltaResult?.status).toBe('skipped-read-only');
        expect(provision).toHaveBeenCalledTimes(1);
        expect(hooks).toHaveBeenCalledTimes(1);
        const file =
          tool === 'gradle'
            ? 'caches/modules-2/files-2.1/local.jar'
            : 'repository/org/test/1/local.jar';
        await put(job, file);
        const untouched = forbidPublicationWork(job);
        job.adapter.collectBuildReport = async () => ({
          anyBuildFailed: true,
          warnings: ['build warning'],
          summaryLines: ['failed build details'],
          logLines: [await readFile(path.join(job.home, file), 'utf8')],
          builds: [],
        });
        job.state.set(JOB_SINGLE_RUN_OWNER_TOKEN_STATE, 'owner');
        await runGuardedCutoffPost(job.deps.runtimeHost, async (preflight) => {
          expect(preflight.journal?.selection).toBeNull();
          expect(preflight.journal?.phase).toBe('build-ready');
          const result = await executeFinalizeAction({ ...job.deps, preflight });
          expect(result.bootstrap.baseCacheResult?.status).toBe('read-only');
          expect(result.deltaArtifactResult).toMatchObject({
            status: 'read-only',
            upsertCount: null,
            usedCount: null,
            emptyEnvelope: false,
          });
          expect(result.cacheStatistics).toBeNull();
          expect(result.buildReport.anyBuildFailed).toBe(true);
        });
        const completed = await journal(job);
        expect(completed).toMatchObject({
          phase: 'completed',
          selection: null,
          observedAt: null,
          saved: false,
          publicationKey: null,
        });
        // Publication-only local transport/native changes do not invalidate a reader retry.
        await rm(path.join(job.home, snapshots.PARTITION_SNAPSHOT_DIRECTORY), {
          recursive: true,
          force: true,
        });
        await put(job, file, 'changed after finalize');
        const persist = vi.spyOn(state, 'persistCutoffJournal');
        await executeFinalizeAction(job.deps);
        expect(persist).not.toHaveBeenCalled();
        expect(await journal(job)).toEqual(completed);
        expect(job.summaries.join('\n')).toContain('❌ Overall status: failed');
        expect(job.summaries.join('\n')).toContain('failed build details');
        expect(job.summaries.join('\n')).toContain('build warning');
        expect(job.summaries.join('\n')).toContain('unavailable (not collected in read-only mode)');
        expect(job.summaries.join('\n')).not.toContain('Upserts: 0');
        untouched();
        vi.restoreAllMocks();
      }
    }
  },
);

it.each(['disabled', 'miss', 'hit', 'fallback', 'unavailable'] as const)(
  'handles a read-only cache %s without finalize observations',
  async (kind) => {
    const job = await jobFor('gradle', kind === 'disabled' ? { 'cache-enabled': 'false' } : {});
    if (kind === 'fallback')
      Object.assign(job.ci, { safeRefName: 'feature', resolvedRefName: 'feature' });
    if (kind === 'unavailable')
      vi.spyOn(job.deps.cacheBackend, 'isFeatureAvailable').mockReturnValue(false);
    if (kind === 'hit' || kind === 'fallback') {
      vi.spyOn(job.deps.cacheBackend, 'restoreCache').mockImplementation(
        async (_paths, primary, fallback) => {
          // Empty snapshot transport is valid; restore still verifies it before consumption.
          const cacheModel = await model.createCacheModel(job.deps.config, job.ci, job.adapter, {
            captureCommandOutput: job.deps.captureCommandOutput,
            env: {},
          });
          for (const p of snapshots.snapshotPartitions(cacheModel))
            await snapshots.stagePartitionSnapshot(cacheModel, p.id, job.home, []);
          return (kind === 'fallback' ? fallback![0]! : primary) + 'seed';
        },
      );
    }
    await job.prepare();
    const untouched = forbidPublicationWork(job);
    const result = await executeFinalizeAction(job.deps);
    expect(result.baseCacheRestoreResult?.status ?? 'disabled').toBe(
      {
        disabled: 'disabled',
        miss: 'miss',
        hit: 'current-lineage-hit',
        fallback: 'fallback-lineage-hit',
        unavailable: 'feature-unavailable',
      }[kind],
    );
    expect(result.cacheStatistics).toBeNull();
    untouched();
  },
);

it.each([
  'lifecycle-json',
  'journal-json',
  'pending',
  'journal-policy',
  'journal-execution',
  'config',
  'model',
  'execution',
  'superseded',
])('rejects read-only %s drift before reports', async (kind) => {
  const job = await jobFor();
  await job.prepare();
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  const file = path.join(job.home, state.cutoffJournalPath(record.invocation));
  if (kind === 'lifecycle-json') job.state.set(CUTOFF_LIFECYCLE_STATE, '{');
  if (kind === 'journal-json') await writeFile(file, '{');
  if (['pending', 'journal-policy', 'journal-execution'].includes(kind)) {
    const j = await journal(job);
    if (kind === 'pending') {
      j.phase = 'prepare-pending';
      j.cutoff = null;
    }
    if (kind === 'journal-policy') j.policy.cacheGcMode = 'off';
    if (kind === 'journal-execution') j.execution.runId = 999;
    await state.persistCutoffJournal(j);
  }

  if (kind === 'model') job.adapter.getBuildToolId = () => 'changed-tool';
  if (kind === 'execution') job.ci.runId = 999;
  if (kind === 'superseded') await job.prepare();
  if (kind === 'superseded') job.state.set(CUTOFF_LIFECYCLE_STATE, JSON.stringify(record));
  const report = vi.spyOn(job.adapter, 'collectBuildReport');
  await expect(
    executeFinalizeAction({
      ...job.deps,
      config: kind === 'config' ? { ...job.deps.config, readOnly: false } : job.deps.config,
    }),
  ).rejects.toThrow();
  expect(report).not.toHaveBeenCalled();
});

it('keeps provider receipts one-use for read-only jobs', async () => {
  const job = await jobFor();
  await job.prepare();
  const preflight = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  await executeFinalizeAction({ ...job.deps, preflight });
  await expect(executeFinalizeAction({ ...job.deps, preflight })).rejects.toThrow(/receipt/);
});

it.each(['default', 'disabled', 'custom'])(
  'skips final snapshot work with %s metadata configuration',
  async (kind) => {
    const job = await jobFor(
      'gradle',
      kind === 'default'
        ? {}
        : {
            'cache-partitions': JSON.stringify([
              { id: 'dependency-metadata', includes: [] },
              ...(kind === 'custom'
                ? [{ id: 'custom', includes: ['custom/**'], publication: 'single-writer' }]
                : []),
            ]),
          },
    );
    await job.prepare();
    const before = await journal(job);
    expect(before.partitionSnapshots.map((s) => s.partitionId)).toEqual(
      kind === 'default' ? ['dependency-metadata'] : kind === 'custom' ? ['custom'] : [],
    );
    const untouched = forbidPublicationWork(job);
    const result = await executeFinalizeAction(job.deps);
    expect(result.cacheStatistics).toBeNull();
    untouched();
  },
);
