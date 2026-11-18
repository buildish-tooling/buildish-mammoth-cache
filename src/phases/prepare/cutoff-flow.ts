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
import { mkdir, rm } from 'node:fs/promises';
import {
  bootstrapPhase,
  createBootstrapLogLines,
  type BootstrapDependencies,
  type BootstrapExecution,
} from '../bootstrap';
import {
  newCutoffJournal,
  persistCutoffJournal,
  cutoffPolicy,
  assertPrepareWorkerBudget,
  type CutoffJournal,
} from '../../cache/cutoff-state';
import { persistCutoffLifecycle, cutoffExecution } from '../cutoff-lifecycle';
import { selectDeltaArtifactsForProducerJobs } from '../../delta/discovery';
import { downloadCutoffPackage, type DownloadedCutoffPackage } from '../../delta/cutoff-service';
import { mergeCutoffPackages, applyCutoffPlan } from '../../delta/cutoff-apply';
import { metadataPath } from '../../cache/metadata-io';
import { CUTOFF_STATE_DIRECTORY } from '../../cache/metadata-paths';
import { captureCacheMetadataSnapshot } from '../../cache/manifest';
import { guardedPath, regularStat, verifyParents } from '../../cache/guarded-files';
import { fileIdentity, sameFileIdentity } from '../../cache/file-identity';
import { restoreBaseCache } from '../../cache/service';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { PublicActionOutputName } from '../../config/public-contract';
import { escapeSummaryText } from '../../util/html';
import {
  snapshotPartitions,
  clearSnapshotFiles,
  resetSnapshotTransport,
  stagePartitionSnapshot,
  restorePartitionSnapshot,
} from '../../cache/partition-snapshots';
import {
  initializePartitionSnapshots,
  snapshotRecord,
  partitionSnapshotSummary,
} from '../../cache/snapshot-lifecycle';

