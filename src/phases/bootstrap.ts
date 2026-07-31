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
  armBaseCacheFinalize,
  restoreBaseCache,
  type BaseCacheOperationResult,
} from '../cache/service';
import type { CiExecutionUrls, CiJobContext, CiPlatformAdapter } from '../ci';
import { createCacheModel, type CacheModel, type CommandOutputCapture } from '../cache/model';
import type { NormalizedActionConfig } from '../config/types';
import { createDetailsSection, createHtmlTable, escapeHtml, escapeSummaryText } from '../util/html';
import type { CoreExecutionPhase } from '../config/types';
import type { HostInputSource, HostReporter, HostStateStore, ReportSink } from '../host/types';
import type { BaseCacheBackend } from '../cache/backend';
import type { BuildToolAdapter, BuildToolProvisioning } from '../build-tool/types';
export type { BuildToolAdapter };

/**
 * Action execution phase.
 */
export type BootstrapPhase = CoreExecutionPhase;

/**
 * Bootstrap output shared by the action entrypoints and tests.
 */
export interface BootstrapStatus {
  /** Phase currently being prepared. Valid values are `prepare` and `finalize`. */
  readonly phase: BootstrapPhase;
  /** Human-readable one-line status summary generated from the normalized context and config. */
  readonly message: string;
  /** Fully normalized action configuration used by later modules. */
  readonly config: NormalizedActionConfig;
  /** Provider-neutral CI metadata for the current job execution. */
  readonly ciContext: CiJobContext;
  /**
   * Fully derived cache model, or `null` when `config.cacheEnabled` is `false`.
   *
   * Defaults to `null` in `createBootstrapStatus()`.
   */
  readonly cacheModel: CacheModel | null;
  /**
   * Base cache restore/save outcome for the current phase, or `null` when caching is disabled.
   *
   * Defaults to `null` in `createBootstrapStatus()`.
   */
  readonly baseCacheResult: BaseCacheOperationResult | null;
  /**
   * Build tool provisioning result from the prepare phase.
   *
   * Contains the list of provisioned items (e.g. verified wrapper JARs), any non-fatal warnings,
   * and additional CI outputs contributed by the adapter. Empty in the `finalize` phase.
   */
  readonly toolProvisioning: BuildToolProvisioning;
  /** Provider-specific bootstrap diagnostics rendered by the active CI adapter. */
  readonly ciDiagnosticsLines: readonly string[];
  /** Provider-specific execution URLs for the current job/run when available. */
  readonly ciExecutionUrls: CiExecutionUrls;
}

/**
 * Fully resolved bootstrap result that also exposes the live provider, report sink, and active
 * build tool adapter needed by downstream prepare/finalize logic.
 */
export interface BootstrapExecution extends BootstrapStatus {
  readonly ciProvider: CiPlatformAdapter;
  readonly reportSink: ReportSink;
  readonly buildToolAdapter: BuildToolAdapter;
}

/**
 * Minimal runtime host surface required during the bootstrap phase.
 *
 * Combines input reading, state persistence, and log reporting into a single injectable type so
 * callers do not need to pass three separate dependencies.
 */
export type BootstrapHost = HostInputSource & HostStateStore & HostReporter;

/**
 * Injectable dependencies for bootstrap-time environment/input discovery.
 */
export interface BootstrapDependencies {
  /** Optional environment map used by config resolution and persistence helpers. */
  readonly env?: NodeJS.ProcessEnv;
  /** Runtime host implementation used for input discovery, non-fatal reporting, and state. */
  readonly runtimeHost: BootstrapHost;
  /** Provider adapter for the active CI environment. */
  readonly ciProvider: CiPlatformAdapter;
  /** Provider-specific reporting sink used for grouped logs and summaries. */
  readonly reportSink: ReportSink;
  /**
   * Fully normalized action configuration pre-resolved by the tool-specific entrypoint.
   *
   * Config resolution (input reading, config-file overlay, normalization) lives in the entrypoint
   * so bootstrap remains agnostic of the active build tool.
   */
  readonly config: NormalizedActionConfig;
  /**
   * Factory that constructs the active build tool adapter.
   *
   * The factory receives no arguments; all tool-specific config (e.g. `gradleUserHome`,
   * `mavenLocalRepository`, wrapper settings) is captured inside the factory closure together with
   * any adapter-level test overrides (e.g. `fetchImpl`, `verifyWrapperSignature` for Gradle).
   */
  readonly buildToolAdapterFactory: () => BuildToolAdapter;
  /**
   * Optional command-capture override for Java version detection.
   *
   * Defaults to the internal child-process implementation when omitted.
   */
  readonly captureCommandOutput?: CommandOutputCapture;
  /** Provider-neutral base-cache backend for the active CI provider. */
  readonly cacheBackend: BaseCacheBackend;
}

