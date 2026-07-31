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

import { uploadDeltaArtifactPackage, stageDeltaArtifactPackage } from '../../delta/service';
import {
  bootstrapPhase,
  createBootstrapLogLines,
  type BootstrapExecution,
  type BootstrapDependencies,
} from '../bootstrap';
import { collectTimestampCacheGarbage, type TimestampCacheGcResult } from '../../cache/gc';
import { decideBaseCacheGeneration } from '../../cache/lifecycle';
import type { CacheDeltaManifest, CacheManifest } from '../../cache/manifest';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
} from '../../cache/manifest';
import { createCacheGeneration, renderCacheJavaMajor, type CacheModel } from '../../cache/model';
import {
  saveBaseCache,
  type BaseCacheOperationResult,
  type BaseCacheRestoreResult,
} from '../../cache/service';
import type { BuildReport } from '../../build-tool/types';
import { createHtmlLink, escapeSummaryText } from '../../util/html';
import {
  getPersistedCacheLifecycleRecord,
  loadPersistedPreBuildCacheManifest,
  type PersistedCacheLifecycleRecord,
} from './state';
import type { WorkflowArtifactBackend } from '../../delta/backend';

const DELTA_ARTIFACT_RETENTION_DAYS = 7;

/**
 * Outcome of the delta artifact upload step in the finalize phase.
 *
 * `status` describes why the artifact was or was not uploaded:
 * - `not-distributed-worker` — job mode is not `distributed-worker`
 * - `read-only` — action is in read-only mode
 * - `uploaded` — delta artifact was successfully packaged and uploaded
 */
export interface FinalizeDeltaArtifactResult {
  readonly status: 'not-distributed-worker' | 'read-only' | 'uploaded';
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly totalChangedCount: number;
  /** Name of the uploaded artifact; `null` when `status` is not `uploaded`. */
  readonly artifactName: string | null;
  /** Provider artifact identifier; `null` when `status` is not `uploaded`. */
  readonly artifactId: number | null;
  readonly artifactSizeBytes: number | null;
  readonly producerAttempt: number | null;
  readonly restoredGenerationKey: string | null;
  readonly preBuildManifestDigest: string | null;
  /** Whether the uploaded envelope explicitly proves successful participation with no changes. */
  readonly emptyEnvelope: boolean;
  readonly message: string;
}

interface FinalizeCacheStatisticCell {
  fileCount: number;
  totalSizeBytes: number;
}

interface FinalizeCacheStatisticRow {
  readonly label: string;
  readonly total: FinalizeCacheStatisticCell | null;
  readonly partitions: readonly (FinalizeCacheStatisticCell | null)[];
}

interface FinalizeCacheStatistics {
  readonly partitionDisplayNames: readonly string[];
  readonly rows: readonly FinalizeCacheStatisticRow[];
}

/** Complete status snapshot produced by {@link executeFinalizeAction} at the end of the finalize phase. */
export interface FinalizeActionStatus {
  readonly bootstrap: BootstrapExecution;
  /** Restored base cache result read from persisted prepare-phase state; `null` when cache is disabled. */
  readonly baseCacheRestoreResult: BaseCacheRestoreResult | null;
  /** Result of best-effort cache garbage collection before cache save; `null` when disabled or not applicable. */
  readonly cacheGcResult: TimestampCacheGcResult | null;
  /** Cache size statistics computed from the post-build manifest; `null` when cache is disabled. */
  readonly cacheStatistics: FinalizeCacheStatistics | null;
  /** Result of deleting consumed worker delta artifacts; `null` when no artifacts were consumed. */
  readonly consumedDeltaCleanupResult: FinalizeConsumedDeltaCleanupResult | null;
  /** Result of uploading the worker delta artifact; `null` for non-worker job modes. */
  readonly deltaArtifactResult: FinalizeDeltaArtifactResult | null;
  /** Build report produced by the active build tool adapter after the build completes. */
  readonly buildReport: BuildReport;
  readonly jobUrl: string | null;
  readonly workflowRunUrl: string | null;
  readonly message: string;
}

/** Outcome of deleting consumed worker delta artifacts at the end of the aggregator finalize phase. */
export interface FinalizeConsumedDeltaCleanupResult {
  readonly attemptedArtifactNames: readonly string[];
  readonly deletedArtifactNames: readonly string[];
  /** Non-fatal warnings for artifacts that could not be deleted (e.g. permission errors). */
  readonly warnings: readonly string[];
  readonly message: string;
}

/**
 * Injectable dependencies for the post (finalize) action flow.
 *
 * Extends {@link BootstrapDependencies} with the artifact backend used to upload worker
 * deltas or clean up consumed aggregator delta artifacts.
 */
