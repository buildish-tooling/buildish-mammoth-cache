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

import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  downloadAndVerifyDeltaArtifactPackage,
  selectDeltaArtifactsForProducerJobs,
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
import { restoreBaseCache } from '../../cache/service';
import {
  CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
  persistCacheLifecycleRecord,
  persistPreBuildCacheManifest,
  type PersistedPreBuildCacheManifestState,
} from '../finalize/state';
import { createDetailsSection, escapeSummaryText } from '../../util/html';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { PublicActionOutputName } from '../../config/public-contract';

/**
 * Combined result of downloading and applying dependent worker delta artifacts during the prepare phase.
 *
 * Extends {@link DeltaApplyResult} with the job names and artifact names that were requested
 * and actually applied, plus a human-readable summary message for the runtime log.
 */
export interface PrepareDependentDeltaResult extends DeltaApplyResult {
  /** Whether dependent deltas were applied or intentionally skipped by the read-only contract. */
  readonly status: 'applied' | 'skipped-read-only';
  readonly requestedJobs: readonly string[];
  readonly downloadedArtifactNames: readonly string[];
  readonly appliedRelativePaths: readonly string[];
  readonly appliedArtifactCount: number;
  readonly selectedProducers: readonly PrepareDependentDeltaProducer[];
  readonly workerBasesDiffered: boolean;
  readonly message: string;
}

/** Selected worker-envelope identity shown in aggregator diagnostics. */
export interface PrepareDependentDeltaProducer {
  readonly jobName: string;
  readonly runAttempt: number | null;
  readonly artifactName: string;
  readonly restoredGenerationKey: string | null;
  readonly preBuildManifestDigest: string;
}

/** Complete status snapshot produced by {@link executePrepareAction} at the end of the prepare phase. */
export interface PrepareActionStatus {
  readonly bootstrap: BootstrapExecution;
  /** Result of the optional prune-managed restore cleanup step; `null` when cleanup was not configured. */
  readonly restoreCleanupResult: RestoreCleanupResult | null;
  /** Result of downloading and applying dependent worker deltas; `null` when no dependent jobs were configured. */
  readonly dependentDeltaResult: PrepareDependentDeltaResult | null;
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
      preBuildManifestState: null,
      message: 'Prepare execution completed without cache orchestration.',
    } satisfies PrepareActionStatus;

    const logLines = createPrepareActionLogLines(status);
    if (logLines.length > 0) {
      bootstrap.reportSink.publishLogGroup('Buildish prepare execution', logLines, logInfo);
    }
    await bootstrap.reportSink.replaceSummary(createPrepareActionSummaryLines(status));
    return status;
  }

  const restoreCleanupResult = await maybePruneManagedFilesAfterRestore(bootstrap, dependencies);
  const dependentDeltaResult = await applyDependentJobDeltas(bootstrap, dependencies);
  const manifest = await captureCacheManifest(bootstrap.cacheModel);
  const preBuildManifestState = await persistPreBuildCacheManifest(manifest, {
    env: dependencies.env,
    tempDirectory: bootstrap.ciContext.tempDirectory,
  });
  const restoreResult = bootstrap.baseCacheResult;
  if (!restoreResult || restoreResult.operation !== 'restore') {
    throw new Error('Cache-enabled prepare completed without a base-cache restore result.');
  }
  persistCacheLifecycleRecord(
    {
      lifecycleSchemaVersion: CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
      cacheSchemaVersion: bootstrap.config.cacheSchemaVersion,
      buildToolId: bootstrap.cacheModel.buildToolId,
      cacheFamilyKey: bootstrap.cacheModel.cacheFamilyKey,
      currentRefLineagePrefix: bootstrap.cacheModel.currentRefLineagePrefix,
      fallbackRefLineagePrefixes: [...bootstrap.cacheModel.fallbackRefLineagePrefixes],
      plannedGenerationId: bootstrap.cacheModel.plannedGenerationId,
      restoreResult: {
        ...restoreResult,
        restoreCandidates: restoreResult.restoreCandidates.map((candidate) => ({ ...candidate })),
        paths: [...restoreResult.paths],
      },
      preBuildManifestPath: preBuildManifestState.manifestPath,
      preBuildManifestDigest: preBuildManifestState.manifestDigest,
      executionIdentity: {
        jobName: bootstrap.ciContext.jobName,
        runId: bootstrap.ciContext.runId,
        runAttempt: bootstrap.ciContext.runAttempt,
      },
      sourceRevision: bootstrap.ciContext.sourceRevision ?? null,
      dependentDelta:
        dependentDeltaResult?.status === 'applied'
          ? {
              requestedJobs: [...dependentDeltaResult.requestedJobs],
              artifactNames: [...dependentDeltaResult.downloadedArtifactNames],
              addedCount: dependentDeltaResult.addedCount,
              modifiedCount: dependentDeltaResult.modifiedCount,
              deletedCount: dependentDeltaResult.deletedCount,
              totalChangedCount:
                dependentDeltaResult.addedCount +
                dependentDeltaResult.modifiedCount +
                dependentDeltaResult.deletedCount,
            }
          : null,
    },
    dependencies.runtimeHost.saveState,
  );

  const status = {
    bootstrap,
    restoreCleanupResult,
    dependentDeltaResult,
    preBuildManifestState,
    message:
      'Prepare execution completed and captured the pre-build cache manifest for finalize processing.',
  } satisfies PrepareActionStatus;

  const logLines = createPrepareActionLogLines(status);
  if (logLines.length > 0) {
    bootstrap.reportSink.publishLogGroup('Buildish prepare execution', logLines, logInfo);
  }
  await bootstrap.reportSink.replaceSummary(createPrepareActionSummaryLines(status));

  return status;
}

