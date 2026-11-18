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
import {
  changedPartitionIds,
  freezePartitionPublication,
  publishPartitionGeneration,
  partitionPublicationLines,
  cleanPublishedPartitionStaging,
} from '../../cache/partition-publication';
import { rm } from 'node:fs/promises';
import { bootstrapPhase, type BootstrapDependencies } from '../bootstrap';
import {
  preflightCutoffLifecycle,
  consumeCutoffPreflight,
  cutoffExecution,
  type CutoffPreflight,
} from '../cutoff-lifecycle';
import {
  cutoffPolicy,
  cutoffModelSchema,
  persistCutoffJournal,
  verifyCutoffReplay,
  cutoffDecisionDigest,
} from '../../cache/cutoff-state';
import { collectCutoffGarbage } from '../../cache/cutoff-gc';
import { createCacheGeneration } from '../../cache/model';
import { saveBaseCache, createBaseCachePaths, type BaseCacheSaveResult } from '../../cache/service';
import { stageCutoffPackage, uploadCutoffPackage } from '../../delta/cutoff-service';
import {
  captureLocalPartitionSnapshots,
  projectedSnapshotStatistics,
  partitionSnapshotSummary,
} from '../../cache/snapshot-lifecycle';
import { ownsSnapshot, verifySnapshotTransport } from '../../cache/partition-snapshots';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import {
  createFinalizeActionLogLines,
  createFinalizeActionSummaryLines,
  createFinalizeCacheStatistics,
  type FinalizeActionStatus,
  type FinalizeDeltaArtifactResult,
} from './reporting';
export {
  createFinalizeActionLogLines,
  createFinalizeActionSummaryLines,
  formatByteCount,
  type FinalizeActionStatus,
  type FinalizeDeltaArtifactResult,
} from './reporting';