export interface FinalizeActionDependencies extends BootstrapDependencies {
  readonly artifactBackend: WorkflowArtifactBackend;
}

/**
 * Runs the full finalize phase of the action.
 *
 * Sequence: bootstrap → cleanup consumed delta artifacts → load Gradle build report → optional
 * timestamp cache GC → capture post-build manifest → save base cache (standalone/aggregator) or
 * upload delta artifact (distributed-worker) → publish log group and job summary.
 *
 * @returns A {@link FinalizeActionStatus} snapshot covering all finalize-phase outcomes.
 */
export async function executeFinalizeAction(
  dependencies: FinalizeActionDependencies,
): Promise<FinalizeActionStatus> {
  const logInfo = dependencies.runtimeHost.info;
  const initialBootstrap = await bootstrapPhase('finalize', dependencies);
  const lifecycleRecord = getPersistedCacheLifecycleRecord(dependencies.runtimeHost.getState);
  const bootstrap = reconcileCacheLifecycle(initialBootstrap, lifecycleRecord);
  const { workflowRunUrl, jobUrl } = bootstrap.ciExecutionUrls;
  const baseCacheRestoreResult = lifecycleRecord?.restoreResult ?? null;
  const consumedDeltaCleanupResult = await cleanupConsumedDeltaArtifacts(
    bootstrap,
    lifecycleRecord,
    dependencies,
  );
  const buildReport = await bootstrap.buildToolAdapter.collectBuildReport(bootstrap.ciContext);
  const logGroupName = `Buildish Mammoth Cache for ${bootstrap.buildToolAdapter.getName()}`;

  if (!bootstrap.cacheModel) {
    const status = {
      bootstrap,
      baseCacheRestoreResult,
      cacheGcResult: null,
      cacheStatistics: null,
      consumedDeltaCleanupResult,
      deltaArtifactResult: null,
      buildReport,
      jobUrl,
      workflowRunUrl,
      message: 'Finalize execution completed without cache orchestration.',
    } satisfies FinalizeActionStatus;
    const logLines1 = createFinalizeActionLogLines(status);
    if (logLines1.length > 0) {
      bootstrap.reportSink.publishLogGroup(logGroupName, logLines1, logInfo);
    }
    const summaryLines1 = createFinalizeActionSummaryLines(status);
    if (summaryLines1.length > 0) {
      await bootstrap.reportSink.replaceSummary(summaryLines1);
    }
    return status;
  }

  if (!lifecycleRecord) {
    throw new Error('Cache lifecycle state is required when finalize has caching enabled.');
  }
  const preBuildManifest = await loadPersistedPreBuildCacheManifest(
    lifecycleRecord.preBuildManifestPath,
  );
  if (preBuildManifest.buildToolId !== bootstrap.cacheModel.buildToolId) {
    throw new Error(
      `Cache manifest build tool mismatch: the persisted pre-build manifest was produced by '${preBuildManifest.buildToolId}', but the current action is running as '${bootstrap.cacheModel.buildToolId}'. Cache manifests cannot be shared across different build tools.`,
    );
  }
  const persistedManifestDigest = calculateCanonicalCacheManifestDigest(preBuildManifest);
  if (persistedManifestDigest !== lifecycleRecord.preBuildManifestDigest) {
    throw new Error(
      'Persisted pre-build cache manifest does not match the digest in cache lifecycle state.',
    );
  }

  const cacheGcResult = await maybeCollectCacheGarbage(bootstrap);
  const currentManifest = await captureCacheManifest(bootstrap.cacheModel);
  const deltaManifest = computeCacheDelta(preBuildManifest, currentManifest);
  const deltaArtifactResult = await uploadFinalizeArtifact(
    deltaManifest,
    bootstrap,
    lifecycleRecord,
    dependencies,
  );
  const baseCacheSaveResult = await saveFinalizeBaseCache(
    bootstrap,
    lifecycleRecord,
    dependencies,
    currentManifest,
  );
  const finalizedBootstrap = withBaseCacheResult(bootstrap, baseCacheSaveResult);

  const status = {
    bootstrap: finalizedBootstrap,
    baseCacheRestoreResult,
    cacheGcResult,
    cacheStatistics: createFinalizeCacheStatistics(
      bootstrap.cacheModel,
      preBuildManifest,
      currentManifest,
      deltaManifest,
      baseCacheRestoreResult,
      deltaArtifactResult,
      baseCacheSaveResult,
    ),
    consumedDeltaCleanupResult,
    deltaArtifactResult,
    buildReport,
    jobUrl,
    workflowRunUrl,
    message:
      deltaArtifactResult.status === 'uploaded'
        ? 'Finalize execution completed and uploaded the distributed worker delta artifact.'
        : 'Finalize execution completed.',
  } satisfies FinalizeActionStatus;

  const logLines3 = createFinalizeActionLogLines(status);
  if (logLines3.length > 0) {
    bootstrap.reportSink.publishLogGroup(logGroupName, logLines3, logInfo);
  }
  const summaryLines3 = createFinalizeActionSummaryLines(status);
  if (summaryLines3.length > 0) {
    await bootstrap.reportSink.replaceSummary(summaryLines3);
  }

  return status;
}

