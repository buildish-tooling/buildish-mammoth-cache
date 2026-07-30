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

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runFinalizeExecution,
  type FinalizeEntrypointDependencies,
} from '../../../src/phases/finalize/cli';

const finalizeFlowMock = vi.hoisted(() => ({
  executeFinalizeAction: vi.fn(async () => ({
    bootstrap: { baseCacheResult: null },
    consumedDeltaCleanupResult: null,
    deltaArtifactResult: null,
    message: 'Finalize execution completed.',
  })),
}));

const jobSingleRunMock = vi.hoisted(() => ({
  decideSingleRunFinalizeExecution: vi.fn(() => ({
    shouldRun: true,
    message: 'Run post action.',
  })),
}));

vi.mock('../../../src/phases/finalize/flow', () => finalizeFlowMock);
vi.mock('../../../src/guard/job-single-run', () => jobSingleRunMock);

describe('finalize entrypoint', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads persisted action state when deciding and executing post work', async () => {
    const runtimeHost = {
      getInput: vi.fn(() => ''),
      getState: vi.fn(() => 'persisted-state'),
      saveState: vi.fn(),
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      setFailed: vi.fn(),
    };
    const ciProvider = {
      context: {
        eventName: 'push',
        resolvedRefName: 'main',
        safeRefName: 'main',
        runnerOs: 'linux',
        runnerArch: 'x64',
        defaultBranch: 'main',
        isPullRequest: false,
        repository: 'buildish-tooling/buildish',
        workflowName: 'CI',
        jobName: 'test',
        runId: 123,
        runAttempt: 1,
        tempDirectory: '/tmp',
        workspace: '/workspace',
        actionPath: null,
      },
      httpHeadersByHost: new Map(),
      executionUrls: { jobUrl: null, workflowRunUrl: null },
      createBootstrapDiagnosticsLines: vi.fn(() => []),
    };
    const reportSink = {
      publishLogGroup: vi.fn(),
      publishSummary: vi.fn(async () => undefined),
      replaceSummary: vi.fn(async () => undefined),
    };
    const dependencies = {
      runtimeHost,
      ciProvider,
      reportSink,
      env: process.env,
      config: {} as FinalizeEntrypointDependencies['config'],
      cacheBackend: {} as FinalizeEntrypointDependencies['cacheBackend'],
      artifactBackend: {} as FinalizeEntrypointDependencies['artifactBackend'],
      buildToolAdapterFactory: {} as FinalizeEntrypointDependencies['buildToolAdapterFactory'],
    } satisfies FinalizeEntrypointDependencies;

    await runFinalizeExecution(dependencies);

    expect(jobSingleRunMock.decideSingleRunFinalizeExecution).toHaveBeenCalledWith({
      getState: runtimeHost.getState,
    });
    expect(finalizeFlowMock.executeFinalizeAction).toHaveBeenCalledWith(dependencies);
    expect(runtimeHost.info).toHaveBeenCalledWith('Finalize execution completed.');
  });
});
