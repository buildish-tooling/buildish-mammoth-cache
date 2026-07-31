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

import { cp } from 'node:fs/promises';
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  downloadAndVerifyDeltaArtifactPackage,
  stageDeltaArtifactPackage,
  type WorkflowArtifactDescriptor,
} from '../../../src/delta/service';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
} from '../../../src/cache/manifest';
import { createCacheModel, type CacheModel } from '../../../src/cache/model';
import {
  createFinalizeActionLogLines,
  createFinalizeActionSummaryLines,
  executeFinalizeAction,
  formatByteCount,
  type FinalizeActionStatus,
} from '../../../src/phases/finalize/flow';
import type { BootstrapExecution } from '../../../src/phases/bootstrap';
import type { NormalizedActionConfig } from '../../../src/config/types';
import type { SummaryWriter } from '../../../src/ci/github/report-sink';
import {
  CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
  getPersistedCacheLifecycleRecord,
  persistCacheLifecycleRecord,
  persistPreBuildCacheManifest,
  type PersistedCacheLifecycleRecord,
} from '../../../src/phases/finalize/state';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../../../src/delta/backend';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../../src/cache/backend';
import {
  createTestGitHubProvider,
  createTestGitHubReportSink,
  createTestRuntimeHost,
} from '../../support/github-test-runtime';
import type { GradleAdapterOptions } from '../../../src/build-tool/gradle/adapter';
import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../../src/config/types';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
  resolveGradleActionInputsFromConfigFile,
} from '../../../src/build-tool/gradle/config';

// ---------------------------------------------------------------------------
// Shared fixture helpers shared by the executeFinalizeAction integration tests.
// ---------------------------------------------------------------------------

/**
 * Standard GitHub push-event payload used by most integration tests.
 * Providing it as a named constant avoids repeating the 3-line inline object literal.
 */
const DEFAULT_PUSH_EVENT_PAYLOAD = {
  repository: { default_branch: 'main' },
} as const;

/**
 * Stub Java-version command output returned by all finalize integration tests.
 * The value matches the exact string the real JVM produces so downstream parsing is exercised.
 */
const MOCK_CAPTURE_COMMAND_OUTPUT = async (): Promise<string> =>
  'openjdk version "21.0.4" 2024-07-16\n';

/**
 * Returns the lifecycle-state callback used by most finalize integration tests.
 */
function createLifecycleGetState(
  savedState: Map<string, string> = new Map(),
): (name: string) => string {
  return (name: string) => savedState.get(name) ?? '';
}

