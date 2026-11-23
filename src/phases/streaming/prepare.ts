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

import { resolveLifecycle } from '../../build-tool/lifecycle';
import { randomBytes } from 'node:crypto';
import { createCachePartitions, validatePartitionConflictHandling } from '../../cache/model';
import { resolveCacheModel, lineageId } from '../../cache/streaming/model';
import { lineagePrefix } from '../../cache/streaming/native-records';
import { contextSchema } from '../../cache/streaming/schema';
import { WorkingBudget } from '../../cache/streaming/tree-state';
import { prepareStreaming } from '../../cache/streaming/prepare';
import { reconcileDisabledRoot } from '../../cache/streaming/passive-lifecycle';
import { disabledInvocationAnchor, encodeInvocationAnchor } from '../../cache/streaming/invocation';
import {
  claimSingleRunPrepareExecution,
  JOB_PREPARE_FAILED_STATE,
} from '../../guard/job-single-run';
import type { LifecycleOptions } from '../../cache/streaming/lifecycle-options';
import type { BuildToolAdapter, BuildToolProvisioning } from '../../build-tool/types';
import type { CiPlatformAdapter } from '../../ci';
import type { NormalizedActionConfig } from '../../config/types';
import type { HostStateStore, HostOutputSink, HostReporter, ReportSink } from '../../host/types';
import type { BaseCacheBackend } from '../../cache/backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';

