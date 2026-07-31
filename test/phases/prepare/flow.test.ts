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

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  stageDeltaArtifactPackage,
  type WorkflowArtifactDescriptor,
} from '../../../src/delta/service';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
  deserializeCacheManifest,
} from '../../../src/cache/manifest';
import { createCacheModel, type CacheModel } from '../../../src/cache/model';
import type { CiJobContext } from '../../../src/ci/types';
import type { NormalizedActionConfig, NormalizedGradleConfig } from '../../../src/config/types';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
  resolveGradleActionInputsFromConfigFile,
} from '../../../src/build-tool/gradle/config';
import {
  createPrepareActionLogLines,
  createPrepareActionOutputs,
  createPrepareActionSummaryLines,
  executePrepareAction,
  type PrepareActionStatus,
} from '../../../src/phases/prepare/flow';
import type { BootstrapExecution } from '../../../src/phases/bootstrap';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../../../src/delta/backend';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../../src/cache/backend';
import type { SummaryWriter } from '../../../src/ci/github/report-sink';
import { getPersistedCacheLifecycleRecord } from '../../../src/phases/finalize/state';
import {
  createTestGitHubProvider,
  createTestGitHubReportSink,
  createTestRuntimeHost,
} from '../../support/github-test-runtime';
import type { GradleAdapterOptions } from '../../../src/build-tool/gradle/adapter';
import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';

async function createPrepareActionDependencies(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly eventPayload: Record<string, unknown>;
  readonly summaryWriter: SummaryWriter;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly saveState?: (name: string, value: string) => void;
  readonly info?: (message: string) => void;
  readonly adapterOptions?: GradleAdapterOptions;
  readonly workspace: string;
}) {
  const runtimeHost = createTestRuntimeHost({
    inputs: options.inputs,
    saveState: options.saveState,
    info: options.info,
  });
  const ciProvider = createTestGitHubProvider(runtimeHost, {
    env: options.env,
    eventPayload: options.eventPayload,
  });

  const directInputs = readGradleActionInputs(runtimeHost);
  const rawInputs = await resolveGradleActionInputsFromConfigFile(directInputs, {
    workspace: options.workspace,
  });
  const config: NormalizedGradleConfig = normalizeGradleActionConfig(rawInputs, {
    phase: 'prepare',
    ciContext: ciProvider.context,
    env: options.env,
  });

  return {
    runtimeHost,
    ciProvider,
    config,
    reportSink: createTestGitHubReportSink(runtimeHost, {
      env: options.env,
      summaryWriter: options.summaryWriter,
    }),
    buildToolAdapterFactory: () => new GradleBuildToolAdapter(config, options.adapterOptions ?? {}),
  };
}