export interface FinalizeActionDependencies extends BootstrapDependencies {
  readonly artifactBackend?: WorkflowArtifactBackend;
  readonly removeTemporaryDirectory?: (p: string) => Promise<void>;
  readonly preflight?: CutoffPreflight;
}
export async function executeFinalizeAction(
  d: FinalizeActionDependencies,
): Promise<FinalizeActionStatus> {
  // Direct callers also validate state and freeze writable observations before content reads.
  const pre = consumeCutoffPreflight(
    d.preflight ?? (await preflightCutoffLifecycle(d.runtimeHost.getState)),
    d.runtimeHost.getState,
  );
  let bootstrap = await bootstrapPhase('finalize', d);
  const { record, journal: state } = pre;
  if (
    record.cacheEnabled !== !!bootstrap.cacheModel ||
    JSON.stringify(cutoffExecution(bootstrap.ciContext)) !== JSON.stringify(record.execution)
  )
    throw new Error('Cache lifecycle configuration drift.');
  if (record.cacheEnabled) {
    const model = cutoffModelSchema.parse({
      ...bootstrap.cacheModel,
      plannedGenerationId: record.model.plannedGenerationId,
    });
    if (
      JSON.stringify(model) !== JSON.stringify(record.model) ||
      JSON.stringify(cutoffPolicy(bootstrap.config)) !== JSON.stringify(record.policy)
    )
      throw new Error('Cache lifecycle model/policy configuration drift.');
    bootstrap = { ...bootstrap, cacheModel: record.model };
  }
  const report = await bootstrap.buildToolAdapter.collectBuildReport(bootstrap.ciContext);
  const buildReport = {
    ...report,
    warnings: [...report.warnings, ...(state?.snapshotWarnings ?? [])],
  };
  let cacheGcResult: FinalizeActionStatus['cacheGcResult'] = null;
  let deltaArtifactResult: FinalizeDeltaArtifactResult | null = null;
  if (state?.policy.readOnly) {
    const save = await saveBaseCache(bootstrap.config, state.model, () => null, d);
    deltaArtifactResult = {
      status: 'read-only',
      artifactName: null,
      artifactId: null,
      artifactSizeBytes: null,
      emptyEnvelope: false,
      upsertCount: null,
      usedCount: null,
      message: 'Worker envelope publication skipped in read-only mode.',
    };
    if (state.phase !== 'completed') {
      state.phase = 'completed';
      await persistCutoffJournal(state);
      await cleanPublishedPartitionStaging(state).catch((e: unknown) =>
        d.runtimeHost.warning(`Could not remove publication staging: ${String(e)}`),
      );
    }
    bootstrap = { ...bootstrap, baseCacheResult: save };
  } else if (state) {
    // Reports may read managed files but must not change the retained metadata projection.
    await verifyCutoffReplay(state);
    cacheGcResult = await collectCutoffGarbage(state);
    await captureLocalPartitionSnapshots(state);
    const selection = state.selection!;
    if (state.policy.jobMode === 'distributed-worker' && !state.policy.readOnly) {
      if (!d.artifactBackend) throw new Error('Artifact backend dependency is required.');
      const pkg = state.workerReceipt ? null : await stageCutoffPackage(state, bootstrap.ciContext);
      try {
        const uploaded =
          state.workerReceipt ?? (await uploadCutoffPackage(d.artifactBackend, pkg!));
        state.workerReceipt = { name: uploaded.name, id: uploaded.id, size: uploaded.size };
        await persistCutoffJournal(state);
        deltaArtifactResult = {
          status: 'uploaded',
          artifactName: uploaded.name,
          artifactId: uploaded.id,
          artifactSizeBytes: uploaded.size,
          emptyEnvelope:
            !selection.upserts.length &&
            !selection.used.length &&
            !state.model.partitions.some((p) =>
              ownsSnapshot(p, state.policy.jobMode, state.execution.jobName),
            ),
          upsertCount: selection.upserts.length,
          usedCount: selection.used.length,
          message: `Uploaded worker envelope '${uploaded.name}'.`,
        };
      } finally {
        if (pkg)
          await (d.removeTemporaryDirectory ?? ((p) => rm(p, { recursive: true, force: true })))(
            pkg.rootDirectory,
          ).catch((e: unknown) =>
            d.runtimeHost.warning(`Could not remove worker staging: ${String(e)}`),
          );
      }
    } else {
      deltaArtifactResult = {
        status: state.policy.readOnly ? 'read-only' : 'not-distributed-worker',
        artifactName: null,
        artifactId: null,
        artifactSizeBytes: null,
        emptyEnvelope: false,
        upsertCount: selection.upserts.length,
        usedCount: selection.used.length,
        message: 'No worker envelope publication for this mode.',
      };
    }
    await verifyCutoffReplay(state);
    const required = !!state.publicationKey || changedPartitionIds(state).length > 0;
    const eligible = !state.policy.readOnly && state.policy.jobMode !== 'distributed-worker';
    const generation =
      required && eligible ? createCacheGeneration(state.model, cutoffDecisionDigest(state)) : null;
    if (generation) {
      if (state.publicationKey && state.publicationKey !== generation.key)
        throw new Error('Frozen publication identity changed.');
      if (!state.saved) await freezePartitionPublication(state, generation);
    }
    let save: BaseCacheSaveResult;
    if (state.saved) {
      save = {
        operation: 'save',
        status: 'saved',
        generationKey: state.publicationKey,
        cacheId: null,
        paths: createBaseCachePaths(state.model),
        message: 'Reused locally recorded successful publication.',
      };
    } else {
      if (generation)
        await verifySnapshotTransport(
          state.model,
          new Map(state.partitionSnapshots.map((s) => [s.partitionId, s.digest])),
        );
      save = await saveBaseCache(bootstrap.config, state.model, () => generation, {
        ...d,
        publishGeneration: () => publishPartitionGeneration(state, d.cacheBackend),
      });
    }
    if (eligible && required && save.status !== 'saved') {
      if (state.policy.jobMode === 'distributed-aggregator')
        throw new Error(
          `Distributed aggregation required a durable base-cache generation: ${save.status}: ${save.message}`,
        );
      d.runtimeHost.warning(save.message);
      // Keep publication intent and original decisions for retry.
    } else {
      state.saved = save.status === 'saved';
      state.phase = 'completed';
      await persistCutoffJournal(state);
      await cleanPublishedPartitionStaging(state).catch((e: unknown) =>
        d.runtimeHost.warning(`Could not remove publication staging: ${String(e)}`),
      );
    }
    bootstrap = { ...bootstrap, baseCacheResult: save };
  }
  const status: FinalizeActionStatus = {
    bootstrap,
    baseCacheRestoreResult: record.cacheEnabled ? record.restoreResult : null,
    cacheGcResult,
    cacheStatistics: state?.selection
      ? {
          ...createFinalizeCacheStatistics(state.selection!),
          ...projectedSnapshotStatistics(state),
        }
      : null,
    partitionSnapshotLines: state
      ? [...partitionSnapshotSummary(state), ...partitionPublicationLines(state)]
      : [],
    deltaArtifactResult,
    buildReport,
    ...bootstrap.ciExecutionUrls,
    message: state?.policy.readOnly
      ? 'Read-only finalize completed without post-build cache observations.'
      : 'Finalize completed with cutoff-based observations.',
    activityCutoff: state?.cutoff ?? null,
  };
  bootstrap.reportSink.publishLogGroup(
    `Buildish Mammoth Cache for ${bootstrap.buildToolAdapter.getName()}`,
    createFinalizeActionLogLines(status),
    d.runtimeHost.info,
  );
  await bootstrap.reportSink.replaceSummary(createFinalizeActionSummaryLines(status));
  return status;
}
