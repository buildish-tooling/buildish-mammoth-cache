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
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCachePartitions } from '../../cache/model';
import { resolveCacheModel, lineageId, invocationId } from '../../cache/streaming/model';
import { lineagePrefix } from '../../cache/streaming/native-records';
import { contextSchema } from '../../cache/streaming/schema';
import { WorkingBudget } from '../../cache/streaming/tree-state';
import { prepareStreaming, type StreamingPrepareResult } from '../../cache/streaming/prepare';
import { dependencyGcSchedule } from '../../cache/streaming/dependency-gc-schedule';
import { MetadataBaseRestore } from '../../cache/streaming/metadata-base-restore';
import type { MetadataGeneration } from '../../cache/streaming/metadata-base-records';
import { LocalCodec } from '../../cache/streaming/local-schema';
import { OwnedStore } from '../../cache/streaming/owned-store';
import { NativeRoot } from '../../cache/streaming/native';
import {
  CACHE_METADATA_DIRECTORY,
  CACHE_METADATA_VERSION_DIRECTORY,
} from '../../cache/metadata-paths';
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
  readonly cacheBackend: (operationRoot?: string) => Promise<BaseCacheBackend>;
  readonly artifactBackend: () => Promise<WorkflowArtifactBackend>;
  readonly nonce?: string;
  readonly now?: () => number;
  readonly reportSink?: () => Promise<ReportSink>;
}

function cacheModel(adapter: BuildToolAdapter, config: NormalizedActionConfig) {
  const hard = adapter.getHardCacheExcludeGlobs();
  return resolveCacheModel(
    {
      buildToolId: adapter.getBuildToolId(),
      hardCacheExcludeGlobs: hard,
      partitions: createCachePartitions(
        config.cachePartitions,
        adapter.getBuiltInPartitionPresets(),
        hard,
      ),
      dependencyCacheLayer: config.dependencyCacheLayer,
    },
    config.cacheKeyPrefix,
    config.cacheSchemaVersion,
  );
}

function sweepOutputs(d: StreamingPrepareDependencies, generation: MetadataGeneration | undefined) {
  const { due } = dependencyGcSchedule(d.config, generation, (d.now ?? Date.now)());
  d.runtimeHost.setOutput('dependency-gc-due', due);
}

