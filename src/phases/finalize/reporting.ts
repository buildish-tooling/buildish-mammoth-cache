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
import type { BuildReport } from '../../build-tool/types';
import type { TimestampCacheGcResult } from '../../cache/gc';
import type { BaseCacheRestoreResult } from '../../cache/service';
import type { BootstrapExecution } from '../bootstrap';
import type { CutoffSelection } from '../../cache/cutoff-selection';
import { createHtmlLink, escapeSummaryText } from '../../util/html';

export interface FinalizeDeltaArtifactResult {
  status: 'not-distributed-worker' | 'read-only' | 'uploaded';
  artifactName: string | null;
  artifactId: number | null;
  artifactSizeBytes: number | null;
  emptyEnvelope: boolean;
  upsertCount: number | null;
  usedCount: number | null;
  message: string;
}
export interface FinalizeActionStatus {
  bootstrap: BootstrapExecution;
  baseCacheRestoreResult: BaseCacheRestoreResult | null;
  cacheGcResult: TimestampCacheGcResult | null;
  cacheStatistics: ReturnType<typeof createFinalizeCacheStatistics> | null;
  deltaArtifactResult: FinalizeDeltaArtifactResult | null;
  buildReport: BuildReport;
  jobUrl: string | null;
  workflowRunUrl: string | null;
  message: string;
  activityCutoff: number | null;
  partitionSnapshotLines?: string[];
}
export function createFinalizeCacheStatistics(selection: CutoffSelection) {
  return {
    fileCount: selection.fileCount,
    byteCount: selection.byteCount,
    upsertCount: selection.upserts.length,
    usedCount: selection.used.length,
  };
}
export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function createFinalizeActionLogLines(s: FinalizeActionStatus): readonly string[] {
  return [
    s.message,
    cutoffPolicyLine(s),
    ...s.buildReport.logLines,
    ...s.buildReport.warnings,
    ...(s.partitionSnapshotLines ?? []),
    s.bootstrap.baseCacheResult?.message ?? '',
    s.cacheGcResult?.message ?? '',
    s.deltaArtifactResult?.message ?? '',
  ].filter(Boolean);
}
export function createFinalizeActionSummaryLines(s: FinalizeActionStatus): readonly string[] {
  const name = s.bootstrap.buildToolAdapter.getName(),
    save = s.bootstrap.baseCacheResult;
  const failed = s.buildReport.anyBuildFailed || save?.status === 'failed';
  const warn =
    s.buildReport.warnings.length > 0 ||
    (save?.operation === 'save' &&
      ['not-saved', 'missing-paths', 'feature-unavailable'].includes(save.status));
  return [
    `## Buildish Mammoth Cache for ${name}`,
    `${failed ? '❌' : warn ? '⚠️' : '✅'} Overall status: ${failed ? 'failed' : warn ? 'warning' : 'success'}`,
    '',
    s.jobUrl ? `### ${createHtmlLink(s.jobUrl, `${name} builds`)}` : `### ${name} builds`,
    ...s.buildReport.summaryLines,
    '',
    '### Cache lifecycle',
    '- ' + cutoffPolicyLine(s),
    `- Restore: ${escapeSummaryText(s.baseCacheRestoreResult?.status ?? 'disabled')}`,
    `- Save: ${escapeSummaryText(save?.status ?? 'disabled')}`,
    ...(save ? [`- Save reason: ${escapeSummaryText(save.message)}`] : []),
    ...(s.cacheStatistics
      ? [`- Upserts: ${s.cacheStatistics.upsertCount}; used paths: ${s.cacheStatistics.usedCount}`]
      : [
          s.bootstrap.config.cacheEnabled && s.bootstrap.config.readOnly
            ? '- Cache activity statistics: unavailable (not collected in read-only mode).'
            : '- Cache activity statistics: unavailable (cache disabled).',
        ]),
    `- GC removed: ${s.cacheGcResult?.deletedFileCount ?? 0}`,
    ...(s.deltaArtifactResult?.status === 'uploaded'
      ? [
          `- Worker envelope: ${escapeSummaryText(s.deltaArtifactResult.artifactName!)}${s.deltaArtifactResult.emptyEnvelope ? ' (empty envelope)' : ''}`,
        ]
      : []),
    ...s.buildReport.warnings.map((w) => `- Warning: ${escapeSummaryText(w)}`),
    ...(s.partitionSnapshotLines ?? []).map((line) => '- ' + escapeSummaryText(line)),
    ...(save?.status === 'failed' ? [`- Error: ${escapeSummaryText(save.message)}`] : []),
  ];
}

function cutoffPolicyLine(s: FinalizeActionStatus): string {
  return (
    'Activity cutoff: ' +
    (s.activityCutoff ?? 'disabled') +
    '; GC mode: ' +
    s.bootstrap.config.cacheGcMode +
    '; file-age grace: ' +
    s.bootstrap.config.cacheGcOlderThanDays +
    ' days.'
  );
}
