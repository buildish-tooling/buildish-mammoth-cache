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

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CacheGeneration } from './model';
import type { BaseCacheBackend } from './backend';
import { metadataPath, readMetadata, writeMetadata } from './metadata-io';
import { CUTOFF_STATE_DIRECTORY } from './metadata-paths';
import { persistCutoffJournal, verifyCutoffReplay, type CutoffJournal } from './cutoff-state';
import { readPartitionSnapshot, type SnapshotSource } from './partition-snapshots';
import {
  stagePartitionObject,
  readPartitionObject,
  readPartitionDescriptor,
} from './partition-transport';
import {
  storageDigest,
  partitionTransportKind,
  partitionObjectRoot,
  partitionObjectPaths,
  generationRecordPaths,
  GENERATION_RECORD_PATH,
  PARTITION_STORAGE_LIMITS,
  createRecoveryGroups,
  validateGenerationRecord,
  type PartitionDescriptor,
  type PartitionReference,
} from './partition-format';

function retainedMembers(state: CutoffJournal, id: string) {
  const removed = new Set(state.selection!.gc.map((e) => e.relativePath));
  return (state.selection!.members ?? state.selection!.upserts).filter(
    (e) => e.partitionId === id && !removed.has(e.relativePath),
  );
}
export function changedPartitionIds(state: CutoffJournal): string[] {
  if (!state.selection) throw new Error('Partition decisions require frozen observations.');
  return state.model.partitions
    .filter((partition) => {
      const baseline = state.basePartitions.find((p) => p.partitionId === partition.id);
      if (partition.publication === 'single-writer') {
        const snapshot = state.partitionSnapshots.find((s) => s.partitionId === partition.id)!;
        return snapshot.changed || (!baseline?.reference && snapshot.fileCount > 0);
      }
      if (state.selection!.gc.some((e) => e.partitionId === partition.id)) return true;
      const members = retainedMembers(state, partition.id);
      if (!baseline || baseline.status === 'missing') return members.length > 0;
      if (
        JSON.stringify(members.map((e) => e.relativePath)) !==
        JSON.stringify(baseline.descriptor?.files.map((e) => e.relativePath) ?? [])
      )
        return true;
      if (
        state.selection!.upserts.some((e) => e.partitionId === partition.id) ||
        state.selection!.gc.some((e) => e.partitionId === partition.id) ||
        state.workers.upserts.some((name) => members.some((e) => e.relativePath === name))
      )
        return true;
      if (partitionTransportKind(state.model, partition.id) === 'groovy') {
        const removed = new Set(state.selection!.gc.map((e) => e.relativePath));
        const workspaces = (state.selection!.workspaces ?? [])
          .filter(
            (u) =>
              u.partitionId === partition.id && !u.workspace.files.every((f) => removed.has(f)),
          )
          .map((u) => u.workspace);
        return JSON.stringify(workspaces) !== JSON.stringify(baseline.descriptor?.workspaces ?? []);
      }
      return false;
    })
    .map((p) => p.id);
}
function publicationRoot(state: CutoffJournal): string {
  return path.join(
    state.model.cacheRoot,
    CUTOFF_STATE_DIRECTORY,
    `publication-${state.invocation}`,
  );
}
/** Frozen plan plus staged payloads survive failed uploads. No new identity is selected on replay. */
export async function freezePartitionPublication(
  state: CutoffJournal,
  generation: CacheGeneration,
): Promise<void> {
  if (state.publicationPlan) {
    if (state.publicationPlan.record.key !== generation.key)
      throw new Error('Frozen publication identity changed.');
    return;
  }
  if (!state.selection || state.policy.readOnly || state.policy.jobMode === 'distributed-worker')
    throw new Error('Ineligible partition publication.');
  const changed = new Set(changedPartitionIds(state));
  const root = publicationRoot(state);
  await metadataPath(
    state.model.cacheRoot,
    `${CUTOFF_STATE_DIRECTORY}/publication-${state.invocation}/reserved`,
    true,
  );
  // An interrupted pre-intent staging pass has no backend side effects and can be reconstructed.
  await rm(root, { recursive: true, force: true });
  await mkdir(root);
  const descriptors: PartitionDescriptor[] = [],
    changedIds: string[] = [];
  const record: NonNullable<CutoffJournal['publicationPlan']>['record'] = {
    schemaVersion: 1,
    familyKey: state.model.cacheFamilyKey,
    buildToolId: state.model.buildToolId,
    partitionFingerprint: state.model.partitionFingerprint,
    lineagePrefix: generation.lineagePrefix,
    generationId: generation.generationId,
    decisionDigest: generation.contentDigest,
    key: generation.key,
    partitions: [],
    recoveryGroups: [],
  };
  for (const partition of state.model.partitions) {
    const baseline = state.basePartitions.find((p) => p.partitionId === partition.id);
    if (!changed.has(partition.id) && baseline?.reference && baseline.descriptor) {
      record.partitions.push({
        partitionId: partition.id,
        kind: 'object',
        reference: baseline.reference,
      });
      descriptors.push(baseline.descriptor);
      continue;
    }
    let sourceRoot = state.model.cacheRoot;
    let sources: SnapshotSource[];
    if (partition.publication === 'single-writer') {
      const snapshot = await readPartitionSnapshot(state.model, partition.id);
      const selected = state.partitionSnapshots.find((p) => p.partitionId === partition.id);
      if (!snapshot || snapshot.digest !== selected?.digest)
        throw new Error('Selected snapshot changed before publication.');
      sourceRoot = snapshot.rootDirectory;
      sources = snapshot.manifest.files.map((e) => ({ ...e, sourcePath: e.payloadPath }));
    } else
      sources = retainedMembers(state, partition.id).map((e) => ({
        relativePath: e.relativePath,
        sourcePath: e.relativePath,
        size: e.identity.size,
        mode: e.identity.mode & 0o777,
        mtimeMs: Math.trunc(e.identity.mtimeMs),
        identity: e.identity,
      }));
    if (!sources.length) {
      record.partitions.push({ partitionId: partition.id, kind: 'empty' });
      continue;
    }
    const kind = partitionTransportKind(state.model, partition.id);
    const removed = new Set(state.selection.gc.map((e) => e.relativePath));
    const descriptor: PartitionDescriptor = {
      schemaVersion: 1,
      identity: {
        familyKey: state.model.cacheFamilyKey,
        lineagePrefix: generation.lineagePrefix,
        partitionId: partition.id,
        writerId: generation.generationId,
        decisionDigest: generation.contentDigest,
      },
      buildToolId: state.model.buildToolId,
      partitionFingerprint: state.model.partitionFingerprint,
      kind,
      workspaces:
        kind === 'groovy'
          ? (state.selection.workspaces ?? [])
              .filter(
                (u) =>
                  u.partitionId === partition.id && !u.workspace.files.every((f) => removed.has(f)),
              )
              .map((u) => u.workspace)
          : [],
      files: [],
    };
    const reference = await stagePartitionObject(
      state.model,
      state.model.cacheRoot,
      descriptor,
      sourceRoot,
      sources,
    );
    const staged = await readPartitionDescriptor(state.model, state.model.cacheRoot, reference);
    record.partitions.push({ partitionId: partition.id, kind: 'object', reference });
    descriptors.push(staged);
    changedIds.push(partition.id);
  }
  record.recoveryGroups = createRecoveryGroups(state.model, descriptors);
  validateGenerationRecord(state.model, record, generation.key);
  await writeMetadata(root, GENERATION_RECORD_PATH, record, PARTITION_STORAGE_LIMITS.bytes);
  const candidate = {
    ...state,
    publicationKey: generation.key,
    phase: 'publication-intent' as const,
    publicationPlan: { record, descriptors, changedIds },
  };
  await persistCutoffJournal(candidate);
  Object.assign(state, candidate);
}
/** Returns null for a verified concurrent publication, otherwise the real record cache ID. */
export async function publishPartitionGeneration(
  state: CutoffJournal,
  backend: BaseCacheBackend,
): Promise<number | null> {
  const plan = state.publicationPlan;
  if (!plan) throw new Error('Missing frozen partition publication plan.');
  const root = publicationRoot(state);
  for (const entry of plan.record.partitions) {
    if (entry.kind === 'empty') continue;
    const objectRoot = state.model.cacheRoot;
    const paths = partitionObjectPaths(
      objectRoot,
      entry.partitionId,
      state.model,
      entry.reference.workspaceRoots,
    );
    const changed = plan.changedIds.includes(entry.partitionId);
    if (!changed || state.partitionReceipts.includes(entry.partitionId)) {
      if (backend.lookupCache) {
        if (
          (await backend.lookupCache(paths, entry.reference.key, { archiveRoot: objectRoot })) !==
          entry.reference.key
        )
          throw new Error(
            `Required partition '${entry.partitionId}' is missing before generation publication.`,
          );
      } else await confirmObject(state, backend, entry.reference);
      continue;
    }
    const descriptor = plan.descriptors.find((d) => d.identity.partitionId === entry.partitionId)!;
    await writeMetadata(
      objectRoot,
      `${partitionObjectRoot(entry.partitionId)}/object.json`,
      descriptor,
      PARTITION_STORAGE_LIMITS.bytes,
    );
    await readPartitionObject(state.model, objectRoot, entry.reference, true);
    await verifyCutoffReplay(state);
    let cacheId: number;
    try {
      cacheId = await backend.saveCache(paths, entry.reference.key, { archiveRoot: objectRoot });
    } catch (error) {
      try {
        await confirmObject(state, backend, entry.reference);
      } catch {
        throw error;
      }
      cacheId = 1;
    }
    if (cacheId <= 0) await confirmObject(state, backend, entry.reference);
    await verifyCutoffReplay(state);
    const candidate = {
      ...state,
      partitionReceipts: [...state.partitionReceipts, entry.partitionId],
    };
    await persistCutoffJournal(candidate);
    Object.assign(state, candidate);
  }
  await verifyCutoffReplay(state);
  // The immutable record must equal the frozen plan even after a process retry.
  await writeMetadata(root, GENERATION_RECORD_PATH, plan.record, PARTITION_STORAGE_LIMITS.bytes);
  let cacheId: number;
  try {
    cacheId = await backend.saveCache(generationRecordPaths(root), plan.record.key, {
      archiveRoot: root,
    });
  } catch {
    cacheId = -1;
  }
  if (cacheId > 0) return cacheId;
  const scratch = await mkdtemp(path.join(tmpdir(), 'mammoth-confirm-record-'));
  try {
    const matched = await backend.restoreCache(
      generationRecordPaths(scratch),
      plan.record.key,
      [],
      { archiveRoot: scratch },
    );
    if (matched !== plan.record.key)
      throw new Error('Generation record publication was not confirmed.');
    const raw = await readMetadata(scratch, GENERATION_RECORD_PATH, PARTITION_STORAGE_LIMITS.bytes);
    if (
      !raw ||
      storageDigest(validateGenerationRecord(state.model, JSON.parse(raw), matched)) !==
        storageDigest(plan.record)
    )
      throw new Error('Concurrent generation record differs from frozen publication.');
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
async function confirmObject(
  state: CutoffJournal,
  backend: BaseCacheBackend,
  reference: PartitionReference,
) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'mammoth-confirm-object-'));
  try {
    const matched = await backend.restoreCache(
      partitionObjectPaths(
        scratch,
        reference.identity.partitionId,
        state.model,
        reference.workspaceRoots,
      ),
      reference.key,
      [],
      { archiveRoot: scratch },
    );
    if (matched !== reference.key)
      throw new Error(`Partition '${reference.identity.partitionId}' upload was not confirmed.`);
    await readPartitionObject(state.model, scratch, reference);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export function partitionPublicationLines(state: CutoffJournal): string[] {
  return (
    state.publicationPlan?.record.partitions.map(
      (entry) =>
        `Partition '${entry.partitionId}': ${entry.kind === 'empty' ? 'empty' : !state.publicationPlan!.changedIds.includes(entry.partitionId) ? 'reused' : state.partitionReceipts.includes(entry.partitionId) ? 'saved' : 'pending'}; generation ${state.saved ? 'published' : 'unconfirmed'}.`,
    ) ?? []
  );
}
export async function cleanPublishedPartitionStaging(state: CutoffJournal): Promise<void> {
  if (state.saved) await rm(publicationRoot(state), { recursive: true, force: true });
}