/**
 * Shared startup path for both the "prepare" and "finalize" entrypoints.
 *
 * Config resolution (input reading, config-file overlay, normalization) is performed by the
 * tool-specific entrypoint before calling this function, so bootstrap remains decoupled from any
 * particular build tool.
 */
export async function bootstrapPhase(
  phase: BootstrapPhase,
  dependencies: BootstrapDependencies,
): Promise<BootstrapExecution> {
  const runtimeEnv = dependencies.env ?? process.env;
  const ciProvider = dependencies.ciProvider;
  const config = dependencies.config;
  const adapter = dependencies.buildToolAdapterFactory();
  const cacheModel = config.cacheEnabled
    ? await createCacheModel(config, ciProvider.context, adapter, {
        captureCommandOutput: dependencies.captureCommandOutput,
        env: runtimeEnv,
      })
    : null;
  const toolProvisioning: BuildToolProvisioning =
    phase === 'prepare'
      ? await adapter.provision({
          workspace: ciProvider.context.workspace,
          httpHeadersByHost: ciProvider.httpHeadersByHost,
          logRetry: dependencies.runtimeHost.info,
        })
      : { items: [], warnings: [], additionalOutputs: {} };
  const baseCacheResult = await runBaseCachePhase(phase, config, cacheModel, dependencies);
  const status = createBootstrapStatus(
    phase,
    config,
    ciProvider.context,
    cacheModel,
    baseCacheResult,
    toolProvisioning,
    ciProvider.createBootstrapDiagnosticsLines(phase),
    ciProvider.executionUrls,
  );

  return {
    ...status,
    ciProvider,
    reportSink: dependencies.reportSink,
    buildToolAdapter: adapter,
  };
}

/**
 * Creates a compact bootstrap status object suitable for logging and testing.
 */
export function createBootstrapStatus(
  phase: BootstrapPhase,
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  cacheModel: CacheModel | null = null,
  baseCacheResult: BaseCacheOperationResult | null = null,
  toolProvisioning: BuildToolProvisioning = { items: [], warnings: [], additionalOutputs: {} },
  ciDiagnosticsLines: readonly string[] = [],
  ciExecutionUrls: CiExecutionUrls = { jobUrl: null, workflowRunUrl: null },
): BootstrapStatus {
  return {
    phase,
    config,
    ciContext,
    cacheModel,
    baseCacheResult,
    toolProvisioning,
    ciDiagnosticsLines,
    ciExecutionUrls,
    message: `Prepared ${phase} phase for ${ciContext.eventName} on ${ciContext.safeRefName} in ${config.jobMode} mode.`,
  };
}

/**
 * Builds the initial job summary section emitted during bootstrap.
 */
export function createBootstrapSummaryLines(status: BootstrapStatus): readonly string[] {
  const downloadedCount = status.toolProvisioning.items.filter((item) => item.wasDownloaded).length;
  const reusedCount = status.toolProvisioning.items.length - downloadedCount;

  return [
    '## Buildish bootstrap',
    `- Base cache ${status.baseCacheResult?.operation ?? 'state'}: ${status.baseCacheResult?.status ?? (status.cacheModel ? 'not-run' : 'disabled')}`,
    `- Tool provisioning: ${status.toolProvisioning.items.length} ready (${downloadedCount} downloaded, ${reusedCount} reused)`,
    ...createDetailsSection('Execution context', [
      `- Phase: ${escapeSummaryText(status.phase)}`,
      `- Workflow: ${escapeSummaryText(status.ciContext.workflowName)}`,
      `- Job: ${escapeSummaryText(status.ciContext.jobName)}`,
      `- Event: ${escapeSummaryText(status.ciContext.eventName)}`,
      `- Ref: ${escapeSummaryText(status.ciContext.resolvedRefName)}`,
      `- Safe ref: ${escapeSummaryText(status.ciContext.safeRefName)}`,
      `- Runner: ${escapeSummaryText(`${status.ciContext.runnerOs}/${status.ciContext.runnerArch}`)}`,
      `- Job mode: ${escapeSummaryText(status.config.jobMode)}`,
      `- Read only: ${status.config.readOnly ? 'yes' : 'no'}`,
      `- Cache enabled: ${status.config.cacheEnabled ? 'yes' : 'no'}`,
      `- Cache family: ${escapeSummaryText(status.cacheModel?.cacheFamilyKey ?? 'disabled')}`,
      `- Current ref lineage: ${escapeSummaryText(status.cacheModel?.currentRefLineagePrefix ?? 'disabled')}`,
      `- Java major: ${escapeSummaryText(String(status.cacheModel?.javaMajor ?? 'n/a'))}`,
      `- Cache partitions: ${status.cacheModel?.partitions.length ?? 0}`,
      ...(status.baseCacheResult
        ? [`- Base cache detail: ${escapeSummaryText(status.baseCacheResult.message)}`]
        : []),
    ]),
    ...createDetailsSection('Tool provisioning', createToolProvisioningSummaryLines(status)),
  ];
}