async function createFinalizeActionDependencies(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly eventPayload?: Record<string, unknown>;
  readonly summaryWriter: SummaryWriter;
  readonly inputProvider: { getInput(name: string): string };
  readonly getState?: (name: string) => string;
  readonly info?: (message: string) => void;
  readonly adapterOptions?: GradleAdapterOptions;
  readonly workspace: string;
}) {
  const runtimeHost = createTestRuntimeHost({
    getInput(name: string): string {
      return options.inputProvider.getInput(name);
    },
    getState: options.getState,
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
    phase: 'finalize',
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

describe('executeFinalizeAction', () => {
  it('uploads a delta artifact for distributed-worker jobs when cache contents changed', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'distributed-worker' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          addedCount: 0,
          modifiedCount: 1,
          deletedCount: 0,
          totalChangedCount: 1,
        }),
      );

      const artifacts = await artifactApi.listArtifacts();
      expect(artifacts).toHaveLength(1);
      expect(artifactApi.uploadRetentionDays).toEqual([7]);
      const downloaded = await downloadAndVerifyDeltaArtifactPackage(artifactApi, artifacts[0]);
      expect(downloaded.metadata.producer.jobName).toBe('worker-build');
      expect(downloaded.metadata.producer.runId).toBe(101);
      expect(
        downloaded.deltaManifest.partitions.some((partition) => partition.entries.length > 0),
      ).toBe(true);
      expect(summary.lines).toEqual([]);
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('Gradle builds');
      expect(summaryText).not.toContain('<summary>Cache details</summary>');
      expect(summaryText).toContain('Delta artifact');
      expect(summary.writeCalls).toBe(0);
      await rm(downloaded.downloadDirectory, { recursive: true, force: true });
    });
  });

  it('reuses the persisted main-phase execution identity when post-phase job metadata drifts', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) => ({
        ...record,
        executionIdentity: {
          jobName: 'worker_a',
          runId: 101,
          runAttempt: 2,
        },
      }));
      expect(getPersistedCacheLifecycleRecord(createLifecycleGetState(savedState))).not.toBeNull();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'post-phase-job-name'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'post-phase-job-name'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          artifactName: expect.stringMatching(
            /^buildish-mammoth-cache-delta-worker_a-[a-f0-9]{8}-run-101-attempt-2-/u,
          ),
        }),
      );

      const artifacts = await artifactApi.listArtifacts();
      expect(artifacts).toHaveLength(1);
      const downloaded = await downloadAndVerifyDeltaArtifactPackage(artifactApi, artifacts[0]);
      expect(downloaded.metadata.producer.jobName).toBe('worker_a');
      expect(downloaded.metadata.producer.runId).toBe(101);
      expect(downloaded.metadata.producer.runAttempt).toBe(2);
      await rm(downloaded.downloadDirectory, { recursive: true, force: true });
    });
  });

  it('renders the final post-action report layout and logs grouped details', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const infoMessages: string[] = [];

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) => ({
        ...record,
        restoreResult: {
          ...record.restoreResult,
          status: 'current-lineage-hit',
          matchedKey: `${record.currentRefLineagePrefix}run-1-attempt-1-job-aaaaaaaaaaaa-bbbbbbbbbbbb`,
          matchedLineagePrefix: record.currentRefLineagePrefix,
          message: 'Restored cache using exact key hit.',
        },
      }));
      await writeCapturedBuildResult(path.join(workspace, 'runner-temp'), {
        invocationKey: 'build-1',
        rootProjectName: 'platform',
        requestedTasks: 'build --scan',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        configCacheHit: true,
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
      });
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker', '987654321'),
          info(message: string): void {
            infoMessages.push(message);
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      const publishedSummary = await readFile(path.join(workspace, 'step-summary.md'), 'utf8');
      const summaryContent = createFinalizeActionSummaryLines(status).join('\n');
      expect(publishedSummary).toBe(`${summaryContent}\n`);
      expect(summaryContent).toContain('## Buildish Mammoth Cache for Gradle');
      expect(summaryContent).toContain(
        '### <a href="https://github.com/buildish-tooling/buildish/actions/runs/101/job/987654321">Gradle builds</a>',
      );
      expect(summaryContent).toContain('Gradle 8\\.14\\.3 / Java 21\\.0\\.4');
      expect(summaryContent).not.toContain('<summary>Cache details</summary>');
      expect(summaryContent).not.toContain('Pulled base cache');
      expect(summaryContent).toContain('Delta artifact');
      expect(summaryContent).not.toContain('Uploaded base cache');
      expect(summaryContent).not.toContain('manifest-derived, uncompressed content sizes');
      expect(summaryContent).not.toContain('### Warnings');
      expect(summaryContent).not.toContain('### Errors');
      expect(infoMessages).toEqual(
        expect.arrayContaining([
          '::group::Buildish Mammoth Cache for Gradle',
          'Bootstrap: Prepared finalize phase for push on main in distributed-worker mode.',
          'Base cache restore: current-lineage-hit.',
          'Delta artifact: uploaded.',
          'Execution details: https://github.com/buildish-tooling/buildish/actions/runs/101/job/987654321',
          'Cache partition statistics (manifest-derived, uncompressed content sizes):',
          expect.stringContaining("Uploaded delta artifact 'buildish-mammoth-cache-delta-"),
          "Gradle 8.14.3 SUCCESS (config-cache hit) tasks='build --scan' project='platform' scan=https://scans.gradle.com/s/local-it-published",
          '::endgroup::',
        ]),
      );
    });
  });

  it('falls back to the workflow run URL when the current job URL cannot be resolved', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      const status = await executeFinalizeAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      const summaryContent = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryContent).toContain('Gradle builds');
      expect(summaryContent).not.toContain('Workflow run:');
    });
  });

  it('skips artifact upload for standalone jobs even when cache contents changed', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({
          saveCache: async () => {
            saveCalls += 1;
            return 77;
          },
        }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('standalone'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(saveCalls).toBe(1);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'not-distributed-worker',
          modifiedCount: 1,
          totalChangedCount: 1,
        }),
      );
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('Gradle builds');
      expect(summaryText).not.toContain('Delta artifact');
      expect(summaryText).not.toContain('Post-build cache delta');
      expect(summary.writeCalls).toBe(0);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(0);
    });
  });

  it('does not publish a duplicate generation for an unchanged current-lineage hit', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'unchanged',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, withCurrentLineageHit);

      const status = await executeFinalizeFixture({
        workspace,
        gradleUserHome,
        savedState,
        jobMode: 'standalone',
        jobName: 'build',
        saveCache: async () => {
          saveCalls += 1;
          return 77;
        },
      });

      expect(saveCalls).toBe(0);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'not-required', generationKey: null }),
      );
      expect(createFinalizeActionSummaryLines(status).join('\n')).not.toContain(
        'Published generation:',
      );
    });
  });

  it('publishes an initial non-empty generation after a restore miss', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      const status = await executeFinalizeFixture({
        workspace,
        gradleUserHome,
        savedState,
        jobMode: 'standalone',
        jobName: 'build',
        saveCache: async () => {
          saveCalls += 1;
          return 78;
        },
      });

      expect(saveCalls).toBe(1);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved', cacheId: 78 }),
      );
    });
  });

  it('uses the persisted prepare-phase generation seed when publishing', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) => ({
        ...record,
        plannedGenerationId: 'uuid-persisted-prepare-seed',
      }));

      const status = await executeFinalizeFixture({
        workspace,
        gradleUserHome,
        savedState,
        jobMode: 'standalone',
        jobName: 'build',
        saveCache: async () => 79,
      });

      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({
          status: 'saved',
          generationKey: expect.stringContaining('-gen-uuid-persisted-prepare-seed-'),
        }),
      );
    });
  });

  it('rejects prepare/finalize cache-family drift before attempting a save', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) => ({
        ...record,
        cacheFamilyKey: `${record.cacheFamilyKey}-drifted`,
        restoreResult: {
          ...record.restoreResult,
          cacheFamilyKey: `${record.cacheFamilyKey}-drifted`,
        },
      }));

      await expect(
        executeFinalizeFixture({
          workspace,
          gradleUserHome,
          savedState,
          jobMode: 'standalone',
          jobName: 'build',
          saveCache: async () => {
            saveCalls += 1;
            return 80;
          },
        }),
      ).rejects.toThrow(/configuration drift.*cache family/u);
      expect(saveCalls).toBe(0);
    });
  });

  it('rejects a pre-build manifest whose digest no longer matches lifecycle state', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) => ({
        ...record,
        preBuildManifestDigest: 'b'.repeat(64),
      }));

      await expect(
        executeFinalizeFixture({
          workspace,
          gradleUserHome,
          savedState,
          jobMode: 'standalone',
          jobName: 'build',
          saveCache: async () => {
            saveCalls += 1;
            return 81;
          },
        }),
      ).rejects.toThrow(/manifest does not match the digest/u);
      expect(saveCalls).toBe(0);
    });
  });

  it('reports standalone save failures as warnings without claiming publication', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      const status = await executeFinalizeFixture({
        workspace,
        gradleUserHome,
        savedState,
        jobMode: 'standalone',
        jobName: 'build',
        saveCache: async () => {
          throw new Error('backend unavailable');
        },
      });

      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'failed', cacheId: null }),
      );
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      const logText = createFinalizeActionLogLines(status).join('\n');
      expect(summaryText).toContain('⚠️ Overall status: completed with warnings');
      expect(summaryText).toContain('- Save status: failed');
      expect(summaryText).toContain('### Warnings');
      expect(summaryText).toContain('backend unavailable');
      expect(summaryText).not.toContain('Published generation:');
      expect(logText).toContain('Attempted base cache generation:');
      expect(logText).not.toContain('Published base cache generation:');
    });
  });

  it('fails an aggregator when its required base-cache publication fails', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      await expect(
        executeFinalizeFixture({
          workspace,
          gradleUserHome,
          savedState,
          jobMode: 'distributed-aggregator',
          jobName: 'aggregate',
          saveCache: async () => {
            throw new Error('backend unavailable');
          },
        }),
      ).rejects.toThrow(
        /publication ended with 'failed'.*publication failed.*backend unavailable/u,
      );
    });
  });

  it('fails an aggregator when the backend declines to create the required generation', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      await expect(
        executeFinalizeFixture({
          workspace,
          gradleUserHome,
          savedState,
          jobMode: 'distributed-aggregator',
          jobName: 'aggregate',
          saveCache: async () => -1,
        }),
      ).rejects.toThrow(/publication ended with 'not-saved'/u);
    });
  });

  it('skips artifact upload for distributed-aggregator jobs and still saves the base cache', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      let saveCalls = 0;
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'after',
      );
      await stageWorkerArtifactForCleanup(artifactApi, workspace, 'worker-build');
      const artifactNameToDelete = (await artifactApi.listArtifacts())[0]!.name;
      replaceLifecycleRecord(savedState, (record) =>
        withConsumedArtifacts(record, [artifactNameToDelete]),
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({
          saveCache: async () => {
            saveCalls += 1;
            return 91;
          },
        }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-aggregator'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(saveCalls).toBe(1);
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved' }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'not-distributed-worker',
          modifiedCount: 1,
          totalChangedCount: 1,
        }),
      );
      expect(status.consumedDeltaCleanupResult).toEqual(
        expect.objectContaining({
          attemptedArtifactNames: [artifactNameToDelete],
          deletedArtifactNames: [artifactNameToDelete],
          warnings: [],
        }),
      );
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish Mammoth Cache for Gradle');
      expect(summaryText).not.toContain('<summary>Cache details</summary>');
      expect(summaryText).not.toContain('Consumed delta cleanup');
      expect(summaryText).not.toContain('Delta artifact');
      expect(summaryText).not.toContain('Post-build cache delta');
      expect(summary.writeCalls).toBe(0);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(0);
    });
  });

  it('runs timestamp cache GC before saving the standalone base cache', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const staleRelativePath = 'caches/modules-2/files-2.1/org/example/stale.bin';
      const stalePath = path.join(gradleUserHome, staleRelativePath);
      let stalePresentWhenSaving = true;

      await writeGradleFile(gradleUserHome, staleRelativePath, 'stale');
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await utimes(
        stalePath,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      );

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({
          saveCache: async () => {
            stalePresentWhenSaving = await pathExists(stalePath);
            return 82;
          },
        }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('standalone'),
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.cacheGcResult).toEqual(
        expect.objectContaining({
          deletedFileCount: 1,
          deletedByteCount: 5,
        }),
      );
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'not-distributed-worker',
          deletedCount: 1,
          totalChangedCount: 1,
        }),
      );
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'saved', cacheId: 82 }),
      );
      expect(stalePresentWhenSaving).toBe(false);
      await expect(pathExists(stalePath)).resolves.toBe(false);
    });
  });

  it('honors cleanup-enabled=false by skipping timestamp cache GC', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();
      const staleRelativePath = 'caches/modules-2/files-2.1/org/example/stale.bin';
      const stalePath = path.join(gradleUserHome, staleRelativePath);

      await writeGradleFile(gradleUserHome, staleRelativePath, 'stale');
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await utimes(
        stalePath,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      );

      const status = await executeFinalizeAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi({ saveCache: async () => 83 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: {
            getInput(name: string): string {
              if (name === 'cleanup-enabled') return 'false';
              return '';
            },
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.cacheGcResult).toBeNull();
      await expect(pathExists(stalePath)).resolves.toBe(true);
    });
  });

  it('skips timestamp cache GC for distributed-worker delta producers', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const staleRelativePath = 'caches/modules-2/files-2.1/org/example/stale.bin';
      const stalePath = path.join(gradleUserHome, staleRelativePath);

      await writeGradleFile(gradleUserHome, staleRelativePath, 'stale');
      await utimes(
        stalePath,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:00.000Z'),
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.cacheGcResult).toBeNull();
      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          emptyEnvelope: true,
          totalChangedCount: 0,
        }),
      );
      await expect(pathExists(stalePath)).resolves.toBe(true);
    });
  });

  it('skips consumed artifact cleanup when the artifact backend does not support deletion', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const artifactBackend: WorkflowArtifactBackend = {
        capabilities: {
          ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
          supportsDeletion: false,
        },
        uploadArtifact: artifactApi.uploadArtifact.bind(artifactApi),
        listArtifacts: artifactApi.listArtifacts.bind(artifactApi),
        getArtifact: artifactApi.getArtifact.bind(artifactApi),
        downloadArtifact: artifactApi.downloadArtifact.bind(artifactApi),
        deleteArtifact: artifactApi.deleteArtifact.bind(artifactApi),
      };
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await stageWorkerArtifactForCleanup(artifactBackend, workspace, 'worker-a');
      const artifactNameToDelete = (await artifactBackend.listArtifacts())[0]!.name;
      replaceLifecycleRecord(savedState, (record) =>
        withConsumedArtifacts(record, [artifactNameToDelete]),
      );

      const status = await executeFinalizeAction({
        artifactBackend,
        cacheBackend: createCacheApi({
          saveCache: async () => 91,
        }),
        env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-aggregator'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(status.consumedDeltaCleanupResult).toEqual(
        expect.objectContaining({
          attemptedArtifactNames: [artifactNameToDelete],
          deletedArtifactNames: [],
          message:
            'Consumed delta artifact cleanup skipped because the artifact backend does not support deletion.',
          warnings: [
            'Consumed delta artifact cleanup skipped because the artifact backend does not support deletion.',
          ],
        }),
      );
      expect(artifactApi.deletedArtifactNames).toEqual([]);
      await expect(artifactBackend.listArtifacts()).resolves.toHaveLength(1);
    });
  });

  it('does not require an artifact backend for read-only aggregator finalize', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'initial',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      replaceLifecycleRecord(savedState, (record) =>
        withConsumedArtifacts(record, ['must-not-be-read-or-deleted']),
      );

      const status = await executeFinalizeAction({
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'aggregate'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: {
            getInput(name: string): string {
              if (name === 'job-mode') return 'distributed-aggregator';
              if (name === 'read-only') return 'true';
              return '';
            },
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.consumedDeltaCleanupResult).toEqual({
        attemptedArtifactNames: [],
        deletedArtifactNames: [],
        warnings: [],
        message:
          'Consumed delta artifact cleanup skipped because read-only mode disables artifact exchange.',
      });
      expect(status.bootstrap.baseCacheResult).toEqual(
        expect.objectContaining({ status: 'read-only' }),
      );
    });
  });

  it('uploads an explicit empty distributed-worker envelope when no cache changes were detected', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const artifactApi = new FakeArtifactApi(path.join(workspace, 'artifact-store'));
      const savedState = new Map<string, string>();
      const summary = createSummaryCapture();

      await writeGradleFile(
        gradleUserHome,
        'caches/modules-2/files-2.1/org/example/module.bin',
        'before',
      );
      await persistPreBuildState(gradleUserHome, savedState, workspace);

      const status = await executeFinalizeAction({
        artifactBackend: artifactApi,
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: summary.writer,
          workspace,
        })),
      });

      expect(status.deltaArtifactResult).toEqual(
        expect.objectContaining({
          status: 'uploaded',
          emptyEnvelope: true,
          addedCount: 0,
          modifiedCount: 0,
          deletedCount: 0,
          totalChangedCount: 0,
        }),
      );
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('## Buildish Mammoth Cache for Gradle');
      expect(summaryText).toContain('Delta artifact');
      expect(summaryText).not.toContain('Post-build cache delta');
      expect(summary.writeCalls).toBe(0);
      await expect(artifactApi.listArtifacts()).resolves.toHaveLength(1);
    });
  });

  it('shows error overall status in the finalize summary when a Gradle build has failed', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();

      await writeGradleFile(gradleUserHome, 'caches/modules-2/files-2.1/module.bin', 'content');
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      // Write the build result directly to RUNNER_TEMP (where loadGradleBuildReport reads from),
      // with buildFailed: true — the writeCapturedBuildResult helper hardcodes buildFailed: false.
      const buildResultsDir = path.join(
        workspace,
        'runner-temp',
        '.buildish-mammoth-cache',
        'build-results',
      );
      await mkdir(buildResultsDir, { recursive: true });
      await writeFile(
        path.join(buildResultsDir, '__run-fail.json'),
        JSON.stringify({
          capturedAtEpochMillis: 1_000,
          rootProjectName: 'demo',
          requestedTasks: 'build',
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: true,
          configCacheHit: false,
        }),
        'utf8',
      );

      const status = await executeFinalizeAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          getState: createLifecycleGetState(savedState),
          inputProvider: createInputProvider('distributed-worker'),
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.buildReport.anyBuildFailed).toBe(true);
      const summaryText = createFinalizeActionSummaryLines(status).join('\n');
      expect(summaryText).toContain('❌');
    });
  });

  it('skips artifact upload when a distributed-worker job runs in read-only mode', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');
      const savedState = new Map<string, string>();

      await writeGradleFile(gradleUserHome, 'caches/modules-2/files-2.1/module.bin', 'before');
      await persistPreBuildState(gradleUserHome, savedState, workspace);
      await writeGradleFile(gradleUserHome, 'caches/modules-2/files-2.1/module.bin', 'after');

      const status = await executeFinalizeAction({
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          getState: createLifecycleGetState(savedState),
          inputProvider: {
            getInput(name: string): string {
              if (name === 'job-mode') return 'distributed-worker';
              if (name === 'read-only') return 'true';
              return '';
            },
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.deltaArtifactResult).toEqual(expect.objectContaining({ status: 'read-only' }));
      await expect(
        new FakeArtifactApi(path.join(workspace, 'artifact-store')).listArtifacts(),
      ).resolves.toHaveLength(0);
    });
  });

  it('fails closed when caching is armed without persisted lifecycle state', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');

      // No persistPreBuildState call — the prepare phase manifest is absent.
      await expect(
        executeFinalizeAction({
          artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
          cacheBackend: createCacheApi({ saveCache: async () => 0 }),
          captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
          env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
          ...(await createFinalizeActionDependencies({
            env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
            // Empty state simulates a finalize invocation without its prepare lifecycle record.
            getState: createLifecycleGetState(),
            inputProvider: createInputProvider('distributed-worker'),
            summaryWriter: createSummaryCapture().writer,
            workspace,
          })),
        }),
      ).rejects.toThrow(/Cache lifecycle state is missing/u);
    });
  });

  it('completes without cache orchestration when the cache is disabled', async () => {
    await withWorkspace(async (workspace) => {
      const gradleUserHome = path.join(workspace, '.gradle');

      const status = await executeFinalizeAction({
        artifactBackend: new FakeArtifactApi(path.join(workspace, 'artifact-store')),
        cacheBackend: createCacheApi({ saveCache: async () => 0 }),
        captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
        env: createTestEnv(workspace, gradleUserHome, 'build'),
        ...(await createFinalizeActionDependencies({
          env: createTestEnv(workspace, gradleUserHome, 'build'),
          getState: () => '',
          inputProvider: {
            getInput(name: string): string {
              if (name === 'cache-enabled') return 'false';
              return '';
            },
          },
          summaryWriter: createSummaryCapture().writer,
          workspace,
        })),
      });

      expect(status.bootstrap.cacheModel).toBeNull();
      expect(status.deltaArtifactResult).toBeNull();
      expect(status.cacheStatistics).toBeNull();
    });
  });
});

