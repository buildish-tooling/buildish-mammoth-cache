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

import { timed } from '../../util/timing';
import { hostTiming } from '../../host/timing';
import { randomBytes } from 'node:crypto';
import { createCachePartitions } from '../../cache/model';
import { resolveCacheModel, lineageId } from '../../cache/streaming/model';
import { lineagePrefix } from '../../cache/streaming/native-records';
import { contextSchema } from '../../cache/streaming/schema';
import { WorkingBudget } from '../../cache/streaming/tree-state';
import { gradleSeedPath, retireGradleSeed } from '../../cache/streaming/gradle-layer';
import { prepareStreaming, type StreamingPrepareResult } from '../../cache/streaming/prepare';
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
import type {
  HostStateStore,
  HostOutputSink,
  HostReporter,
  HostEnvironment,
  ReportSink,
} from '../../host/types';
import type { BaseCacheBackend } from '../../cache/backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';

import {
  STREAMING_INVOCATION_STATE,
  STREAMING_LAYER_ADVERTISEMENT_STATE,
  STREAMING_LAYER_ACTIVATED_STATE,
} from './state';
export { STREAMING_INVOCATION_STATE } from './state';
export interface StreamingPrepareDependencies extends Omit<LifecycleOptions, 'budget'> {
  readonly budget?: WorkingBudget;
  readonly providerId: string;
  readonly runtimeHost: HostStateStore & HostOutputSink & HostReporter & HostEnvironment;
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
async function runStreamingPrepareImpl(d: StreamingPrepareDependencies) {
  const host = d.runtimeHost,
    ci = d.ciProvider.context,
    claim = await claimSingleRunPrepareExecution({ ciContext: ci, saveState: host.saveState });
  if (!claim.accepted) {
    throw new Error(claim.message);
  }
  let layerPreparation: StreamingPrepareResult | undefined;
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
      await reconcileDisabledRoot(root, options, tool);
      host.saveState(
        STREAMING_INVOCATION_STATE,
        encodeInvocationAnchor(disabledInvocationAnchor(context, root, ci.tempDirectory)),
      );
      await provision();
      await adapter.installBuildHooks(ci);
      for (const warning of provisioning!.warnings) {
        host.warning(warning);
      }
      for (const [key, value] of Object.entries(provisioning!.additionalOutputs)) {
        host.setOutput(key, value);
      }
      outputs(host, config, null, null, 0, '', false);
      await prepareSummary(d, 'disabled');
      if (tool === 'gradle') {
        host.setOutput('gradle-ro-dep-cache', '');
      }
      return { outcome: 'disabled' as const };
    }
    const hard = adapter.getHardCacheExcludeGlobs(),
      partitions = createCachePartitions(
        config.cachePartitions,
        adapter.getBuiltInPartitionPresets(),
        hard,
      );
    const model = resolveCacheModel(
      {
        buildToolId: tool,
        hardCacheExcludeGlobs: hard,
        partitions,
        dependencyCacheLayer: config.dependencyCacheLayer,
      },
      config.cacheKeyPrefix,
      config.cacheSchemaVersion,
    );
    const result = await prepareStreaming({
      ...options,
      maxDirectoryEntries: config.cacheMaxDirectoryEntries,
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
          for (const detail of warnings.details) {
            host.warning(detail);
          }
        }
      },
      saveAnchor: (raw) => host.saveState(STREAMING_INVOCATION_STATE, raw),
      cacheBackend: d.cacheBackend,
      artifactBackend: d.artifactBackend,
      provision,
      existingGradleLayer: host.getEnvironmentVariable('GRADLE_RO_DEP_CACHE'),
      hasGradleWrapper: () => !!provisioning?.items.length,
      installHooks: async (store, lifecycle, layered) => {
        await lifecycle.prepareCapture(store, ci, () => adapter.installBuildHooks(ci), layered);
      },
    });
    layerPreparation = result;
    for (const warning of provisioning?.warnings ?? []) {
      host.warning(warning);
    }
    for (const [key, value] of Object.entries(provisioning?.additionalOutputs ?? {})) {
      host.setOutput(key, value);
    }
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
    if (tool === 'gradle' && !result.gradleSeed) {
      host.setOutput('gradle-ro-dep-cache', '');
    }
    return result;
  } catch (error) {
    const failure = layerPreparation?.gradleSeed
      ? await cleanupFailedLayer(d, layerPreparation, false, error)
      : error;
    host.saveState(JOB_PREPARE_FAILED_STATE, 'true');
    throw failure;
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
  for (const [name, value] of Object.entries(values)) {
    host.setOutput(name, value);
  }
}

