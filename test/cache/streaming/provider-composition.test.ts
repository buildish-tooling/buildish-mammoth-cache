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

import { gradleResolver } from './quiescence-fixture';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import {
  runStreamingPrepare,
  STREAMING_INVOCATION_STATE,
} from '../../../src/phases/streaming/prepare';
import {
  STREAMING_LAYER_ADVERTISEMENT_STATE,
  STREAMING_LAYER_ACTIVATED_STATE,
} from '../../../src/phases/streaming/state';
import { Digest, encodeRecord, rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { readWorkerArchive } from '../../../src/cache/streaming/worker-codec';
import type { ResolvedModel } from '../../../src/cache/streaming/model';
import { byteSource, FixtureMembership } from './protocol-fixtures';
import * as observationCapture from '../../../src/cache/streaming/observation-capture';
import * as basePost from '../../../src/cache/streaming/base-post';
import {
  runStreamingPost,
  type StreamingPostDependencies,
} from '../../../src/phases/streaming/post';
import { decodeInvocationAnchor, OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
import { dependencyGcSchedule } from '../../../src/cache/streaming/dependency-gc-schedule';
import {
  decodeMetadataGeneration,
  metadataPartitionDecision,
} from '../../../src/cache/streaming/metadata-base-records';
import { MetadataBaseRestore } from '../../../src/cache/streaming/metadata-base-restore';
import { recordKey } from '../../../src/cache/streaming/native-records';
import {
  installGradleBuildResultCapture,
  cleanupGradleBuildResultCapture,
} from '../../../src/build-tool/gradle/build-results';
import {
  INIT_SCRIPT_FILE_NAME,
  SERVICE_PLUGIN_FILE_NAME,
} from '../../../src/build-tool/gradle/build-result-capture-scripts';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { JOB_PREPARE_FAILED_STATE } from '../../../src/guard/job-single-run';
import { createTestRuntimeHost } from '../../support/github-test-runtime';
import { fixtureCi } from '../../support/ci-fixture';
import { readGradleActionInputs } from '../../../src/build-tool/gradle/config';
import { normalizeSharedActionConfig } from '../../../src/config/normalize';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import { memoryArtifacts } from './memory-artifact-fixture';
import type { BuildToolAdapter } from '../../../src/build-tool/types';
const roots: string[] = [],
  budgets: WorkingBudget[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const budget of budgets.splice(0)) {
    expect(budget.retained).toBe(0);
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  await cleanupBaseFixtures();
});
async function fixture(tool: 'maven' | 'gradle' = 'maven', inputs: Record<string, string> = {}) {
  const root = await mkdtemp(path.resolve('build/streaming-provider-'));
  roots.push(root);
  const home = path.join(root, 'cache'),
    temp = path.join(root, 'temp');
  await mkdir(temp);
  const state = new Map<string, string>(),
    outputs = new Map<string, unknown>(),
    info = vi.fn(),
    warning = vi.fn();
  const host = createTestRuntimeHost({
    inputs,
    getState: (k) => state.get(k) ?? '',
    saveState: (k, v) => state.set(k, v),
    setOutput: (k, v) => outputs.set(k, v),
    info,
    warning,
  });
  const ci = { ...fixtureCi(root, 'A'), tempDirectory: temp, sourceRevision: 'rev-1' },
    config = normalizeSharedActionConfig(readGradleActionInputs(host), {
      phase: 'prepare',
      ciContext: ci,
      env: {},
    }),
    budget = new WorkingBudget();
  budgets.push(budget);
  const sdk = await nativeCacheBackend(),
    artifacts = memoryArtifacts(),
    provision = vi.fn(async () => ({ items: [], warnings: [], additionalOutputs: {} })),
    hooks = vi.fn(async () => {});
  const adapter: BuildToolAdapter = {
    getBuildToolId: () => tool,
    getCacheRoot: () => home,
    getBuiltInPartitionPresets: () => [
      {
        id: 'data',
        displayName: 'Data',
        description: '',
        defaultEnabled: true,
        relativeIncludeGlobs: ['data/**'],
        purgeableGlobs: ['data/runtime.lock'],
        relativeExcludeGlobs: [],
      },
    ],
    getHardCacheExcludeGlobs: () => ['.mammoth/**', 'init.d/**', '**/*.lock'],
    provision,
    installBuildHooks: hooks,
  };
  const deps = {
    providerId: 'github',
    runtimeHost: host,
    ciProvider: {
      context: ci,
      httpHeadersByHost: new Map(),
      executionUrls: { jobUrl: null, workflowRunUrl: null },
      createBootstrapDiagnosticsLines: () => [],
    },
    config,
    buildToolAdapterFactory: () => adapter,
    cacheBackend: async () => sdk.backend,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
    budget,
    nonce: 'a'.repeat(32),
    lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: false }) }),
  };
  const loadReport = vi.fn(async () => ({
      anyBuildFailed: false,
      warnings: [],
      summaryLines: ['build report'],
      logLines: [],
      builds: [],
    })),
    removeHooks = vi.fn(async () => []),
    sink = {
      publishLogGroup: vi.fn(),
      publishSummary: vi.fn(async () => {}),
      replaceSummary: vi.fn(async () => {}),
    },
    backend = vi.fn(async () => sdk.backend);
  const post: StreamingPostDependencies = {
    runtimeHost: host,
    budget,
    assertCurrent: (): undefined => {},
    cacheBackend: backend,
    artifactBackend: async () => artifacts.api,
    removeHooks,
    loadReport,
    reportSink: async () => sink,
  };
  return {
    root,
    home,
    state,
    outputs,
    host,
    info,
    warning,
    ci,
    config,
    budget,
    sdk,
    artifacts,
    provision,
    hooks,
    deps,
    post,
    loadReport,
    removeHooks,
    backend,
    sink,
  };
}
function captureLines(f: Awaited<ReturnType<typeof fixture>>) {
  return f.info.mock.calls
    .flat()
    .filter((line) => /^(?:Mammoth capture summary|data: captured=)/.test(line));
}

async function restoreGeneration(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  model: ResolvedModel,
) {
  const saved = path.join(f.root, 'record.json');
  await f.sdk.backend.restoreCache([saved], key, [], { archiveRoot: f.root });
  return decodeMetadataGeneration(await readFile(saved), model, key);
}

async function setGenerationSweepAt(
  f: Awaited<ReturnType<typeof fixture>>,
  key: string,
  model: ResolvedModel,
  timestamp: number,
) {
  const generation = await restoreGeneration(f, key, model);
  generation[12] = timestamp;
  generation[10] = metadataPartitionDecision(generation);
  generation[11] = recordKey(model.family, generation[5], generation[6], generation[10]);
  const saved = path.join(f.root, 'record.json');
  await writeFile(saved, encodeRecord(generation));
  await f.sdk.backend.saveCache([saved], generation[11], { archiveRoot: f.root });
  return generation;
}

async function readUploadedWorker(
  f: Awaited<ReturnType<typeof fixture>>,
  {
    context,
    model,
  }: { context: Parameters<typeof readWorkerArchive>[1]['context']; model: ResolvedModel },
  authorizedSnapshots: readonly string[] = [],
) {
  const archive = [...f.artifacts.objects.values()][0].bytes;
  return readWorkerArchive(byteSource(archive), {
    model,
    context,
    authorizedSnapshots,
    budget: f.budget,
    membership: new FixtureMembership(),
    async consumeFile({ body }) {
      for await (const chunk of body) {
        expect(Buffer.isBuffer(chunk)).toBe(true);
      }
    },
  });
}
it.each(['maven', 'gradle'] as const)(
  'uses the guarded %s prepare/post composition and reports only after frozen post completion',
  async (tool) => {
    const f = await fixture(tool);
    await runStreamingPrepare(f.deps);
    const raw = f.state.get(STREAMING_INVOCATION_STATE)!;
    expect(raw.length).toBeLessThan(4096);
    expect(f.outputs.get('base-cache-restore-status')).toBe('miss');
    expect(f.outputs.get('dependency-gc-due')).toBe('unknown');
    await mkdir(f.home + '/data');
    await writeFile(f.home + '/data/file', 'built');
    if (tool === 'gradle') {
      f.post = {
        ...f.post,
        lifecycle: gradleResolver({
          inspect: async () => ({ remaining: false, uncertain: false }),
        }),
      };
    }
    f.backend.mockImplementationOnce(async () => {
      expect(captureLines(f)[0]).toBe('Mammoth capture summary (complete):');
      expect(captureLines(f)[1]).toContain('captured=1 files/5 logical bytes');
      return f.sdk.backend;
    });
    f.loadReport.mockImplementation(async () => {
      const a = decodeInvocationAnchor(raw);
      if (a[0] !== 'streaming-lifecycle') {
        throw new Error('anchor');
      }
      const opened = await OpenedInvocation.open(a, f.budget);
      expect(opened.state[7]?.[1]).toBe('published');
      return { anyBuildFailed: false, warnings: [], summaryLines: [], logLines: [], builds: [] };
    });
    expect((await runStreamingPost(f.post)).outcome).toBe('published');
    expect(f.removeHooks).toHaveBeenCalledTimes(1);
    expect(f.loadReport).toHaveBeenCalledWith(tool, f.ci.tempDirectory);
    expect(f.sink.publishSummary).toHaveBeenCalledTimes(1);
    await expect(runStreamingPrepare(f.deps)).rejects.toThrow('already');
    expect(f.provision).toHaveBeenCalledTimes(1);
  },
);

