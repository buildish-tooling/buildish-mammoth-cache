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

import path from 'node:path';
import { ImmutableCacheBackend } from './immutable-cache-backend';
import { mkdir } from 'node:fs/promises';
import { normalizeSharedActionConfig } from '../../src/config/normalize';
import { readGradleActionInputs } from '../../src/build-tool/gradle/config';
import { createTestRuntimeHost } from './github-test-runtime';
import { cutoffFixtureCi } from './cutoff-fixture';
import type { BuildToolAdapter } from '../../src/build-tool/types';
import {
  executeCutoffPrepareAction,
  type CutoffPrepareDependencies,
} from '../../src/phases/prepare/cutoff-flow';
import { type BaseCacheBackend } from '../../src/cache/backend';
import type { WorkflowArtifactBackend } from '../../src/delta/backend';

export async function cutoffJob(
  root: string,
  options: {
    name?: string;
    runAttempt?: number;
    inputs?: Record<string, string>;
    cacheBackend?: BaseCacheBackend;
    artifactBackend?: WorkflowArtifactBackend;
    provision?: () => Promise<void>;
    hooks?: () => Promise<void>;
    report?: () => Promise<void>;
  } = {},
) {
  await mkdir(root, { recursive: true });
  const home = path.join(root, 'cache');
  await mkdir(home, { recursive: true });
  const ci = {
    ...cutoffFixtureCi(root, options.name ?? 'build'),
    workspace: root,
    runAttempt: options.runAttempt ?? 1,
  };
  const state = new Map<string, string>(),
    warnings: string[] = [],
    logs: string[] = [],
    summaries: string[] = [];
  const inputs = { 'job-mode': 'standalone', ...options.inputs };
  const runtimeHost = createTestRuntimeHost({
    inputs,
    getState: (key) => state.get(key) ?? '',
    saveState: (key, value) => state.set(key, value),
    warning: (m) => warnings.push(m),
    info: (m) => logs.push(m),
  });
  const config = normalizeSharedActionConfig(readGradleActionInputs(runtimeHost), {
    phase: 'prepare',
    ciContext: ci,
    env: {},
  });
  const adapter: BuildToolAdapter = {
    getName: () => 'Test',
    getBuildToolId: () => 'test',
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
    getHardCacheExcludeGlobs: () => ['**/*.lock'],
    provision: async () => {
      await options.provision?.();
      return { items: [], warnings: [], additionalOutputs: {} };
    },
    installBuildHooks: async () => {
      await options.hooks?.();
    },
    collectBuildReport: async () => {
      await options.report?.();
      return { anyBuildFailed: false, warnings: [], summaryLines: [], logLines: [], builds: [] };
    },
  };
  const cacheBackend = options.cacheBackend ?? new ImmutableCacheBackend();
  const deps: CutoffPrepareDependencies = {
    runtimeHost,
    config,
    ciProvider: {
      context: ci,
      httpHeadersByHost: new Map(),
      executionUrls: { jobUrl: null, workflowRunUrl: null },
      createBootstrapDiagnosticsLines: () => [],
    },
    reportSink: {
      publishLogGroup: () => {},
      publishSummary: async (lines) => {
        summaries.push(...lines);
      },
      replaceSummary: async (lines) => {
        summaries.splice(0, summaries.length, ...lines);
      },
    },
    buildToolAdapterFactory: () => adapter,
    cacheBackend,
    artifactBackend: options.artifactBackend,
  };
  return {
    root,
    home,
    ci,
    state,
    warnings,
    logs,
    summaries,
    adapter,
    deps,
    prepare: () => executeCutoffPrepareAction(deps),
  };
}
