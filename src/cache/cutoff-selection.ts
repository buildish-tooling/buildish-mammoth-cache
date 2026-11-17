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
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CacheMetadataSnapshot } from './manifest';
import { fileIdentitySchema } from './file-identity';
import { cutoffPartitionIdSchema, cutoffPathSchema, cutoffTimeSchema } from './cutoff-format';

export const cutoffTargetSchema = z
  .object({
    partitionId: cutoffPartitionIdSchema,
    relativePath: cutoffPathSchema,
    identity: fileIdentitySchema,
  })
  .strict();
export type CutoffTarget = z.infer<typeof cutoffTargetSchema>;
export interface WorkerObservations {
  upserts: string[];
  used: string[];
}
export const EMPTY_WORKER_OBSERVATIONS: WorkerObservations = { upserts: [], used: [] };
export interface CutoffSelection {
  upserts: CutoffTarget[];
  used: string[];
  gc: CutoffTarget[];
  retainedFingerprint: string;
  fileCount: number;
  byteCount: number;
}
export function fingerprintMetadata(
  snapshot: CacheMetadataSnapshot,
  excluded: ReadonlySet<string> = new Set(),
): string {
  const hash = createHash('sha256').update('cutoff-native-v1\n');
  let count = 0;
  for (const p of snapshot.partitions)
    for (const e of p.entries) {
      if (excluded.has(e.relativePath)) continue;
      const { dev, ino, size, mode, mtimeMs, ctimeMs } = e.identity;
      hash.update(
        JSON.stringify([p.partitionId, e.relativePath, dev, ino, size, mode, mtimeMs, ctimeMs]) +
          '\n',
      );
      count++;
    }
  return hash.update(String(count)).digest('hex');
}
export function selectCutoffActivity(
  snapshot: CacheMetadataSnapshot,
  cutoff: number,
  now: number,
  graceDays: number,
  gcEnabled: boolean,
  workers: WorkerObservations = EMPTY_WORKER_OBSERVATIONS,
): CutoffSelection {
  cutoffTimeSchema.parse(cutoff);
  cutoffTimeSchema.parse(now);
  if (!Number.isFinite(graceDays) || graceDays < 2)
    throw new Error('GC grace must be at least two days.');
  const upserts: CutoffTarget[] = [],
    used: string[] = [],
    gc: CutoffTarget[] = [];
  const imported = new Set(workers.upserts),
    accessed = new Set(workers.used);
  let fileCount = 0,
    byteCount = 0;
  for (const p of snapshot.partitions)
    for (const e of p.entries) {
      fileCount++;
      byteCount += e.size;
      const target = {
        partitionId: p.partitionId,
        relativePath: e.relativePath,
        identity: e.identity,
      };
      if (imported.has(e.relativePath) || e.identity.ctimeMs >= cutoff || e.mtimeMs >= cutoff)
        upserts.push(target);
      else if (accessed.has(e.relativePath) || e.atimeMs >= cutoff) used.push(e.relativePath);
      else if (gcEnabled && e.mtimeMs < now - graceDays * 86400_000) gc.push(target);
    }
  return {
    upserts,
    used,
    gc,
    retainedFingerprint: fingerprintMetadata(snapshot, new Set(gc.map((e) => e.relativePath))),
    fileCount,
    byteCount,
  };
}