describe('executePrepareAction', () => {
  it('downloads dependent job deltas, applies them, and persists the pre-build manifest', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const summary = createSummaryCapture();
      const infoMessages: string[] = [];

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-build',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-delta',
      });

      const status = await executePrepareAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'buildish-tooling/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'aggregate',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          HOME: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        ...(await createPrepareActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          inputs: {
            'job-mode': 'distributed-aggregator',
            'dependent-jobs': 'worker-build',
          },
          info(message: string): void {
            infoMessages.push(message);
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(status.bootstrap.config.jobMode).toBe('distributed-aggregator');
      expect(status.dependentDeltaResult).toEqual(
        expect.objectContaining({
          appliedArtifactCount: 1,
          appliedRelativePaths: ['caches/modules-2/files-2.1/example/module.bin'],
          addedCount: 1,
          modifiedCount: 0,
          deletedCount: 0,
        }),
      );
      await expect(
        readFile(
          path.join(gradleUserHome, 'caches', 'modules-2', 'files-2.1', 'example', 'module.bin'),
          'utf8',
        ),
      ).resolves.toBe('from-worker-delta');
      expect(getPersistedCacheLifecycleRecord((name) => savedState.get(name) ?? '')).not.toBeNull();
      const lifecycleRecord = getPersistedCacheLifecycleRecord(
        (name: string) => savedState.get(name) ?? '',
      );
      expect(lifecycleRecord?.dependentDelta?.artifactNames).toEqual([
        expect.stringContaining('buildish-mammoth-cache-delta-'),
      ]);

      const manifestPath = lifecycleRecord?.preBuildManifestPath;
      expect(manifestPath).toBeTruthy();
      const persistedManifest = deserializeCacheManifest(await readFile(manifestPath!, 'utf8'));
      expect(
        persistedManifest.partitions
          .flatMap((partition) => partition.entries)
          .map((entry) => entry.relativePath),
      ).toContain('caches/modules-2/files-2.1/example/module.bin');
      const summaryText = createPrepareActionSummaryLines(status).join('\n');
      expect(summary.lines.join('\n')).toBe(summaryText);
      expect(summaryText).toContain('## Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: none');
      expect(summaryText).toContain('- Dependent delta reuse: 1 artifact(s) from 1 job(s)');
      expect(summaryText).toContain('- Pre-build manifest: persisted');
      expect(summaryText).toContain('<summary>Prepare-phase details</summary>');
      expect(summaryText).toContain('- Downloaded delta artifacts: 1');
      expect(summaryText).toContain('- Applied delta changes: 1 added, 0 modified, 0 deleted.');
      expect(summaryText).toContain('- Delta apply warnings: 0');
      expect(summaryText).toContain('- Post-job artifact cleanup scheduled: 1');
      expect(infoMessages).toEqual(
        expect.arrayContaining([
          '::group::Buildish prepare execution',
          'Bootstrap: Prepared prepare phase for push on main in distributed-aggregator mode.',
          "GitHub input 'github-token' present: no.",
          "GitHub environment 'GITHUB_TOKEN' available: no.",
          "GitHub input 'github-job-check-run-id': unset.",
          'Tool provisioning: 1 ready (0 downloaded, 1 reused).',
          `Downloaded dependent delta artifacts: ${status.dependentDeltaResult!.downloadedArtifactNames[0]}.`,
          `Persisted pre-build cache manifest to '${manifestPath}'.`,
          '::endgroup::',
        ]),
      );
      expect(createPrepareActionOutputs(status)).toEqual({
        'cache-family-key': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}$/u,
        ),
        'cache-lineage-prefix': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}-ref-main-[a-f0-9]{12}-gen-$/u,
        ),
        'cache-key': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}-ref-main-[a-f0-9]{12}-gen-$/u,
        ),
        'base-cache-restore-status': 'miss',
        'restored-cache-key': '',
        'java-major': '21',
        'job-mode': 'distributed-aggregator',
        'read-only': 'false',
        'wrapper-count': '1',
        'gradle-versions': '8.14.0',
        'wrapper-downloaded-count': '0',
        'wrapper-reused-count': '1',
        'resolved-ref-name': 'main',
        'safe-ref-name': 'main',
        'dependent-jobs-count': '1',
        'downloaded-dependent-artifact-count': '1',
        'job-name': 'aggregate',
      });
      expect(summary.writeCalls).toBe(1);
    });
  });

  it('rejects dependent delta artifacts whose cache family does not match the current job', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-build',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-delta',
        overrideCacheFamilyKey: 'mismatched-cache-family',
      });

      await expect(
        executePrepareAction({
          artifactBackend: artifactApi,
          cacheBackend: createCacheApi(),
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          ...(await createPrepareActionDependencies({
            env: {
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_REPOSITORY: 'buildish-tooling/buildish',
              GITHUB_WORKFLOW: 'CI',
              GITHUB_JOB: 'aggregate',
              GITHUB_RUN_ID: '101',
              GITHUB_RUN_ATTEMPT: '2',
              GITHUB_WORKSPACE: workspace,
              GRADLE_USER_HOME: gradleUserHome,
              HOME: workspace,
              RUNNER_OS: 'Linux',
              RUNNER_ARCH: 'X64',
              RUNNER_TEMP: path.join(workspace, 'runner-temp'),
            },
            eventPayload: {
              repository: { default_branch: 'main' },
            },
            inputs: {
              'job-mode': 'distributed-aggregator',
              'dependent-jobs': 'worker-build',
            },
            saveState(): void {},
            summaryWriter: createSummaryCapture().writer,
            workspace,
            adapterOptions: {
              fetchImpl: async (input: string | URL | Request): Promise<Response> => {
                const url = String(input);
                if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                  return new Response(`${wrapperJarSha256}\n`, { status: 200 });
                }
                if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                  return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
                }
                throw new Error(`Unexpected fetch URL: ${url}`);
              },
              verifyWrapperSignature: async () => {},
            },
          })),
        }),
      ).rejects.toThrow(/does not match the aggregator's cache family/u);
    });
  });

  it('captures pre-build state even without dependent jobs', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

      const status = await executePrepareAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'buildish-tooling/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'build',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          HOME: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        ...(await createPrepareActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'build',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(status.dependentDeltaResult).toBeNull();
      expect(status.preBuildManifestState).not.toBeNull();
      expect(
        getPersistedCacheLifecycleRecord((name: string) => savedState.get(name) ?? '')
          ?.preBuildManifestPath,
      ).toBeTruthy();
      const summaryText = createPrepareActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: none');
      expect(summaryText).toContain('- Dependent delta reuse: none');
      expect(summaryText).toContain('<summary>Prepare-phase details</summary>');
      expect(summaryText).toContain('- Downloaded delta artifacts: 0');
      expect(summaryText).toContain('- Pre-build manifest: persisted');
      expect(createPrepareActionOutputs(status)).toEqual({
        'cache-family-key': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}$/u,
        ),
        'cache-lineage-prefix': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}-ref-main-[a-f0-9]{12}-gen-$/u,
        ),
        'cache-key': expect.stringMatching(
          /^buildish-mammoth-cache-gradle-v2-21-linux-x64-[a-f0-9]{16}-ref-main-[a-f0-9]{12}-gen-$/u,
        ),
        'base-cache-restore-status': 'miss',
        'restored-cache-key': '',
        'java-major': '21',
        'job-mode': 'standalone',
        'read-only': 'false',
        'wrapper-count': '1',
        'gradle-versions': '8.14.0',
        'wrapper-downloaded-count': '0',
        'wrapper-reused-count': '1',
        'resolved-ref-name': 'main',
        'safe-ref-name': 'main',
        'dependent-jobs-count': '0',
        'downloaded-dependent-artifact-count': '0',
        'job-name': 'build',
      });
      expect(summary.writeCalls).toBe(1);
    });
  });

  it('optionally prunes active managed files and re-restores on a base-cache hit', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();
      let restoreCalls = 0;

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const managedFile = path.join(
        gradleUserHome,
        'caches',
        'modules-2',
        'files-2.1',
        'example',
        'module.bin',
      );
      await mkdir(path.dirname(managedFile), { recursive: true });
      await writeFile(managedFile, 'stale-local', 'utf8');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));

      const status = await executePrepareAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({
          matchedKeyMode: 'primary',
          onRestore: async () => {
            restoreCalls += 1;
            await mkdir(path.dirname(managedFile), { recursive: true });
            await writeFile(managedFile, `from-cache-${restoreCalls}`, 'utf8');
          },
        }),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'buildish-tooling/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'build',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          HOME: workspace,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        ...(await createPrepareActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'build',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          inputs: {
            'restore-cleanup-mode': 'prune-managed',
          },
          saveState(name: string, value: string): void {
            savedState.set(name, value);
          },
          summaryWriter: summary.writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(status.restoreCleanupResult).toEqual(
        expect.objectContaining({
          mode: 'prune-managed',
          status: 'pruned',
          deletedFileCount: 1,
        }),
      );
      expect(restoreCalls).toBe(2);
      await expect(readFile(managedFile, 'utf8')).resolves.toBe('from-cache-2');
      const summaryText = createPrepareActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish prepare execution');
      expect(summaryText).toContain('- Restore cleanup: prune-managed (1 deleted)');
      expect(summaryText).toContain('- Restore cleanup status: pruned');
      expect(summaryText).toContain('- Restore cleanup deleted files: 1');
    });
  });

  it('rejects dependent deltas produced for a different runner OS or architecture', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'windows-worker',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-delta',
        runnerOs: 'windows',
      });

      await expect(
        executePrepareAction({
          artifactBackend: artifactApi,
          cacheBackend: createCacheApi(),
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            HOME: workspace,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          ...(await createPrepareActionDependencies({
            env: {
              GITHUB_EVENT_NAME: 'push',
              GITHUB_REF: 'refs/heads/main',
              GITHUB_REPOSITORY: 'buildish-tooling/buildish',
              GITHUB_WORKFLOW: 'CI',
              GITHUB_JOB: 'aggregate',
              GITHUB_RUN_ID: '101',
              GITHUB_RUN_ATTEMPT: '2',
              GITHUB_WORKSPACE: workspace,
              GRADLE_USER_HOME: gradleUserHome,
              HOME: workspace,
              RUNNER_OS: 'Linux',
              RUNNER_ARCH: 'X64',
              RUNNER_TEMP: path.join(workspace, 'runner-temp'),
            },
            eventPayload: {
              repository: { default_branch: 'main' },
            },
            inputs: {
              'job-mode': 'distributed-aggregator',
              'dependent-jobs': 'windows-worker',
            },
            summaryWriter: createSummaryCapture().writer,
            workspace,
            adapterOptions: {
              fetchImpl: async (input: string | URL | Request): Promise<Response> => {
                const url = String(input);
                if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                  return new Response(`${wrapperJarSha256}\n`, { status: 200 });
                }
                if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                  return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
                }
                throw new Error(`Unexpected fetch URL: ${url}`);
              },
              verifyWrapperSignature: async () => {},
            },
          })),
        }),
      ).rejects.toThrow(/Cross-runner dependent delta reuse is not supported/u);
    });
  });

  it('can resolve overlapping dependent delta paths by newest mtime when configured', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-a',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-a',
        modifiedAt: new Date('2026-03-25T12:00:02.000Z'),
        accessedAt: new Date('2026-03-25T12:00:01.000Z'),
      });
      await stageWorkerDeltaArtifact(artifactApi, workspace, {
        jobName: 'worker-b',
        runId: 101,
        runAttempt: 2,
        relativePath: 'caches/modules-2/files-2.1/example/module.bin',
        contents: 'from-worker-b',
        modifiedAt: new Date('2026-03-25T12:00:06.000Z'),
        accessedAt: new Date('2026-03-25T12:00:05.000Z'),
      });

      const status = await executePrepareAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'buildish-tooling/buildish',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'aggregate',
          GITHUB_RUN_ID: '101',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_WORKSPACE: workspace,
          GRADLE_USER_HOME: gradleUserHome,
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
          HOME: workspace,
          RUNNER_TEMP: path.join(workspace, 'runner-temp'),
        },
        ...(await createPrepareActionDependencies({
          env: {
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: 'refs/heads/main',
            GITHUB_REPOSITORY: 'buildish-tooling/buildish',
            GITHUB_WORKFLOW: 'CI',
            GITHUB_JOB: 'aggregate',
            GITHUB_RUN_ID: '101',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_WORKSPACE: workspace,
            GRADLE_USER_HOME: gradleUserHome,
            RUNNER_OS: 'Linux',
            RUNNER_ARCH: 'X64',
            HOME: workspace,
            RUNNER_TEMP: path.join(workspace, 'runner-temp'),
          },
          eventPayload: {
            repository: { default_branch: 'main' },
          },
          inputs: {
            'job-mode': 'distributed-aggregator',
            'dependent-jobs': 'worker-a,worker-b',
            'allow-duplicate-dependent-delta-paths': 'true',
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(status.dependentDeltaResult).toEqual(
        expect.objectContaining({
          appliedArtifactCount: 2,
          appliedRelativePaths: ['caches/modules-2/files-2.1/example/module.bin'],
          addedCount: 1,
          modifiedCount: 0,
          deletedCount: 0,
        }),
      );
      await expect(
        readFile(
          path.join(gradleUserHome, 'caches', 'modules-2', 'files-2.1', 'example', 'module.bin'),
          'utf8',
        ),
      ).resolves.toBe('from-worker-b');
    });
  });

  it('sets restore cleanup status to skipped-no-hit when prune-managed mode is active but no cache hit occurred', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      const env = {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'buildish-tooling/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'build',
        GITHUB_RUN_ID: '101',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_WORKSPACE: workspace,
        GRADLE_USER_HOME: gradleUserHome,
        HOME: workspace,
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: path.join(workspace, 'runner-temp'),
      };

      const status = await executePrepareAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi(), // returns undefined → no cache hit
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env,
        ...(await createPrepareActionDependencies({
          env,
          eventPayload: { repository: { default_branch: 'main' } },
          inputs: { 'restore-cleanup-mode': 'prune-managed' },
          summaryWriter: createSummaryCapture().writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(status.restoreCleanupResult).toEqual(
        expect.objectContaining({
          mode: 'prune-managed',
          status: 'skipped-no-hit',
          deletedFileCount: 0,
        }),
      );
      const summaryText = createPrepareActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('- Restore cleanup: prune-managed (skipped-no-hit)');
    });
  });

  it('throws when prune-managed re-restore does not hit after deleting managed files', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );

      // The first restoreCache call returns the current lineage → current-lineage-hit,
      // which arms the prune-managed path.  The second call (re-restore after pruning) returns
      // undefined → miss, which must cause executePrepareAction to reject rather than silently
      // continue with a partially pruned cache root.
      let restoreCallCount = 0;
      const twoPhaseCacheBackend: BaseCacheBackend = {
        capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
        isFeatureAvailable(): boolean {
          return true;
        },
        async restoreCache(_paths: string[], primaryKey: string): Promise<string | undefined> {
          restoreCallCount += 1;
          return restoreCallCount === 1
            ? `${primaryKey}run-100-attempt-1-job-bbbbbbbbbbbb-bbbbbbbbbbbb`
            : undefined;
        },
        async saveCache(): Promise<number> {
          throw new Error('saveCache should not be called during main action flow');
        },
        isMissingPathsError(): boolean {
          return false;
        },
      };

      const env = {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'buildish-tooling/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'build',
        GITHUB_RUN_ID: '101',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_WORKSPACE: workspace,
        GRADLE_USER_HOME: gradleUserHome,
        HOME: workspace,
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: path.join(workspace, 'runner-temp'),
      };

      await expect(
        executePrepareAction({
          artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
          cacheBackend: twoPhaseCacheBackend,
          captureCommandOutput: async (): Promise<string> =>
            'openjdk version "21.0.4" 2024-07-16\n',
          env,
          ...(await createPrepareActionDependencies({
            env,
            eventPayload: { repository: { default_branch: 'main' } },
            inputs: { 'restore-cleanup-mode': 'prune-managed' },
            saveState(): void {},
            summaryWriter: createSummaryCapture().writer,
            workspace,
            adapterOptions: {
              fetchImpl: async (input: string | URL | Request): Promise<Response> => {
                const url = String(input);
                if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                  return new Response(`${wrapperJarSha256}\n`, { status: 200 });
                }
                if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                  return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
                }
                throw new Error(`Unexpected fetch URL: ${url}`);
              },
              verifyWrapperSignature: async () => {},
            },
          })),
        }),
      ).rejects.toThrow(/follow-up base cache restore did not hit again/u);

      expect(restoreCallCount).toBe(2);
    });
  });

  it('logs a message and continues when Gradle build hook installation fails', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const wrapperJarBytes = Buffer.from('existing-wrapper-jar');
      const wrapperJarSha256 = sha256Hex(wrapperJarBytes);

      await mkdir(path.join(workspace, 'gradle', 'wrapper'), { recursive: true });
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        wrapperJarBytes,
      );
      await writeFile(
        path.join(workspace, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
        [
          'distributionBase=GRADLE_USER_HOME',
          'distributionPath=wrapper/dists',
          'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
          'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
          'validateDistributionUrl=true',
          'zipStoreBase=GRADLE_USER_HOME',
          'zipStorePath=wrapper/dists',
          '',
        ].join('\n'),
        'utf8',
      );
      // Create a regular FILE at gradleUserHome/init.d so that mkdir(init.d, {recursive:true})
      // inside installGradleBuildResultCapture fails with EEXIST — the .catch() in
      // executePrepareAction should log a message and continue rather than propagating the error.
      await mkdir(gradleUserHome, { recursive: true });
      await writeFile(path.join(gradleUserHome, 'init.d'), 'blocked', 'utf8');

      const infoMessages: string[] = [];
      const env = {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'buildish-tooling/buildish',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'build',
        GITHUB_RUN_ID: '101',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_WORKSPACE: workspace,
        GRADLE_USER_HOME: gradleUserHome,
        HOME: workspace,
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: path.join(workspace, 'runner-temp'),
      };

      const status = await executePrepareAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi(),
        captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
        env,
        ...(await createPrepareActionDependencies({
          env,
          eventPayload: { repository: { default_branch: 'main' } },
          info(message: string): void {
            infoMessages.push(message);
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
          adapterOptions: {
            fetchImpl: async (input: string | URL | Request): Promise<Response> => {
              const url = String(input);
              if (url.endsWith('gradle-8.14-wrapper.jar.sha256')) {
                return new Response(`${wrapperJarSha256}\n`, { status: 200 });
              }
              if (url.endsWith('gradle-8.14-wrapper.jar.asc')) {
                return new Response(TEST_SIGNATURE_ARMORED, { status: 200 });
              }
              throw new Error(`Unexpected fetch URL: ${url}`);
            },
            verifyWrapperSignature: async () => {},
          },
        })),
      });

      expect(
        infoMessages.some((msg) => msg.includes('build reporting could not install capture hooks')),
      ).toBe(true);
      // Action still completes successfully despite the hook installation failure.
      expect(status.bootstrap.cacheModel).not.toBeNull();
    });
  });
});