import { STREAMING_INVOCATION_STATE } from './state';
export { STREAMING_INVOCATION_STATE } from './state';
export interface StreamingPrepareDependencies extends Omit<LifecycleOptions, 'budget'> {
  readonly budget?: WorkingBudget;
  readonly providerId: string;
  readonly runtimeHost: HostStateStore & HostOutputSink & HostReporter;
  readonly ciProvider: CiPlatformAdapter;
  readonly config: NormalizedActionConfig;
  readonly buildToolAdapterFactory: () => BuildToolAdapter;
  readonly cacheBackend: () => Promise<BaseCacheBackend>;
  readonly artifactBackend: () => Promise<WorkflowArtifactBackend>;
  readonly nonce?: string;
  readonly reportSink?: () => Promise<ReportSink>;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#provider-composition-and-activation-boundary.
// Action prepare composition. Never calls legacy bootstrap, snapshots or cutoff inventory.
export async function runStreamingPrepare(d: StreamingPrepareDependencies) {
  const host = d.runtimeHost,
    ci = d.ciProvider.context,
    claim = await claimSingleRunPrepareExecution({ ciContext: ci, saveState: host.saveState });
  if (!claim.accepted) throw new Error(claim.message);
  try {
    const adapter = d.buildToolAdapterFactory(),
      config = d.config,
      tool = adapter.getBuildToolId(),
      context = contextSchema.parse([
        d.providerId,
        ci.repository,
        ci.workflowName,
        String(ci.runId ?? ''),
        ci.jobName,
        ci.runAttempt,
        ci.sourceRevision,
        tool,
      ]),
      budget = d.budget ?? new WorkingBudget(),
      options = { ...d, budget },
      root = adapter.getCacheRoot();
    let provisioning: BuildToolProvisioning | undefined;
    const provision = async () => {
      provisioning = await adapter.provision({
        workspace: ci.workspace,
        httpHeadersByHost: d.ciProvider.httpHeadersByHost,
        logRetry: host.warning,
      });
    };
    if (!config.cacheEnabled) {
      await reconcileDisabledRoot(root, options);
      host.saveState(
        STREAMING_INVOCATION_STATE,
        encodeInvocationAnchor(disabledInvocationAnchor(context, root, ci.tempDirectory)),
      );
      await provision();
      await adapter.installBuildHooks(ci);
      for (const warning of provisioning!.warnings) host.warning(warning);
      for (const [key, value] of Object.entries(provisioning!.additionalOutputs))
        host.setOutput(key, value);
      outputs(host, config, null, null, 0, '', false);
      await prepareSummary(d, 'disabled');
      return { outcome: 'disabled' as const };
    }
    const hard = adapter.getHardCacheExcludeGlobs(),
      partitions = createCachePartitions(
        root,
        config.cachePartitions,
        adapter.getBuiltInPartitionPresets(),
        hard,
      );
    validatePartitionConflictHandling(tool, partitions);
    const model = resolveCacheModel(
      { buildToolId: tool, hardCacheExcludeGlobs: hard, partitions },
      config.cacheKeyPrefix,
      config.cacheSchemaVersion,
    );
    const result = await prepareStreaming({
      ...options,
      root,
      model,
      context,
      nonce: d.nonce ?? randomBytes(16).toString('hex'),
      policy: {
        role: config.jobMode,
        access: config.readOnly ? 'read-only' : 'writable',
        restoreCleanup: config.cleanupEnabled ? config.restoreCleanupMode : 'none',
        gcAgeMs:
          config.cleanupEnabled && config.cacheGcMode === 'timestamp'
            ? Math.ceil(config.cacheGcOlderThanDays * 86400000)
            : null,
        ordinaryPolicy: config.allowDuplicateDependentDeltaPaths ? 'newer-mtime' : 'strict',
        ordinaryOrder: config.jobMode === 'distributed-aggregator' ? config.dependentJobs : [],
      },
      currentRef: ci.resolvedRefName,
      defaultRef: ci.defaultBranch,
      captureTempDirectory: ci.tempDirectory,
      artifactRetentionDays: config.workerArtifactRetentionDays,
      cleanupEnabled: config.cleanupEnabled,
      onWorkerWarnings: (warnings) => {
        if (warnings.count) {
          host.warning(
            `Worker merge selected winners for ${warnings.count} differing contributions.`,
          );
          for (const detail of warnings.details) host.warning(detail);
        }
      },
      saveAnchor: (raw) => host.saveState(STREAMING_INVOCATION_STATE, raw),
      cacheBackend: d.cacheBackend,
      artifactBackend: d.artifactBackend,
      provision,
      installHooks: async (store) => {
        const lifecycle = await resolveLifecycle(store.codec.options.context[7], d.lifecycle);
        await lifecycle.prepareCapture(store, ci, () => adapter.installBuildHooks(ci));
      },
    });
    for (const warning of provisioning?.warnings ?? []) host.warning(warning);
    for (const [key, value] of Object.entries(provisioning?.additionalOutputs ?? {}))
      host.setOutput(key, value);
    outputs(
      host,
      config,
      model.family,
      result.restoredKey,
      result.workerCount,
      lineagePrefix(model.family, lineageId(ci.resolvedRefName)),
      config.dependentJobs.length > 0 ||
        model.partitions.some(
          (p) => p[3] === 'single-writer' && p[4] !== null && p[4] !== context[4],
        ),
      result.restoreStatus,
    );
    await prepareSummary(d, result.restoreStatus);
    return result;
  } catch (e) {
    host.saveState(JOB_PREPARE_FAILED_STATE, 'true');
    throw e;
  }
}
function outputs(
  host: HostOutputSink,
  config: NormalizedActionConfig,
  family: string | null,
  key: string | null,
  workers: number,
  lineage = '',
  requests = false,
  restoreStatus = '',
) {
  const values = {
    'cache-family-key': family ?? '',
    'cache-lineage-prefix': lineage,
    'base-cache-restore-status': restoreStatus,
    'restored-cache-key': key ?? '',
    'job-mode': config.jobMode,
    'read-only': String(config.readOnly),
    'dependent-delta-status':
      config.jobMode === 'distributed-aggregator' && requests
        ? config.readOnly
          ? 'skipped-read-only'
          : 'applied'
        : 'not-configured',
    'dependent-delta-artifact-count': String(workers),
  };
  for (const [name, value] of Object.entries(values)) host.setOutput(name, value);
}

async function prepareSummary(d: StreamingPrepareDependencies, outcome: string) {
  const assert = () => {
    d.signal?.throwIfAborted();
    if (d.assertCurrent() !== undefined)
      throw new Error('Lifecycle assertion must be synchronous.');
  };
  assert();
  const sink = await d.reportSink?.();
  assert();
  await sink?.publishSummary([
    '## Mammoth cache prepare',
    `Mode: ${d.config.jobMode}; read-only: ${d.config.readOnly}.`,
    `Base cache: ${outcome}.`,
  ]);
  assert();
}