function createTestEnv(
  workspace: string,
  gradleUserHome: string,
  jobName: string,
): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'buildish-tooling/buildish',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_JOB: jobName,
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_STEP_SUMMARY: path.join(workspace, 'step-summary.md'),
    GITHUB_WORKSPACE: workspace,
    GRADLE_USER_HOME: gradleUserHome,
    HOME: workspace,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: path.join(workspace, 'runner-temp'),
  };
}

function createTestCiContext(workspace: string) {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'buildish-tooling/buildish',
    workflowName: 'CI',
    jobName: 'worker-build',
    runId: 101,
    runAttempt: 2,
    sourceRevision: null,
    tempDirectory: path.join(workspace, 'runner-temp'),
    workspace,
    actionPath: null,
  };
}

function createInputProvider(
  jobMode: string,
  githubJobCheckRunId = '',
): { getInput(name: string): string } {
  return {
    getInput(name: string): string {
      if (name === 'job-mode') {
        return jobMode;
      }
      if (name === 'github-job-check-run-id') {
        return githubJobCheckRunId;
      }
      return '';
    },
  };
}

function createCacheApi(options: { readonly saveCache: () => Promise<number> }): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return true;
    },
    async restoreCache(): Promise<string | undefined> {
      throw new Error('restoreCache should not be called during post action flow');
    },
    async saveCache(): Promise<number> {
      return await options.saveCache();
    },
    isMissingPathsError(): boolean {
      return false;
    },
  };
}