async function stageWorkerDeltaArtifact(
  artifactApi: WorkflowArtifactBackend,
  workspace: string,
  options: {
    readonly jobName: string;
    readonly runId: number;
    readonly runAttempt: number;
    readonly relativePath: string;
    readonly contents: string;
    readonly accessedAt?: Date;
    readonly modifiedAt?: Date;
    readonly runnerOs?: string;
    readonly runnerArch?: string;
    readonly overrideCacheFamilyKey?: string;
  },
): Promise<void> {
  const workerGradleHome = path.join(workspace, `${options.jobName}-gradle-home`);
  await mkdir(path.dirname(path.join(workerGradleHome, options.relativePath)), { recursive: true });

  const cacheModel = await createTestCacheModel(
    workerGradleHome,
    options.runnerOs ?? 'linux',
    options.runnerArch ?? 'x64',
  );
  const previousManifest = await captureCacheManifest(cacheModel);
  await writeFile(path.join(workerGradleHome, options.relativePath), options.contents, 'utf8');
  if (options.accessedAt || options.modifiedAt) {
    const modifiedAt = options.modifiedAt ?? options.accessedAt ?? new Date();
    const accessedAt = options.accessedAt ?? modifiedAt;
    await utimes(path.join(workerGradleHome, options.relativePath), accessedAt, modifiedAt);
  }
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    createCiContext(
      options.jobName,
      workspace,
      options.runId,
      options.runAttempt,
      options.runnerOs ?? 'linux',
      options.runnerArch ?? 'x64',
    ),
    options.overrideCacheFamilyKey
      ? {
          ...cacheModel,
          cacheFamilyKey: options.overrideCacheFamilyKey,
          currentRefLineagePrefix: `${options.overrideCacheFamilyKey}-ref-main-test-gen-`,
        }
      : cacheModel,
    deltaManifest,
    {
      lifecycleIdentity: {
        restoredGenerationKey: null,
        preBuildManifestDigest: calculateCanonicalCacheManifestDigest(previousManifest),
      },
    },
  );

  await artifactApi.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
  );
}