it.each(['gradle', 'maven'] as const)(
  'checks only the %s fallback record before ordinary workers restore its objects',
  async (tool) => {
    const publisher = await fixture(tool);
    const prepared = await runStreamingPrepare(publisher.deps);
    if (!('store' in prepared)) {
      throw new Error('Expected a normal prepare.');
    }
    await mkdir(publisher.home + '/data');
    await writeFile(publisher.home + '/data/file', 'built');
    const published = await runStreamingPost({
      ...publisher.post,
      lifecycle: publisher.deps.lifecycle,
    });
    if (published.outcome !== 'published' || !published.key) {
      throw new Error('Expected a published generation.');
    }
    const model = prepared.store.codec.options.model;
    const sdk = publisher.sdk.backend;
    const generation = await setGenerationSweepAt(publisher, published.key, model, 1000);
    expect(generation[8].some((entry) => entry[0] === 'object')).toBe(true);

    const planner = await fixture(tool, { 'job-mode': 'prepare-only', 'read-only': 'true' });
    const backend = vi.spyOn(sdk, 'restoreCache');
    const ci = {
      ...planner.ci,
      resolvedRefName: 'feature',
      defaultBranch: publisher.ci.resolvedRefName,
    };
    const dueAt = 1000 + planner.config.dependencyGcIntervalMs;
    const deps = {
      ...planner.deps,
      ciProvider: { ...planner.deps.ciProvider, context: ci },
      cacheBackend: async () => sdk,
      now: () => dueAt - 1,
    };
    expect(await runStreamingPrepare(deps)).toEqual({ outcome: 'generation-checked' });
    expect([...planner.outputs]).toEqual([['dependency-gc-due', 'false']]);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend.mock.calls[0]![0].map((entry) => path.basename(entry))).toEqual(['record.json']);
    expect(planner.provision).not.toHaveBeenCalled();
    expect(planner.hooks).not.toHaveBeenCalled();
    expect(planner.artifacts.list).not.toHaveBeenCalled();
    expect(planner.state.size).toBe(0);
    expect(await readdir(planner.ci.tempDirectory!)).toEqual([]);
    await expect(readdir(planner.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await runStreamingPost(planner.post)).outcome).toBe('skipped');
    expect(planner.backend).not.toHaveBeenCalled();

    backend.mockClear();
    const worker = await fixture(tool, { 'job-mode': 'distributed-worker' });
    await runStreamingPrepare({
      ...worker.deps,
      ciProvider: {
        ...worker.deps.ciProvider,
        context: { ...ci, tempDirectory: worker.ci.tempDirectory },
      },
      cacheBackend: async () => sdk,
      now: () => dueAt,
    });
    expect(worker.outputs.get('restored-cache-key')).toBe(generation[11]);
    expect(worker.outputs.get('dependency-gc-due')).toBe('true');
    expect(backend).toHaveBeenCalledTimes(2);
    expect(await readFile(worker.home + '/data/file', 'utf8')).toBe('built');
    expect(dependencyGcSchedule(planner.config, generation, dueAt)).toEqual({
      due: 'true',
      force: false,
    });
    const forceAt = dueAt + planner.config.dependencyGcForceGraceMs!;
    expect(dependencyGcSchedule(planner.config, generation, forceAt - 1).force).toBe(false);
    expect(dependencyGcSchedule(planner.config, generation, forceAt).force).toBe(true);
    generation[12] = null;
    expect(dependencyGcSchedule(planner.config, generation, dueAt)).toEqual({
      due: 'true',
      force: true,
    });
    expect(
      dependencyGcSchedule(
        { ...planner.config, dependencyGcForceGraceMs: null },
        generation,
        dueAt,
      ),
    ).toEqual({
      due: 'true',
      force: false,
    });
  },
);

it.each([
  [{}, true, 'unknown'],
  [{}, false, 'unknown'],
  [{ 'cache-gc-mode': 'off' }, false, 'false'],
  [{ 'cache-enabled': 'false' }, true, 'false'],
  [{ 'cleanup-enabled': 'false' }, true, 'false'],
] as const)(
  'reports the prepare-only hint for settings %o, availability %s',
  async (settings, available, due) => {
    const f = await fixture('maven', { 'job-mode': 'prepare-only', ...settings });
    f.sdk.backend.isFeatureAvailable = () => available;
    await runStreamingPrepare(f.deps);
    expect([...f.outputs]).toEqual([['dependency-gc-due', due]]);
  },
);

it.each(['availability probe', 'restore'] as const)(
  'reports an indeterminate prepare-only %s and retires its empty scratch',
  async (operation) => {
    const f = await fixture('maven', { 'job-mode': 'prepare-only' });
    const reason = new Error('backend unavailable');
    if (operation === 'availability probe') {
      vi.spyOn(f.sdk.backend, 'isFeatureAvailable').mockImplementation(() => {
        throw reason;
      });
    } else {
      vi.spyOn(f.sdk.backend, 'restoreCache').mockRejectedValue(reason);
    }
    await runStreamingPrepare(f.deps);
    expect([...f.outputs]).toEqual([['dependency-gc-due', 'unknown']]);
    expect(f.warning).toHaveBeenCalledWith(expect.stringContaining('backend unavailable'));
    expect(await readdir(f.ci.tempDirectory!)).toEqual([]);
  },
);

it('retains prepare-only scratch when guarded retirement fails', async () => {
  const f = await fixture('maven', { 'job-mode': 'prepare-only' });
  vi.spyOn(MetadataBaseRestore.prototype, 'dispose').mockRejectedValueOnce(
    new Error('retirement failed'),
  );
  await expect(runStreamingPrepare(f.deps)).rejects.toThrow('retirement failed');
  expect([...f.outputs]).toEqual([]);
  expect(await readdir(f.ci.tempDirectory!)).toEqual([
    expect.stringMatching(/^mammoth-generation-/u),
  ]);
});

it('canonicalizes repeated configured producers before freezing and requests them once in first-occurrence order', async () => {
  const service = memoryArtifacts();
  for (const job of ['A', 'B']) {
    const worker = await fixture('maven', { 'job-mode': 'distributed-worker' });
    await runStreamingPrepare({
      ...worker.deps,
      ciProvider: {
        ...worker.deps.ciProvider,
        context: { ...worker.ci, jobName: job },
      },
    });
    await mkdir(worker.home + '/data');
    await writeFile(worker.home + '/data/only-' + job, job);
    expect(
      (
        await runStreamingPost({
          ...worker.post,
          artifactBackend: async () => service.api,
        })
      ).outcome,
    ).toBe('worker-uploaded');
  }
  const f = await fixture('maven', {
    'job-mode': 'distributed-aggregator',
    'dependent-jobs': 'B,A,B',
  });
  expect(f.config.dependentJobs).toEqual(['B', 'A', 'B']);
  await runStreamingPrepare({
    ...f.deps,
    ciProvider: {
      ...f.deps.ciProvider,
      context: { ...f.ci, jobName: 'parent' },
    },
    artifactBackend: async () => service.api,
  });
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') {
    throw new Error('anchor');
  }
  const opened = await OpenedInvocation.open(anchor, f.budget),
    handoff = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  try {
    expect(opened.bindings[8][10]).toEqual(['B', 'A']);
    expect(handoff.header[11]).toBe(2);
  } finally {
    handoff.close();
  }
  expect(service.list).toHaveBeenCalledTimes(1);
  expect(service.download.mock.calls.map(([id]) => id)).toEqual([2, 1]);
  expect(await readFile(f.home + '/data/only-A', 'utf8')).toBe('A');
  expect(await readFile(f.home + '/data/only-B', 'utf8')).toBe('B');
}, 20_000);
it('duplicate and missing prepare stop before anchor, backends, reports or deferred provider graph', async () => {
  const f = await fixture();
  expect((await runStreamingPost(f.post)).outcome).toBe('skipped');
  expect(f.backend).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  await runStreamingPrepare(f.deps);
  await expect(runStreamingPrepare(f.deps)).rejects.toThrow();
  expect((await runStreamingPost(f.post)).outcome).toBe('skipped');
  expect(f.backend).not.toHaveBeenCalled();
});

