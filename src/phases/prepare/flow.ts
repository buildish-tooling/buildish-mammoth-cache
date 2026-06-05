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

import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  downloadAndVerifyDeltaArtifactPackage,
  findDeltaArtifactByProducerJob,
  type DownloadedDeltaArtifactPackage,
} from '../../delta/service';
import {
  bootstrapPhase,
  createBootstrapLogLines,
  type BootstrapExecution,
  type BootstrapDependencies,
} from '../bootstrap';
import {
  applyMergedDeltaPlan,
  mergeDeltaArtifactPackages,
  type DeltaApplyResult,
} from '../../delta/apply';
import { captureCacheManifest } from '../../cache/manifest';
import { collectTimestampCacheGarbage, type TimestampCacheGcResult } from '../../cache/gc';
import { restoreBaseCache } from '../../cache/service';
import {
  persistBaseCacheRestoreResult,
  persistConsumedDeltaArtifactNames,
  persistDeltaArtifactExecutionIdentity,
  persistPreBuildCacheManifest,
  type PersistedPreBuildCacheManifestState,
} from '../finalize/state';
import { createDetailsSection, escapeSummaryText } from '../../util/html';
import type { WorkflowArtifactBackend } from '../../delta/backend';

/**
 * Combined result of downloading and applying dependent worker delta artifacts during the prepare phase.
 *
 * Extends {@link DeltaApplyResult} with the job names and artifact names that were requested
 * and actually applied, plus a human-readable summary message for the runtime log.
 */
export interface PrepareDependentDeltaResult extends DeltaApplyResult {
  readonly requestedJobs: readonly string[];
  readonly downloadedArtifactNames: readonly string[];
  readonly appliedRelativePaths: readonly string[];
  readonly appliedArtifactCount: number;
  readonly message: string;
}

/** Complete status snapshot produced by {@link executePrepareAction} at the end of the prepare phase. */
export interface PrepareActionStatus {
  readonly bootstrap: BootstrapExecution;
  /** Result of the optional prune-managed restore cleanup step; `null` when cleanup was not configured. */
  readonly restoreCleanupResult: RestoreCleanupResult | null;
  /** Result of downloading and applying dependent worker deltas; `null` when no dependent jobs were configured. */
  readonly dependentDeltaResult: PrepareDependentDeltaResult | null;
  /** Result of best-effort cache garbage collection; `null` when disabled. */
  readonly cacheGcResult: TimestampCacheGcResult | null;
  /** Path and metadata of the persisted pre-build cache manifest; `null` when the cache is disabled. */
  readonly preBuildManifestState: PersistedPreBuildCacheManifestState | null;
  readonly message: string;
}

/** Result of the optional prune-managed restore cleanup step performed after a cache hit. */
export interface RestoreCleanupResult {
  readonly mode: 'prune-managed';
  /** `skipped-no-hit` when no cache entry was restored; `pruned` when managed files were deleted and re-restored. */
  readonly status: 'skipped-no-hit' | 'pruned';
  readonly deletedFileCount: number;
  readonly message: string;
}

/**
 * Injectable dependencies for the main (prepare) action flow.
 *
 * Extends {@link BootstrapDependencies} with the optional artifact backend used to download
 * dependent worker delta artifacts in `distributed-aggregator` mode.
 */
export interface PrepareActionDependencies extends BootstrapDependencies {
  readonly artifactBackend?: WorkflowArtifactBackend;
}

/**
 * Runs the full prepare phase of the action.
 *
 * Sequence: bootstrap → install build-result capture hook → restore base cache → optional
 * prune-managed cleanup → download and apply dependent deltas (aggregator mode) → capture
 * pre-build manifest → persist state for the finalize phase.
 *
 * @returns A {@link PrepareActionStatus} snapshot covering all prepare-phase outcomes.
 */