async function createTestCacheModel(
  gradleUserHome: string,
  runnerOs = 'linux',
  runnerArch = 'x64',
): Promise<CacheModel> {
  const config = createTestConfig(gradleUserHome);
  return createCacheModel(
    config,
    createCiContext('worker', gradleUserHome, 1, 1, runnerOs, runnerArch),
    new GradleBuildToolAdapter(config),
    {
      captureCommandOutput: async (): Promise<string> => 'openjdk version "21.0.4" 2024-07-16\n',
    },
  );
}

function createTestConfig(gradleUserHome: string): NormalizedGradleConfig {
  return {
    phase: 'prepare',
    baseDirectory: '.',
    cacheEnabled: true,
    readOnly: false,
    jobMode: 'standalone',
    dependentJobs: [],
    allowDuplicateDependentDeltaPaths: false,
    cacheKeyPrefix: 'buildish-mammoth-cache-',
    cachePartitions: [],
    cacheSchemaVersion: 2,
    wrapperSelectionMode: 'default',
    wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
    defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
    wrapperPropertiesFiles: [],
    cleanupEnabled: true,
    restoreCleanupMode: 'none',
    cacheGcMode: 'off',
    cacheGcOlderThanDays: 14,
    gradleUserHome,
  };
}

function createCiContext(
  jobName: string,
  workspace: string,
  runId: number,
  runAttempt: number,
  runnerOs = 'linux',
  runnerArch = 'x64',
): CiJobContext {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs,
    runnerArch,
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'buildish-tooling/buildish',
    workflowName: 'CI',
    jobName,
    runId,
    runAttempt,
    sourceRevision: null,
    tempDirectory: null,
    workspace,
    actionPath: null,
  };
}

