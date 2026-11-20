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
import { stagePartitionObject, readPartitionObject } from './partition-transport';
import { DirectoryValidationBatch } from './guarded-files';
import { StoreEvidence } from './store-evidence';
import type { CutoffTarget } from './cutoff-selection';
import {
  inspectWorkspaceTree,
  type WorkspaceObservation,
  type ImmutableWorkspace,
} from './immutable-workspaces';
import { sameFileIdentity } from './file-identity';
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

function publicationInputs(state: CutoffJournal) {
  if (!state.selection) throw new Error('Partition decisions require frozen observations.');
  const removed = new Set(state.selection.gc.map((e) => e.relativePath));
  const members = new Map<string, CutoffTarget[]>();
  for (const entry of state.selection.members ?? state.selection.upserts) {
    if (removed.has(entry.relativePath)) continue;
    const list = members.get(entry.partitionId) ?? [];
    list.push(entry);
    members.set(entry.partitionId, list);
  }
  const workspaces = new Map<string, ImmutableWorkspace[]>();
  for (const unit of state.selection.workspaces ?? []) {
    if (unit.workspace.files.every((f) => removed.has(f))) continue;
    const list = workspaces.get(unit.partitionId) ?? [];
    list.push(unit.workspace);
    workspaces.set(unit.partitionId, list);
  }
  const baselines = new Map(state.basePartitions.map((p) => [p.partitionId, p]));
  const snapshots = new Map(state.partitionSnapshots.map((s) => [s.partitionId, s]));
  const touched = new Set(
    [...state.selection.upserts, ...state.selection.gc].map((e) => e.partitionId),
  );
  const workerPaths = new Set(state.workers.upserts);
  const changedIds = state.model.partitions
    .filter((partition) => {
      const baseline = baselines.get(partition.id),
        selected = members.get(partition.id) ?? [];
      if (partition.publication === 'single-writer') {
        const snapshot = snapshots.get(partition.id)!;
        return snapshot.changed || (!baseline?.reference && snapshot.fileCount > 0);
      }
      if (touched.has(partition.id)) return true;
      if (!baseline || baseline.status === 'missing') return selected.length > 0;
      if (
        JSON.stringify(selected.map((e) => e.relativePath)) !==
        JSON.stringify(baseline.descriptor?.files.map((e) => e.relativePath) ?? [])
      )
        return true;
      if (selected.some((e) => workerPaths.has(e.relativePath))) return true;
      return (
        partitionTransportKind(state.model, partition.id) === 'workspace' &&
        JSON.stringify(workspaces.get(partition.id) ?? []) !==
          JSON.stringify(baseline.descriptor?.workspaces ?? [])
      );
    })
    .map((p) => p.id);
  return { members, workspaces, baselines, snapshots, changedIds };
}
export function changedPartitionIds(state: CutoffJournal): string[] {
  return publicationInputs(state).changedIds;
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
  evidence?: StoreEvidence,
): Promise<void> {
  if (state.publicationPlan) {
    if (state.publicationPlan.record.key !== generation.key)
      throw new Error('Frozen publication identity changed.');
    return;
  }
  if (!state.selection || state.policy.readOnly || state.policy.jobMode === 'distributed-worker')
    throw new Error('Ineligible partition publication.');
  const inputs = publicationInputs(state);
  const changed = new Set(inputs.changedIds);
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
    schemaVersion: 3,
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
    const baseline = inputs.baselines.get(partition.id);
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
      const snapshot = await readPartitionSnapshot(state.model, partition.id, 'verified', evidence);
      const selected = inputs.snapshots.get(partition.id);
      if (!snapshot || snapshot.digest !== selected?.digest)
        throw new Error('Selected snapshot changed before publication.');
      sourceRoot = snapshot.rootDirectory;
      sources = snapshot.manifest.files.map((e) => ({ ...e, sourcePath: e.payloadPath }));
    } else
      sources = (inputs.members.get(partition.id) ?? []).map((e) => ({
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
    const descriptor: PartitionDescriptor = {
      schemaVersion: 3,
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
      workspaces: kind === 'workspace' ? (inputs.workspaces.get(partition.id) ?? []) : [],
      files: [],
    };
    const { reference, descriptor: staged } = await stagePartitionObject(
      state.model,
      state.model.cacheRoot,
      descriptor,
      sourceRoot,
      sources,
      evidence,
    );
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
  await persistCutoffJournal(candidate, evidence);
  Object.assign(state, candidate);
}
/** Returns null for a verified concurrent publication, otherwise the real record cache ID. */
export async function publishPartitionGeneration(
  state: CutoffJournal,
  backend: BaseCacheBackend,
  publicationEvidence?: StoreEvidence,
): Promise<number | null> {
  const plan = state.publicationPlan;
  if (!plan) throw new Error('Missing frozen partition publication plan.');
  const root = publicationRoot(state);
  // A resumed/direct publication establishes fresh proofs before trusting any receipt.
  const evidence = publicationEvidence ?? new StoreEvidence();
  if (!publicationEvidence) await verifyCutoffReplay(state, evidence);
  evidence.sealTransportDirectories();
  const workspaces = new Map((state.selection?.workspaces ?? []).map((u) => [u.workspace.root, u]));
  const changedIds = new Set(plan.changedIds),
    receipts = new Set(state.partitionReceipts);
  const descriptors = new Map(plan.descriptors.map((d) => [d.identity.partitionId, d]));
  for (const entry of plan.record.partitions) {
    if (entry.kind === 'empty') continue;
    const objectRoot = state.model.cacheRoot;
    const paths = partitionObjectPaths(
      objectRoot,
      entry.partitionId,
      state.model,
      entry.reference.workspaceRoots,
      entry.reference.ordinaryPaths,
    );
    const changed = changedIds.has(entry.partitionId);
    if (!changed || receipts.has(entry.partitionId)) {
      // A prior invocation may have saved a receipt before its global directory
      // barrier failed. Fresh readback prevents that archive reviving a bad plan.
      if (receipts.has(entry.partitionId)) await confirmObject(state, backend, entry.reference);
      else if (backend.lookupCache) {
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
    const descriptor = descriptors.get(entry.partitionId)!;
    await writeMetadata(
      objectRoot,
      `${partitionObjectRoot(entry.partitionId)}/object.json`,
      descriptor,
      PARTITION_STORAGE_LIMITS.bytes,
    );
    await evidence.measure('partition-source-check', () =>
      verifyPublicationSources(state, descriptor, entry.reference, evidence, workspaces),
    );
    let cacheId: number;
    try {
      cacheId = await evidence.measure('backend-save', () =>
        backend.saveCache(paths, entry.reference.key, { archiveRoot: objectRoot }),
      );
    } catch (error) {
      try {
        await confirmObject(state, backend, entry.reference);
      } catch {
        throw error;
      }
      cacheId = 1;
    }
    if (cacheId <= 0) await confirmObject(state, backend, entry.reference);
    await evidence.measure('partition-source-check', () =>
      verifyPublicationSources(state, descriptor, entry.reference, evidence, workspaces),
    );
    const candidate = {
      ...state,
      partitionReceipts: [...state.partitionReceipts, entry.partitionId],
    };
    await persistCutoffJournal(candidate, evidence);
    Object.assign(state, candidate);
  }
  await verifyCutoffReplay(state, evidence);
  // The immutable record must equal the frozen plan even after a process retry.
  await writeMetadata(root, GENERATION_RECORD_PATH, plan.record, PARTITION_STORAGE_LIMITS.bytes);
  let cacheId: number;
  try {
    cacheId = await evidence.measure('backend-save', () =>
      backend.saveCache(generationRecordPaths(root), plan.record.key, {
        archiveRoot: root,
      }),
    );
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
/** Small persisted metadata boundary plus operation-local content/identity bindings. */
async function verifyPublicationSources(
  state: CutoffJournal,
  descriptor: PartitionDescriptor,
  reference: PartitionReference,
  evidence: StoreEvidence,
  workspaces: ReadonlyMap<string, WorkspaceObservation>,
): Promise<void> {
  const root = state.model.cacheRoot;
  const raw = await readMetadata(
    root,
    `${partitionObjectRoot(reference.identity.partitionId)}/object.json`,
    PARTITION_STORAGE_LIMITS.bytes,
  );
  if (!raw || storageDigest(JSON.parse(raw)) !== reference.descriptorDigest)
    throw new Error('Planned partition descriptor changed.');
  for (const unit of descriptor.workspaces) {
    const expected = workspaces.get(unit.root);
    const tree = await inspectWorkspaceTree(root, unit.root, unit.kind !== 'artifact-transform');
    if (
      !expected ||
      !tree ||
      JSON.stringify(tree.files.map((f) => f.relativePath)) !== JSON.stringify(unit.files) ||
      JSON.stringify(tree.emptyDirectories) !== JSON.stringify(unit.emptyDirectories) ||
      tree.directories.length !== expected.directories.length ||
      tree.directories.some(
        (entry, i) =>
          entry.relativePath !== expected.directories[i]!.relativePath ||
          !sameFileIdentity(entry.identity, expected.directories[i]!.identity, true),
      )
    )
      throw new Error('Frozen publication workspace changed.');
  }
  const directories = new DirectoryValidationBatch(root);
  for (const entry of descriptor.files)
    await evidence.hash(root, entry.payloadPath, entry, undefined, directories);
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
        reference.ordinaryPaths,
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
