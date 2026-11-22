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

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import {
  runStreamingPrepare,
  STREAMING_INVOCATION_STATE,
} from '../../../src/phases/streaming/prepare';
import {
  runStreamingPost,
  type StreamingPostDependencies,
} from '../../../src/phases/streaming/post';
import { decodeInvocationAnchor, OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { PrepareFacts } from '../../../src/cache/streaming/prepare-state';
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
      f.post = { ...f.post, inspect: async () => ({ remaining: false, uncertain: false }) };
    f.loadReport.mockImplementation(async () => {
      const a = decodeInvocationAnchor(raw);
      if (a[0] !== 'streaming-lifecycle') throw new Error('anchor');
      const opened = await OpenedInvocation.open(a, f.budget);
      expect(opened.state[14]).toBe('published');
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
it('failed prepare reconciles its owned state without reading reports or publishing a required worker success', async () => {
  const f = await fixture('maven', { 'job-mode': 'distributed-worker' });
  f.hooks.mockRejectedValue(new Error('hook failure'));
  await expect(runStreamingPrepare(f.deps)).rejects.toThrow('hook failure');
  expect(f.state.get(JOB_PREPARE_FAILED_STATE)).toBe('true');
  expect((await runStreamingPost(f.post)).outcome).toBe('skipped');
  expect(f.artifacts.upload).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  const a = decodeInvocationAnchor(f.state.get(STREAMING_INVOCATION_STATE)!);
  if (a[0] !== 'streaming-lifecycle') throw new Error('anchor');
  expect((await OpenedInvocation.open(a, f.budget)).state[14]).toBe('abandoned');
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
it('a denied Gradle window does not load report/sink/backend SDK dependencies', async () => {
  const f = await fixture('gradle');
  await runStreamingPrepare(f.deps);
  expect(
    (
      await runStreamingPost({
        ...f.post,
        inspect: async () => ({ remaining: false, uncertain: true }),
      })
    ).outcome,
  ).toBe('skipped-not-quiescent');
  expect(f.backend).not.toHaveBeenCalled();
  expect(f.loadReport).not.toHaveBeenCalled();
  expect(f.sink.publishSummary).not.toHaveBeenCalled();
});
it('guard and GitHub factory modules defer provider SDK/config/build-tool graphs and released entrypoints stay selected', async () => {
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
        p.includes('src/config/') || p.includes('src/build-tool/') || p.includes('src/ci/github/'),
    ),
  ).toBe(false);
  const { readFile } = await import('node:fs/promises');
  for (const tool of ['gradle', 'maven'])
    for (const phase of ['main', 'post'])
      expect(await readFile('src/ci/github/' + tool + '/' + phase + '.ts', 'utf8')).not.toContain(
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
    facts = await PrepareFacts.open(opened.store, { budget: f.budget });
  try {
    expect(facts.selection![4][5]).toBe(202666657);
  } finally {
    facts.close();
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