async function applyDependentJobDeltas(
  bootstrap: BootstrapExecution,
  dependencies: PrepareActionDependencies,
): Promise<PrepareDependentDeltaResult | null> {
  const requestedJobs = bootstrap.config.dependentJobs;
  if (requestedJobs.length === 0) {
    return null;
  }

  if (bootstrap.config.readOnly) {
    return {
      status: 'skipped-read-only',
      requestedJobs,
      downloadedArtifactNames: [],
      appliedRelativePaths: [],
      appliedArtifactCount: 0,
      cacheRoot: bootstrap.cacheModel!.cacheRoot,
      preconditionValidatedCount: 0,
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      noopCount: 0,
      warnings: [],
      selectedProducers: [],
      workerBasesDiffered: false,
      message:
        'Dependent delta aggregation skipped because read-only mode disables artifact exchange.',
    };
  }

  const artifactBackend = resolveArtifactBackend(dependencies);
  const selectedArtifacts = await selectDeltaArtifactsForProducerJobs(
    artifactBackend,
    requestedJobs,
    bootstrap.ciContext,
  );
  const downloadedPackages: DownloadedDeltaArtifactPackage[] = [];

  try {
    for (const selected of selectedArtifacts) {
      downloadedPackages.push(
        await downloadAndVerifyDeltaArtifactPackage(artifactBackend, selected.artifact, {
          expectedIdentity: {
            repository: bootstrap.ciContext.repository,
            workflowName: bootstrap.ciContext.workflowName,
            runId: bootstrap.ciContext.runId,
            producerJobName: selected.producerJobName,
            producerAttempt: selected.producerAttempt,
            sourceRevision: bootstrap.ciContext.sourceRevision ?? null,
          },
        }),
      );
    }
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
  const cacheModel = bootstrap.cacheModel;
  const currentRunner = `${bootstrap.ciContext.runnerOs}/${bootstrap.ciContext.runnerArch}`;

  for (const artifactPackage of downloadedPackages) {
    const producer = artifactPackage.metadata.producer;
    if (
      producer.runnerOs === bootstrap.ciContext.runnerOs &&
      producer.runnerArch === bootstrap.ciContext.runnerArch
    ) {
      const cacheIdentity = artifactPackage.metadata.cacheIdentity;
      const expectedPartitionIds = cacheModel?.partitions.map((partition) => partition.id) ?? [];
      if (
        cacheModel &&
        (cacheIdentity.familyKey !== cacheModel.cacheFamilyKey ||
          cacheIdentity.refLineagePrefix !== cacheModel.currentRefLineagePrefix ||
          cacheIdentity.partitionFingerprint !== cacheModel.partitionFingerprint ||
          JSON.stringify(cacheIdentity.partitionIds) !== JSON.stringify(expectedPartitionIds) ||
          producer.safeRefName !== bootstrap.ciContext.safeRefName ||
          producer.defaultBranch !== bootstrap.ciContext.defaultBranch)
      ) {
        throw new Error(
          `Dependent delta artifact '${artifactPackage.artifact.name}' from job '${producer.jobName}' does not match the aggregator's cache family, ref lineage, partition layout, or ref identity.`,
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
  if (
    !bootstrap.config.cleanupEnabled ||
    bootstrap.config.restoreCleanupMode === 'none' ||
    !bootstrap.cacheModel
  ) {
    return null;
  }

  const baseCacheResult = bootstrap.baseCacheResult;
  if (
    !baseCacheResult ||
    baseCacheResult.operation !== 'restore' ||
    (baseCacheResult.status !== 'current-lineage-hit' &&
      baseCacheResult.status !== 'fallback-lineage-hit')
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

  const reRestore = await restoreBaseCache(bootstrap.cacheModel, dependencies);
  if (
    reRestore.operation !== 'restore' ||
    (reRestore.status !== 'current-lineage-hit' && reRestore.status !== 'fallback-lineage-hit')
  ) {
    throw new Error(
      `restore-cleanup-mode=prune-managed deleted ${relativePaths.length} managed file(s), but the follow-up base cache restore did not hit again. Refusing to continue with a partially pruned cache root.`,
    );
  }

  return {
    mode: 'prune-managed',
    status: 'pruned',
    deletedFileCount: relativePaths.length,
    message: `Pruned ${relativePaths.length} managed file(s) from the active cache partitions and re-restored base cache '${reRestore.matchedKey ?? reRestore.currentRefLineagePrefix}'.`,
  };
}

function createPrepareDependentDeltaResult(
  requestedJobs: readonly string[],
  downloadedPackages: readonly DownloadedDeltaArtifactPackage[],
  plan: ReturnType<typeof mergeDeltaArtifactPackages>,
  applied: DeltaApplyResult,
): PrepareDependentDeltaResult {
  const selectedProducers = downloadedPackages.map((artifactPackage) => ({
    jobName: artifactPackage.metadata.producer.jobName,
    runAttempt: artifactPackage.metadata.producer.runAttempt,
    artifactName: artifactPackage.artifact.name,
    restoredGenerationKey: artifactPackage.metadata.cacheIdentity.restoredGenerationKey,
    preBuildManifestDigest: artifactPackage.metadata.cacheIdentity.preBuildManifestDigest,
  }));
  return {
    ...applied,
    status: 'applied',
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
    selectedProducers,
    workerBasesDiffered:
      new Set(
        selectedProducers.map(
          (producer) =>
            `${producer.restoredGenerationKey ?? '<none>'}:${producer.preBuildManifestDigest}`,
        ),
      ).size > 1,
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
      await rm(artifactPackage.temporaryDirectory ?? artifactPackage.downloadDirectory, {
        recursive: true,
        force: true,
      });
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
  const cacheModel = status.bootstrap.cacheModel;
  const restoreResult =
    status.bootstrap.baseCacheResult?.operation === 'restore'
      ? status.bootstrap.baseCacheResult
      : null;

  return [
    '## Buildish prepare execution',
    `- Cache family: ${escapeSummaryText(cacheModel?.cacheFamilyKey ?? 'disabled')}`,
    `- Current ref lineage: ${escapeSummaryText(cacheModel?.currentRefLineagePrefix ?? 'disabled')}`,
    `- Fallback ref lineage: ${escapeSummaryText(cacheModel?.fallbackRefLineagePrefixes.join(', ') || 'none')}`,
    `- Base cache restore: ${escapeSummaryText(restoreResult?.status ?? 'disabled')}`,
    `- Restored generation: ${escapeSummaryText(restoreResult?.matchedKey ?? 'none')}`,
    `- Restore origin: ${escapeSummaryText(describeRestoreOrigin(restoreResult))}`,
    `- Job mode: ${escapeSummaryText(status.bootstrap.config.jobMode)}`,
    `- Read only: ${status.bootstrap.config.readOnly ? 'yes' : 'no'}`,
    `- Restore cleanup: ${describeRestoreCleanupSummary(status.restoreCleanupResult)}`,
    `- Dependent delta reuse: ${describeDependentDeltaSummary(dependentDelta)}`,
    ...(status.preBuildManifestState
      ? ['- Pre-build manifest: persisted']
      : ['- Pre-build manifest: not persisted']),
    ...createDetailsSection('Prepare-phase details', [
      `- Dependent jobs configured: ${dependentDelta?.requestedJobs.length ?? 0}`,
      `- Downloaded delta artifacts: ${dependentDelta?.appliedArtifactCount ?? 0}`,
      ...(dependentDelta
        ? [
            `- Applied delta changes: ${dependentDelta.addedCount} added, ${dependentDelta.modifiedCount} modified, ${dependentDelta.deletedCount} deleted.`,
            `- Validated delta preconditions: ${dependentDelta.preconditionValidatedCount}`,
            `- Idempotent delta no-ops: ${dependentDelta.noopCount}`,
            `- Worker bases differed: ${dependentDelta.workerBasesDiffered ? 'yes' : 'no'}`,
            ...dependentDelta.selectedProducers.map(
              (producer) =>
                `- Selected worker ${escapeSummaryText(producer.jobName)}: attempt ${producer.runAttempt ?? 'unknown'}, artifact ${escapeSummaryText(producer.artifactName)}, restored base ${escapeSummaryText(producer.restoredGenerationKey ?? 'none')}, pre-build digest ${escapeSummaryText(producer.preBuildManifestDigest.slice(0, 12))}`,
            ),
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
  const restoreResult =
    status.bootstrap.baseCacheResult?.operation === 'restore'
      ? status.bootstrap.baseCacheResult
      : null;
  const lines = [
    ...createBootstrapLogLines(status.bootstrap),
    `Restored cache generation: ${restoreResult?.matchedKey ?? 'none'}; origin: ${describeRestoreOrigin(restoreResult)}.`,
    `Restore cleanup: ${describeRestoreCleanupSummary(status.restoreCleanupResult)}.`,
    `Dependent delta reuse: ${describeDependentDeltaSummary(status.dependentDeltaResult)}.`,
    status.preBuildManifestState
      ? 'Pre-build manifest: persisted.'
      : 'Pre-build manifest: not persisted.',
  ];

  if (status.restoreCleanupResult) {
    lines.push(status.restoreCleanupResult.message);
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
    if (status.dependentDeltaResult.selectedProducers.length > 0) {
      lines.push(
        `Validated ${status.dependentDeltaResult.preconditionValidatedCount} dependent delta path precondition(s); ${status.dependentDeltaResult.noopCount} path(s) were already in the desired state.`,
        `Worker bases differed: ${status.dependentDeltaResult.workerBasesDiffered ? 'yes' : 'no'}.`,
        ...status.dependentDeltaResult.selectedProducers.map(
          (producer) =>
            `Selected worker '${producer.jobName}' attempt ${producer.runAttempt ?? 'unknown'} artifact '${producer.artifactName}'; restored base '${producer.restoredGenerationKey ?? 'none'}'; pre-build digest ${producer.preBuildManifestDigest.slice(0, 12)}.`,
        ),
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

  return result.status === 'skipped-read-only'
    ? `skipped-read-only (${result.requestedJobs.length} configured job(s))`
    : `${result.appliedArtifactCount} artifact(s) from ${result.requestedJobs.length} job(s)`;
}

function describeRestoreOrigin(
  result: Extract<BootstrapExecution['baseCacheResult'], { operation: 'restore' }> | null,
): string {
  if (!result?.matchedKey) {
    return 'none';
  }
  return result.status === 'current-lineage-hit' ? 'current ref' : 'default branch';
}

/**
 * Derives the action output key-value map from a completed prepare-phase status.
 *
 * The returned map is passed to the CI runtime output sink (e.g. `setOutput` on GitHub Actions).
 * The exact key set is part of the canonical public action contract. Internal diagnostics and
 * tool-provisioning details belong in logs and summaries rather than undeclared outputs.
 */
export function createPrepareActionOutputs(
  status: PrepareActionStatus,
): Record<PublicActionOutputName, string> {
  const cacheModel = status.bootstrap.cacheModel;
  const restoreResult =
    status.bootstrap.baseCacheResult?.operation === 'restore'
      ? status.bootstrap.baseCacheResult
      : null;
  return {
    'cache-family-key': cacheModel?.cacheFamilyKey ?? '',
    'cache-lineage-prefix': cacheModel?.currentRefLineagePrefix ?? '',
    'base-cache-restore-status': restoreResult?.status ?? '',
    'restored-cache-key': restoreResult?.matchedKey ?? '',
    'job-mode': status.bootstrap.config.jobMode,
    'read-only': String(status.bootstrap.config.readOnly),
    'dependent-delta-status': status.dependentDeltaResult?.status ?? 'not-configured',
    'dependent-delta-artifact-count': String(
      status.dependentDeltaResult?.appliedArtifactCount ?? 0,
    ),
  };
}

function formatSummaryList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
