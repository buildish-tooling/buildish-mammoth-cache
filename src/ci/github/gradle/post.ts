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

import { createGitHubHost } from '../host';
import { runGuardedCutoffPost } from '../../../phases/finalize/preflight';

const runtimeHost = createGitHubHost();
async function main(): Promise<void> {
  await runGuardedCutoffPost(runtimeHost, async (preflight) => {
    // Importing the artifact SDK can read GITHUB_EVENT_PATH. Defer the entire graph.
    const { GradleBuildToolAdapter } = await import('../../../build-tool/gradle/adapter');
    const {
      readGradleActionInputs,
      resolveGradleActionInputsFromConfigFile,
      normalizeGradleActionConfig,
    } = await import('../../../build-tool/gradle/config');
    const { runFinalizeExecution } = await import('../../../phases/finalize/cli');
    const { readGitHubPlatformActionInputs } = await import('../action-inputs');
    const {
      createGitHubBaseCacheBackend,
      createGitHubPlatform,
      createGitHubReportSink,
      createGitHubWorkflowArtifactBackend,
    } = await import('../index');
    const ciProvider = createGitHubPlatform({
      env: process.env,
      ...readGitHubPlatformActionInputs(runtimeHost, 'gradle'),
    });
    const directInputs = readGradleActionInputs(runtimeHost);
    const rawInputs = await resolveGradleActionInputsFromConfigFile(directInputs, {
      workspace: ciProvider.context.workspace,
    });
    const config = normalizeGradleActionConfig(rawInputs, {
      phase: 'finalize',
      ciContext: ciProvider.context,
      env: process.env,
    });
    await runFinalizeExecution({
      runtimeHost,
      ciProvider,
      config,
      preflight,
      reportSink: createGitHubReportSink({ env: process.env }),
      env: process.env,
      cacheBackend: createGitHubBaseCacheBackend(),
      artifactBackend: config.readOnly ? undefined : createGitHubWorkflowArtifactBackend(),
      buildToolAdapterFactory: () => new GradleBuildToolAdapter(config),
    });
  });
}
main().catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