async function executeFinalizeFixture(options: {
  readonly workspace: string;
  readonly gradleUserHome: string;
  readonly savedState: Map<string, string>;
  readonly jobMode: string;
  readonly jobName: string;
  readonly saveCache: () => Promise<number>;
}): Promise<FinalizeActionStatus> {
  const env = createTestEnv(options.workspace, options.gradleUserHome, options.jobName);
  return await executeFinalizeAction({
    artifactBackend: new FakeArtifactApi(path.join(options.workspace, 'artifact-store')),
    cacheBackend: createCacheApi({ saveCache: options.saveCache }),
    captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
    env,
    ...(await createFinalizeActionDependencies({
      env,
      eventPayload: DEFAULT_PUSH_EVENT_PAYLOAD,
      getState: createLifecycleGetState(options.savedState),
      inputProvider: createInputProvider(options.jobMode),
      summaryWriter: createSummaryCapture().writer,
      workspace: options.workspace,
    })),
  });
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

async function createTestCacheModel(
  gradleUserHome: string,
  workspace: string,
): Promise<CacheModel> {
  const gradleAdapter = new GradleBuildToolAdapter({ gradleUserHome } as NormalizedGradleConfig);
  return await createCacheModel(
    {
      cacheKeyPrefix: 'buildish-mammoth-cache-',
      cacheSchemaVersion: 2,
      cachePartitions: [],
    } as unknown as NormalizedActionConfig,
    createTestCiContext(workspace),
    gradleAdapter,
    {
      captureCommandOutput: MOCK_CAPTURE_COMMAND_OUTPUT,
      env: createTestEnv(workspace, gradleUserHome, 'worker-build'),
    },
  );
}

async function persistPreBuildState(
  gradleUserHome: string,
  savedState: Map<string, string>,
  workspace: string,
): Promise<void> {
  const cacheModel = await createTestCacheModel(gradleUserHome, workspace);
  const manifest = await captureCacheManifest(cacheModel);
  const persistedManifest = await persistPreBuildCacheManifest(manifest, {
    env: { RUNNER_TEMP: path.join(workspace, 'runner-temp') },
  });
  persistCacheLifecycleRecord(
    {
      lifecycleSchemaVersion: CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
      cacheSchemaVersion: 2,
      buildToolId: cacheModel.buildToolId,
      cacheFamilyKey: cacheModel.cacheFamilyKey,
      currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
      fallbackRefLineagePrefixes: [...cacheModel.fallbackRefLineagePrefixes],
      plannedGenerationId: cacheModel.plannedGenerationId,
      restoreResult: {
        operation: 'restore',
        status: 'miss',
        cacheFamilyKey: cacheModel.cacheFamilyKey,
        currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
        matchedKey: null,
        matchedLineagePrefix: null,
        restoreCandidates: [
          { lineage: 'current-ref', keyPrefix: cacheModel.currentRefLineagePrefix },
          ...cacheModel.fallbackRefLineagePrefixes.map((keyPrefix) => ({
            lineage: 'default-branch' as const,
            keyPrefix,
          })),
        ],
        paths: [...cacheModel.includePaths, ...cacheModel.excludePaths.map((value) => `!${value}`)],
        message: 'Base cache restore missed.',
      },
      preBuildManifestPath: persistedManifest.manifestPath,
      preBuildManifestDigest: persistedManifest.manifestDigest,
      executionIdentity: {
        jobName: 'worker-build',
        runId: 101,
        runAttempt: 2,
      },
      sourceRevision: null,
      dependentDelta: null,
    },
    savedState.set.bind(savedState),
  );
  expect(getPersistedCacheLifecycleRecord(createLifecycleGetState(savedState))).not.toBeNull();
}

function replaceLifecycleRecord(
  savedState: Map<string, string>,
  replace: (record: PersistedCacheLifecycleRecord) => PersistedCacheLifecycleRecord,
): void {
  const record = getPersistedCacheLifecycleRecord(createLifecycleGetState(savedState));
  if (!record) {
    throw new Error('Expected test lifecycle state to be present.');
  }
  persistCacheLifecycleRecord(replace(record), savedState.set.bind(savedState));
}

function withConsumedArtifacts(
  record: PersistedCacheLifecycleRecord,
  artifactNames: readonly string[],
): PersistedCacheLifecycleRecord {
  return {
    ...record,
    dependentDelta: {
      requestedJobs: ['worker-a'],
      artifactNames: [...artifactNames],
      addedCount: 1,
      modifiedCount: 0,
      deletedCount: 0,
      totalChangedCount: 1,
    },
  };
}

function withCurrentLineageHit(
  record: PersistedCacheLifecycleRecord,
): PersistedCacheLifecycleRecord {
  return {
    ...record,
    restoreResult: {
      ...record.restoreResult,
      status: 'current-lineage-hit',
      matchedKey: `${record.currentRefLineagePrefix}run-1-attempt-1-job-test-aaaaaaaaaaaa`,
      matchedLineagePrefix: record.currentRefLineagePrefix,
      message: 'Restored current lineage.',
    },
  };
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
}

async function pathExists(absolutePath: string): Promise<boolean> {
  return await lstat(absolutePath)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return false;
      }
      throw error;
    });
}