function createCacheApi(
  options: {
    readonly matchedKeyMode?: 'miss' | 'primary';
    readonly onRestore?: () => Promise<void>;
  } = {},
): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return true;
    },
    async restoreCache(_paths: string[], primaryKey: string): Promise<string | undefined> {
      await options.onRestore?.();
      return options.matchedKeyMode === 'primary'
        ? `${primaryKey}run-100-attempt-1-job-bbbbbbbbbbbb-bbbbbbbbbbbb`
        : undefined;
    },
    async saveCache(): Promise<number> {
      throw new Error('saveCache should not be called during main action flow');
    },
    isMissingPathsError(): boolean {
      return false;
    },
  };
}

function createSummaryCapture(): {
  readonly lines: string[];
  readonly writer: SummaryWriter;
  get writeCalls(): number;
} {
  const lines: string[] = [];
  let writeCalls = 0;
  const writer: SummaryWriter = {
    addRaw(text: string): SummaryWriter {
      lines.push(text);
      return writer;
    },
    async write(): Promise<void> {
      writeCalls += 1;
    },
  };

  return {
    lines,
    writer,
    get writeCalls(): number {
      return writeCalls;
    },
  };
}

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-main-flow-'));
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

class FakeArtifactApi implements WorkflowArtifactBackend {
  readonly capabilities = STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES;