function reconcileCacheLifecycle(
  bootstrap: BootstrapExecution,
  lifecycleRecord: PersistedCacheLifecycleRecord | null,
): BootstrapExecution {
  const cacheModel = bootstrap.cacheModel;
  if (!cacheModel) {
    if (lifecycleRecord) {
      throw new Error(
        'Cache lifecycle configuration drift: prepare enabled caching but finalize disabled it.',
      );
    }
    return bootstrap;
  }
  if (!lifecycleRecord) {
    throw new Error(
      'Cache lifecycle state is missing even though finalize has caching enabled. Refusing to save without validated prepare state.',
    );
  }

  const mismatches: string[] = [];
  if (lifecycleRecord.cacheSchemaVersion !== bootstrap.config.cacheSchemaVersion) {
    mismatches.push('cache schema version');
  }
  if (lifecycleRecord.buildToolId !== cacheModel.buildToolId) {
    mismatches.push('build tool');
  }
  if (lifecycleRecord.cacheFamilyKey !== cacheModel.cacheFamilyKey) {
    mismatches.push('cache family');
  }
  if (lifecycleRecord.currentRefLineagePrefix !== cacheModel.currentRefLineagePrefix) {
    mismatches.push('current ref lineage');
  }
  if (lifecycleRecord.sourceRevision !== (bootstrap.ciContext.sourceRevision ?? null)) {
    mismatches.push('source revision');
  }
  if (
    JSON.stringify(lifecycleRecord.fallbackRefLineagePrefixes) !==
    JSON.stringify(cacheModel.fallbackRefLineagePrefixes)
  ) {
    mismatches.push('fallback ref lineages');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Cache lifecycle configuration drift between prepare and finalize: ${mismatches.join(', ')}. Refusing to save under inconsistent cache identity.`,
    );
  }

  return {
    ...bootstrap,
    cacheModel: {
      ...cacheModel,
      plannedGenerationId: lifecycleRecord.plannedGenerationId,
    },
  };
}

async function maybeCollectCacheGarbage(
  bootstrap: BootstrapExecution,
): Promise<TimestampCacheGcResult | null> {
  if (
    bootstrap.config.cacheGcMode === 'off' ||
    !bootstrap.cacheModel ||
    bootstrap.config.readOnly ||
    bootstrap.config.jobMode === 'distributed-worker'
  ) {
    return null;
  }

  return await collectTimestampCacheGarbage(bootstrap.cacheModel, {
    olderThanDays: bootstrap.config.cacheGcOlderThanDays,
  });
}

async function saveFinalizeBaseCache(
  bootstrap: BootstrapExecution,
  lifecycleRecord: PersistedCacheLifecycleRecord,
  dependencies: FinalizeActionDependencies,
  currentManifest: CacheManifest,
): Promise<BaseCacheOperationResult | null> {
  const cacheModel = bootstrap.cacheModel;
  if (!cacheModel) {
    return null;
  }

  const currentManifestDigest = calculateCanonicalCacheManifestDigest(currentManifest);
  const generationDecision = decideBaseCacheGeneration({
    restoreStatus: lifecycleRecord.restoreResult.status,
    preBuildManifestDigest: lifecycleRecord.preBuildManifestDigest,
    currentManifestDigest,
    currentEntryCount: currentManifest.partitions.reduce(
      (count, partition) => count + partition.entries.length,
      0,
    ),
    dependentMutationCount: lifecycleRecord.dependentDelta?.totalChangedCount ?? 0,
  });
  const saveResult = await saveBaseCache(
    bootstrap.config,
    cacheModel,
    () =>
      generationDecision.required ? createCacheGeneration(cacheModel, currentManifestDigest) : null,
    {
      cacheBackend: dependencies.cacheBackend,
    },
  );

  if (
    bootstrap.config.jobMode === 'distributed-aggregator' &&
    !bootstrap.config.readOnly &&
    generationDecision.required &&
    saveResult.status !== 'saved'
  ) {
    throw new Error(
      `Distributed aggregation required a durable base-cache generation, but publication ended with '${saveResult.status}': ${saveResult.message}`,
    );
  }

  return saveResult;
}

function withBaseCacheResult(
  bootstrap: BootstrapExecution,
  baseCacheResult: BaseCacheOperationResult | null,
): BootstrapExecution {
  return {
    ...bootstrap,
    baseCacheResult,
  };
}

async function uploadFinalizeArtifact(
  deltaManifest: Parameters<typeof stageDeltaArtifactPackage>[2],
  bootstrap: BootstrapExecution,
  lifecycleRecord: PersistedCacheLifecycleRecord,
  dependencies: FinalizeActionDependencies,
): Promise<FinalizeDeltaArtifactResult> {
  const counts = countDeltaEntries(deltaManifest);

  if (bootstrap.config.jobMode !== 'distributed-worker') {
    return {
      status: 'not-distributed-worker',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      producerAttempt: null,
      restoredGenerationKey: null,
      preBuildManifestDigest: null,
      emptyEnvelope: false,
      ...counts,
      message: `Delta artifact upload skipped because only distributed-worker jobs publish delta artifacts; current mode is '${bootstrap.config.jobMode}'.`,
    };
  }

  if (bootstrap.config.readOnly) {
    return {
      status: 'read-only',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      producerAttempt: null,
      restoredGenerationKey: null,
      preBuildManifestDigest: null,
      emptyEnvelope: false,
      ...counts,
      message: 'Delta artifact upload skipped because read-only mode is enabled.',
    };
  }

  const artifactBackend = dependencies.artifactBackend;
  const deltaArtifactExecutionContext = {
    ...bootstrap.ciContext,
    jobName: lifecycleRecord.executionIdentity.jobName,
    runId: lifecycleRecord.executionIdentity.runId,
    runAttempt: lifecycleRecord.executionIdentity.runAttempt,
    sourceRevision: lifecycleRecord.sourceRevision,
  };
  const stagedPackage = await stageDeltaArtifactPackage(
    deltaArtifactExecutionContext,
    bootstrap.cacheModel!,
    deltaManifest,
    {
      lifecycleIdentity: {
        restoredGenerationKey: lifecycleRecord.restoreResult.matchedKey,
        preBuildManifestDigest: lifecycleRecord.preBuildManifestDigest,
      },
    },
  );

  try {
    const uploadedPackage = await uploadDeltaArtifactPackage(artifactBackend, stagedPackage, {
      retentionDays: DELTA_ARTIFACT_RETENTION_DAYS,
    });
    return {
      status: 'uploaded',
      artifactName: uploadedPackage.artifact.name,
      artifactId: uploadedPackage.artifact.id,
      artifactSizeBytes: uploadedPackage.artifact.size,
      producerAttempt: lifecycleRecord.executionIdentity.runAttempt,
      restoredGenerationKey: lifecycleRecord.restoreResult.matchedKey,
      preBuildManifestDigest: lifecycleRecord.preBuildManifestDigest,
      emptyEnvelope: counts.totalChangedCount === 0,
      ...counts,
      message:
        `Uploaded delta artifact '${uploadedPackage.artifact.name}' ` +
        `${counts.totalChangedCount === 0 ? 'as an explicit empty envelope' : `with ${counts.addedCount} added, ${counts.modifiedCount} modified, ${counts.deletedCount} deleted cache path(s)`}; ` +
        `unconsumed artifacts expire after ${DELTA_ARTIFACT_RETENTION_DAYS} day(s).`,
    };
  } finally {
    await rm(stagedPackage.stagingDirectory, { recursive: true, force: true });
  }
}

async function cleanupConsumedDeltaArtifacts(
  bootstrap: BootstrapExecution,
  lifecycleRecord: PersistedCacheLifecycleRecord | null,
  dependencies: FinalizeActionDependencies,
): Promise<FinalizeConsumedDeltaCleanupResult | null> {
  if (bootstrap.config.jobMode !== 'distributed-aggregator') {
    return null;
  }

  const artifactNames = [...new Set(lifecycleRecord?.dependentDelta?.artifactNames ?? [])];

  if (artifactNames.length === 0) {
    return {
      attemptedArtifactNames: [],
      deletedArtifactNames: [],
      warnings: [],
      message:
        'Consumed delta artifact cleanup skipped because no dependent artifact names were persisted during the prepare phase.',
    };
  }

  const artifactBackend = dependencies.artifactBackend;
  if (!artifactBackend.capabilities.supportsDeletion) {
    return {
      attemptedArtifactNames: artifactNames,
      deletedArtifactNames: [],
      warnings: [
        'Consumed delta artifact cleanup skipped because the artifact backend does not support deletion.',
      ],
      message:
        'Consumed delta artifact cleanup skipped because the artifact backend does not support deletion.',
    };
  }

  const deleteResults = await Promise.allSettled(
    artifactNames.map(async (artifactName) => {
      await artifactBackend.deleteArtifact(artifactName);
      return artifactName;
    }),
  );

  const deletedArtifactNames: string[] = [];
  const warnings: string[] = [];
  for (const [index, result] of deleteResults.entries()) {
    const artifactName = artifactNames[index]!;
    if (result.status === 'fulfilled') {
      deletedArtifactNames.push(result.value);
      continue;
    }

    warnings.push(
      `Failed to delete consumed delta artifact '${artifactName}': ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  }

  return {
    attemptedArtifactNames: artifactNames,
    deletedArtifactNames,
    warnings,
    message: `Consumed delta artifact cleanup deleted ${deletedArtifactNames.length} of ${artifactNames.length} persisted artifact(s).`,
  };
}

