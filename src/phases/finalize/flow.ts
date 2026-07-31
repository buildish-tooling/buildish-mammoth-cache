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
import { bootstrapPhase, type BootstrapExecution, type BootstrapDependencies } from '../bootstrap';
import { collectTimestampCacheGarbage, type TimestampCacheGcResult } from '../../cache/gc';
import { decideBaseCacheGeneration } from '../../cache/lifecycle';
import type { CacheManifest } from '../../cache/manifest';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
} from '../../cache/manifest';
import { createCacheGeneration } from '../../cache/model';
import { saveBaseCache, type BaseCacheOperationResult } from '../../cache/service';
import {
  getPersistedCacheLifecycleRecord,
  loadPersistedPreBuildCacheManifest,
  type PersistedCacheLifecycleRecord,
} from './state';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import {
  createFinalizeActionLogLines,
  createFinalizeActionSummaryLines,
  createFinalizeCacheStatistics,
  type FinalizeActionStatus,
  type FinalizeConsumedDeltaCleanupResult,
  type FinalizeDeltaArtifactResult,
} from './reporting';

export {
  createFinalizeActionLogLines,
  createFinalizeActionSummaryLines,
  formatByteCount,
  type FinalizeActionStatus,
  type FinalizeConsumedDeltaCleanupResult,
  type FinalizeDeltaArtifactResult,
} from './reporting';

const DELTA_ARTIFACT_RETENTION_DAYS = 7;

/**
 * Injectable dependencies for the post (finalize) action flow.
 *
 * Extends {@link BootstrapDependencies} with the artifact backend used to upload worker
 * deltas or clean up consumed aggregator delta artifacts.
 */
export interface FinalizeActionDependencies extends BootstrapDependencies {
  readonly artifactBackend?: WorkflowArtifactBackend;
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
    !bootstrap.config.cleanupEnabled ||
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

  const artifactBackend = resolveFinalizeArtifactBackend(dependencies);
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

  if (bootstrap.config.readOnly) {
    return {
      attemptedArtifactNames: [],
      deletedArtifactNames: [],
      warnings: [],
      message:
        'Consumed delta artifact cleanup skipped because read-only mode disables artifact exchange.',
    };
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

  const artifactBackend = resolveFinalizeArtifactBackend(dependencies);
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

function resolveFinalizeArtifactBackend(
  dependencies: Pick<FinalizeActionDependencies, 'artifactBackend'>,
): WorkflowArtifactBackend {
  const { artifactBackend } = dependencies;
  if (!artifactBackend) {
    throw new Error('Artifact backend dependency is required for writable artifact operations.');
  }
  return artifactBackend;
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