async function publishSweepBase(inputs: Record<string, string> = {}) {
  const producer = await fixture('maven', inputs);
  const ready = await runStreamingPrepare(producer.deps);
  if (!('store' in ready)) {
    throw new Error('Expected a normal prepare.');
  }
  await mkdir(producer.home + '/data');
  await writeFile(producer.home + '/data/inherited', 'base');
  const published = await runStreamingPost(producer.post);
  if (published.outcome !== 'published' || !published.key) {
    throw new Error('Expected a published generation.');
  }
  return { producer, key: published.key, model: ready.store.codec.options.model };
}

async function preparedSweep(f: Awaited<ReturnType<typeof fixture>>) {
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') {
    throw new Error('Expected an owning prepare invocation.');
  }
  const opened = await OpenedInvocation.open(anchor, f.budget);
  const handoff = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  try {
    return { sweep: handoff.publisherSweep, key: handoff.header[8]?.[0], root: opened.store.root };
  } finally {
    handoff.close();
  }
}

it.each([
  { state: 'during grace', expected: undefined },
  { state: 'at force', expected: 'forced' },
  { state: 'bootstrap', expected: 'forced' },
  { state: 'disabled force at bootstrap', expected: undefined },
  { state: 'cold', expected: undefined },
  { state: 'standalone', expected: 'complete' },
])(
  'freezes publisher eligibility with no dependent-jobs at $state',
  async ({ state, expected }) => {
    const inputs = {
      'cache-partitions': JSON.stringify([{ id: 'empty', includes: ['empty/**'] }]),
    };
    const { producer, key, model } = await publishSweepBase(inputs);
    const timestamp = 1000;
    const selected =
      state === 'during grace' || state === 'at force'
        ? await setGenerationSweepAt(producer, key, model, timestamp)
        : await restoreGeneration(producer, key, model);
    if (state === 'cold') {
      const entry = selected[8].find((entry) => entry[0] === 'object');
      if (entry?.[0] !== 'object') {
        throw new Error('Expected a cached base object.');
      }
      expect(producer.sdk.objects.delete(entry[2][2])).toBe(true);
    }
    const f = await fixture('maven', {
      ...inputs,
      'job-mode': state === 'standalone' ? 'standalone' : 'distributed-aggregator',
      ...(state === 'at force' && { 'dependent-jobs': '' }),
      ...(state === 'disabled force at bootstrap' && { 'dependency-gc-force-grace-days': 'off' }),
    });
    const forceAt =
      timestamp + f.config.dependencyGcIntervalMs + (f.config.dependencyGcForceGraceMs ?? 0);
    await runStreamingPrepare({
      ...f.deps,
      cacheBackend: async () => producer.sdk.backend,
      now: () => (state === 'during grace' ? forceAt - 1 : forceAt),
    });
    const { sweep, key: frozenKey } = await preparedSweep(f);
    expect(f.outputs.get('dependency-gc-due')).toBe('true');
    expect(frozenKey).toBe(selected[11]);
    expect(sweep?.[0]).toBe(expected);
    if (sweep) {
      expect(sweep[1]).toBe(0);
      expect(sweep[2]).toBeNull();
    }
  },
);

it.each([
  { workerState: 'current', mode: 'complete', differs: false },
  { workerState: 'stale', mode: undefined, differs: false },
  { workerState: 'mismatched', mode: 'forced', differs: true },
  { workerState: 'missing', mode: undefined, differs: false },
])(
  'preserves ordinary artifact admission for a $workerState worker',
  async ({ workerState, mode, differs }) => {
    const { producer, key, model } = await publishSweepBase();
    const timestamp = Date.now() - 3 * 86400000 - 60000;
    const selected = await setGenerationSweepAt(producer, key, model, timestamp);
    const artifacts = memoryArtifacts();
    if (workerState !== 'missing') {
      const worker = await fixture('maven', { 'job-mode': 'distributed-worker' });
      await runStreamingPrepare({ ...worker.deps, cacheBackend: async () => producer.sdk.backend });
      await writeFile(worker.home + '/data/contribution', 'ordinary');
      expect(
        (await runStreamingPost({ ...worker.post, artifactBackend: async () => artifacts.api }))
          .outcome,
      ).toBe('worker-uploaded');
    }
    const base = differs
      ? await setGenerationSweepAt(producer, key, model, timestamp - 1000)
      : selected;
    const f = await fixture('maven', {
      'job-mode': 'distributed-aggregator',
      'dependent-jobs': 'A',
    });
    const start =
      base[12]! +
      f.config.dependencyGcIntervalMs +
      (differs ? f.config.dependencyGcForceGraceMs! : 0);
    const preparing = runStreamingPrepare({
      ...f.deps,
      ciProvider: {
        ...f.deps.ciProvider,
        context: { ...f.ci, jobName: 'parent', runAttempt: workerState === 'stale' ? 2 : 1 },
      },
      artifactBackend: async () => artifacts.api,
      cacheBackend: async () => producer.sdk.backend,
      now: () => start,
    });
    if (workerState === 'missing') {
      await expect(preparing).rejects.toThrow(/no artifact/i);
      return;
    }
    await preparing;
    expect(await readFile(f.home + '/data/contribution', 'utf8')).toBe('ordinary');
    const { sweep, key: frozenKey, root } = await preparedSweep(f);
    expect(sweep?.[0]).toBe(mode);
    expect(frozenKey).toBe(base[11]);
    if (differs) {
      expect(f.warning).toHaveBeenCalledWith(
        expect.stringContaining("Worker 'A' observed a different cache generation"),
      );
      const alt = sweep?.[2];
      expect(alt).toBeTruthy();
      if (alt) {
        expect(await root.stat(alt[2])).toBeTruthy();
        expect(
          (await runStreamingPost({ ...f.post, cacheBackend: async () => producer.sdk.backend }))
            .outcome,
        ).toBe('published');
        expect(await root.stat(alt[2])).toBeNull();
      }
    } else {
      expect(f.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('different cache generation'),
      );
    }
  },
);
it('failed prepare cleans only known hooks without reading reports or publishing a required worker success', async () => {
  const f = await fixture('maven', { 'job-mode': 'distributed-worker' });
  f.hooks.mockRejectedValue(new Error('hook failure'));
  await expect(runStreamingPrepare(f.deps)).rejects.toThrow('hook failure');
  expect(f.state.get(JOB_PREPARE_FAILED_STATE)).toBe('true');
  expect((await runStreamingPost(f.post)).outcome).toBe('skipped');
  expect(f.artifacts.upload).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  const a = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (a[0] !== 'streaming-lifecycle') {
    throw new Error('anchor');
  }
  const state = (await OpenedInvocation.open(a, f.budget)).state;
  expect(state[4]).toBe('prepare-failed');
  expect(state[7]).toBeNull();
  expect(f.removeHooks).toHaveBeenCalledExactlyOnceWith(a[2], a[4][7]);
});
it.each(['disabled', 'read-only'] as const)(
  '%s preserves provisioning/report behavior without a post backend',
  async (mode) => {
    const f = await fixture(
      'maven',
      mode === 'disabled' ? { 'cache-enabled': 'false' } : { 'read-only': 'true' },
    );
    await runStreamingPrepare(f.deps);
    expect(f.provision).toHaveBeenCalledTimes(1);
    expect((await runStreamingPost(f.post)).outcome).toBe(mode);
    expect(captureLines(f)).toEqual([]);
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.artifacts.upload).not.toHaveBeenCalled();
    expect(f.loadReport).toHaveBeenCalledTimes(1);
  },
);
it('a denied Gradle window reports retained activity once without report/sink/backend SDK dependencies', async () => {
  const f = await fixture('gradle');
  await runStreamingPrepare(f.deps);
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') {
    throw new Error('anchor');
  }
  const opened = await OpenedInvocation.open(anchor, f.budget);
  const facts = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  let activityPath: string;
  try {
    activityPath = opened.store.root.resolve(facts.header[9][2]);
  } finally {
    facts.close();
  }
  const original = await readFile(activityPath);
  const warning = vi.spyOn(f.host, 'warning');
  expect(
    (
      await runStreamingPost({
        ...f.post,
        lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: true }) }),
      })
    ).outcome,
  ).toBe('skipped-not-quiescent');
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0][0]).toMatch(/^Cache save skipped: /);
  expect(warning.mock.calls[0][0]).toContain(activityPath);
  expect(warning.mock.calls[0][0]).toContain(
    'owned snapshots/activity retained for manual handling',
  );
  expect(await readFile(activityPath)).toEqual(original);
  expect(f.backend).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  expect(f.sink.publishSummary).not.toHaveBeenCalled();
});
it('guard and GitHub factory modules defer provider SDK/config/build-tool graphs and streaming entrypoints are selected', async () => {
  const built = await build({
    entryPoints: ['src/phases/streaming/post.ts', 'src/ci/github/streaming.ts'],
    outdir: 'build/unused-streaming-graph',
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    splitting: true,
  });
  const main = Object.values(built.metafile.outputs).find(
    (o) => o.entryPoint === 'src/phases/streaming/post.ts',
  )!;
  expect(
    Object.keys(main.inputs).some(
      (p) =>
        p.includes('src/config/') ||
        /src\/build-tool\/(?:gradle|maven)\//.test(p) ||
        p.includes('src/ci/github/'),
    ),
  ).toBe(false);
  const { readFile } = await import('node:fs/promises');
  for (const tool of ['gradle', 'maven']) {
    for (const phase of ['main', 'post']) {
      expect(await readFile('src/ci/github/' + tool + '/' + phase + '.ts', 'utf8')).toContain(
        'streaming',
      );
    }
  }
});

