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
import {
  decideSingleRunFinalizeExecution,
  JOB_PREPARE_FAILED_STATE,
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
  JOB_SINGLE_RUN_DUPLICATE_STATE,
} from '../../guard/job-single-run';
import { decodeInvocationAnchor, OpenedInvocation } from '../../cache/streaming/invocation';
import { WorkingBudget } from '../../cache/streaming/tree-state';
import { LifecycleHandoff } from '../../cache/streaming/lifecycle-handoff';
import { type LifecycleOptions } from '../../cache/streaming/lifecycle-options';
import { postStreamingBase } from '../../cache/streaming/base-post';
import {
  postStreamingWorker,
  postFailedPrepareGradleLayer,
} from '../../cache/streaming/worker-post';
import { postStreamingReadOnly } from '../../cache/streaming/passive-lifecycle';
import { PartitionSummaries } from '../../cache/streaming/partition-summaries';
import {
  STREAMING_INVOCATION_STATE,
  STREAMING_LAYER_ADVERTISEMENT_STATE,
  STREAMING_LAYER_ACTIVATED_STATE,
} from './state';
import type { HostReporter, HostStateStore, ReportSink } from '../../host/types';
import type { BaseCacheBackend } from '../../cache/backend';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { BuildReport } from '../../build-tool/types';
import type { Context } from '../../cache/streaming/schema';
export interface StreamingPostDependencies extends Omit<LifecycleOptions, 'budget'> {
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
  if (d.assertCurrent() !== undefined) {
    throw new Error('Lifecycle assertion must be synchronous.');
  }
}
function assertCleanup(d: StreamingPostDependencies) {
  d.cleanupSignal?.throwIfAborted();
  if (d.assertCurrent() !== undefined) {
    throw new Error('Lifecycle assertion must be synchronous.');
  }
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#provider-composition-and-activation-boundary.
// Guard graph deliberately has no provider SDK, configuration-reader or build-tool runtime import.
async function runStreamingPostImpl(d: StreamingPostDependencies) {
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
          let advertisedInvocation = host.getState(STREAMING_LAYER_ADVERTISEMENT_STATE);
          if (!advertisedInvocation && d.overlayMount) {
            // The mount can already be visible when the first host state write fails.
            const budget = d.budget ?? new WorkingBudget();
            const current = await OpenedInvocation.current(anchor[2], budget, d.cleanupSignal);
            if (current?.state[4] === 'build-ready') {
              const opened = await OpenedInvocation.open(anchor, budget, d.cleanupSignal);
              const handoff = await LifecycleHandoff.read(opened.store, opened.state[6]!, {
                budget,
                signal: d.cleanupSignal,
                maxDirectoryEntries: opened.bindings[8][9],
              });
              try {
                if (handoff.header[13]) {
                  advertisedInvocation = opened.store.codec.options.invocation;
                }
              } finally {
                handoff.close();
              }
            }
          }
          if (advertisedInvocation) {
            await postFailedPrepareGradleLayer({
              ...d,
              signal: d.cleanupSignal,
              budget: d.budget ?? new WorkingBudget(),
              anchor,
              advertisedInvocation,
              assertCurrent: () => {
                assertCleanup(d);
                return undefined;
              },
              removeHooks: async () => {
                for (const warning of await d.removeHooks(anchor[2], anchor[4][7])) {
                  host.warning(warning);
                }
              },
              onWarning: (message) => host.warning(message),
            });
          } else {
            for (const warning of await d.removeHooks(anchor[2], anchor[4][7])) {
              host.warning(warning);
            }
          }
        } else {
          for (const warning of await d.removeHooks(anchor[3], anchor[2][7])) {
            host.warning(warning);
          }
        }
      }
    }
    host.info(decision.message);
    return { outcome: 'skipped' as const };
  }
  assertCleanup(d);
  const raw = host.getState(STREAMING_INVOCATION_STATE);
  if (!raw) {
    throw new Error('Owning prepare has no streaming invocation handoff.');
  }
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
  const facts = await LifecycleHandoff.read(opened.store, opened.state[6]!, {
    ...options,
    signal: d.cleanupSignal,
    maxDirectoryEntries: opened.bindings[8][9],
  });
  // Build-ready precedes host advertisement. Absence of terminal activation is cleanup-only,
  // including abrupt interruptions that could not save the generic prepare-failed flag.
  if (
    (facts.header[12] || facts.header[13]) &&
    host.getState(STREAMING_LAYER_ACTIVATED_STATE) !== opened.store.codec.options.invocation
  ) {
    facts.close();
    await postFailedPrepareGradleLayer({
      ...d,
      signal: d.cleanupSignal,
      budget,
      anchor,
      advertisedInvocation:
        host.getState(STREAMING_LAYER_ADVERTISEMENT_STATE) || opened.store.codec.options.invocation,
      assertCurrent: () => {
        assertCleanup(d);
        return undefined;
      },
      removeHooks: async () => {
        for (const warning of await d.removeHooks(
          opened.store.root.path,
          opened.store.codec.options.context[7],
        )) {
          host.warning(warning);
        }
      },
      onWarning: (message) => host.warning(message),
    });
    host.info('Incomplete Gradle layer activation settled without cache capture or publication.');
    return { outcome: 'skipped' as const };
  }
  const summaries = new PartitionSummaries(opened.store.codec.options.model, budget, d.analytics);
  const onCaptureInfo = (message: string) => host.info(message);
  const warnings: string[] = [];
  const onWarning = (message: string) => {
    warnings.push(message);
    // Retained paths must remain visible even if cancellation or reporting fails later.
    host.warning(message);
  };
  try {
    const removeHooks = async () => {
      assertCurrent(d);
      for (const warning of await d.removeHooks(
        opened.store.root.path,
        opened.store.codec.options.context[7],
      )) {
        onWarning(warning);
      }
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
              onCaptureInfo,
              onWarning,
              removeHooks,
            })
          : await postStreamingBase({
              ...options,
              anchor,
              cacheBackend: () => d.cacheBackend(opened.store.root.path),
              summaries,
              onCaptureInfo,
              onWarning,
              removeHooks,
            });
    if (result.outcome === 'skipped-not-quiescent') {
      if (!result.message || !warnings.includes(result.message)) {
        host.warning('Cache save skipped: ' + (result.message ?? 'consumers remain.'));
      }
      return result;
    }
    if (
      result.outcome === 'feature-unavailable' &&
      !warnings.includes('Cache save skipped: cache backend is unavailable.')
    ) {
      onWarning('Cache save skipped: cache backend is unavailable.');
    }
    if (result.outcome === 'read-only') {
      await removeHooks();
    }
    // Core recovery, observation/purge, source return and receipt precede these content/provider reads.
    const report = await d.loadReport(opened.store.codec.options.context[7], facts.header[4]);
    const sink = await emit(host, d, report, [], result.outcome);
    try {
      summaries.emit(host, sink);
    } catch {
      // Partition diagnostics must not change the finalization outcome.
    }
    return result;
  } finally {
    summaries.dispose();
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
  for (const warning of [...warnings, ...report.warnings]) {
    host.warning(warning);
  }
  for (const line of report.logLines) {
    host.info(line);
  }
  host.info('Mammoth cache outcome: ' + outcome + '.');
  const sink = await d.reportSink?.();
  if (sink) {
    await sink.publishSummary([
      '## Mammoth cache post',
      `Outcome: ${outcome}.`,
      ...report.summaryLines,
    ]);
  }
  assertCurrent(d);
  return sink;
}

export async function runStreamingPost(input: StreamingPostDependencies) {
  const d = { ...input, timing: input.timing ?? hostTiming(input.runtimeHost) };
  return timed(
    d,
    'finalization',
    () => runStreamingPostImpl(d),
    (result) => result.outcome,
  );
}
