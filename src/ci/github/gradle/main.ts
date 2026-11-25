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

import { GradleBuildToolAdapter } from '../../../build-tool/gradle/adapter';
import { linuxOverlayMount } from '../../../cache/streaming/overlay-mount';
import {
  readGradleActionInputs,
  resolveGradleActionInputsFromConfigFile,
  normalizeGradleActionConfig,
} from '../../../build-tool/gradle/config';
import { runStreamingPrepare } from '../../../phases/streaming/prepare';
import { gitHubStreamingFactories } from '../streaming';
import { createGitHubHost } from '../host';
import { createGitHubPlatform } from '../provider';
import type { NormalizedGradleConfig } from '../../../config/types';
import { readGitHubPlatformActionInputs } from '../action-inputs';

const runtimeHost = createGitHubHost();
const ciProvider = createGitHubPlatform({
  env: process.env,
  ...readGitHubPlatformActionInputs(runtimeHost, 'gradle'),
});

async function main(): Promise<void> {
  const directInputs = readGradleActionInputs(runtimeHost);
  const rawInputs = await resolveGradleActionInputsFromConfigFile(directInputs, {
    workspace: ciProvider.context.workspace,
  });
  const config: NormalizedGradleConfig = normalizeGradleActionConfig(rawInputs, {
    phase: 'prepare',
    ciContext: ciProvider.context,
    env: process.env,
  });

  await runStreamingPrepare({
    ...gitHubStreamingFactories(config.gradleUserHome),
    providerId: 'github',
    // Dedicated job root/completed consumers; tool inspection supplies fresh evidence.
    assertCurrent: (): undefined => {},
    runtimeHost,
    ciProvider,
    config,
    overlayMount: linuxOverlayMount(
      process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.GITHUB_ACTIONS === 'true',
    ),
    buildToolAdapterFactory: () => new GradleBuildToolAdapter(config),
  });
}

main().catch((error: unknown) => {
  runtimeHost.setFailed(error instanceof Error ? error.message : String(error));
});