it.each(['disabled', 'read-only'] as const)(
  'removes actual Gradle summary hooks in %s without post config rereads',
  async (mode) => {
    const f = await fixture(
      'gradle',
      mode === 'disabled' ? { 'cache-enabled': 'false' } : { 'read-only': 'true' },
    );
    f.hooks.mockImplementation(async () => installGradleBuildResultCapture(f.home, f.ci));
    await runStreamingPrepare(f.deps);
    for (const name of [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME]) {
      expect(await readFile(f.home + '/init.d/' + name, 'utf8')).toBeTruthy();
    }
    await runStreamingPost({
      ...f.post,
      removeHooks: async (root) => cleanupGradleBuildResultCapture(root),
    });
    for (const name of [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME]) {
      await expect(readFile(f.home + '/init.d/' + name)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(f.loadReport).toHaveBeenCalledWith('gradle', f.ci.tempDirectory);
    expect(f.backend).not.toHaveBeenCalled();
  },
);
it('rounds fractional configured GC age conservatively once and freezes that scalar', async () => {
  const f = await fixture('maven', {
    'cache-gc-mode': 'timestamp',
    'cache-gc-older-than-days': '2.3456789',
  });
  await runStreamingPrepare(f.deps);
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') {
    throw new Error('anchor');
  }
  const opened = await OpenedInvocation.open(anchor, f.budget),
    handoff = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  try {
    expect(handoff.header[7]).toBe(202666657);
  } finally {
    handoff.close();
  }
});
it.each([true, false])(
  'aggregator without configured producer requests reports not-configured, enabled=%s',
  async (enabled) => {
    const f = await fixture('maven', {
      'job-mode': 'distributed-aggregator',
      'cache-enabled': String(enabled),
    });
    await runStreamingPrepare(f.deps);
    expect(f.outputs.get('dependent-delta-status')).toBe('not-configured');
    expect(f.outputs.get('dependent-delta-artifact-count')).toBe('0');
  },
);

it.each(['base', 'read-only', 'worker', 'disabled'] as const)(
  'selects Gradle capture only after prepare admission, preserving %s ordinary-hook behavior',
  async (mode) => {
    const f = await fixture(
      'gradle',
      mode === 'read-only'
        ? { 'read-only': 'true' }
        : mode === 'worker'
          ? { 'job-mode': 'distributed-worker' }
          : mode === 'disabled'
            ? { 'cache-enabled': 'false' }
            : {},
    );
    const resolver = vi.fn(f.deps.lifecycle);
    await runStreamingPrepare({ ...f.deps, lifecycle: resolver });
    expect(resolver).toHaveBeenCalledTimes(mode === 'disabled' ? 0 : 1);
    if (mode !== 'disabled') {
      expect(resolver).toHaveBeenCalledWith('gradle');
    }
    expect(f.hooks).toHaveBeenCalledTimes(mode === 'base' ? 0 : 1);
    if (mode === 'base') {
      const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
      const owner = await OpenedInvocation.open(anchor as never, f.deps.budget);
      expect(await owner.store.root.stat(owner.store.prefix + 'registrations')).not.toBeNull();
      expect(await readFile(f.home + '/init.d/' + INIT_SCRIPT_FILE_NAME, 'utf8')).toContain(
        owner.store.codec.options.invocation,
      );
    }
  },
);

it.each([
  { stage: 'factory', cancel: true },
  { stage: 'publish', cancel: true },
  { stage: 'factory', cancel: false },
  { stage: 'publish', cancel: false },
])(
  'rejects summary $stage cancellation/lost lifetime (cancel=$cancel) after preserving owned state',
  async ({ stage, cancel }) => {
    const f = await fixture('maven'),
      controller = new AbortController();
    let current = true;
    const revoke = () => {
      if (cancel) {
        controller.abort(new Error('summary cancelled'));
      } else {
        current = false;
      }
    };
    await expect(
      runStreamingPrepare({
        ...f.deps,
        signal: controller.signal,
        assertCurrent: (): undefined => {
          if (!current) {
            throw new Error('lifetime revoked');
          }
        },
        reportSink: async () => {
          if (stage === 'factory') {
            revoke();
          }
          return {
            ...f.sink,
            publishSummary: async () => {
              if (stage === 'publish') {
                revoke();
              }
            },
          };
        },
      }),
    ).rejects.toThrow(cancel ? 'summary cancelled' : 'lifetime revoked');
    expect(f.state.get(JOB_PREPARE_FAILED_STATE)).toBe('true');
    expect(f.state.get(STREAMING_INVOCATION_STATE)).toBeTruthy();
  },
);

it('keeps an unrelated source warning and adds the exact unavailable warning once', async () => {
  const f = await fixture('maven');
  await runStreamingPrepare(f.deps);
  const warning = vi.spyOn(f.host, 'warning');
  vi.spyOn(basePost, 'postStreamingBase').mockImplementation(async (request) => {
    request.onWarning?.('Unrelated source-layout warning.');
    return { outcome: 'feature-unavailable', key: null };
  });
  expect((await runStreamingPost(f.post)).outcome).toBe('feature-unavailable');
  expect(warning.mock.calls.map(([message]) => message)).toEqual([
    'Unrelated source-layout warning.',
    'Cache save skipped: cache backend is unavailable.',
  ]);
});

it.each(['unavailable', 'unconfirmed'] as const)(
  'reports actual base %s once without a publication receipt',
  async (kind) => {
    const f = await fixture('maven');
    await runStreamingPrepare(f.deps);
    await mkdir(f.home + '/data');
    await writeFile(f.home + '/data/a', 'body');
    const warning = vi.spyOn(f.host, 'warning'),
      api = {
        ...f.sdk.backend,
        isFeatureAvailable: () => kind !== 'unavailable',
        saveCache: async () => -1,
      };
    const result = await runStreamingPost({ ...f.post, cacheBackend: async () => api });
    expect(result.outcome).toBe(kind === 'unavailable' ? 'feature-unavailable' : 'abandoned');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(f.sdk.calls.filter((c) => c.kind === 'save')).toEqual([]);
    const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
    if (anchor[0] !== 'streaming-lifecycle') {
      throw new Error('anchor');
    }
    const opened = await OpenedInvocation.open(anchor, f.budget);
    expect(opened.state[7]).toEqual(['outcome', result.outcome, null, null, null]);
    expect(await readFile(f.home + '/data/a', 'utf8')).toBe('body');
  },
);
it('reports an actual outgoing worker rejection without discovery or a success receipt', async () => {
  const f = await fixture('maven', { 'job-mode': 'distributed-worker' });
  await runStreamingPrepare(f.deps);
  await mkdir(f.home + '/data');
  await writeFile(f.home + '/data/a', 'body');
  const warning = vi.spyOn(f.host, 'warning');
  f.artifacts.upload.mockRejectedValueOnce(new Error('upload response lost'));
  expect((await runStreamingPost(f.post)).outcome).toBe('abandoned');
  expect(warning).toHaveBeenCalledTimes(1);
  expect(f.artifacts.upload).toHaveBeenCalledTimes(1);
  expect(f.artifacts.list).not.toHaveBeenCalled();
  expect(f.artifacts.get).not.toHaveBeenCalled();
  expect(f.artifacts.download).not.toHaveBeenCalled();
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') {
    throw new Error('anchor');
  }
  expect((await OpenedInvocation.open(anchor, f.budget)).state[7]).toEqual([
    'outcome',
    'abandoned',
    null,
    null,
    null,
  ]);
});