  private nextId = 1;
  private readonly artifacts = new Map<
    number,
    { descriptor: WorkflowArtifactDescriptor; directory: string }
  >();

  constructor(private readonly storageRoot: string) {}

  async uploadArtifact(
    name: string,
    _files: readonly string[],
    rootDirectory: string,
    _options?: { readonly retentionDays?: number; readonly compressionLevel?: number },
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });

    const descriptor: WorkflowArtifactDescriptor = {
      id,
      name,
      size: 0,
      digest: null,
    };
    this.artifacts.set(id, { descriptor, directory });
    return descriptor;
  }

  async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
    return [...this.artifacts.values()].map((artifact) => artifact.descriptor);
  }

  async getArtifact(name: string): Promise<WorkflowArtifactDescriptor> {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    return artifact.descriptor;
  }

  async downloadArtifact(
    artifactId: number,
    options?: { readonly path?: string; readonly expectedHash?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });

    return {
      downloadPath,
      digestMismatch: false,
    };
  }

  async deleteArtifact(name: string): Promise<void> {
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    this.artifacts.delete(artifact[0]);
  }
}

const TEST_SIGNATURE_ARMORED = `-----BEGIN PGP SIGNATURE-----
Version: test

ZmFrZQ==
=abcd
-----END PGP SIGNATURE-----`;

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// Unit tests for createPrepareActionSummaryLines and createPrepareActionLogLines.
//
// These tests exercise the formatting logic in isolation using minimal
// PrepareActionStatus fixtures so regressions in icons, counters, or wording
// are caught without running the full executePrepareAction integration flow.
// ---------------------------------------------------------------------------

