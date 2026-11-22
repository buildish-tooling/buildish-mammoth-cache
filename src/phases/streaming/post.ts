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
  decideSingleRunFinalizeExecution,
  JOB_PREPARE_FAILED_STATE,
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
  JOB_SINGLE_RUN_DUPLICATE_STATE,
} from '../../guard/job-single-run';
import { decodeInvocationAnchor, OpenedInvocation } from '../../cache/streaming/invocation';
import { WorkingBudget } from '../../cache/streaming/tree-state';
import { PrepareFacts } from '../../cache/streaming/prepare-state';
import { reconcileInvocation, type RecoveryOptions } from '../../cache/streaming/recovery';
import { postStreamingBase } from '../../cache/streaming/base-post';
import { postStreamingWorker } from '../../cache/streaming/worker-post';
import { postStreamingReadOnly } from '../../cache/streaming/passive-lifecycle';
import { PartitionSummaries } from '../../cache/streaming/partition-summaries';
import { STREAMING_INVOCATION_STATE } from './state';
import type { HostReporter, HostStateStore, ReportSink } from '../../host/types';
import type { BaseCacheBackend } from '../../cache/backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { BuildReport } from '../../build-tool/types';
import type { Context } from '../../cache/streaming/schema';
export interface StreamingPostDependencies extends Omit<RecoveryOptions, 'budget'> {
  readonly budget?: WorkingBudget;
  readonly runtimeHost: HostStateStore & HostReporter;
  readonly cacheBackend: (root: string) => Promise<BaseCacheBackend>;
  readonly artifactBackend: () => Promise<WorkflowArtifactBackend>;
  readonly removeHooks: (root: string, tool: Context[7]) => Promise<readonly string[]>;
  readonly loadReport: (tool: Context[7], tempDirectory: string | null) => Promise<BuildReport>;
  readonly reportSink?: () => Promise<ReportSink>;
  readonly analytics?: boolean;
}
function assertCurrent(d: StreamingPostDependencies) {
  d.signal?.throwIfAborted();
  if (d.assertCurrent() !== undefined) throw new Error('Lifecycle assertion must be synchronous.');
}
function assertCleanup(d: StreamingPostDependencies) {
  d.cleanupSignal?.throwIfAborted();
  if (d.assertCurrent() !== undefined) throw new Error('Lifecycle assertion must be synchronous.');
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#provider-composition-and-activation-boundary.
// Guard graph deliberately has no provider SDK, configuration-reader or build-tool runtime import.
export async function runStreamingPost(d: StreamingPostDependencies) {
  const host = d.runtimeHost,
    decision = decideSingleRunFinalizeExecution(host);
  if (!decision.shouldRun) {
    // Failed prepare can still own destructive intent. Duplicate/missing invocation cannot.
    if (
      host.getState(JOB_PREPARE_FAILED_STATE) === 'true' &&
      host.getState(JOB_SINGLE_RUN_DUPLICATE_STATE) !== 'true' &&
      host.getState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE)
    ) {
      assertCleanup(d);
      const raw = host.getState(STREAMING_INVOCATION_STATE);
      if (raw) {
        const anchor = decodeInvocationAnchor(raw);
        if (anchor[0] === 'streaming-lifecycle') {
          const budget = d.budget ?? new WorkingBudget(),
            opened = await OpenedInvocation.open(anchor, budget, d.cleanupSignal);
          await reconcileInvocation(opened, 'abandon', { ...d, budget });
          for (const warning of await d.removeHooks(
            opened.store.root.path,
            opened.store.codec.options.context[7],
          ))
            host.warning(warning);
        } else {
          for (const warning of await d.removeHooks(anchor[3], anchor[2][7])) host.warning(warning);
        }
      }
    }
    host.info(decision.message);
    return { outcome: 'skipped' as const };
  }
  assertCleanup(d);
  const raw = host.getState(STREAMING_INVOCATION_STATE);
  if (!raw) throw new Error('Owning prepare has no streaming invocation handoff.');
  const anchor = decodeInvocationAnchor(raw),
    budget = d.budget ?? new WorkingBudget(),
    options = { ...d, budget };
  if (anchor[0] === 'streaming-disabled') {
    assertCurrent(d);
    const warnings = await d.removeHooks(anchor[3], anchor[2][7]);
    assertCurrent(d);
    const report = await d.loadReport(anchor[2][7], anchor[4]);
    await emit(host, d, report, warnings, 'disabled');
    return { outcome: 'disabled' as const };
  }
  const opened = await OpenedInvocation.open(anchor, budget, d.cleanupSignal);
  await reconcileInvocation(opened, 'resume', options);
  const facts = await PrepareFacts.open(opened.store, {
      ...options,
      maxDirectoryEntries: opened.bindings[8][9],
    }),
    summaries =
      d.analytics === false
        ? undefined
        : new PartitionSummaries(opened.store.codec.options.model, budget);
  const warnings: string[] = [];
  try {
    if (!facts.selection) throw new Error('Missing frozen execution configuration.');
    const removeHooks = async () => {
      assertCurrent(d);
      warnings.push(
        ...(await d.removeHooks(opened.store.root.path, opened.store.codec.options.context[7])),
      );
      assertCurrent(d);
    };
    const result =
      opened.store.codec.options.access === 'read-only'
        ? await postStreamingReadOnly(anchor, options)
        : opened.store.codec.options.role === 'distributed-worker'
          ? await postStreamingWorker({
              ...options,
              anchor,
              artifactBackend: d.artifactBackend,
              summaries,
              removeHooks,
            })
          : await postStreamingBase({
              ...options,
              anchor,
              cacheBackend: () => d.cacheBackend(opened.store.root.path),
              summaries,
              removeHooks,
            });
    if (result.outcome === 'skipped-not-quiescent') {
      host.warning(result.message ?? 'Cache save skipped: consumers remain.');
      return result;
    }
    if (result.outcome === 'read-only') await removeHooks();
    if (opened.store.codec.options.role === 'distributed-aggregator')
      for (const p of opened.store.codec.options.model.partitions)
        if (p[3] === 'single-writer' && p[4] === null)
          host.warning(
            `Partition '${p[0]}' has no configured snapshot writer; preserving its prepared snapshot.`,
          );
    // Core recovery, observation/purge, source return and receipt precede these content/provider reads.
    const report = await d.loadReport(opened.store.codec.options.context[7], facts.selection[4][2]);
    const sink = await emit(host, d, report, warnings, result.outcome);
    summaries?.emit(host, sink);
    return result;
  } finally {
    summaries?.dispose();
    facts.close();
  }
}
async function emit(
  host: HostReporter,
  d: StreamingPostDependencies,
  report: BuildReport,
  warnings: readonly string[],
  outcome: string,
) {
  assertCurrent(d);
  for (const warning of [...warnings, ...report.warnings]) host.warning(warning);
  for (const line of report.logLines) host.info(line);
  host.info('Mammoth cache outcome: ' + outcome + '.');
  const sink = await d.reportSink?.();
  if (sink) await sink.publishSummary(report.summaryLines);
  assertCurrent(d);
  return sink;
}