export async function executePrepareAction(
  dependencies: PrepareActionDependencies,
): Promise<PrepareActionStatus> {
  const logInfo = dependencies.runtimeHost.info;
  const bootstrap = await bootstrapPhase('prepare', dependencies);
  await bootstrap.buildToolAdapter
    .installBuildHooks(bootstrap.ciContext)
    .catch((error: unknown) => {
      logInfo(
        `${bootstrap.buildToolAdapter.getName()} build reporting could not install capture hooks and will be skipped for this job: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  if (!bootstrap.cacheModel) {
    const status = {
      bootstrap,
      restoreCleanupResult: null,
      dependentDeltaResult: null,
      cacheGcResult: null,
      preBuildManifestState: null,
      message: 'Prepare execution completed without cache orchestration.',
    } satisfies PrepareActionStatus;

    const logLines = createPrepareActionLogLines(status);
    if (logLines.length > 0) {
      bootstrap.reportSink.publishLogGroup('Apache Buildish prepare execution', logLines, logInfo);
    }
    return status;
  }

  const restoreCleanupResult = await maybePruneManagedFilesAfterRestore(bootstrap, dependencies);
  const dependentDeltaResult = await applyDependentJobDeltas(bootstrap, dependencies);
  const cacheGcResult = await maybeCollectCacheGarbage(bootstrap, dependentDeltaResult);
  if (dependentDeltaResult) {
    persistConsumedDeltaArtifactNames(
      dependentDeltaResult.downloadedArtifactNames,
      dependencies.runtimeHost.saveState,
    );
  }
  if (bootstrap.baseCacheResult?.operation === 'restore') {
    persistBaseCacheRestoreResult(bootstrap.baseCacheResult, dependencies.runtimeHost.saveState);
  }
  persistDeltaArtifactExecutionIdentity(bootstrap.ciContext, dependencies.runtimeHost.saveState);
  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const preBuildManifestState = await persistPreBuildCacheManifest(
    manifest,
    dependencies.runtimeHost.saveState,
    { env: dependencies.env, tempDirectory: bootstrap.ciContext.tempDirectory },
  );

  const status = {
    bootstrap,
    restoreCleanupResult,
    dependentDeltaResult,
    cacheGcResult,
    preBuildManifestState,
    message:
      'Prepare execution completed and captured the pre-build cache manifest for finalize processing.',
  } satisfies PrepareActionStatus;

  const logLines = createPrepareActionLogLines(status);
  if (logLines.length > 0) {
    bootstrap.reportSink.publishLogGroup('Apache Buildish prepare execution', logLines, logInfo);
  }

  return status;
}

async function maybeCollectCacheGarbage(
  bootstrap: BootstrapExecution,
  dependentDeltaResult: PrepareDependentDeltaResult | null,
): Promise<TimestampCacheGcResult | null> {
  if (bootstrap.config.cacheGcMode === 'off' || !bootstrap.cacheModel) {
    return null;
  }

  return await collectTimestampCacheGarbage(bootstrap.cacheModel, {
    olderThanDays: bootstrap.config.cacheGcOlderThanDays,
    protectedRelativePaths: dependentDeltaResult?.appliedRelativePaths,
  });
}

async function applyDependentJobDeltas(
  bootstrap: BootstrapExecution,
  dependencies: PrepareActionDependencies,
): Promise<PrepareDependentDeltaResult | null> {
  const requestedJobs = bootstrap.config.dependentJobs;
  if (requestedJobs.length === 0) {
    return null;
  }

  const artifactBackend = resolveArtifactBackend(dependencies);
  const downloadedPackages = await Promise.all(
    requestedJobs.map(async (jobName) => {
      const artifact = await findDeltaArtifactByProducerJob(
        artifactBackend,
        jobName,
        bootstrap.ciContext.runId,
        bootstrap.ciContext.runAttempt,
      );
      return await downloadAndVerifyDeltaArtifactPackage(artifactBackend, artifact);
    }),
  );

  try {
    assertCompatibleDependentDeltaArtifacts(downloadedPackages, bootstrap);
    const plan = mergeDeltaArtifactPackages(downloadedPackages, {
      allowDuplicateDependentDeltaPaths: bootstrap.config.allowDuplicateDependentDeltaPaths,
    });
    const applied = await applyMergedDeltaPlan(plan, bootstrap.cacheModel!.cacheRoot);
    return createPrepareDependentDeltaResult(requestedJobs, downloadedPackages, plan, applied);
  } finally {
    await cleanupDownloadedPackages(downloadedPackages);
  }
}

function resolveArtifactBackend(
  dependencies: Pick<PrepareActionDependencies, 'artifactBackend'>,
): WorkflowArtifactBackend {
  const { artifactBackend } = dependencies;
  if (!artifactBackend) {
    throw new Error('Artifact backend dependency is required.');
  }
  return artifactBackend;
}

function assertCompatibleDependentDeltaArtifacts(
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
  bootstrap: BootstrapExecution,
): void {
  const currentCacheKey = bootstrap.cacheModel?.cacheKey;
  const currentRunner = `${bootstrap.ciContext.runnerOs}/${bootstrap.ciContext.runnerArch}`;

  for (const artifactPackage of downloadedPackages) {
    const producer = artifactPackage.metadata.producer;
    if (
      producer.runnerOs === bootstrap.ciContext.runnerOs &&
      producer.runnerArch === bootstrap.ciContext.runnerArch
    ) {
      if (currentCacheKey && producer.cacheKey !== currentCacheKey) {
        throw new Error(
          `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' targets cache key '${producer.cacheKey}', but the current job expects '${currentCacheKey}'. Distributed delta reuse requires identical cache key inputs, partition layout, and runner selection.`,
        );
      }
      continue;
    }

    throw new Error(
      `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' targets runner ${producer.runnerOs}/${producer.runnerArch}, but the current job runs on ${currentRunner}. Cross-runner dependent delta reuse is not supported; keep distributed jobs on the same runner OS and architecture.`,
    );
  }
}