async function checkGeneration(d: StreamingPrepareDependencies) {
  if (!d.config.cacheEnabled || !d.config.cleanupEnabled || d.config.cacheGcMode === 'off') {
    sweepOutputs(d, undefined);
    return { outcome: 'generation-checked' as const };
  }
  const adapter = d.buildToolAdapterFactory();
  const ci = d.ciProvider.context;
  const context = cacheContext(d, adapter.getBuildToolId());
  const codec = new LocalCodec({
    model: cacheModel(adapter, d.config),
    context,
    invocation: invocationId(context, d.nonce ?? randomBytes(16).toString('hex')),
    role: 'standalone',
    access: 'read-only',
  });
  const scratch = await NativeRoot.bind(
    await mkdtemp(join(ci.tempDirectory ?? tmpdir(), 'mammoth-generation-')),
  );
  const root = join(scratch.path, 'root');
  await mkdir(root);
  const store = await OwnedStore.bind(root, codec);
  const warnLookupError = (error: unknown) =>
    d.runtimeHost.warning(
      'Unable to check the cache generation for periodic GC: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  let backend: BaseCacheBackend | undefined;
  try {
    backend = await d.cacheBackend(root);
  } catch (error) {
    warnLookupError(error);
  }
  const generation =
    backend &&
    (await MetadataBaseRestore.lookupGeneration(
      store,
      backend,
      { currentRef: ci.resolvedRefName, defaultRef: ci.defaultBranch },
      { ...d, budget: d.budget ?? new WorkingBudget() },
      warnLookupError,
    ));
  await scratch.verifyRoot(true);
  for (const relative of [
    store.prefix + 'base',
    store.prefix.slice(0, -1),
    CACHE_METADATA_VERSION_DIRECTORY,
    CACHE_METADATA_DIRECTORY,
  ]) {
    if (await store.root.stat(relative)) {
      await rmdir(store.root.resolve(relative));
    }
  }
  await store.root.verifyRoot(true);
  await rmdir(root);
  await rmdir(scratch.path);
  d.signal?.throwIfAborted();
  sweepOutputs(d, generation);
  return { outcome: 'generation-checked' as const };
}

function cacheContext(
  d: StreamingPrepareDependencies,
  tool: ReturnType<BuildToolAdapter['getBuildToolId']>,
) {
  const ci = d.ciProvider.context;
  return contextSchema.parse([
    d.providerId,
    ci.repository,
    ci.workflowName,
    String(ci.runId ?? ''),
    ci.jobName,
    ci.runAttempt,
    ci.sourceRevision,
    tool,
  ]);
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#provider-composition-and-activation-boundary.
// Action prepare composition. Never calls legacy bootstrap, snapshots or cutoff inventory.
async function runStreamingPrepareImpl(d: StreamingPrepareDependencies) {
  const config = d.config;
  if (config.jobMode === 'prepare-only') {
    return checkGeneration(d);
  }
  const host = d.runtimeHost,
    ci = d.ciProvider.context,
    claim = await claimSingleRunPrepareExecution({ ciContext: ci, saveState: host.saveState });
  if (!claim.accepted) {
    throw new Error(claim.message);
  }
  let layerPreparation: StreamingPrepareResult | undefined;
  try {
    const adapter = d.buildToolAdapterFactory(),
      tool = adapter.getBuildToolId(),
      context = cacheContext(d, tool),
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
      for (const warning of provisioning!.warnings) {
        host.warning(warning);
      }
      for (const [key, value] of Object.entries(provisioning!.additionalOutputs)) {
        host.setOutput(key, value);
      }
      outputs(host, config, null, null, 0, '', false);
      sweepOutputs(d, undefined);
      await prepareSummary(d, 'disabled');
      if (tool === 'gradle') {
        host.setOutput('gradle-ro-dep-cache', '');
      }
      return { outcome: 'disabled' as const };
    }
    const model = cacheModel(adapter, config);
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
      dependencyGc: config,
      now: d.now,
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
      allowMissingDependentJobs: config.allowMissingDependentJobs,
      onMissingDependentJobs: (jobs) =>
        host.warning(
          `Dependent jobs without a worker artifact: ${jobs.join(', ')}. The available workers are merged, but this run cannot reach full sweep coverage.`,
        ),
      onWorkerGenerationMismatch: (job) =>
        host.warning(
          `Worker '${job}' observed a different cache generation. Its usage does not qualify for periodic GC.`,
        ),
      saveAnchor: (raw) => host.saveState(STREAMING_INVOCATION_STATE, raw),
      cacheBackend: d.cacheBackend,
      artifactBackend: d.artifactBackend,
      provision,
      existingDependencyLayer: host.getEnvironmentVariable('GRADLE_RO_DEP_CACHE'),
      overlayFs: config.overlayFs,
      hasWrapper: () => !!provisioning?.items.length,
      installHooks: async (store, lifecycle, layered) => {
        await lifecycle.prepareCapture(store, ci, () => adapter.installBuildHooks(ci), layered);
      },
    });
    layerPreparation = result;
    if (result.overlay) {
      host.saveState(STREAMING_LAYER_ADVERTISEMENT_STATE, result.store.codec.options.invocation);
      host.info('OverlayFS is active at ' + result.store.root.resolve(result.overlay[10]) + '.');
    }
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
    host.setOutput('dependency-gc-due', result.dependencyGc!.due);
    await prepareSummary(d, result.restoreStatus);
    if (tool === 'gradle' && !result.dependencyLayer) {
      host.setOutput('gradle-ro-dep-cache', '');
    }
    return result;
  } catch (error) {
    const failure = layerPreparation?.dependencyLayer
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
  if (!prepared.dependencyLayer) {
    return e;
  }
  const { store, dependencyLayer: seed } = prepared;
  const layer = prepared.lifecycle.dependencyLayer!;
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
          layer.path(store, seed),
      );
    } catch (report) {
      return new AggregateError(
        [e, report],
        'Advertised Gradle seed retained until owning post at ' + layer.path(store, seed),
      );
    }
    return e;
  }
  try {
    await layer.retire(store, seed, options);
  } catch (cleanup) {
    const message = 'Prepare failed; Gradle seed retained at ' + layer.path(store, seed);
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
    if ('dependencyLayer' in result && result.dependencyLayer) {
      const path = result.lifecycle.dependencyLayer!.path(result.store, result.dependencyLayer);
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
    } else if ('overlay' in result && result.overlay) {
      d.signal?.throwIfAborted();
      if (d.assertCurrent() !== undefined) {
        throw new Error('OverlayFS activation lifetime assertion must be synchronous.');
      }
      d.runtimeHost.saveState(
        STREAMING_LAYER_ACTIVATED_STATE,
        result.store.codec.options.invocation,
      );
    }
    return result;
  } catch (error) {
    const failure =
      prepared && 'dependencyLayer' in prepared && prepared.dependencyLayer
        ? await cleanupFailedLayer(d, prepared, advertised, error)
        : error;
    if (prepared) {
      d.runtimeHost.saveState(JOB_PREPARE_FAILED_STATE, 'true');
    }
    throw failure;
  }
}