async function prepareSummary(d: StreamingPrepareDependencies, outcome: string) {
  const assert = () => {
    d.signal?.throwIfAborted();
    if (d.assertCurrent() !== undefined) {
      throw new Error('Lifecycle assertion must be synchronous.');
    }
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

async function cleanupFailedLayer(
  d: StreamingPrepareDependencies,
  prepared: StreamingPrepareResult,
  advertised: boolean,
  e: unknown,
): Promise<unknown> {
  if (!prepared.gradleSeed) {
    return e;
  }
  const { store, gradleSeed: seed } = prepared;
  const options = {
    ...d,
    budget: d.budget ?? new WorkingBudget(),
    signal: d.cleanupSignal ?? new AbortController().signal,
  };
  if (advertised) {
    // Later always()/continue-on-error steps may still consume either successful host write.
    try {
      d.runtimeHost.warning(
        'Prepare failed; advertised Gradle seed and hooks retained until owning post at ' +
          gradleSeedPath(store, seed),
      );
    } catch (report) {
      return new AggregateError(
        [e, report],
        'Advertised Gradle seed retained until owning post at ' + gradleSeedPath(store, seed),
      );
    }
    return e;
  }
  try {
    await retireGradleSeed(store, seed, options);
  } catch (cleanup) {
    const message = 'Prepare failed; Gradle seed retained at ' + gradleSeedPath(store, seed);
    const errors = [e, cleanup];
    try {
      d.runtimeHost.warning(message);
    } catch (report) {
      errors.push(report);
    }
    e = new AggregateError(errors, message);
  }

  return e;
}

export async function runStreamingPrepare(input: StreamingPrepareDependencies) {
  const d = { ...input, timing: input.timing ?? hostTiming(input.runtimeHost) };
  let prepared: Awaited<ReturnType<typeof runStreamingPrepareImpl>> | undefined,
    advertised = false;
  try {
    const result = await timed(
      d,
      'preparation',
      async () => {
        prepared = await runStreamingPrepareImpl(d);
        return prepared;
      },
      (result) => ('restoreStatus' in result ? result.restoreStatus : result.outcome),
    );
    // Host output/environment are the last operations, after all failure-prone reporting.
    if ('gradleSeed' in result && result.gradleSeed) {
      const path = gradleSeedPath(result.store, result.gradleSeed);
      const assertActivation = () => {
        d.signal?.throwIfAborted();
        if (d.assertCurrent() !== undefined) {
          throw new Error('Layer activation lifetime assertion must be synchronous.');
        }
      };
      assertActivation();
      d.runtimeHost.saveState(
        STREAMING_LAYER_ADVERTISEMENT_STATE,
        result.store.codec.options.invocation,
      );
      advertised = true;
      d.runtimeHost.setOutput('gradle-ro-dep-cache', path);
      assertActivation();
      if (d.config.exportLayerEnvironment) {
        d.runtimeHost.exportEnvironmentVariable('GRADLE_RO_DEP_CACHE', path);
      }
      assertActivation();
      d.runtimeHost.saveState(
        STREAMING_LAYER_ACTIVATED_STATE,
        result.store.codec.options.invocation,
      );
    }
    return result;
  } catch (error) {
    const failure =
      prepared && 'gradleSeed' in prepared && prepared.gradleSeed
        ? await cleanupFailedLayer(d, prepared, advertised, error)
        : error;
    if (prepared) {
      d.runtimeHost.saveState(JOB_PREPARE_FAILED_STATE, 'true');
    }
    throw failure;
  }
}