async function maybePruneManagedFilesAfterRestore(
  bootstrap: BootstrapExecution,
  dependencies: PrepareActionDependencies,
): Promise<RestoreCleanupResult | null> {
  if (bootstrap.config.restoreCleanupMode === 'none' || !bootstrap.cacheModel) {
    return null;
  }

  const baseCacheResult = bootstrap.baseCacheResult;
  if (
    !baseCacheResult ||
    baseCacheResult.operation !== 'restore' ||
    (baseCacheResult.status !== 'exact-hit' && baseCacheResult.status !== 'partial-hit')
  ) {
    return {
      mode: 'prune-managed',
      status: 'skipped-no-hit',
      deletedFileCount: 0,
      message:
        'Restore cleanup skipped because no base cache hit was available to re-apply after pruning managed files.',
    };
  }

  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const relativePaths = manifest.partitions.flatMap((partition) =>
    partition.entries.map((entry) => entry.relativePath),
  );
  const cacheRoot = bootstrap.cacheModel.cacheRoot;
  await Promise.all(
    relativePaths.map(async (relativePath) => {
      await rm(path.join(cacheRoot, relativePath), { force: true });
    }),
  );

  const reRestore = await restoreBaseCache(bootstrap.config, bootstrap.cacheModel, dependencies);
  if (
    reRestore.operation !== 'restore' ||
    (reRestore.status !== 'exact-hit' && reRestore.status !== 'partial-hit')
  ) {
    throw new Error(
      `restore-cleanup-mode=prune-managed deleted ${relativePaths.length} managed file(s), but the follow-up base cache restore did not hit again. Refusing to continue with a partially pruned cache root.`,
    );
  }

  return {
    mode: 'prune-managed',
    status: 'pruned',
    deletedFileCount: relativePaths.length,
    message: `Pruned ${relativePaths.length} managed file(s) from the active cache partitions and re-restored base cache '${reRestore.matchedKey ?? reRestore.cacheKey}'.`,
  };
}