async function writeCapturedBuildResult(
  gradleUserHome: string,
  options: {
    readonly invocationKey: string;
    readonly rootProjectName: string;
    readonly requestedTasks: string;
    readonly gradleVersion: string;
    readonly javaVersion: string;
    readonly configCacheHit: boolean;
    readonly buildScanUri: string | null;
  },
): Promise<void> {
  const resultsDirectory = path.join(gradleUserHome, '.buildish-mammoth-cache', 'build-results');
  const buildScansDirectory = path.join(gradleUserHome, '.buildish-mammoth-cache', 'build-scans');
  await mkdir(resultsDirectory, { recursive: true });
  await mkdir(buildScansDirectory, { recursive: true });
  await writeFile(
    path.join(resultsDirectory, `${options.invocationKey}.json`),
    JSON.stringify({
      capturedAtEpochMillis: 1_000,
      rootProjectName: options.rootProjectName,
      requestedTasks: options.requestedTasks,
      gradleVersion: options.gradleVersion,
      javaVersion: options.javaVersion,
      buildFailed: false,
      configCacheHit: options.configCacheHit,
    }),
    'utf8',
  );

  if (options.buildScanUri) {
    await writeFile(
      path.join(buildScansDirectory, `${options.invocationKey}.json`),
      JSON.stringify({ buildScanUri: options.buildScanUri, buildScanFailed: false }),
      'utf8',
    );
  }
}

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-post-flow-'));
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
    options?: { readonly retentionDays?: number; readonly compressionLevel?: number },
  ): Promise<WorkflowArtifactDescriptor> {
    await mkdir(this.storageRoot, { recursive: true });
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });
    this.uploadRetentionDays.push(options?.retentionDays ?? null);

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
    this.deletedArtifactNames.push(name);
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }
    this.artifacts.delete(artifact[0]);
  }

  readonly uploadRetentionDays: Array<number | null> = [];

  readonly deletedArtifactNames: string[] = [];
}