function countDeltaEntries(deltaManifest: Parameters<typeof stageDeltaArtifactPackage>[2]): {
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly totalChangedCount: number;
} {
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;

  for (const partition of deltaManifest.partitions) {
    for (const entry of partition.entries) {
      if (entry.changeType === 'added') {
        addedCount += 1;
      } else if (entry.changeType === 'modified') {
        modifiedCount += 1;
      } else {
        deletedCount += 1;
      }
    }
  }

  return {
    addedCount,
    modifiedCount,
    deletedCount,
    totalChangedCount: addedCount + modifiedCount + deletedCount,
  };
}

/**
 * Renders the Markdown job-summary lines for the finalize phase.
 *
 * Produces a top-level status heading with an overall health icon, a build section whose lines
 * are supplied by the active {@link BuildToolAdapter}, and collapsible details covering cache
 * statistics, delta artifact results, and any warnings.
 */
export function createFinalizeActionSummaryLines(status: FinalizeActionStatus): readonly string[] {
  const summaryIssues = collectFinalizeActionSummaryIssues(status);
  const overallStatus = determineOverallSummaryStatus(summaryIssues);
  const toolName = status.bootstrap.buildToolAdapter.getName();
  const cacheModel = status.bootstrap.cacheModel;
  const saveResult =
    status.bootstrap.baseCacheResult?.operation === 'save'
      ? status.bootstrap.baseCacheResult
      : null;
  const lifecycleLines = cacheModel
    ? [
        '',
        '### Cache lifecycle',
        `- Cache family: ${escapeSummaryText(cacheModel.cacheFamilyKey)}`,
        `- Current ref lineage: ${escapeSummaryText(cacheModel.currentRefLineagePrefix)}`,
        `- Restore status: ${escapeSummaryText(status.baseCacheRestoreResult?.status ?? 'not evaluated')}`,
        `- Restored generation: ${escapeSummaryText(status.baseCacheRestoreResult?.matchedKey ?? 'none')}`,
        `- Save status: ${escapeSummaryText(saveResult?.status ?? 'not evaluated')}`,
        ...(saveResult?.status === 'saved' && saveResult.generationKey
          ? [
              `- Published generation: ${escapeSummaryText(saveResult.generationKey)}`,
              `- Published cache ID: ${saveResult.cacheId ?? 'not reported'}`,
            ]
          : []),
        ...(status.deltaArtifactResult?.status === 'uploaded'
          ? [
              `- Delta artifact: ${escapeSummaryText(status.deltaArtifactResult.artifactName ?? 'unknown')}${status.deltaArtifactResult.emptyEnvelope ? ' (empty envelope)' : ''}`,
              `- Delta producer attempt: ${status.deltaArtifactResult.producerAttempt ?? 'unknown'}`,
              `- Delta restored base: ${escapeSummaryText(status.deltaArtifactResult.restoredGenerationKey ?? 'none')}`,
              `- Delta pre-build digest: ${escapeSummaryText(status.deltaArtifactResult.preBuildManifestDigest?.slice(0, 12) ?? 'unknown')}`,
              `- Delta changes: ${status.deltaArtifactResult.addedCount} added, ${status.deltaArtifactResult.modifiedCount} modified, ${status.deltaArtifactResult.deletedCount} deleted`,
            ]
          : []),
      ]
    : [];
  const issueLines = [
    ...(summaryIssues.errors.length > 0
      ? ['', '### Errors', ...summaryIssues.errors.map((issue) => `- ${escapeSummaryText(issue)}`)]
      : []),
    ...(summaryIssues.warnings.length > 0
      ? [
          '',
          '### Warnings',
          ...summaryIssues.warnings.map((warning) => `- ${escapeSummaryText(warning)}`),
        ]
      : []),
  ];
  return [
    `## Buildish Mammoth Cache for ${toolName}`,
    `${getSummaryStatusIcon(overallStatus)} Overall status: ${getSummaryStatusLabel(overallStatus)}`,
    '',
    status.jobUrl
      ? `### ${createHtmlLink(status.jobUrl, `${toolName} builds`)}`
      : `### ${toolName} builds`,
    ...status.buildReport.summaryLines,
    ...lifecycleLines,
    ...issueLines,
  ];
}