/**
 * Builds a fully-typed {@link BootstrapExecution} stub for use in rendering-only unit tests.
 *
 * All fields required by {@link createPrepareActionLogLines} (via {@link createBootstrapLogLines})
 * are given concrete values. Fields that are never accessed by the rendering functions under test
 * (`ciProvider`, `reportSink`) are null-asserted to the correct type with an explanatory comment;
 * any newly accessed field will surface as a compile error rather than a silent runtime failure.
 */
function createMinimalPrepareBootstrapExecution(): BootstrapExecution {
  return {
    phase: 'prepare',
    message: 'Prepared prepare phase for push on main in standalone mode.',
    config: {
      jobMode: 'standalone',
      readOnly: false,
      cacheEnabled: true,
      dependentJobs: [],
    } as unknown as NormalizedActionConfig,
    ciContext: {
      eventName: 'push',
      resolvedRefName: 'main',
      safeRefName: 'main',
      runnerOs: 'linux',
      runnerArch: 'x64',
      defaultBranch: 'main',
      isPullRequest: false,
      repository: 'buildish-tooling/buildish',
      workflowName: 'CI',
      jobName: 'build',
      runId: 1,
      runAttempt: 1,
      sourceRevision: null,
      tempDirectory: '/tmp',
      workspace: '/workspace',
      actionPath: null,
    },
    cacheModel: null,
    baseCacheResult: null,
    toolProvisioning: { items: [], warnings: [], additionalOutputs: {} },
    ciDiagnosticsLines: [],
    ciExecutionUrls: { jobUrl: null, workflowRunUrl: null },
    buildToolAdapter: { getName: () => 'Gradle' } as BootstrapExecution['buildToolAdapter'],
    // ciProvider and reportSink are never accessed by the rendering functions under test.
    ciProvider: null as unknown as BootstrapExecution['ciProvider'],
    reportSink: null as unknown as BootstrapExecution['reportSink'],
  };
}

/**
 * Builds the minimum {@link PrepareActionStatus} fixture required by
 * {@link createPrepareActionSummaryLines} and {@link createPrepareActionLogLines}.
 * Apply `overrides` to exercise specific rendering paths.
 */
function createMinimalPrepareStatus(
  overrides: Partial<PrepareActionStatus> = {},
): PrepareActionStatus {
  return {
    bootstrap: createMinimalPrepareBootstrapExecution(),
    restoreCleanupResult: null,
    dependentDeltaResult: null,
    preBuildManifestState: null,
    message: 'Test.',
    ...overrides,
  };
}

describe('createPrepareActionOutputs', () => {
  it('uses the canonical Java 0 identity when Java is unavailable', () => {
    const bootstrap = createMinimalPrepareBootstrapExecution();
    const status = createMinimalPrepareStatus({
      bootstrap: {
        ...bootstrap,
        cacheModel: {
          javaMajor: null,
          cacheFamilyKey: 'test-family-v2-0-linux-x64-layout',
          currentRefLineagePrefix: 'test-family-v2-0-linux-x64-layout-ref-main-gen-',
          cacheKey: 'test-family-v2-0-linux-x64-layout-ref-main-gen-',
        } as unknown as CacheModel,
      },
    });

    expect(createPrepareActionOutputs(status)['java-major']).toBe('0');
  });
});

