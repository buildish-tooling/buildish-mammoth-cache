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

import { resolveLifecycle } from '../../../src/build-tool/lifecycle';
import { gradleResolver } from './quiescence-fixture';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import {
  runStreamingPrepare,
  STREAMING_INVOCATION_STATE,
} from '../../../src/phases/streaming/prepare';
import * as basePost from '../../../src/cache/streaming/base-post';
import {
  runStreamingPost,
  type StreamingPostDependencies,
} from '../../../src/phases/streaming/post';
import { decodeInvocationAnchor, OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
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
import { cutoffFixtureCi } from '../../support/cutoff-fixture';
import { readGradleActionInputs } from '../../../src/build-tool/gradle/config';
import { normalizeSharedActionConfig } from '../../../src/config/normalize';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import { memoryArtifacts } from './memory-artifact-fixture';
import type { BuildToolAdapter } from '../../../src/build-tool/types';
const roots: string[] = [],
  budgets: WorkingBudget[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const budget of budgets.splice(0)) expect(budget.retained).toBe(0);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
  const ci = { ...cutoffFixtureCi(root, 'A'), tempDirectory: temp, sourceRevision: 'rev-1' },
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
    getName: () => tool,
    getBuildToolId: () => tool,
    getCacheRoot: () => home,
    getBuiltInPartitionPresets: () => [
      {
        id: 'data',
        displayName: 'Data',
        description: '',
        defaultEnabled: true,
        relativeIncludeGlobs: ['data/**'],
        relativeExcludeGlobs: [],
      },
    ],
    getHardCacheExcludeGlobs: () => ['.mammoth/**', 'init.d/**', '**/*.lock'],
    provision,
    installBuildHooks: hooks,
    collectBuildReport: async () => ({
      anyBuildFailed: false,
      warnings: [],
      summaryLines: [],
      logLines: [],
      builds: [],
    }),
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
it.each(['maven', 'gradle'] as const)(
  'uses the guarded %s prepare/post composition and reports only after frozen post completion',
  async (tool) => {
    const f = await fixture(tool);
    await runStreamingPrepare(f.deps);
    const raw = f.state.get(STREAMING_INVOCATION_STATE)!;
    expect(raw.length).toBeLessThan(4096);
    expect(f.outputs.get('base-cache-restore-status')).toBe('miss');
    await mkdir(f.home + '/data');
    await writeFile(f.home + '/data/file', 'built');
    if (tool === 'gradle')
      f.post = {
        ...f.post,
        lifecycle: gradleResolver({
          inspect: async () => ({ remaining: false, uncertain: false }),
        }),
      };
    f.loadReport.mockImplementation(async () => {
      const a = decodeInvocationAnchor(raw);
      if (a[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
  if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
it('failed prepare cleans only known hooks without reading reports or publishing a required worker success', async () => {
  const f = await fixture('maven', { 'job-mode': 'distributed-worker' });
  f.hooks.mockRejectedValue(new Error('hook failure'));
  await expect(runStreamingPrepare(f.deps)).rejects.toThrow('hook failure');
  expect(f.state.get(JOB_PREPARE_FAILED_STATE)).toBe('true');
  expect((await runStreamingPost(f.post)).outcome).toBe('skipped');
  expect(f.artifacts.upload).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  const a = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (a[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.artifacts.upload).not.toHaveBeenCalled();
    expect(f.loadReport).toHaveBeenCalledTimes(1);
  },
);
it('a denied Gradle window reports retained activity once without report/sink/backend SDK dependencies', async () => {
  const f = await fixture('gradle');
  await runStreamingPrepare(f.deps);
  const anchor = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
  for (const tool of ['gradle', 'maven'])
    for (const phase of ['main', 'post'])
      expect(await readFile('src/ci/github/' + tool + '/' + phase + '.ts', 'utf8')).toContain(
        'streaming',
      );
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
    for (const name of [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME])
      expect(await readFile(f.home + '/init.d/' + name, 'utf8')).toBeTruthy();
    await runStreamingPost({
      ...f.post,
      removeHooks: async (root) => cleanupGradleBuildResultCapture(root),
    });
    for (const name of [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME])
      await expect(readFile(f.home + '/init.d/' + name)).rejects.toMatchObject({ code: 'ENOENT' });
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
  if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
    const resolver = vi.fn(resolveLifecycle);
    await runStreamingPrepare({ ...f.deps, lifecycle: resolver });
    expect(resolver).toHaveBeenCalledTimes(mode === 'disabled' ? 0 : 1);
    if (mode !== 'disabled') expect(resolver).toHaveBeenCalledWith('gradle');
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
      if (cancel) controller.abort(new Error('summary cancelled'));
      else current = false;
    };
    await expect(
      runStreamingPrepare({
        ...f.deps,
        signal: controller.signal,
        assertCurrent: (): undefined => {
          if (!current) throw new Error('lifetime revoked');
        },
        reportSink: async () => {
          if (stage === 'factory') revoke();
          return {
            ...f.sink,
            publishSummary: async () => {
              if (stage === 'publish') revoke();
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
    if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
  if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
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
    if (args[1] === 'data') throw new Error('return destination unavailable');
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
      expect(original!.length).toBeGreaterThan(0);
      expect(warning).not.toHaveBeenCalled();
      if (stage === 'cancel') controller.abort(new Error('cancel publication'));
    } finally {
      release();
    }
    await rejected;
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
    if (anchor[0] !== 'streaming-lifecycle') throw new Error('anchor');
    const opened = await OpenedInvocation.open(anchor, f.budget);
    expect(opened.state[7]).toEqual(
      stage === 'cancel' ? null : ['outcome', 'abandoned', null, null, null],
    );
    expect(opened.state[4]).toBe(stage === 'cancel' ? 'post-active' : 'completed');
    if (stage === 'cancel') expect(f.loadReport).not.toHaveBeenCalled();
    if (stage === 'cancel' || stage === 'report' || stage === 'sink-factory')
      expect(f.sink.publishSummary).not.toHaveBeenCalled();
  },
);