/**
 * Renders the log-group lines for the finalize phase.
 *
 * Produces a compact machine-readable list of outcomes: bootstrap message, overall status icon,
 * build-report log lines, execution details URL, any errors or warnings, delta-artifact and
 * consumed-delta notes, and the cache key / statistics summary. The output is written to the
 * CI log group opened by {@link executeFinalizeAction}.
 */
export function createFinalizeActionLogLines(status: FinalizeActionStatus): readonly string[] {
  const summaryIssues = collectFinalizeActionSummaryIssues(status);
  const overallStatus = determineOverallSummaryStatus(summaryIssues);
  const lines = [
    ...createBootstrapLogLines(status.bootstrap),
    `${getSummaryStatusIcon(overallStatus)} Overall status: ${getSummaryStatusLabel(overallStatus)}`,
    ...status.buildReport.logLines,
  ];

  if (status.jobUrl) {
    lines.push(`Execution details: ${status.jobUrl}`);
  } else if (status.workflowRunUrl) {
    lines.push(`Execution details: ${status.workflowRunUrl}`);
  }

  for (const issue of summaryIssues.errors) {
    lines.push(`Error: ${issue}`);
  }
  for (const warning of summaryIssues.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  if (status.deltaArtifactResult?.artifactName) {
    const detailParts = [`Uploaded delta artifact '${status.deltaArtifactResult.artifactName}'`];
    if (status.deltaArtifactResult.artifactId !== null) {
      detailParts.push(`ID ${status.deltaArtifactResult.artifactId}`);
    }
    if (status.deltaArtifactResult.artifactSizeBytes !== null) {
      detailParts.push(formatByteCount(status.deltaArtifactResult.artifactSizeBytes));
    }
    lines.push(formatUploadedArtifactLogMessage(detailParts));
  }

  if (status.consumedDeltaCleanupResult?.attemptedArtifactNames.length) {
    lines.push(
      `Attempted cleanup of consumed delta artifacts: ${status.consumedDeltaCleanupResult.attemptedArtifactNames.join(', ')}.`,
    );
  }

  if (status.consumedDeltaCleanupResult?.deletedArtifactNames.length) {
    lines.push(
      `Deleted consumed delta artifacts: ${status.consumedDeltaCleanupResult.deletedArtifactNames.join(', ')}.`,
    );
  }

  lines.push(...createCacheDetailLogLines(status), ...createExecutionContextLogLines(status));

  return lines;
}

function createCacheDetailLogLines(status: FinalizeActionStatus): readonly string[] {
  if (!status.bootstrap.cacheModel) {
    return [];
  }

  const lines = [
    `Base cache restore: ${status.baseCacheRestoreResult?.status ?? 'not evaluated'}.`,
    `Cache GC: ${describeCacheGcSummary(status.cacheGcResult)}.`,
    `Base cache save: ${status.bootstrap.baseCacheResult?.status ?? 'not evaluated'}.`,
    `Delta artifact: ${status.deltaArtifactResult?.status ?? 'not evaluated'}.`,
  ];

  if (status.baseCacheRestoreResult?.matchedKey) {
    lines.push(`Restored base cache generation: ${status.baseCacheRestoreResult.matchedKey}.`);
  }

  const saveResult =
    status.bootstrap.baseCacheResult?.operation === 'save'
      ? status.bootstrap.baseCacheResult
      : null;
  if (saveResult?.status === 'saved' && saveResult.generationKey) {
    lines.push(`Published base cache generation: ${saveResult.generationKey}.`);
  } else if (saveResult?.status === 'failed' && saveResult.generationKey) {
    lines.push(`Attempted base cache generation: ${saveResult.generationKey}.`);
  }

  if (status.deltaArtifactResult) {
    lines.push(
      `Post-build cache delta: ${status.deltaArtifactResult.addedCount} added, ${status.deltaArtifactResult.modifiedCount} modified, ${status.deltaArtifactResult.deletedCount} deleted.`,
    );
  }

  if (status.consumedDeltaCleanupResult) {
    lines.push(
      `Consumed delta cleanup: deleted ${status.consumedDeltaCleanupResult.deletedArtifactNames.length} of ${status.consumedDeltaCleanupResult.attemptedArtifactNames.length}.`,
    );
  }

  if (status.cacheGcResult) {
    lines.push(status.cacheGcResult.message);
  }

  if (status.cacheStatistics) {
    lines.push(...createCacheStatisticsLogLines(status.cacheStatistics));
  }

  return lines;
}

function describeCacheGcSummary(result: TimestampCacheGcResult | null): string {
  if (!result) {
    return 'off';
  }

  return `${result.mode} (${result.deletedFileCount} deleted)`;
}

function createExecutionContextLogLines(status: FinalizeActionStatus): readonly string[] {
  return [
    `Post-action detail: ${status.message}`,
    `Post-action cache context: family '${status.bootstrap.cacheModel?.cacheFamilyKey ?? 'disabled'}', current ref lineage '${status.bootstrap.cacheModel?.currentRefLineagePrefix ?? 'disabled'}', Java major '${status.bootstrap.cacheModel ? renderCacheJavaMajor(status.bootstrap.cacheModel.javaMajor) : 'n/a'}', cache partitions ${status.bootstrap.cacheModel?.partitions.length ?? 0}.`,
  ];
}

function collectFinalizeActionSummaryIssues(status: FinalizeActionStatus): {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (status.buildReport.anyBuildFailed) {
    errors.push(`One or more ${status.bootstrap.buildToolAdapter.getName()} builds failed.`);
  }

  warnings.push(...status.buildReport.warnings);
  warnings.push(...(status.consumedDeltaCleanupResult?.warnings ?? []));

  const restoreWarning = getBaseCacheWarning(status.baseCacheRestoreResult);
  if (restoreWarning) {
    warnings.push(restoreWarning);
  }

  const saveWarning = getBaseCacheWarning(status.bootstrap.baseCacheResult);
  if (saveWarning) {
    warnings.push(saveWarning);
  }

  return {
    errors,
    warnings,
  };
}

function determineOverallSummaryStatus(summaryIssues: {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}): 'success' | 'warning' | 'error' {
  if (summaryIssues.errors.length > 0) {
    return 'error';
  }
  if (summaryIssues.warnings.length > 0) {
    return 'warning';
  }
  return 'success';
}

function getSummaryStatusIcon(status: 'success' | 'warning' | 'error'): string {
  if (status === 'error') {
    return '❌';
  }
  if (status === 'warning') {
    return '⚠️';
  }
  return '✅';
}

function getSummaryStatusLabel(status: 'success' | 'warning' | 'error'): string {
  if (status === 'error') {
    return 'issues detected';
  }
  if (status === 'warning') {
    return 'completed with warnings';
  }
  return 'success';
}

function createCacheStatisticsLogLines(
  cacheStatistics: FinalizeCacheStatistics,
): readonly string[] {
  const hasAvailableRow = cacheStatistics.rows.some((row) => row.total !== null);
  if (!hasAvailableRow) {
    return [];
  }

  return [
    'Cache partition statistics (manifest-derived, uncompressed content sizes):',
    ...cacheStatistics.rows
      .filter((row) => row.total !== null)
      .map((row) => {
        const partitionSummary = row.partitions
          .map(
            (cell, index) =>
              `${cacheStatistics.partitionDisplayNames[index] ?? `Partition ${index + 1}`}: ${formatCacheStatisticCell(cell)}`,
          )
          .join('; ');
        return `- ${row.label}: total ${formatCacheStatisticCell(row.total)}; ${partitionSummary}`;
      }),
    'Note: base-cache rows reflect cache-manifest snapshots, not the compressed size of the backend cache entry.',
  ];
}

function formatUploadedArtifactLogMessage(detailParts: readonly string[]): string {
  if (detailParts.length === 0) {
    return 'Uploaded delta artifact.';
  }

  const [subject, ...details] = detailParts;
  return details.length > 0 ? `${subject} (${details.join(', ')}).` : `${subject}.`;
}

function createFinalizeCacheStatistics(
  cacheModel: CacheModel,
  preBuildManifest: CacheManifest,
  currentManifest: CacheManifest,
  deltaManifest: CacheDeltaManifest,
  baseCacheRestoreResult: BaseCacheRestoreResult | null,
  deltaArtifactResult: FinalizeDeltaArtifactResult,
  baseCacheSaveResult: BootstrapExecution['baseCacheResult'],
): FinalizeCacheStatistics {
  const pulledBaseCache =
    baseCacheRestoreResult?.status === 'current-lineage-hit' ||
    baseCacheRestoreResult?.status === 'fallback-lineage-hit'
      ? summarizeManifest(cacheModel, preBuildManifest)
      : null;
  const deltaArtifact =
    deltaArtifactResult.status === 'uploaded'
      ? summarizeDeltaPayload(cacheModel, deltaManifest)
      : null;
  const uploadedBaseCache =
    baseCacheSaveResult?.operation === 'save' && baseCacheSaveResult.status === 'saved'
      ? summarizeManifest(cacheModel, currentManifest)
      : null;

  return {
    partitionDisplayNames: cacheModel.partitions.map((partition) => partition.displayName),
    rows: [
      createCacheStatisticRow('Pulled base cache', cacheModel, pulledBaseCache),
      createCacheStatisticRow('Delta artifact', cacheModel, deltaArtifact),
      createCacheStatisticRow('Uploaded base cache', cacheModel, uploadedBaseCache),
    ],
  };
}

function createCacheStatisticRow(
  label: string,
  cacheModel: CacheModel,
  statistics: ReadonlyMap<string, FinalizeCacheStatisticCell> | null,
): FinalizeCacheStatisticRow {
  const total = statistics ? summarizeStatisticCells(Array.from(statistics.values())) : null;
  return {
    label,
    total,
    partitions: cacheModel.partitions.map((partition) => statistics?.get(partition.id) ?? null),
  };
}

function summarizeManifest(
  cacheModel: CacheModel,
  manifest: CacheManifest,
): ReadonlyMap<string, FinalizeCacheStatisticCell> {
  const statistics = initializeCacheStatistics(cacheModel);
  for (const partition of manifest.partitions) {
    const cell = statistics.get(partition.partitionId);
    if (!cell) {
      continue;
    }
    for (const entry of partition.entries) {
      cell.fileCount += 1;
      cell.totalSizeBytes += entry.size;
    }
  }
  return statistics;
}

function summarizeDeltaPayload(
  cacheModel: CacheModel,
  manifest: CacheDeltaManifest,
): ReadonlyMap<string, FinalizeCacheStatisticCell> {
  const statistics = initializeCacheStatistics(cacheModel);
  for (const partition of manifest.partitions) {
    const cell = statistics.get(partition.partitionId);
    if (!cell) {
      continue;
    }
    for (const entry of partition.entries) {
      if (!entry.current) {
        continue;
      }
      cell.fileCount += 1;
      cell.totalSizeBytes += entry.current.size;
    }
  }
  return statistics;
}

function initializeCacheStatistics(
  cacheModel: CacheModel,
): Map<string, FinalizeCacheStatisticCell> {
  return new Map(
    cacheModel.partitions.map((partition) => [
      partition.id,
      { fileCount: 0, totalSizeBytes: 0 } satisfies FinalizeCacheStatisticCell,
    ]),
  );
}

function summarizeStatisticCells(
  cells: readonly FinalizeCacheStatisticCell[],
): FinalizeCacheStatisticCell {
  return cells.reduce<FinalizeCacheStatisticCell>(
    (summary, cell) => ({
      fileCount: summary.fileCount + cell.fileCount,
      totalSizeBytes: summary.totalSizeBytes + cell.totalSizeBytes,
    }),
    { fileCount: 0, totalSizeBytes: 0 },
  );
}

function formatCacheStatisticCell(cell: FinalizeCacheStatisticCell | null): string {
  if (!cell) {
    return 'n/a';
  }
  return `${cell.fileCount} ${pluralize('file', cell.fileCount)} / ${formatByteCount(cell.totalSizeBytes)}`;
}

function getBaseCacheWarning(
  result: BaseCacheRestoreResult | BootstrapExecution['baseCacheResult'] | null,
): string | null {
  if (!result) {
    return null;
  }

  if (result.operation === 'restore') {
    if (result.status === 'feature-unavailable') {
      return result.message;
    }
    return null;
  }

  if (
    result.status === 'feature-unavailable' ||
    result.status === 'missing-paths' ||
    result.status === 'not-saved' ||
    result.status === 'failed'
  ) {
    return result.message;
  }

  return null;
}

/**
 * Converts a raw byte count into a human-readable string with an appropriate binary unit.
 *
 * Values below 1 024 are displayed as bytes (`N B`). Larger values step through KiB → MiB →
 * GiB → TiB; the loop caps at TiB so arbitrarily large inputs still produce a finite string.
 * Fractional values below 10 use two decimal places (`1.00 KiB`); values from 10 upward use
 * one decimal place (`10.0 KiB`). This function is exported so its boundary behaviour can be
 * pinned by unit tests independently of the finalize rendering pipeline.
 */
export function formatByteCount(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