async function stageWorkerArtifactForCleanup(
  artifactApi: WorkflowArtifactBackend,
  workspace: string,
  jobName: string,
): Promise<void> {
  const workerGradleHome = path.join(workspace, `${jobName}-gradle-home`);
  await writeGradleFile(
    workerGradleHome,
    'caches/modules-2/files-2.1/example/module.bin',
    'worker-before',
  );
  const cacheModel = await createTestCacheModel(workerGradleHome, workspace);
  const previousManifest = await captureCacheManifest(cacheModel);
  await writeGradleFile(
    workerGradleHome,
    'caches/modules-2/files-2.1/example/module.bin',
    'worker-after',
  );
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    {
      eventName: 'push',
      resolvedRefName: 'main',
      safeRefName: 'main',
      runnerOs: 'linux',
      runnerArch: 'x64',
      defaultBranch: 'main',
      isPullRequest: false,
      repository: 'buildish-tooling/buildish',
      workflowName: 'CI',
      jobName,
      runId: 101,
      runAttempt: 2,
      sourceRevision: null,
      tempDirectory: path.join(workspace, 'runner-temp'),
      workspace,
      actionPath: null,
    },
    cacheModel,
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

// ---------------------------------------------------------------------------
// Unit tests for createFinalizeActionSummaryLines rendering logic.
//
// These tests exercise the heading, status icon/label, and job-URL link logic
// in isolation using minimal FinalizeActionStatus fixtures so regressions in
// formatting are caught without running the full executeFinalizeAction flow.
// ---------------------------------------------------------------------------

/**
 * Builds a fully-typed {@link BootstrapExecution} stub for use in rendering-only unit tests.
 *
 * All fields required by {@link createFinalizeActionSummaryLines} and
 * {@link createFinalizeActionLogLines} are given concrete values. Fields that are never
 * accessed by those rendering functions (`ciProvider`, `reportSink`) are null-asserted to the
 * correct type; these assertions are safe because the tested functions do not call any method
 * on those objects — TypeScript still validates that the overall object satisfies the
 * {@link BootstrapExecution} interface, so any newly accessed field will surface as a compile
 * error rather than a silent runtime failure.
 */
function createMinimalBootstrapExecution(): BootstrapExecution {
  return {
    phase: 'finalize',
    message: 'Test bootstrap.',
    config: {
      jobMode: 'standalone',
      readOnly: false,
      cacheEnabled: false,
    } as NormalizedActionConfig,
    ciContext: {
      eventName: 'push',
      resolvedRefName: 'main',
      safeRefName: 'main',
      runnerOs: 'linux',
      runnerArch: 'x64',
      defaultBranch: 'main',
      isPullRequest: false,
      repository: 'test/repo',
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
 * Builds the minimum {@link FinalizeActionStatus} fixture required by
 * {@link createFinalizeActionSummaryLines} and {@link createFinalizeActionLogLines}.
 * Apply `overrides` to exercise specific rendering paths.
 */
function createMinimalFinalizeStatus(
  overrides: Partial<FinalizeActionStatus> = {},
): FinalizeActionStatus {
  return {
    bootstrap: createMinimalBootstrapExecution(),
    baseCacheRestoreResult: null,
    cacheGcResult: null,
    cacheStatistics: null,
    consumedDeltaCleanupResult: null,
    deltaArtifactResult: null,
    buildReport: {
      anyBuildFailed: false,
      warnings: [],
      summaryLines: ['No builds captured.'],
      logLines: [],
      builds: [],
    },
    jobUrl: null,
    workflowRunUrl: null,
    message: 'Test.',
    ...overrides,
  };
}

describe('createFinalizeActionSummaryLines', () => {
  it('includes the build-tool name in the top-level heading', () => {
    const lines = createFinalizeActionSummaryLines(createMinimalFinalizeStatus()).join('\n');
    expect(lines).toContain('## Buildish Mammoth Cache for Gradle');
  });

  it('shows success icon and label when there are no issues', () => {
    const lines = createFinalizeActionSummaryLines(createMinimalFinalizeStatus()).join('\n');
    expect(lines).toContain('✅ Overall status: success');
  });

  it('shows error icon and label when a build failed', () => {
    const status = createMinimalFinalizeStatus({
      buildReport: {
        anyBuildFailed: true,
        warnings: [],
        summaryLines: [],
        logLines: [],
        builds: [],
      },
    });
    const lines = createFinalizeActionSummaryLines(status).join('\n');
    expect(lines).toContain('❌ Overall status: issues detected');
    expect(lines).not.toContain('✅');
  });

  it('shows warning icon and label when the cache restore feature is unavailable', () => {
    const status = createMinimalFinalizeStatus({
      baseCacheRestoreResult: {
        operation: 'restore',
        status: 'feature-unavailable',
        cacheFamilyKey: 'test-family',
        currentRefLineagePrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-',
        matchedKey: null,
        matchedLineagePrefix: null,
        restoreCandidates: [
          { lineage: 'current-ref', keyPrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-' },
        ],
        paths: [],
        message: 'Cache backend unavailable.',
      },
    });
    const lines = createFinalizeActionSummaryLines(status).join('\n');
    expect(lines).toContain('⚠️ Overall status: completed with warnings');
    expect(lines).not.toContain('✅');
  });

  it('renders the tool builds heading as a plain label when jobUrl is absent', () => {
    const lines = createFinalizeActionSummaryLines(createMinimalFinalizeStatus()).join('\n');
    expect(lines).toContain('### Gradle builds');
    expect(lines).not.toContain('href');
  });

  it('renders the tool builds heading as an HTML link when jobUrl is present', () => {
    const status = createMinimalFinalizeStatus({
      jobUrl: 'https://github.com/buildish-tooling/buildish/actions/runs/101/jobs/42',
    });
    const lines = createFinalizeActionSummaryLines(status).join('\n');
    expect(lines).toContain(
      'href="https://github.com/buildish-tooling/buildish/actions/runs/101/jobs/42"',
    );
    expect(lines).toContain('Gradle builds');
  });

  it('includes build-report summary lines verbatim', () => {
    const status = createMinimalFinalizeStatus({
      buildReport: {
        anyBuildFailed: false,
        warnings: [],
        summaryLines: ['Line one from build report.', 'Line two from build report.'],
        logLines: [],
        builds: [],
      },
    });
    const lines = createFinalizeActionSummaryLines(status).join('\n');
    expect(lines).toContain('Line one from build report.');
    expect(lines).toContain('Line two from build report.');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for createFinalizeActionLogLines rendering logic.
//
// These tests mirror the createFinalizeActionSummaryLines tests above but cover
// the log-group output path in isolation using the same minimal fixtures.
// ---------------------------------------------------------------------------

describe('createFinalizeActionLogLines', () => {
  it('includes the success status icon and label when there are no issues', () => {
    const lines = createFinalizeActionLogLines(createMinimalFinalizeStatus()).join('\n');
    expect(lines).toContain('✅ Overall status: success');
  });

  it('includes the error status icon and label when a build failed', () => {
    const status = createMinimalFinalizeStatus({
      buildReport: {
        anyBuildFailed: true,
        warnings: [],
        summaryLines: [],
        logLines: [],
        builds: [],
      },
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain('❌ Overall status: issues detected');
    expect(lines).not.toContain('✅');
  });

  it('includes the warning status icon and label when the cache restore feature is unavailable', () => {
    const status = createMinimalFinalizeStatus({
      baseCacheRestoreResult: {
        operation: 'restore',
        status: 'feature-unavailable',
        cacheFamilyKey: 'test-family',
        currentRefLineagePrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-',
        matchedKey: null,
        matchedLineagePrefix: null,
        restoreCandidates: [
          { lineage: 'current-ref', keyPrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-' },
        ],
        paths: [],
        message: 'Cache backend unavailable.',
      },
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain('⚠️ Overall status: completed with warnings');
    expect(lines).not.toContain('✅');
  });

  it('includes an Execution details line from jobUrl when present', () => {
    const status = createMinimalFinalizeStatus({
      jobUrl: 'https://github.com/buildish-tooling/buildish/actions/runs/101/jobs/42',
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain(
      'Execution details: https://github.com/buildish-tooling/buildish/actions/runs/101/jobs/42',
    );
  });

  it('falls back to workflowRunUrl for the Execution details line when jobUrl is absent', () => {
    const status = createMinimalFinalizeStatus({
      jobUrl: null,
      workflowRunUrl: 'https://github.com/buildish-tooling/buildish/actions/runs/101',
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain(
      'Execution details: https://github.com/buildish-tooling/buildish/actions/runs/101',
    );
  });

  it('prefixes failed base-cache saves with "Warning:" in the log output', () => {
    const status = createMinimalFinalizeStatus({
      bootstrap: {
        ...createMinimalBootstrapExecution(),
        baseCacheResult: {
          operation: 'save',
          status: 'failed',
          generationKey: 'test-family-ref-main-gen-run-1-deadbeef',
          cacheId: null,
          paths: ['/tmp/cache'],
          message: 'Base cache generation publication failed: backend unavailable.',
        },
      },
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain('Warning:');
    expect(lines).toContain('⚠️ Overall status: completed with warnings');
    expect(lines).not.toContain('saved under');
  });

  it('prefixes warning messages with "Warning:" in the log output', () => {
    const status = createMinimalFinalizeStatus({
      buildReport: {
        anyBuildFailed: false,
        warnings: ['Configuration cache was invalidated.'],
        summaryLines: [],
        logLines: [],
        builds: [],
      },
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain('Warning: Configuration cache was invalidated.');
  });

  it('includes build-report log lines verbatim', () => {
    const status = createMinimalFinalizeStatus({
      buildReport: {
        anyBuildFailed: false,
        warnings: [],
        summaryLines: [],
        logLines: ['Log line one.', 'Log line two.'],
        builds: [],
      },
    });
    const lines = createFinalizeActionLogLines(status).join('\n');
    expect(lines).toContain('Log line one.');
    expect(lines).toContain('Log line two.');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for formatByteCount boundary behaviour.
//
// The function has two non-obvious decision points:
//   1. The size >= 10 threshold that switches between .toFixed(2) and .toFixed(1).
//   2. The loop that stops at TiB regardless of the input magnitude.
// These tests pin both so a future refactor (e.g. flipping >= to >) is caught immediately.
// ---------------------------------------------------------------------------

describe('formatByteCount', () => {
  it('formats zero bytes as "0 B"', () => {
    expect(formatByteCount(0)).toBe('0 B');
  });

  it('formats 1 byte as "1 B"', () => {
    expect(formatByteCount(1)).toBe('1 B');
  });

  it('formats 1 023 bytes as "1023 B" (just below the KiB boundary)', () => {
    expect(formatByteCount(1023)).toBe('1023 B');
  });

  it('formats exactly 1 024 bytes as "1.00 KiB" (size < 10, two decimal places)', () => {
    // 1024 / 1024 = 1.0 which is less than the >= 10 threshold, so .toFixed(2) applies.
    expect(formatByteCount(1024)).toBe('1.00 KiB');
  });

  it('formats 10 239 bytes as "10.00 KiB" (just below the >= 10 threshold, .toFixed(2) rounds up)', () => {
    // 10239 / 1024 ≈ 9.999, which is < 10 so .toFixed(2) is used; rounding carries all the
    // way through the fractional digits and produces "10.00", not "9.99".
    expect(formatByteCount(10239)).toBe('10.00 KiB');
  });

  it('formats exactly 10 240 bytes as "10.0 KiB" (at the >= 10 threshold, .toFixed(1) applies)', () => {
    // 10240 / 1024 = 10.0 which satisfies size >= 10, so .toFixed(1) applies.
    expect(formatByteCount(10240)).toBe('10.0 KiB');
  });

  it('formats exactly 1 MiB as "1.00 MiB"', () => {
    expect(formatByteCount(1024 * 1024)).toBe('1.00 MiB');
  });

  it('formats exactly 1 GiB as "1.00 GiB"', () => {
    expect(formatByteCount(1024 * 1024 * 1024)).toBe('1.00 GiB');
  });

  it('formats exactly 1 TiB as "1.00 TiB"', () => {
    expect(formatByteCount(1024 * 1024 * 1024 * 1024)).toBe('1.00 TiB');
  });

  it('formats values above 1 TiB in TiB units (loop caps at TiB)', () => {
    // The loop terminates at TiB (unitIndex 3) regardless of input magnitude.
    // 2 TiB → size = 2.0 which is < 10, so .toFixed(2) applies → '2.00 TiB'.
    expect(formatByteCount(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.00 TiB');
  });
});