it('routes an actual local return failure through the GitHub entrypoint to setFailed', async () => {
  const f = await fixture('maven');
  await runStreamingPrepare(f.deps);
  await mkdir(f.home + '/data');
  await writeFile(f.home + '/data/a', 'body');
  const { NativeRoot } = await import('../../../src/cache/streaming/native'),
    rename = NativeRoot.prototype.renameAbsent;
  vi.spyOn(NativeRoot.prototype, 'renameAbsent').mockImplementation(async function (
    this: (typeof NativeRoot)['prototype'],
    ...args
  ) {
    if (args[1] === 'data') {
      throw new Error('return destination unavailable');
    }
    return rename.apply(this, args);
  });
  let complete!: (message: string) => void;
  const finished = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const failed = vi.spyOn(f.host, 'setFailed').mockImplementation((message) => {
    complete(String(message));
  });
  const warning = vi.spyOn(f.host, 'warning');
  vi.doMock('../../../src/ci/github/host', () => ({ createGitHubHost: () => f.host }));
  vi.doMock('../../../src/ci/github/streaming', () => ({ gitHubStreamingFactories: () => f.post }));
  try {
    await import('../../../src/ci/github/maven/post');
    expect(await finished).toMatch(/return|retained/i);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    expect(f.loadReport).not.toHaveBeenCalled();
    expect(f.sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(1);
  } finally {
    vi.doUnmock('../../../src/ci/github/host');
    vi.doUnmock('../../../src/ci/github/streaming');
  }
});

it('publishes an unassigned aggregator snapshot without a false preservation warning', async () => {
  const f = await fixture('maven', {
    'job-mode': 'distributed-aggregator',
    'cache-partitions': JSON.stringify([{ id: 'data', publication: 'single-writer' }]),
  });
  await runStreamingPrepare(f.deps);
  await mkdir(path.join(f.home, 'data'), { recursive: true });
  await writeFile(path.join(f.home, 'data/local'), 'local');
  const warning = vi.spyOn(f.host, 'warning');
  expect((await runStreamingPost(f.post)).outcome).toBe('published');
  expect(warning).not.toHaveBeenCalled();
});

it.each(['cancel', 'report', 'sink-factory', 'sink-publish'] as const)(
  'reports a retained real worker package once despite later %s failure',
  async (stage) => {
    const f = await fixture('maven', { 'job-mode': 'distributed-worker' });
    await runStreamingPrepare(f.deps);
    await mkdir(f.home + '/data');
    await writeFile(f.home + '/data/a', 'body');
    const warning = vi.spyOn(f.host, 'warning'),
      controller = new AbortController();
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let packagePath = '',
      original: Buffer | undefined;
    f.artifacts.upload.mockImplementationOnce(async (_name, files) => {
      packagePath = files[0];
      original = await readFile(packagePath);
      started();
      await gate; // Raw backend cannot be cancelled while settling this upload.
      throw new Error('upload response lost');
    });
    const later = new Error(stage + ' failed');
    const pending = runStreamingPost({
      ...f.post,
      signal: controller.signal,
      loadReport:
        stage === 'report'
          ? async () => {
              throw later;
            }
          : f.post.loadReport,
      reportSink:
        stage === 'sink-factory'
          ? async () => {
              throw later;
            }
          : stage === 'sink-publish'
            ? async () => ({
                ...f.sink,
                publishSummary: async () => {
                  throw later;
                },
              })
            : f.post.reportSink,
    });
    const rejected = expect(pending).rejects.toThrow(
      stage === 'cancel' ? 'cancel publication' : later.message,
    );
    try {
      await entered;
      expect(captureLines(f)).toEqual([
        'Mammoth capture summary (complete):',
        expect.stringMatching(/data: captured=1 files\/4 logical bytes.*purge=skipped$/),
      ]);
      expect(original!.length).toBeGreaterThan(0);
      expect(warning).not.toHaveBeenCalled();
      if (stage === 'cancel') {
        controller.abort(new Error('cancel publication'));
      }
    } finally {
      release();
    }
    await rejected;
    expect(captureLines(f)).toHaveLength(2);
    expect(warning.mock.calls.map(([message]) => message)).toEqual([
      'Raw worker upload unconfirmed; retain immutable package at ' + packagePath,
    ]);
    expect(await readFile(packagePath)).toEqual(original);
    expect(f.artifacts.upload).toHaveBeenCalledTimes(1);
    expect(f.artifacts.objects.size).toBe(0);
    expect(f.artifacts.list).not.toHaveBeenCalled();
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.artifacts.download).not.toHaveBeenCalled();
    const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
    if (anchor[0] !== 'streaming-lifecycle') {
      throw new Error('anchor');
    }
    const opened = await OpenedInvocation.open(anchor, f.budget);
    expect(opened.state[7]).toEqual(
      stage === 'cancel' ? null : ['outcome', 'abandoned', null, null, null],
    );
    expect(opened.state[4]).toBe(stage === 'cancel' ? 'post-active' : 'completed');
    if (stage === 'cancel') {
      expect(f.loadReport).not.toHaveBeenCalled();
    }
    if (stage === 'cancel' || stage === 'report' || stage === 'sink-factory') {
      expect(f.sink.publishSummary).not.toHaveBeenCalled();
    }
  },
);

it.each(['failure', 'cancel', 'analytics-disabled'] as const)(
  'reports bounded capture diagnostics in the Gradle worker %s path',
  async (mode) => {
    const f = await fixture('gradle', {
      'job-mode': 'distributed-worker',
      'cache-partitions': JSON.stringify([{ id: 'data', includes: ['data/**', 'caches/**'] }]),
    });
    await runStreamingPrepare(f.deps);
    const member = 'caches/9.9.2/kotlin-dsl/ic/unknown.bin';
    await mkdir(f.home + '/data', { recursive: true });
    await mkdir(path.dirname(f.home + '/' + member), { recursive: true });
    await writeFile(f.home + '/data/a', 'built');
    await writeFile(f.home + '/data/runtime.lock', 'retained worker lock');
    await writeFile(f.home + '/' + member, 'local only');
    const reason = new Error(mode + ' at index construction');
    const controller = new AbortController();
    const write = ObservationIndex.write;
    if (mode !== 'analytics-disabled') {
      vi.spyOn(ObservationIndex, 'write').mockImplementationOnce(async (...args) => {
        if (mode === 'failure') {
          throw reason;
        }
        const index = await write.apply(ObservationIndex, args);
        controller.abort(reason);
        return index;
      });
    }
    const post = runStreamingPost({
      ...f.post,
      signal: controller.signal,
      analytics: mode !== 'analytics-disabled',
    });
    if (mode === 'analytics-disabled') {
      expect((await post).outcome).toBe('worker-uploaded');
      expect(captureLines(f)).toEqual([]);
      expect(f.sink.publishLogGroup).not.toHaveBeenCalled();
    } else {
      await expect(post).rejects.toBe(reason);
      expect(captureLines(f)).toEqual([
        'Mammoth capture summary (partial):',
        expect.stringMatching(
          /captured=1 files\/5 logical bytes.*unsupported-layout=1 files, purge=skipped/,
        ),
      ]);
      expect(f.warning.mock.calls[0][0]).toContain('(partial capture)');
      expect(f.loadReport).not.toHaveBeenCalled();
      expect(f.artifacts.upload).not.toHaveBeenCalled();
    }
    expect(f.warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('data: ' + member));
    expect(await readFile(f.home + '/' + member, 'utf8')).toBe('local only');
    expect(await readFile(f.home + '/data/runtime.lock', 'utf8')).toBe('retained worker lock');
  },
);