function createPrepareDependentDeltaResult(
  requestedJobs: readonly string[],
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
  plan: ReturnType<typeof mergeDeltaArtifactPackages>,
  applied: DeltaApplyResult,
): PrepareDependentDeltaResult {
  return {
    ...applied,
    requestedJobs,
    downloadedArtifactNames: downloadedPackages.map(
      (artifactPackage) => artifactPackage.artifact.name,
    ),
    appliedRelativePaths: plan.deltaManifest.partitions.flatMap((partition) =>
      partition.entries
        .filter((entry) => entry.changeType !== 'deleted')
        .map((entry) => entry.relativePath),
    ),
    appliedArtifactCount: downloadedPackages.length,
    message:
      `Applied ${downloadedPackages.length} dependent delta artifact(s) ` +
      `from ${requestedJobs.length} configured job(s): ` +
      `${applied.addedCount} added, ${applied.modifiedCount} modified, ${applied.deletedCount} deleted.`,
  };
}

async function cleanupDownloadedPackages(
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
): Promise<void> {
  await Promise.all(
    downloadedPackages.map(async (artifactPackage) => {
      await rm(artifactPackage.downloadDirectory, { recursive: true, force: true });
    }),
  );
}

/**
 * Renders the Markdown job-summary lines for the prepare phase.
 *
 * Includes a top-level status overview and a collapsible details section with per-phase
 * counters for restore cleanup, dependent delta apply, and manifest persistence.
 */
export function createPrepareActionSummaryLines(status: PrepareActionStatus): readonly string[] {
  const dependentDelta = status.dependentDeltaResult;

  return [
    '## Apache Buildish prepare execution',
    `- Restore cleanup: ${describeRestoreCleanupSummary(status.restoreCleanupResult)}`,
    `- Dependent delta reuse: ${describeDependentDeltaSummary(dependentDelta)}`,
    `- Cache GC: ${describeCacheGcSummary(status.cacheGcResult)}`,
    ...(status.preBuildManifestState
      ? ['- Pre-build manifest: persisted']
      : ['- Pre-build manifest: not persisted']),
    ...createDetailsSection('Prepare-phase details', [
      `- Dependent jobs configured: ${dependentDelta?.requestedJobs.length ?? 0}`,
      `- Downloaded delta artifacts: ${dependentDelta?.appliedArtifactCount ?? 0}`,
      ...(dependentDelta
        ? [
            `- Applied delta changes: ${dependentDelta.addedCount} added, ${dependentDelta.modifiedCount} modified, ${dependentDelta.deletedCount} deleted.`,
            `- Delta apply warnings: ${dependentDelta.warnings.length}`,
            `- Post-job artifact cleanup scheduled: ${dependentDelta.downloadedArtifactNames.length}`,
          ]
        : []),
      ...(status.restoreCleanupResult
        ? [
            `- Restore cleanup mode: ${escapeSummaryText(status.restoreCleanupResult.mode)}`,
            `- Restore cleanup status: ${escapeSummaryText(status.restoreCleanupResult.status)}`,
            `- Restore cleanup deleted files: ${status.restoreCleanupResult.deletedFileCount}`,
          ]
        : []),
      ...(status.cacheGcResult
        ? [
            `- Cache GC mode: ${escapeSummaryText(status.cacheGcResult.mode)}`,
            `- Cache GC scanned files: ${status.cacheGcResult.scannedFileCount}`,
            `- Cache GC deleted files: ${status.cacheGcResult.deletedFileCount}`,
            `- Cache GC deleted bytes: ${status.cacheGcResult.deletedByteCount}`,
          ]
        : []),
    ]),
  ];
}

/**
 * Renders the runtime log lines for the prepare phase.
 *
 * Emitted inside a named log group so operators can quickly assess the prepare outcome without
 * opening the full job summary. Each nullable result field contributes additional lines only when
 * that phase step was actually executed.
 */
