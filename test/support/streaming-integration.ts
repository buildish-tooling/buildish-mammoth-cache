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

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
  resolveGradleActionInputsFromConfigFile,
} from '../../src/build-tool/gradle/config';
import { createGradleLifecycle } from '../../src/build-tool/gradle/lifecycle';
import { MavenBuildToolAdapter } from '../../src/build-tool/maven/adapter';
import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
  resolveMavenActionInputsFromConfigFile,
} from '../../src/build-tool/maven/config';
import type { BaseCacheBackend } from '../../src/cache/backend';
import type { WorkflowArtifactBackend } from '../../src/delta/backend';
import type { OverlayMountDriver } from '../../src/cache/streaming/overlay-mount';
import { createGitHubPlatform } from '../../src/ci/github';
import { gitHubStreamingFactories } from '../../src/ci/github/streaming';
import { runStreamingPrepare } from '../../src/phases/streaming/prepare';
import { runStreamingPost } from '../../src/phases/streaming/post';
import { createTestRuntimeHost } from './github-test-runtime';

export async function streamingIntegrationJob(options: {
  root: string;
  home?: string;
  tool: 'gradle' | 'maven';
  name: string;
  inputs?: Record<string, string>;
  cache?: BaseCacheBackend;
  artifacts?: WorkflowArtifactBackend;
  now?: () => number;
  installedGradle?: string;
  overlayMount?: OverlayMountDriver;
}) {
  const { root, tool, name } = options;
  const home = options.home ?? path.join(root, 'home');
  const workspace = path.join(root, 'project');
  const temp = path.join(root, 'temp');
  for (const directory of [home, workspace, temp]) {
    await mkdir(directory, { recursive: true });
  }
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'fixtures/mammoth',
    GITHUB_WORKFLOW: 'Local integration',
    GITHUB_JOB: name,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temp,
    GRADLE_USER_HOME: home,
    MAVEN_USER_HOME: home,
  };
  const state = new Map<string, string>();
  const outputs: Record<string, string> = {};
  const warnings: string[] = [];
  const summaries: string[] = [];
  const runtimeHost = createTestRuntimeHost({
    environment: env,
    inputs: {
      'read-only': 'false',
      'cache-gc-mode': 'off',
      'process-all-wrapper-files': 'true',
      ...options.inputs,
    },
    getState: (key) => state.get(key) ?? '',
    saveState: (key, value) => void state.set(key, value),
    setOutput: (key, value) => {
      outputs[key] = String(value);
    },
    warning: (message) => warnings.push(message),
  });
  const ciProvider = createGitHubPlatform({
    env,
    eventPayload: { repository: { default_branch: 'main' } },
  });
  const configOptions = { phase: 'prepare' as const, ciContext: ciProvider.context, env };
  const configFile = { workspace };
  async function configured() {
    if (tool === 'gradle') {
      const raw = await resolveGradleActionInputsFromConfigFile(
        readGradleActionInputs(runtimeHost),
        configFile,
      );
      const config = normalizeGradleActionConfig(raw, configOptions);
      const adapter = new GradleBuildToolAdapter(config);
      if (options.installedGradle) {
        adapter.provision = async () => ({ items: [], warnings: [], additionalOutputs: {} });
      }
      return { config, buildToolAdapterFactory: () => adapter };
    }
    const raw = await resolveMavenActionInputsFromConfigFile(
      readMavenActionInputs(runtimeHost),
      configFile,
    );
    const config = normalizeMavenActionConfig(raw, configOptions);
    return { config, buildToolAdapterFactory: () => new MavenBuildToolAdapter(config) };
  }
  const factories = gitHubStreamingFactories();
  const shared = {
    runtimeHost,
    assertCurrent: (): undefined => undefined,
    cacheBackend: async () => {
      assert(options.cache, 'Unexpected cache backend use');
      return options.cache;
    },
    artifactBackend: async () => {
      assert(options.artifacts, 'Unexpected artifact backend use');
      return options.artifacts;
    },
    reportSink: async () => ({
      publishLogGroup(_title: string, lines: readonly string[], write: (line: string) => void) {
        lines.forEach(write);
      },
      async publishSummary(lines: readonly string[]) {
        summaries.push(...lines);
      },
      async replaceSummary(lines: readonly string[]) {
        summaries.splice(0, summaries.length, ...lines);
      },
    }),
    now: options.now,
    overlayMount: options.overlayMount,
    // These fixtures wait for each no-daemon child before post. CI can run unrelated
    // integration builds concurrently. The native quiescence suites verify inspection separately.
    lifecycle:
      tool === 'gradle'
        ? async () =>
            createGradleLifecycle({
              inspect: async () => ({ remaining: false, uncertain: false }),
            })
        : undefined,
  };
  return {
    home,
    workspace,
    env,
    outputs,
    warnings,
    summaries,
    async prepare() {
      return runStreamingPrepare({
        ...shared,
        ...(await configured()),
        providerId: 'github',
        ciProvider,
      });
    },
    async post() {
      return runStreamingPost({ ...factories, ...shared });
    },
  };
}