/**
 * Renders a compact set of single-line log messages summarizing the bootstrap outcome.
 *
 * These lines are emitted via the runtime reporter before the log group is closed, giving
 * operators a quick overview of cache, tool provisioning, and configuration state without opening
 * the details section.
 */
export function createBootstrapLogLines(status: BootstrapStatus): readonly string[] {
  const downloadedCount = status.toolProvisioning.items.filter((item) => item.wasDownloaded).length;
  const reusedCount = status.toolProvisioning.items.length - downloadedCount;
  const lines = [
    `Bootstrap: ${status.message}`,
    `Base cache ${status.baseCacheResult?.operation ?? 'state'}: ${status.baseCacheResult?.status ?? (status.cacheModel ? 'not-run' : 'disabled')}.`,
    `Tool provisioning: ${status.toolProvisioning.items.length} ready (${downloadedCount} downloaded, ${reusedCount} reused).`,
    `Execution context: workflow '${status.ciContext.workflowName}', job '${status.ciContext.jobName}', event '${status.ciContext.eventName}', ref '${status.ciContext.resolvedRefName}', safe ref '${status.ciContext.safeRefName}', runner '${status.ciContext.runnerOs}/${status.ciContext.runnerArch}', job mode '${status.config.jobMode}', read only ${status.config.readOnly ? 'yes' : 'no'}, cache ${status.config.cacheEnabled ? 'enabled' : 'disabled'}.`,
  ];

  if (status.cacheModel) {
    lines.push(
      `Cache family: ${status.cacheModel.cacheFamilyKey}; current ref lineage: ${status.cacheModel.currentRefLineagePrefix}; Java major: ${status.cacheModel.javaMajor}; cache partitions: ${status.cacheModel.partitions.length}.`,
    );
  }

  if (status.baseCacheResult) {
    lines.push(status.baseCacheResult.message);
  }

  if (status.ciDiagnosticsLines.length > 0) {
    lines.push(...status.ciDiagnosticsLines);
  }

  if (status.phase === 'finalize') {
    lines.push('Tool provisioning is skipped during the finalize phase.');
    return lines;
  }

  if (status.toolProvisioning.items.length === 0) {
    lines.push('No build tool items were selected for provisioning.');
    return lines;
  }

  for (const item of status.toolProvisioning.items) {
    const action = capitalize(item.wasDownloaded ? 'downloaded' : 'reused');
    lines.push(`${action} '${item.label}' (${item.version}).`);
  }

  return lines;
}

function createToolProvisioningSummaryLines(status: BootstrapStatus): readonly string[] {
  if (status.phase === 'finalize') {
    return ['- Tool provisioning is skipped during the finalize phase.'];
  }

  if (status.toolProvisioning.items.length === 0) {
    return ['- No build tool items were selected for provisioning.'];
  }

  return createHtmlTable(
    ['Properties file', 'Action', 'Version'],
    status.toolProvisioning.items.map((item) => [
      escapeHtml(item.label),
      escapeHtml(capitalize(item.wasDownloaded ? 'downloaded' : 'reused')),
      escapeHtml(item.version),
    ]),
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function runBaseCachePhase(
  phase: BootstrapPhase,
  config: NormalizedActionConfig,
  cacheModel: CacheModel | null,
  dependencies: BootstrapDependencies,
): Promise<BaseCacheOperationResult | null> {
  if (!cacheModel) {
    return null;
  }

  if (phase === 'prepare') {
    const restoreResult = await restoreBaseCache(cacheModel, {
      cacheBackend: dependencies.cacheBackend,
    });

    armBaseCacheFinalize(dependencies.runtimeHost.saveState);
    return restoreResult;
  }

  return null;
}