export function createPrepareActionLogLines(status: PrepareActionStatus): readonly string[] {
  const lines = [
    ...createBootstrapLogLines(status.bootstrap),
    `Restore cleanup: ${describeRestoreCleanupSummary(status.restoreCleanupResult)}.`,
    `Dependent delta reuse: ${describeDependentDeltaSummary(status.dependentDeltaResult)}.`,
    `Cache GC: ${describeCacheGcSummary(status.cacheGcResult)}.`,
    status.preBuildManifestState
      ? 'Pre-build manifest: persisted.'
      : 'Pre-build manifest: not persisted.',
  ];

  if (status.restoreCleanupResult) {
    lines.push(status.restoreCleanupResult.message);
  }

  if (status.cacheGcResult) {
    lines.push(status.cacheGcResult.message);
  }

  if (status.dependentDeltaResult) {
    if (status.dependentDeltaResult.requestedJobs.length > 0) {
      lines.push(
        `Configured dependent jobs: ${formatSummaryList(status.dependentDeltaResult.requestedJobs)}.`,
      );
    }
    if (status.dependentDeltaResult.downloadedArtifactNames.length > 0) {
      lines.push(
        `Downloaded dependent delta artifacts: ${formatSummaryList(status.dependentDeltaResult.downloadedArtifactNames)}.`,
      );
    }
  }

  if (status.preBuildManifestState) {
    lines.push(
      `Persisted pre-build cache manifest to '${status.preBuildManifestState.manifestPath}'.`,
    );
  }

  return lines;
}

function describeRestoreCleanupSummary(result: RestoreCleanupResult | null): string {
  if (!result) {
    return 'none';
  }

  return result.status === 'pruned'
    ? `${result.mode} (${result.deletedFileCount} deleted)`
    : `${result.mode} (${result.status})`;
}

function describeDependentDeltaSummary(result: PrepareDependentDeltaResult | null): string {
  if (!result) {
    return 'none';
  }

  return `${result.appliedArtifactCount} artifact(s) from ${result.requestedJobs.length} job(s)`;
}

function describeCacheGcSummary(result: TimestampCacheGcResult | null): string {
  if (!result) {
    return 'off';
  }

  return `${result.mode} (${result.deletedFileCount} deleted)`;
}

/**
 * Derives the action output key-value map from a completed prepare-phase status.
 *
 * The returned map is passed to the CI runtime output sink (e.g. `setOutput` on GitHub Actions).
 * Outputs include the resolved cache key, restore status, and any tool-specific outputs contributed
 * by the active {@link BuildToolAdapter} via {@link BuildToolProvisioning.additionalOutputs}.
 */
export function createPrepareActionOutputs(status: PrepareActionStatus): Record<string, string> {
  return {
    // Generic outputs
    'cache-key': status.bootstrap.cacheModel?.cacheKey ?? '',
    'base-cache-restore-status':
      status.bootstrap.baseCacheResult?.operation === 'restore'
        ? status.bootstrap.baseCacheResult.status
        : '',
    'java-major': status.bootstrap.cacheModel?.javaMajor?.toString() ?? '',
    'job-mode': status.bootstrap.config.jobMode,
    'read-only': String(status.bootstrap.config.readOnly),
    'resolved-ref-name': status.bootstrap.ciContext.resolvedRefName,
    'safe-ref-name': status.bootstrap.ciContext.safeRefName,
    'dependent-jobs-count': String(status.bootstrap.config.dependentJobs.length),
    'downloaded-dependent-artifact-count': String(
      status.dependentDeltaResult?.appliedArtifactCount ?? 0,
    ),
    'job-name': status.bootstrap.ciContext.jobName,
    // Tool-specific outputs contributed by the active build tool adapter
    ...status.bootstrap.toolProvisioning.additionalOutputs,
  };
}

function formatSummaryList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