it.each([true, false])(
  'fresh provider post keeps prepared family policy %s despite changed current inputs',
  async (enabled) => {
    const inputs = { 'dependency-cache-layer': String(enabled) };
    const f = await fixture('gradle', inputs);
    const presets = f.deps.buildToolAdapterFactory().getBuiltInPartitionPresets();
    const adapter = {
      ...f.deps.buildToolAdapterFactory(),
      getBuiltInPartitionPresets: () => presets.map((p) => ({ ...p, readOnlyLayer: true })),
    };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000);
    const ready = await runStreamingPrepare({ ...f.deps, buildToolAdapterFactory: () => adapter });
    clock.mockRestore();
    if (!('anchor' in ready)) {
      throw new Error('fixture');
    }
    await mkdir(f.home + '/data', { recursive: true });
    await writeFile(f.home + '/data/old.jar', 'old');
    await utimes(f.home + '/data/old.jar', 1.234, 1.234);
    inputs['dependency-cache-layer'] = String(!enabled);
    const changed = normalizeSharedActionConfig(readGradleActionInputs(f.host), {
      phase: 'finalize',
      ciContext: f.ci,
      env: {},
    });
    expect(changed.dependencyCacheLayer).toBe(!enabled);
    const reopened = await OpenedInvocation.open(ready.anchor, f.budget);
    expect(reopened.store.codec.options.model.dependencyCacheLayer).toBe(enabled);
    const result = await runStreamingPost({ ...f.post, lifecycle: f.deps.lifecycle });
    expect(result.outcome).toBe('published');
    expect((await ready.store.root.stat('data/old.jar')) !== null).toBe(enabled);
  },
);

it.each(['model-policy', 'handoff-family'] as const)(
  'rejects inconsistent persisted %s before fresh-post capture or publication',
  async (kind) => {
    const f = await fixture('gradle', { 'dependency-cache-layer': 'true' });
    const ready = await runStreamingPrepare(f.deps);
    if (!('anchor' in ready)) {
      throw new Error('fixture');
    }
    const opened = await OpenedInvocation.open(ready.anchor, f.budget);
    const bindings = structuredClone(opened.bindings),
      state = structuredClone(opened.state);
    const reference = kind === 'model-policy' ? bindings[6] : state[6]!;
    const rows: Value[][] = (await readFile(ready.store.root.resolve(reference[2]), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (kind === 'model-policy') {
      expect(rows[1][3]).toBe('retain-dependencies');
      rows[1].pop();
    } else {
      rows[0][5] = 'mammoth-s1-gradle-' + '0'.repeat(64);
    }
    const digest = new Digest('local-' + reference[1]);
    for (const row of rows.slice(0, -1)) {
      digest.update(row);
    }
    rows.at(-1)![2] = digest.digest();
    const bytes = Buffer.concat(rows.map((row) => encodeRecord(row)));
    await writeFile(ready.store.root.resolve(reference[2]), bytes);
    const next = ['ref', reference[1], reference[2], bytes.length, rawSha(bytes)];
    if (kind === 'model-policy') {
      bindings[6] = next as (typeof bindings)[6];
      const encoded = encodeRecord(bindings);
      await writeFile(ready.store.root.resolve(state[5][2]), encoded);
      state[5] = ['ref', 'bindings', state[5][2], encoded.length, rawSha(encoded)];
    } else {
      state[6] = next as (typeof state)[6];
    }
    await writeFile(
      ready.store.root.resolve(ready.store.prefix + 'state.json'),
      encodeRecord(state),
    );
    const capture = vi.spyOn(observationCapture, 'captureObservations');
    await expect(runStreamingPost({ ...f.post, lifecycle: f.deps.lifecycle })).rejects.toThrow(
      /model identity|stream header/,
    );
    expect(capture).not.toHaveBeenCalled();
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.removeHooks).not.toHaveBeenCalled();
    expect(f.sdk.calls.filter((call) => call.kind === 'save')).toHaveLength(0);
  },
);

const layerArtifact = 'caches/modules-2/files-2.1/g/a/1/hash/a.jar';
const layerMetadata = 'caches/modules-2/metadata-2.107/descriptors.bin';
function layerAdapter(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...f.deps.buildToolAdapterFactory(),
    getBuiltInPartitionPresets: () => [
      {
        id: 'data',
        displayName: 'Artifacts',
        description: '',
        defaultEnabled: true,
        readOnlyLayer: true,
        relativeIncludeGlobs: ['caches/modules-2/files-2.1/**'],
        relativeExcludeGlobs: [],
      },
      {
        id: 'metadata',
        displayName: 'Metadata',
        description: '',
        defaultEnabled: true,
        readOnlyLayer: true,
        publication: 'single-writer' as const,
        relativeIncludeGlobs: ['caches/modules-2/metadata-*/**'],
        relativeExcludeGlobs: [],
      },
    ],
    provision: async () => ({
      ...(await f.provision()),
      items: [{ label: 'gradle-wrapper.properties', version: '9.9.2', wasDownloaded: false }],
    }),
  };
}
const layerInputs = {
  'dependency-cache-layer': 'true',
  'cache-partitions': JSON.stringify([{ id: 'metadata', writer: 'writer' }]),
};
async function warmLayerProvider(
  extra: Record<string, string> = {},
  sweepTime = Date.now() as number | null,
) {
  const producer = await fixture('gradle', layerInputs);
  const ready = await runStreamingPrepare({
    ...producer.deps,
    buildToolAdapterFactory: () => layerAdapter(producer),
  });
  for (const member of [layerArtifact, layerMetadata]) {
    await mkdir(path.dirname(producer.home + '/' + member), { recursive: true });
    await writeFile(producer.home + '/' + member, 'seed');
  }
  const published = await runStreamingPost({
    ...producer.post,
    lifecycle: producer.deps.lifecycle,
  });
  if (!('store' in ready) || published.outcome !== 'published' || !published.key) {
    throw new Error('Expected a published Gradle generation.');
  }
  const model = ready.store.codec.options.model;
  if (sweepTime !== null) {
    await setGenerationSweepAt(producer, published.key, model, sweepTime);
  }
  const worker = await fixture('gradle', {
    ...layerInputs,
    'job-mode': 'distributed-worker',
    ...extra,
  });
  const inspect = vi.fn(async () => ({ remaining: false, uncertain: false }));
  const dependencies = {
    ...worker.deps,
    cacheBackend: async () => producer.sdk.backend,
    buildToolAdapterFactory: () => layerAdapter(worker),
    lifecycle: gradleResolver({ inspect }),
  };
  return { producer, worker, dependencies, inspect, family: model.family };
}

it.each(['writable', 'read-only'] as const)(
  'suppresses the Gradle seed during the force grace on %s runs in the same family',
  async (access) => {
    const { worker, dependencies, family } = await warmLayerProvider(
      { 'read-only': String(access === 'read-only') },
      Date.now() - 3 * 86400000 - 60000,
    );
    const result = await runStreamingPrepare(dependencies);
    if (!('store' in result)) {
      throw new Error('Expected normal prepare.');
    }
    expect(worker.outputs.get('dependency-gc-due')).toBe('true');
    expect(result.dependencyGc).toEqual({ due: 'true', force: false });
    expect(result.store.codec.options.model.family).toBe(family);
    expect(result.dependencyLayer).toBeNull();
    expect(await readFile(worker.home + '/' + layerArtifact, 'utf8')).toBe('seed');
    const outcome = await runStreamingPost({ ...worker.post, lifecycle: dependencies.lifecycle });
    if (access === 'read-only') {
      expect(outcome.outcome).toBe('read-only');
      expect(worker.artifacts.upload).not.toHaveBeenCalled();
    } else {
      expect(outcome.outcome).toBe('worker-uploaded');
      const resultSummary = await readUploadedWorker(worker, result.store.codec.options);
      expect(resultSummary.identity[1]).toBe(3);
      expect(resultSummary.identity[8]).toEqual([
        'sweep-usage',
        result.restoredKey,
        result.cutoff,
        expect.any(Number),
        ['data'],
      ]);
    }
  },
);