describe('createPrepareActionSummaryLines', () => {
  it('includes the top-level heading', () => {
    const text = createPrepareActionSummaryLines(createMinimalPrepareStatus()).join('\n');
    expect(text).toContain('## Buildish prepare execution');
  });

  it('shows "none" for restore cleanup when restoreCleanupResult is null', () => {
    const text = createPrepareActionSummaryLines(createMinimalPrepareStatus()).join('\n');
    expect(text).toContain('- Restore cleanup: none');
  });

  it('shows prune-managed status with deleted file count when cleanup was pruned', () => {
    const text = createPrepareActionSummaryLines(
      createMinimalPrepareStatus({
        restoreCleanupResult: {
          mode: 'prune-managed',
          status: 'pruned',
          deletedFileCount: 5,
          message: 'Pruned 5 managed file(s).',
        },
      }),
    ).join('\n');
    expect(text).toContain('- Restore cleanup: prune-managed (5 deleted)');
    // escapeSummaryText escapes the hyphen in 'prune-managed', so the details section renders
    // 'prune\-managed' (Markdown escape) rather than the raw mode string.
    expect(text).toContain('- Restore cleanup mode: prune\\-managed');
    expect(text).toContain('- Restore cleanup status: pruned');
    expect(text).toContain('- Restore cleanup deleted files: 5');
  });

  it('shows "none" for dependent delta when dependentDeltaResult is null', () => {
    const text = createPrepareActionSummaryLines(createMinimalPrepareStatus()).join('\n');
    expect(text).toContain('- Dependent delta reuse: none');
  });

  it('shows artifact and job counts in the dependent delta reuse line', () => {
    const text = createPrepareActionSummaryLines(
      createMinimalPrepareStatus({
        dependentDeltaResult: {
          requestedJobs: ['worker-a', 'worker-b'],
          downloadedArtifactNames: ['artifact-a', 'artifact-b'],
          appliedRelativePaths: [],
          appliedArtifactCount: 2,
          message: 'Applied 2.',
          cacheRoot: '/tmp/.gradle',
          addedCount: 3,
          modifiedCount: 1,
          deletedCount: 0,
          warnings: [],
        },
      }),
    ).join('\n');
    expect(text).toContain('- Dependent delta reuse: 2 artifact(s) from 2 job(s)');
    expect(text).toContain('- Applied delta changes: 3 added, 1 modified, 0 deleted.');
  });

  it('shows "persisted" or "not persisted" for the pre-build manifest line', () => {
    const withManifest = createPrepareActionSummaryLines(
      createMinimalPrepareStatus({
        preBuildManifestState: {
          manifestPath: '/tmp/manifest.json',
          manifestDigest: 'a'.repeat(64),
        },
      }),
    ).join('\n');
    expect(withManifest).toContain('- Pre-build manifest: persisted');

    const withoutManifest = createPrepareActionSummaryLines(createMinimalPrepareStatus()).join(
      '\n',
    );
    expect(withoutManifest).toContain('- Pre-build manifest: not persisted');
  });
});

describe('createPrepareActionLogLines', () => {
  it('begins with a bootstrap summary line', () => {
    const lines = createPrepareActionLogLines(createMinimalPrepareStatus());
    expect(lines[0]).toContain('Bootstrap:');
  });

  it('contains "Restore cleanup: none." when restoreCleanupResult is null', () => {
    const text = createPrepareActionLogLines(createMinimalPrepareStatus()).join('\n');
    expect(text).toContain('Restore cleanup: none.');
  });

  it('appends the restoreCleanupResult message when cleanup was performed', () => {
    const text = createPrepareActionLogLines(
      createMinimalPrepareStatus({
        restoreCleanupResult: {
          mode: 'prune-managed',
          status: 'pruned',
          deletedFileCount: 2,
          message: 'Pruned 2 managed file(s) and re-restored.',
        },
      }),
    ).join('\n');
    expect(text).toContain('Pruned 2 managed file(s) and re-restored.');
  });

  it('lists configured dependent job names when dependentDeltaResult is present', () => {
    const text = createPrepareActionLogLines(
      createMinimalPrepareStatus({
        dependentDeltaResult: {
          requestedJobs: ['worker-a', 'worker-b'],
          downloadedArtifactNames: ['artifact-a'],
          appliedRelativePaths: [],
          appliedArtifactCount: 1,
          message: 'Applied 1.',
          cacheRoot: '/tmp/.gradle',
          addedCount: 1,
          modifiedCount: 0,
          deletedCount: 0,
          warnings: [],
        },
      }),
    ).join('\n');
    expect(text).toContain('Configured dependent jobs: worker-a, worker-b.');
    expect(text).toContain('Downloaded dependent delta artifacts: artifact-a.');
  });

  it('omits dependent-job and artifact lines when dependentDeltaResult is null', () => {
    const text = createPrepareActionLogLines(createMinimalPrepareStatus()).join('\n');
    expect(text).not.toContain('Configured dependent jobs');
    expect(text).not.toContain('Downloaded dependent delta artifacts');
  });

  it('includes the persisted manifest path when preBuildManifestState is set', () => {
    const text = createPrepareActionLogLines(
      createMinimalPrepareStatus({
        preBuildManifestState: {
          manifestPath: '/tmp/runner/manifest.json',
          manifestDigest: 'a'.repeat(64),
        },
      }),
    ).join('\n');
    expect(text).toContain("Persisted pre-build cache manifest to '/tmp/runner/manifest.json'.");
  });
});
