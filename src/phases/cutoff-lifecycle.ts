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
import { z } from 'zod';
import {
  cutoffModelSchema,
  cutoffPolicySchema,
  cutoffExecutionSchema,
  cutoffJournalPath,
  loadCutoffJournal,
  freezeCutoffSelection,
  verifyCutoffReplay,
  cutoffGcEnabled,
  type CutoffJournal,
} from '../cache/cutoff-state';
import { captureCacheMetadataSnapshot } from '../cache/manifest';
import { selectCutoffActivity } from '../cache/cutoff-selection';
import type { CiJobContext } from '../ci';
import { ownsSnapshot } from '../cache/partition-snapshots';

export const CUTOFF_LIFECYCLE_STATE = 'buildish-mammoth-cache-cutoff-lifecycle';
const restoreSchema = z
  .object({
    operation: z.literal('restore'),
    status: z.enum(['miss', 'feature-unavailable', 'current-lineage-hit', 'fallback-lineage-hit']),
    cacheFamilyKey: z.string(),
    currentRefLineagePrefix: z.string(),
    matchedKey: z.string().nullable(),
    matchedLineagePrefix: z.string().nullable(),
    restoreCandidates: z.array(
      z
        .object({ lineage: z.enum(['current-ref', 'default-branch']), keyPrefix: z.string() })
        .strict(),
    ),
    paths: z.array(z.string()),
    message: z.string(),
  })
  .strict();
const enabled = z
  .object({
    schemaVersion: z.literal(4),
    cacheEnabled: z.literal(true),
    model: cutoffModelSchema,
    policy: cutoffPolicySchema,
    execution: cutoffExecutionSchema,
    invocation: z.string().uuid(),
    cutoff: z.number().finite().nonnegative(),
    restoreResult: restoreSchema,
  })
  .strict();
export const cutoffLifecycleSchema = z
  .discriminatedUnion('cacheEnabled', [
    enabled,
    z
      .object({
        schemaVersion: z.literal(4),
        cacheEnabled: z.literal(false),
        execution: cutoffExecutionSchema,
      })
      .strict(),
  ])
  .superRefine((r, ctx) => {
    if (
      r.cacheEnabled &&
      (r.restoreResult.cacheFamilyKey !== r.model.cacheFamilyKey ||
        r.restoreResult.currentRefLineagePrefix !== r.model.currentRefLineagePrefix)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Cutoff lifecycle restore/model identity mismatch.',
      });
  });
export type CutoffLifecycle = z.infer<typeof cutoffLifecycleSchema>;
export function cutoffExecution(ci: CiJobContext): CutoffJournal['execution'] {
  return cutoffExecutionSchema.parse(
    Object.fromEntries(
      Object.keys(cutoffExecutionSchema.shape).map((key) => [key, ci[key as keyof CiJobContext]]),
    ),
  );
}
export function persistCutoffLifecycle(
  record: CutoffLifecycle,
  saveState: (key: string, value: string) => void,
): void {
  const value = JSON.stringify(cutoffLifecycleSchema.parse(record));
  if (Buffer.byteLength(value) > 64 * 1024)
    throw new Error('Cutoff CI lifecycle exceeds its budget.');
  saveState(CUTOFF_LIFECYCLE_STATE, value);
}
export function readCutoffLifecycle(getState: (key: string) => string): CutoffLifecycle {
  const raw = getState(CUTOFF_LIFECYCLE_STATE);
  if (!raw || Buffer.byteLength(raw) > 64 * 1024)
    throw new Error('Cutoff lifecycle is missing or oversized.');
  return cutoffLifecycleSchema.parse(JSON.parse(raw));
}
export interface CutoffPreflight {
  record: CutoffLifecycle;
  journal: CutoffJournal | null;
}
const issuedPreflights = new WeakMap<CutoffPreflight, string>();
function issuePreflight(result: CutoffPreflight): CutoffPreflight {
  issuedPreflights.set(result, JSON.stringify(result.record));
  return result;
}
/** Consume a receipt issued before configuration/provider content reads. */
export function consumeCutoffPreflight(
  preflight: CutoffPreflight,
  getState: (key: string) => string,
): CutoffPreflight {
  const identity = issuedPreflights.get(preflight);
  issuedPreflights.delete(preflight);
  if (
    !identity ||
    identity !== JSON.stringify(readCutoffLifecycle(getState)) ||
    identity !== JSON.stringify(preflight.record)
  )
    throw new Error('Invalid or consumed cutoff preflight receipt.');
  return preflight;
}
/** Validate lifecycle state before imports; freeze publication decisions only for writers. */
export async function preflightCutoffLifecycle(
  getState: (key: string) => string,
  now = Date.now(),
): Promise<CutoffPreflight> {
  const record = readCutoffLifecycle(getState);
  if (!record.cacheEnabled) return issuePreflight({ record, journal: null });
  const journal = await loadCutoffJournal(
    record.model,
    cutoffJournalPath(record.invocation),
    record.invocation,
  );
  if (
    JSON.stringify(journal.policy) !== JSON.stringify(record.policy) ||
    JSON.stringify(journal.execution) !== JSON.stringify(record.execution) ||
    journal.cutoff !== record.cutoff ||
    journal.restoredKey !== record.restoreResult.matchedKey ||
    journal.restoreStatus !== record.restoreResult.status
  )
    throw new Error('Cutoff lifecycle/journal mismatch.');
  if (journal.phase === 'prepare-pending' || journal.cutoff === null)
    throw new Error('Prepare did not establish a valid cutoff.');
  if (journal.policy.readOnly) return issuePreflight({ record, journal });
  if (journal.selection) await verifyCutoffReplay(journal);
  else {
    const snapshot = await captureCacheMetadataSnapshot(record.model);
    const selection = selectCutoffActivity(
      snapshot,
      journal.cutoff,
      now,
      journal.policy.cacheGcOlderThanDays,
      cutoffGcEnabled(journal.policy),
      journal.workers,
      record.model.partitions,
      record.model.partitions
        .filter((p) => ownsSnapshot(p, journal.policy.jobMode, journal.execution.jobName))
        .map((p) => p.id),
    );
    await freezeCutoffSelection(journal, selection, now);
  }
  return issuePreflight({ record, journal });
}