it('reports available and explicitly empty sweep partitions while omitting cold partitions', async () => {
  const inputs = {
    'cache-partitions': JSON.stringify([
      { id: 'cold', includes: ['cold/**'] },
      { id: 'empty', includes: ['empty/**'] },
    ]),
  };
  const producer = await fixture('maven', inputs);
  const prepared = await runStreamingPrepare(producer.deps);
  if (!('store' in prepared)) {
    throw new Error('Expected normal prepare.');
  }
  for (const partition of ['data', 'cold']) {
    await mkdir(path.join(producer.home, partition));
    await writeFile(path.join(producer.home, partition, 'file'), 'cached');
  }
  const published = await runStreamingPost(producer.post);
  if (published.outcome !== 'published' || !published.key) {
    throw new Error('Expected publication.');
  }
  const generation = await restoreGeneration(
    producer,
    published.key,
    prepared.store.codec.options.model,
  );
  const cold = generation[8].find((entry) => entry[0] === 'object' && entry[1] === 'cold');
  if (!cold || cold[0] !== 'object') {
    throw new Error('Expected cold fixture object.');
  }
  expect(producer.sdk.objects.delete(cold[2][2])).toBe(true);

  const worker = await fixture('maven', { ...inputs, 'job-mode': 'distributed-worker' });
  const ready = await runStreamingPrepare({
    ...worker.deps,
    cacheBackend: async () => producer.sdk.backend,
  });
  if (!('store' in ready)) {
    throw new Error('Expected normal prepare.');
  }
  expect(ready.restoreStatus).toBe('current-lineage-partial-hit');
  expect(worker.outputs.get('dependency-gc-due')).toBe('true');
  expect((await runStreamingPost(worker.post)).outcome).toBe('worker-uploaded');
  const { identity } = await readUploadedWorker(worker, ready.store.codec.options);
  expect(identity[1]).toBe(3);
  if (identity[1] === 3) {
    expect(identity[8][4]).toEqual(['data', 'empty']);
  }
});

it('keeps ordinary archive identity for a due Gradle writer using an external seed', async () => {
  const { worker, dependencies } = await warmLayerProvider({}, null);
  worker.host.exportEnvironmentVariable('GRADLE_RO_DEP_CACHE', '/external-seed');
  const ready = await runStreamingPrepare({
    ...dependencies,
    ciProvider: { ...dependencies.ciProvider, context: { ...worker.ci, jobName: 'writer' } },
  });
  if (!('store' in ready)) {
    throw new Error('Expected normal prepare.');
  }
  expect(worker.outputs.get('dependency-gc-due')).toBe('true');
  expect(ready.dependencyLayer).toBeNull();
  expect(await readFile(worker.home + '/' + layerArtifact, 'utf8')).toBe('seed');
  expect(
    (await runStreamingPost({ ...worker.post, lifecycle: dependencies.lifecycle })).outcome,
  ).toBe('worker-uploaded');
  const { identity } = await readUploadedWorker(worker, ready.store.codec.options, ['metadata']);
  expect(identity[1]).toBe(1);
});

it.each([true, false])(
  'publishes a warm seed last and honors export-layer-environment=%s',
  async (exportEnvironment) => {
    const { worker, dependencies, inspect } = await warmLayerProvider({
      'export-layer-environment': String(exportEnvironment),
    });
    const output = vi.spyOn(worker.host, 'setOutput'),
      environment = vi.spyOn(worker.host, 'exportEnvironmentVariable');
    const result = await runStreamingPrepare(dependencies);
    if (!('dependencyLayer' in result) || !result.dependencyLayer) {
      throw new Error('No warm seed');
    }
    expect(worker.state.get(STREAMING_LAYER_ACTIVATED_STATE)).toBe(
      result.store.codec.options.invocation,
    );
    const seed = String(worker.outputs.get('gradle-ro-dep-cache'));
    expect(await readFile(seed + '/modules-2/files-2.1/g/a/1/hash/a.jar', 'utf8')).toBe('seed');
    expect(worker.info.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      output.mock.invocationCallOrder.at(-1)!,
    );
    if (exportEnvironment) {
      expect(environment).toHaveBeenCalledExactlyOnceWith('GRADLE_RO_DEP_CACHE', seed);
      expect(worker.host.getEnvironmentVariable('GRADLE_RO_DEP_CACHE')).toBe(seed);
    } else {
      expect(environment).not.toHaveBeenCalled();
    }
    expect(
      (await runStreamingPost({ ...worker.post, lifecycle: dependencies.lifecycle })).outcome,
    ).toBe('worker-uploaded');
    expect(inspect).toHaveBeenCalledTimes(2);
    await expect(readFile(seed + '/modules-2/metadata-2.107/descriptors.bin')).rejects.toThrow(
      /ENOENT/,
    );
  },
);

it.each([true, false])(
  'rejects an existing Gradle layer before provisioning or backend access with environment export %s',
  async (exportEnvironment) => {
    const f = await fixture('gradle', {
      ...layerInputs,
      'job-mode': 'distributed-worker',
      'export-layer-environment': String(exportEnvironment),
    });
    f.host.exportEnvironmentVariable('GRADLE_RO_DEP_CACHE', '/caller/cache');
    await expect(
      runStreamingPrepare({ ...f.deps, buildToolAdapterFactory: () => layerAdapter(f) }),
    ).rejects.toThrow(/already set.*disable dependency-cache-layer/);
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.sdk.calls).toHaveLength(0);
    expect(f.artifacts.list).not.toHaveBeenCalled();
  },
);

it.each(['report', 'output', 'environment'] as const)(
  'settles a private or advertised seed when final %s fails',
  async (failure) => {
    const { worker, dependencies, inspect } = await warmLayerProvider();
    let seed = '';
    const output = worker.host.setOutput.bind(worker.host);
    vi.spyOn(worker.host, 'setOutput').mockImplementation((name, value) => {
      output(name, value);
      if (name === 'gradle-ro-dep-cache' && value) {
        seed = String(value);
        if (failure === 'output') {
          throw new Error('output failure');
        }
      }
    });
    if (failure === 'environment') {
      const publish = worker.host.exportEnvironmentVariable.bind(worker.host);
      vi.spyOn(worker.host, 'exportEnvironmentVariable').mockImplementation((name, value) => {
        publish(name, value);
        throw new Error('environment failure');
      });
    }
    const request =
      failure === 'report'
        ? {
            ...dependencies,
            reportSink: async () => ({
              ...worker.sink,
              publishSummary: async () => {
                throw new Error('report failure');
              },
            }),
          }
        : dependencies;
    await expect(runStreamingPrepare(request)).rejects.toThrow(failure + ' failure');
    expect(worker.state.has(STREAMING_LAYER_ACTIVATED_STATE)).toBe(false);
    const raw = worker.state.get(STREAMING_INVOCATION_STATE)!;
    const anchor = decodeInvocationAnchor(raw);
    if (anchor[0] !== 'streaming-lifecycle') {
      throw new Error('anchor');
    }
    const opened = await OpenedInvocation.open(anchor, worker.budget);
    if (failure === 'report') {
      expect(await readdir(opened.store.root.resolve(opened.store.prefix + 'seed'))).toEqual([]);
      expect(seed).toBe('');
      expect(inspect).toHaveBeenCalledTimes(1);
    } else {
      // A later always()/continue-on-error step can still consume the successful output.
      expect(seed).not.toBe('');
      expect(await readFile(seed + '/modules-2/metadata-2.107/descriptors.bin', 'utf8')).toBe(
        'seed',
      );
      expect(await readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME, 'utf8')).toContain(
        'gradle-installation',
      );
      expect(inspect).toHaveBeenCalledTimes(1);
      const capture = vi.spyOn(observationCapture, 'captureObservations');
      worker.removeHooks.mockImplementation(async () => {
        await cleanupGradleBuildResultCapture(worker.home);
        return [];
      });
      expect(
        (await runStreamingPost({ ...worker.post, lifecycle: dependencies.lifecycle })).outcome,
      ).toBe('skipped');
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(capture).not.toHaveBeenCalled();
      expect(worker.artifacts.upload).not.toHaveBeenCalled();
      expect(worker.backend).not.toHaveBeenCalled();
      await expect(readFile(seed + '/modules-2/metadata-2.107/descriptors.bin')).rejects.toThrow(
        /ENOENT/,
      );
      await expect(readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME)).rejects.toThrow(
        /ENOENT/,
      );
      expect((await OpenedInvocation.open(anchor, worker.budget)).state[7]?.[1]).toBe('abandoned');
    }
  },
);

