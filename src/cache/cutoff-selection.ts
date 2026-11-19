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
import path from 'node:path';
import { z } from 'zod';
import type { CacheMetadataSnapshot } from './manifest';
import type { WorkspaceObservation } from './immutable-workspaces';
import { fileIdentitySchema } from './file-identity';
import { cutoffPartitionIdSchema, cutoffPathSchema, cutoffTimeSchema } from './cutoff-format';
import type { CachePartitionDefinition } from './model';

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
  members?: CutoffTarget[];
  workspaces?: WorkspaceObservation[];
  snapshotFileCount?: number;
  snapshotByteCount?: number;
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
  for (const unit of snapshot.workspaces ?? []) {
    if (unit.workspace.files.every((name) => excluded.has(name))) continue;
    for (const directory of unit.directories) {
      const { dev, ino, size, mode, mtimeMs, ctimeMs } = directory.identity;
      hash.update(
        JSON.stringify([
          unit.partitionId,
          directory.relativePath,
          dev,
          ino,
          size,
          mode,
          mtimeMs,
          ctimeMs,
        ]) + '\n',
      );
      count++;
    }
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
  partitions: readonly CachePartitionDefinition[] = [],
  ownedSnapshotIds: readonly string[] = [],
): CutoffSelection {
  cutoffTimeSchema.parse(cutoff);
  cutoffTimeSchema.parse(now);
  if (!Number.isFinite(graceDays) || graceDays < 2)
    throw new Error('GC grace must be at least two days.');
  const upserts: CutoffTarget[] = [];
  let used: string[] = [],
    gc: CutoffTarget[] = [];
  const imported = new Set(workers.upserts),
    accessed = new Set(workers.used);
  let fileCount = 0,
    byteCount = 0;
  let snapshotFileCount = 0,
    snapshotByteCount = 0;
  const snapshots = new Set(
    partitions.filter((p) => p.publication === 'single-writer').map((p) => p.id),
  );
  const owned = new Set(ownedSnapshotIds);
  for (const p of snapshot.partitions)
    for (const e of p.entries) {
      fileCount++;
      byteCount += e.size;
      if (snapshots.has(p.partitionId)) {
        snapshotFileCount++;
        snapshotByteCount += e.size;
        if (!owned.has(p.partitionId)) continue;
      }
      const target = {
        partitionId: p.partitionId,
        relativePath: e.relativePath,
        identity: e.identity,
      };
      if (
        snapshots.has(p.partitionId) ||
        imported.has(e.relativePath) ||
        e.identity.ctimeMs >= cutoff ||
        e.mtimeMs >= cutoff
      )
        upserts.push(target);
      else if (accessed.has(e.relativePath) || e.atimeMs >= cutoff) used.push(e.relativePath);
      else if (gcEnabled && e.mtimeMs < now - graceDays * 86400_000) gc.push(target);
    }
  // A Resolver marker describes siblings, including local installs. Never transfer a
  // changed file without its directory's complete managed view, or GC only its marker.
  if (snapshot.buildToolId === 'maven') {
    // Maven origins describe a complete coordinate directory. Different publication
    // units cannot independently own siblings and then expand each other's changes.
    const directoryOwners = new Map<string, Set<string>>();
    for (const p of snapshot.partitions)
      for (const e of p.entries) {
        if (!e.relativePath.startsWith('repository/')) continue;
        const directory = path.posix.dirname(e.relativePath);
        const owners = directoryOwners.get(directory) ?? new Set<string>();
        owners.add(p.partitionId);
        directoryOwners.set(directory, owners);
      }
    for (const [directory, owners] of directoryOwners)
      if (owners.size > 1 && [...owners].some((id) => snapshots.has(id)))
        throw new Error(
          `Maven repository directory '${directory}' cannot span single-writer publication units.`,
        );
    const directories = new Map<string, CutoffTarget[]>();
    for (const p of snapshot.partitions)
      for (const e of p.entries) {
        if (!e.relativePath.startsWith('repository/')) continue;
        const directory = path.posix.dirname(e.relativePath);
        const members = directories.get(directory) ?? [];
        members.push({
          partitionId: p.partitionId,
          relativePath: e.relativePath,
          identity: e.identity,
        });
        directories.set(directory, members);
      }
    const changed = new Set(upserts.map((e) => e.relativePath));
    const read = new Set(used);
    const garbage = new Set(gc.map((e) => e.relativePath));
    for (const members of directories.values()) {
      if (members.some((e) => changed.has(e.relativePath))) {
        for (const e of members) changed.add(e.relativePath);
      }
      if (members.some((e) => read.has(e.relativePath))) {
        for (const e of members) read.add(e.relativePath);
      }
      if (!members.every((e) => garbage.has(e.relativePath))) {
        for (const e of members) garbage.delete(e.relativePath);
      }
    }
    const all = [...directories.values()].flat();
    const selected = new Set(upserts.map((e) => e.relativePath));
    for (const e of all)
      if (changed.has(e.relativePath) && !selected.has(e.relativePath)) upserts.push(e);
    used = [...read].filter((name) => !changed.has(name)).sort((a, b) => a.localeCompare(b));
    gc = gc.filter((e) => garbage.has(e.relativePath));
    upserts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
  if (snapshot.workspaces?.length) {
    const changed = new Set(upserts.map((e) => e.relativePath)),
      read = new Set(used),
      garbage = new Set(gc.map((e) => e.relativePath));
    const entries = new Map(
      snapshot.partitions.flatMap((p) =>
        p.entries.map(
          (e) =>
            [
              e.relativePath,
              { partitionId: p.partitionId, relativePath: e.relativePath, identity: e.identity },
            ] as const,
        ),
      ),
    );
    for (const unit of snapshot.workspaces) {
      const names = unit.workspace.files;
      if (
        names.some((n) => changed.has(n)) ||
        unit.directories.some((d) => d.identity.ctimeMs >= cutoff || d.identity.mtimeMs >= cutoff)
      )
        for (const name of names) changed.add(name);
      if (names.some((n) => read.has(n))) for (const name of names) read.add(name);
      if (names.some((n) => changed.has(n) || read.has(n)) || !names.every((n) => garbage.has(n)))
        for (const name of names) garbage.delete(name);
    }
    upserts.splice(
      0,
      upserts.length,
      ...[...changed]
        .map((n) => entries.get(n)!)
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    );
    used = [...read].filter((n) => !changed.has(n)).sort((a, b) => a.localeCompare(b));
    gc = gc.filter((e) => garbage.has(e.relativePath));
  }
  return {
    members: snapshot.partitions.flatMap((p) =>
      p.entries.map((e) => ({
        partitionId: p.partitionId,
        relativePath: e.relativePath,
        identity: e.identity,
      })),
    ),
    ...(snapshot.workspaces?.length ? { workspaces: [...snapshot.workspaces] } : {}),
    snapshotFileCount,
    snapshotByteCount,
    upserts,
    used,
    gc,
    retainedFingerprint: fingerprintMetadata(snapshot, new Set(gc.map((e) => e.relativePath))),
    fileCount,
    byteCount,
  };
}
