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

import { MavenBuildToolAdapter } from '../../../build-tool/maven/adapter';
import {
  readMavenActionInputs,
  resolveMavenActionInputsFromConfigFile,
  normalizeMavenActionConfig,
} from '../../../build-tool/maven/config';
import { runPrepareExecution } from '../../../phases/prepare/cli';
import type { NormalizedMavenConfig } from '../../../config/types';
import { readGitHubPlatformActionInputs } from '../action-inputs';

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
  ...readGitHubPlatformActionInputs(runtimeHost, 'maven'),
});
const reportSink = createGitHubReportSink({ env: process.env });

async function main(): Promise<void> {
  const directInputs = readMavenActionInputs(runtimeHost);
  const rawInputs = await resolveMavenActionInputsFromConfigFile(directInputs, {
    workspace: ciProvider.context.workspace,
  });
  const config: NormalizedMavenConfig = normalizeMavenActionConfig(rawInputs, {
    phase: 'prepare',
    ciContext: ciProvider.context,
    env: process.env,
  });

  await runPrepareExecution({
    runtimeHost,
    ciProvider,
    reportSink,
    config,
    env: process.env,
    cacheBackend: createGitHubBaseCacheBackend(),
    artifactBackend: config.readOnly ? undefined : createGitHubWorkflowArtifactBackend(),
    buildToolAdapterFactory: () => new MavenBuildToolAdapter(config),
  });
}

main().catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
