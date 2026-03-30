/*
 * Copyright 2026 The Apache Software Foundation
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

import { GradleBuildToolAdapter } from '../../../build-tool/gradle/adapter';
import {
  readGradleActionInputs,
  resolveGradleActionInputsFromConfigFile,
  normalizeGradleActionConfig,
} from '../../../build-tool/gradle/config';
import { runFinalizeExecution } from '../../../phases/finalize/cli';
import type { NormalizedGradleConfig } from '../../../config/types';

import {
  createGitHubBaseCacheBackend,
  createGitHubPlatform,
  createGitHubReportSink,
  createGitHubHost,
  createGitHubWorkflowArtifactBackend,
} from '../index';

const runtimeHost = createGitHubHost();
const ciProvider = createGitHubPlatform({
  env: process.env,
  githubTokenInput: runtimeHost.getInput('github-token', { trimWhitespace: true }),
  githubJobCheckRunId: runtimeHost.getInput('github-job-check-run-id', {
    trimWhitespace: true,
  }),
});
const reportSink = createGitHubReportSink({ env: process.env });

async function main(): Promise<void> {
  const directInputs = readGradleActionInputs(runtimeHost);
  const rawInputs = await resolveGradleActionInputsFromConfigFile(directInputs, {
    workspace: ciProvider.context.workspace,
  });
  const config: NormalizedGradleConfig = normalizeGradleActionConfig(rawInputs, {
    phase: 'finalize',
    ciContext: ciProvider.context,
    env: process.env,
  });

  await runFinalizeExecution({
    runtimeHost,
    ciProvider,
    reportSink,
    config,
    env: process.env,
    cacheBackend: createGitHubBaseCacheBackend(),
    artifactBackend: createGitHubWorkflowArtifactBackend(),
    buildToolAdapterFactory: () => new GradleBuildToolAdapter(config),
  });
}

main().catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