export interface CutoffPrepareDependencies extends BootstrapDependencies {
  artifactBackend?: WorkflowArtifactBackend;
  removeTemporaryDirectory?: (p: string) => Promise<void>;
  now?: () => number;
}
export interface CutoffDependentResult {
  status: 'applied' | 'skipped-read-only';
  requestedJobs: readonly string[];
  appliedArtifactCount: number;
  downloadedArtifactNames: string[];
  upsertCount: number;
  usedCount: number;
  selectedProducers: {
    jobName: string;
    runAttempt: number | null;
    artifactName: string;
    restoredGenerationKey: string | null;
  }[];
  warnings: string[];
  message: string;
}
export interface CutoffPrepareStatus {
  partitionSnapshotLines?: string[];
  bootstrap: BootstrapExecution;
  restoreCleanupResult: {
    mode: 'prune-managed';
    status: 'pruned' | 'skipped-no-hit';
    deletedFileCount: number;
    message: string;
  } | null;
  dependentDeltaResult: CutoffDependentResult | null;
  cutoff: number | null;
  message: string;
}
export async function executeCutoffPrepareAction(
  dependencies: CutoffPrepareDependencies,
): Promise<CutoffPrepareStatus> {
  let journal: CutoffJournal | undefined;
  const bootstrap = await bootstrapPhase('prepare', {
    ...dependencies,
    beforeCacheWork: async (model) => {
      await mkdir(model.cacheRoot, { recursive: true });
      journal = newCutoffJournal(
        model,
        cutoffPolicy(dependencies.config),
        cutoffExecution(dependencies.ciProvider.context),
      );
      await persistCutoffJournal(journal);
      if (snapshotPartitions(model).length) {
        const removed = await clearSnapshotFiles(model);
        if (removed)
          journal.snapshotWarnings.push(
            `Replaced ${removed} preexisting managed snapshot file(s) before cache restore. Restore misses start these partitions empty.`,
          );
        await resetSnapshotTransport(model);
      }
      await dependencies.beforeCacheWork?.(model);
    },
  });
  await bootstrap.buildToolAdapter
    .installBuildHooks(bootstrap.ciContext)
    .catch((e: unknown) =>
      dependencies.runtimeHost.warning(`Could not install build hooks: ${String(e)}`),
    );
  let cleanup: CutoffPrepareStatus['restoreCleanupResult'] = null,
    dependent: CutoffDependentResult | null = null;
  if (!bootstrap.cacheModel) {
    persistCutoffLifecycle(
      { schemaVersion: 4, cacheEnabled: false, execution: cutoffExecution(bootstrap.ciContext) },
      dependencies.runtimeHost.saveState,
    );
  } else {
    const model = bootstrap.cacheModel,
      state = journal!;
    const restore = bootstrap.baseCacheResult;
    if (!restore || restore.operation !== 'restore')
      throw new Error('Prepare restore result is required.');
    state.restoredKey = restore.matchedKey;
    state.restoreStatus = restore.status;
    if (
      bootstrap.config.cleanupEnabled &&
      bootstrap.config.restoreCleanupMode === 'prune-managed'
    ) {
      let count = 0;
      if (restore.matchedKey) {
        // Optional explicit restore cleanup is the only prepare inventory traversal; not a baseline.
        const snapshot = await captureCacheMetadataSnapshot(model);
        for (const p of snapshot.partitions)
          for (const entry of p.entries) {
            await verifyParents(
              model.cacheRoot,
              entry.relativePath.split('/').slice(0, -1).join('/'),
            );
            const file = guardedPath(model.cacheRoot, entry.relativePath);
            const current = await regularStat(file);
            if (current) {
              if (!sameFileIdentity(entry.identity, fileIdentity(current), true))
                throw new Error('Restore cleanup target changed.');
              await rm(file);
              count++;
            }
          }
        await restoreBaseCache(model, dependencies, restore.matchedKey);
      }
      cleanup = {
        mode: 'prune-managed',
        status: restore.matchedKey ? 'pruned' : 'skipped-no-hit',
        deletedFileCount: count,
        message: `Restore cleanup removed ${count} managed file(s).`,
      };
    }
    await initializePartitionSnapshots(state, !!restore.matchedKey);
    const required = bootstrap.config.dependentJobs;
    const writerJobs =
      bootstrap.config.jobMode === 'distributed-aggregator'
        ? snapshotPartitions(model).flatMap((p) =>
            p.writer && p.writer !== bootstrap.ciContext.jobName ? [p.writer] : [],
          )
        : [];
    const requested = [...new Set([...required, ...writerJobs])];
    if (requested.length) {
      dependent = {
        status: bootstrap.config.readOnly ? 'skipped-read-only' : 'applied',
        requestedJobs: requested,
        appliedArtifactCount: 0,
        downloadedArtifactNames: [],
        upsertCount: 0,
        usedCount: 0,
        selectedProducers: [],
        warnings: [],
        message: bootstrap.config.readOnly
          ? 'Dependent artifacts skipped in read-only mode.'
          : 'Dependent worker envelopes applied.',
      };
      if (!bootstrap.config.readOnly) {
        const backend = dependencies.artifactBackend;
        if (!backend) throw new Error('Artifact backend dependency is required.');
        const selected = await selectDeltaArtifactsForProducerJobs(
            backend,
            requested,
            bootstrap.ciContext,
            { optionalProducerJobNames: requested.filter((name) => !required.includes(name)) },
          ),
          downloaded: DownloadedCutoffPackage[] = [];
        const marker = await metadataPath(
          model.cacheRoot,
          `${CUTOFF_STATE_DIRECTORY}/downloads/reserved`,
          true,
        );
        try {
          for (const pick of selected)
            downloaded.push(
              await downloadCutoffPackage(
                backend,
                pick.artifact,
                marker.slice(0, -'/reserved'.length),
                {
                  repository: bootstrap.ciContext.repository,
                  workflowName: bootstrap.ciContext.workflowName,
                  runId: bootstrap.ciContext.runId,
                  producerJobName: pick.producerJobName,
                  producerAttempt: pick.producerAttempt,
                  sourceRevision: bootstrap.ciContext.sourceRevision,
                },
              ),
            );
          const plan = mergeCutoffPackages(
            downloaded,
            model,
            bootstrap.ciContext,
            bootstrap.config.allowDuplicateDependentDeltaPaths,
            required,
          );
          const workers = {
              upserts: plan.upserts.map((e) => e.entry.relativePath),
              used: plan.used,
            },
            names = downloaded.map((p) => p.artifact.name);
          assertPrepareWorkerBudget(state, workers, names);
          const applied = await applyCutoffPlan(plan, model);
          for (const incoming of plan.snapshots ?? []) {
            const previous = state.partitionSnapshots.find(
              (s) => s.partitionId === incoming.partitionId,
            )!;
            const snapshot = await stagePartitionSnapshot(
              model,
              incoming.partitionId,
              incoming.rootDirectory,
              incoming.entries.map((e) => ({ ...e, sourcePath: e.payloadPath })),
            );
            await restorePartitionSnapshot(model, snapshot);
            state.partitionSnapshots = state.partitionSnapshots.map((s) =>
              s.partitionId === incoming.partitionId
                ? snapshotRecord(snapshot, previous.baselineDigest, 'writer')
                : s,
            );
          }
          for (const p of snapshotPartitions(model))
            if (
              writerJobs.includes(p.writer ?? '') &&
              !(plan.snapshots ?? []).some((s) => s.partitionId === p.id)
            )
              state.snapshotWarnings.push(
                `Partition '${p.id}' writer '${p.writer}' contributed no snapshot. Retaining previous metadata.`,
              );
          if (plan.directoryConflicts) {
            const { count, details } = plan.directoryConflicts;
            dependent.warnings.push(
              `Maven directory selection resolved ${count} conflicting directory view(s).`,
              ...details,
            );
            if (count > details.length)
              dependent.warnings.push(
                `${count - details.length} additional conflicting directories omitted.`,
              );
          }
          state.workers = { upserts: applied.upserts, used: plan.used };
          state.producerArtifacts = names;
          Object.assign(dependent, {
            appliedArtifactCount: downloaded.length,
            downloadedArtifactNames: names,
            upsertCount: applied.upserts.length,
            usedCount: applied.used.length,
            selectedProducers: downloaded.map((p) => ({
              jobName: p.metadata.producer.jobName,
              runAttempt: p.metadata.producer.runAttempt,
              artifactName: p.artifact.name,
              restoredGenerationKey: p.metadata.cacheIdentity.restoredGenerationKey,
            })),
          });
        } finally {
          for (const pkg of downloaded)
            await (
              dependencies.removeTemporaryDirectory ??
              ((p) => rm(p, { recursive: true, force: true }))
            )(pkg.temporaryDirectory).catch((e: unknown) =>
              dependencies.runtimeHost.warning(
                `Could not remove worker download staging: ${String(e)}`,
              ),
            );
        }
      }
    }
    // Every prepare-side managed read/write, including worker application, precedes this cutoff.
    state.cutoff = (dependencies.now ?? Date.now)();
    state.phase = 'build-ready';
    await persistCutoffJournal(state);
    for (const warning of [...state.snapshotWarnings, ...(dependent?.warnings ?? [])])
      dependencies.runtimeHost.warning(warning);
    persistCutoffLifecycle(
      {
        schemaVersion: 4,
        cacheEnabled: true,
        model: state.model,
        policy: state.policy,
        execution: state.execution,
        invocation: state.invocation,
        cutoff: state.cutoff,
        restoreResult: {
          ...restore,
          restoreCandidates: restore.restoreCandidates.map((c) => ({ ...c })),
          paths: [...restore.paths],
        },
      },
      dependencies.runtimeHost.saveState,
    );
  }
  const status: CutoffPrepareStatus = {
    bootstrap,
    restoreCleanupResult: cleanup,
    dependentDeltaResult: dependent,
    cutoff: journal?.cutoff ?? null,
    message: 'Prepare completed with cutoff-based cache observations.',
    partitionSnapshotLines: journal
      ? [...journal.snapshotWarnings, ...partitionSnapshotSummary(journal)]
      : [],
  };
  bootstrap.reportSink.publishLogGroup(
    `Buildish Mammoth Cache for ${bootstrap.buildToolAdapter.getName()}`,
    createBootstrapLogLines(bootstrap),
    dependencies.runtimeHost.info,
  );
  await bootstrap.reportSink.publishSummary(createCutoffPrepareSummary(status));
  return status;
}
export function createCutoffPrepareSummary(s: CutoffPrepareStatus): string[] {
  return [
    `## Buildish Mammoth Cache for ${s.bootstrap.buildToolAdapter.getName()}`,
    `- Cache family: ${escapeSummaryText(s.bootstrap.cacheModel?.cacheFamilyKey ?? 'disabled')}`,
    `- Activity cutoff: ${s.cutoff ?? 'not applicable'}`,
    `- Worker upserts: ${s.dependentDeltaResult?.upsertCount ?? 0}`,
    `- Worker used paths: ${s.dependentDeltaResult?.usedCount ?? 0}`,
    ...(s.dependentDeltaResult?.warnings ?? []).map((line) => `- ${escapeSummaryText(line)}`),
    ...(s.partitionSnapshotLines ?? []).map((line) => '- ' + escapeSummaryText(line)),
  ];
}
export function createCutoffPrepareOutputs(
  status: CutoffPrepareStatus,
): Record<PublicActionOutputName, string> {
  const model = status.bootstrap.cacheModel,
    restore = status.bootstrap.baseCacheResult;
  return {
    'cache-family-key': model?.cacheFamilyKey ?? '',
    'cache-lineage-prefix': model?.currentRefLineagePrefix ?? '',
    'base-cache-restore-status': restore?.status ?? '',
    'restored-cache-key': restore?.operation === 'restore' ? (restore.matchedKey ?? '') : '',
    'job-mode': status.bootstrap.config.jobMode,
    'read-only': String(status.bootstrap.config.readOnly),
    'dependent-delta-status': status.dependentDeltaResult?.status ?? 'not-configured',
    'dependent-delta-artifact-count': String(
      status.dependentDeltaResult?.appliedArtifactCount ?? 0,
    ),
  };
}