it.each(['output', 'environment'] as const)(
  'keeps the seed live for later consumers after successful %s publication followed by cancellation',
  async (point) => {
    const { worker, dependencies, inspect } = await warmLayerProvider();
    const controller = new AbortController(),
      output = worker.host.setOutput.bind(worker.host);
    const publish = worker.host.exportEnvironmentVariable.bind(worker.host);
    const environment = vi
      .spyOn(worker.host, 'exportEnvironmentVariable')
      .mockImplementation((name, value) => {
        publish(name, value);
        if (point === 'environment') {
          controller.abort(new Error('activation cancelled'));
        }
      });
    vi.spyOn(worker.host, 'setOutput').mockImplementation((name, value) => {
      output(name, value);
      if (name === 'gradle-ro-dep-cache' && value && point === 'output') {
        controller.abort(new Error('activation cancelled'));
      }
    });
    await expect(
      runStreamingPrepare({ ...dependencies, signal: controller.signal }),
    ).rejects.toThrow('activation cancelled');
    if (point === 'output') {
      expect(environment).not.toHaveBeenCalled();
    } else {
      expect(environment).toHaveBeenCalledOnce();
    }
    expect(inspect).toHaveBeenCalledTimes(1);
    const seed = String(worker.outputs.get('gradle-ro-dep-cache'));
    if (point === 'environment') {
      expect(worker.host.getEnvironmentVariable('GRADLE_RO_DEP_CACHE')).toBe(seed);
    }
    expect(await readFile(seed + '/modules-2/metadata-2.107/descriptors.bin', 'utf8')).toBe('seed');
    expect(await readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME, 'utf8')).toContain(
      'gradle-installation',
    );
    const capture = vi.spyOn(observationCapture, 'captureObservations');
    worker.removeHooks.mockImplementation(async () => {
      await cleanupGradleBuildResultCapture(worker.home);
      return [];
    });
    expect(
      (
        await runStreamingPost({
          ...worker.post,
          signal: controller.signal,
          lifecycle: dependencies.lifecycle,
        })
      ).outcome,
    ).toBe('skipped');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect(worker.artifacts.upload).not.toHaveBeenCalled();
    expect(worker.backend).not.toHaveBeenCalled();
    await expect(readFile(seed + '/modules-2/metadata-2.107/descriptors.bin')).rejects.toThrow(
      /ENOENT/,
    );
    await expect(readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME)).rejects.toThrow(
      /ENOENT/,
    );
  },
);

it('retains the advertised seed and operational hooks if failed-prepare post cannot settle consumers', async () => {
  const { worker, dependencies, inspect } = await warmLayerProvider();
  const publish = worker.host.exportEnvironmentVariable.bind(worker.host);
  vi.spyOn(worker.host, 'exportEnvironmentVariable').mockImplementation((name, value) => {
    publish(name, value);
    throw new Error('environment failed');
  });
  await expect(runStreamingPrepare(dependencies)).rejects.toThrow('environment failed');
  const seed = String(worker.outputs.get('gradle-ro-dep-cache'));
  inspect.mockResolvedValue({ remaining: false, uncertain: true });
  const capture = vi.spyOn(observationCapture, 'captureObservations');
  await expect(
    runStreamingPost({ ...worker.post, lifecycle: dependencies.lifecycle }),
  ).rejects.toThrow('Failed-prepare Gradle seed retained at ' + seed);
  expect(capture).not.toHaveBeenCalled();
  expect(worker.removeHooks).not.toHaveBeenCalled();
  expect(worker.artifacts.upload).not.toHaveBeenCalled();
  expect(worker.backend).not.toHaveBeenCalled();
  expect(await readFile(seed + '/modules-2/metadata-2.107/descriptors.bin', 'utf8')).toBe('seed');
  expect(await readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME, 'utf8')).toContain(
    'gradle-installation',
  );
  expect(worker.warning.mock.calls.flat().join(' ')).toContain(seed);
});

it.each(['advertisement-only', 'no-markers', 'foreign-terminal', 'aborted-work'] as const)(
  'uses cleanup-only post for interrupted seed activation with %s and no prepare-failed flag',
  async (interruption) => {
    const { worker, dependencies, inspect } = await warmLayerProvider();
    const ready = await runStreamingPrepare(dependencies);
    if (!('dependencyLayer' in ready) || !ready.dependencyLayer) {
      throw new Error('No warm seed');
    }
    expect(worker.state.get(STREAMING_LAYER_ADVERTISEMENT_STATE)).toBe(
      ready.store.codec.options.invocation,
    );
    expect(worker.state.get(STREAMING_LAYER_ACTIVATED_STATE)).toBe(
      ready.store.codec.options.invocation,
    );
    // Recreate the durable state at interruption: build-ready and its frozen handoff exist,
    // but completion of activation was never witnessed. Generic exception handling did not run.
    worker.state.delete(JOB_PREPARE_FAILED_STATE);
    worker.state.delete(STREAMING_LAYER_ACTIVATED_STATE);
    const seed = String(worker.outputs.get('gradle-ro-dep-cache'));
    if (interruption === 'no-markers') {
      worker.state.delete(STREAMING_LAYER_ADVERTISEMENT_STATE);
      worker.outputs.delete('gradle-ro-dep-cache');
      worker.host.exportEnvironmentVariable('GRADLE_RO_DEP_CACHE', '');
    }
    if (interruption === 'foreign-terminal') {
      worker.state.set(STREAMING_LAYER_ACTIVATED_STATE, '0'.repeat(64));
    }
    expect(await readFile(seed + '/modules-2/metadata-2.107/descriptors.bin', 'utf8')).toBe('seed');
    expect(await readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME, 'utf8')).toContain(
      'gradle-installation',
    );
    const capture = vi.spyOn(observationCapture, 'captureObservations');
    worker.removeHooks.mockImplementation(async () => {
      await cleanupGradleBuildResultCapture(worker.home);
      return [];
    });
    const abort = new AbortController();
    if (interruption === 'aborted-work') {
      abort.abort(new Error('work already cancelled'));
    }
    expect(
      (
        await runStreamingPost({
          ...worker.post,
          signal: abort.signal,
          lifecycle: dependencies.lifecycle,
        })
      ).outcome,
    ).toBe('skipped');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect(worker.artifacts.upload).not.toHaveBeenCalled();
    expect(worker.backend).not.toHaveBeenCalled();
    expect(worker.loadReport).not.toHaveBeenCalled();
    expect((await OpenedInvocation.open(ready.anchor, worker.budget)).state[7]?.[1]).toBe(
      'abandoned',
    );
    await expect(readFile(seed + '/modules-2/metadata-2.107/descriptors.bin')).rejects.toThrow(
      /ENOENT/,
    );
    await expect(readFile(worker.home + '/init.d/' + INIT_SCRIPT_FILE_NAME)).rejects.toThrow(
      /ENOENT/,
    );
  },
);

it.each(['gradle', 'maven'] as const)(
  'preserves cancelled-work semantics for ordinary %s post',
  async (tool) => {
    const f = await fixture(tool);
    await runStreamingPrepare(f.deps);
    const abort = new AbortController();
    abort.abort(new Error('normal work cancelled'));
    const capture = vi.spyOn(observationCapture, 'captureObservations');
    await expect(
      runStreamingPost({ ...f.post, lifecycle: f.deps.lifecycle, signal: abort.signal }),
    ).rejects.toThrow('normal work cancelled');
    expect(capture).not.toHaveBeenCalled();
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.removeHooks).not.toHaveBeenCalled();
  },
);
