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
import { randomUUID, createHash } from 'node:crypto';
import { opendir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readMetadata, writeMetadata, metadataPath } from './metadata-io';
import { CUTOFF_STATE_DIRECTORY } from './metadata-paths';
import {
  cutoffDigestSchema,
  cutoffManifestSchema,
  cutoffPathSchema,
  cutoffPartitionIdSchema,
} from './cutoff-format';
import {
  cutoffTargetSchema,
  fingerprintMetadata,
  type CutoffSelection,
  type WorkerObservations,
} from './cutoff-selection';
import { sameFileIdentity } from './file-identity';
import { captureCacheMetadataSnapshot, createManagedCachePathMatcher } from './manifest';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import type { CacheModel } from './model';
import type { NormalizedActionConfig } from '../config/types';
import { isMissingPathError } from '../util/fs';
import { snapshotPartitions, ownsSnapshot, readPartitionSnapshot } from './partition-snapshots';

export const CUTOFF_JOURNAL_LIMITS = { records: 200_000, bytes: 64 * 1024 * 1024 } as const;
const text = z.string().min(1);
const glob = text.refine((p) => {
  try {
    validateNormalizedRelativePosixPath(p, 'Glob', 'cache root');
    return true;
  } catch {
    return false;
  }
});
const partitionSchema = z
  .object({
    id: cutoffPartitionIdSchema,
    displayName: text,
    description: z.string(),
    publication: z.enum(['aggregate', 'single-writer']).optional(),
    writer: text.optional(),
    relativeIncludeGlobs: z.array(glob),
    relativeExcludeGlobs: z.array(glob),
    absoluteIncludeGlobs: z.array(text),
    absoluteExcludeGlobs: z.array(text),
  })
  .strict();
export const cutoffModelSchema = z
  .object({
    cacheRoot: text.refine((p) => path.isAbsolute(p) && path.resolve(p) === p),
    cacheFamilyKey: text.max(512),
    currentRefToken: text,
    currentRefLineagePrefix: text.max(512),
    fallbackRefLineagePrefixes: z.array(text).max(1),
    plannedGenerationId: text,
    javaMajor: z.number().int().min(8).nullable(),
    runnerOs: text,
    runnerArch: text,
    safeRefName: text,
    partitionFingerprint: text,
    buildToolId: text,
    partitions: z.array(partitionSchema),
    includePaths: z.array(text),
    excludePaths: z.array(text),
  })
  .strict()
  .superRefine((model, ctx) => {
    const ids = model.partitions.map((p) => p.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate partitions.' });
    for (const p of model.partitions)
      for (const [relative, absolute] of [
        [p.relativeIncludeGlobs, p.absoluteIncludeGlobs],
        [p.relativeExcludeGlobs, p.absoluteExcludeGlobs],
      ])
        if (
          JSON.stringify(relative!.map((g) => path.join(model.cacheRoot, g))) !==
          JSON.stringify(absolute)
        )
          ctx.addIssue({ code: 'custom', message: 'Partition absolute globs mismatch.' });
    if (
      JSON.stringify(model.includePaths) !==
        JSON.stringify(model.partitions.flatMap((p) => p.absoluteIncludeGlobs)) ||
      JSON.stringify(model.excludePaths) !==
        JSON.stringify([...new Set(model.partitions.flatMap((p) => p.absoluteExcludeGlobs))])
    )
      ctx.addIssue({ code: 'custom', message: 'Model path mismatch.' });
  });
export const cutoffPolicySchema = z
  .object({
    jobMode: z.enum(['standalone', 'distributed-worker', 'distributed-aggregator']),
    readOnly: z.boolean(),
    cleanupEnabled: z.boolean(),
    cacheGcMode: z.enum(['off', 'timestamp']),
    cacheGcOlderThanDays: z.number().finite().min(2),
    restoreCleanupMode: z.enum(['none', 'prune-managed']),
    dependentJobs: z.array(text),
    allowDuplicateDependentDeltaPaths: z.boolean(),
  })
  .strict();
export type CutoffPolicy = z.infer<typeof cutoffPolicySchema>;
export function cutoffGcEnabled(p: CutoffPolicy): boolean {
  return (
    p.cacheGcMode === 'timestamp' &&
    p.cleanupEnabled &&
    !p.readOnly &&
    p.jobMode !== 'distributed-worker'
  );
}
export function cutoffPolicy(config: NormalizedActionConfig): CutoffPolicy {
  return cutoffPolicySchema.parse(
    Object.fromEntries(
      Object.keys(cutoffPolicySchema.shape).map((key) => [
        key,
        config[key as keyof NormalizedActionConfig],
      ]),
    ),
  );
}
export const cutoffExecutionSchema = z
  .object({
    repository: text,
    workflowName: text,
    jobName: text,
    runId: z.number().int().nonnegative().nullable(),
    runAttempt: z.number().int().positive().nullable(),
    sourceRevision: z.string().nullable(),
  })
  .strict();
const observationsSchema = z
  .object({ upserts: z.array(cutoffPathSchema), used: z.array(cutoffPathSchema) })
  .strict();
const selectionSchema = z
  .object({
    snapshotFileCount: z.number().int().nonnegative().optional(),
    snapshotByteCount: z.number().nonnegative().optional(),
    upserts: z.array(cutoffTargetSchema),
    used: z.array(cutoffPathSchema),
    gc: z.array(cutoffTargetSchema),
    retainedFingerprint: cutoffDigestSchema,
    fileCount: z.number().int().nonnegative(),
    byteCount: z.number().nonnegative(),
  })
  .strict();
const sealSchema = z
  .object({ manifest: cutoffManifestSchema, identity: cutoffDigestSchema, artifactName: text })
  .strict();
const partitionSnapshotRecordSchema = z
  .object({
    partitionId: cutoffPartitionIdSchema,
    baselineDigest: cutoffDigestSchema.nullable(),
    digest: cutoffDigestSchema,
    contentDigest: cutoffDigestSchema,
    fileCount: z.number().int().nonnegative(),
    byteCount: z.number().nonnegative(),
    source: z.enum(['seed', 'writer', 'local']),
    changed: z.boolean(),
  })
  .strict();
export const cutoffJournalSchema = z
  .object({
    schemaVersion: z.literal(2),
    invocation: z.string().uuid(),
    phase: z.enum([
      'prepare-pending',
      'build-ready',
      'observations-frozen',
      'package-sealed',
      'deleting',
      'publication-intent',
      'completed',
    ]),
    model: cutoffModelSchema,
    policy: cutoffPolicySchema,
    execution: cutoffExecutionSchema,
    cutoff: z.number().finite().nonnegative().nullable(),
    workers: observationsSchema,
    producerArtifacts: z.array(text),
    partitionSnapshots: z.array(partitionSnapshotRecordSchema).default([]),
    snapshotWarnings: z.array(text).default([]),
    restoredKey: text.nullable(),
    restoreStatus: z.enum([
      'miss',
      'feature-unavailable',
      'current-lineage-hit',
      'fallback-lineage-hit',
    ]),
    observedAt: z.number().finite().nonnegative().nullable(),
    selection: selectionSchema.nullable(),
    seal: sealSchema.nullable(),
    deletedPaths: z.array(cutoffPathSchema),
    publicationKey: text.nullable(),
    saved: z.boolean(),
    workerReceipt: z
      .object({ name: text, id: z.number().int().positive(), size: z.number().nonnegative() })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    const snapshotIds = snapshotPartitions(state.model).map((p) => p.id);
    if (
      new Set(state.partitionSnapshots.map((s) => s.partitionId)).size !==
        state.partitionSnapshots.length ||
      state.partitionSnapshots.some((s) => !snapshotIds.includes(s.partitionId)) ||
      (state.phase !== 'prepare-pending' && state.partitionSnapshots.length !== snapshotIds.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Snapshot selection/model mismatch.' });
    if (state.selection?.gc.some((e) => snapshotIds.includes(e.partitionId)))
      ctx.addIssue({ code: 'custom', message: 'Snapshot partitions cannot use per-file GC.' });
    if (
      state.workerReceipt &&
      (!state.seal || state.workerReceipt.name !== state.seal.artifactName)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid worker publication receipt.' });
    const early = ['prepare-pending', 'build-ready'].includes(state.phase);
    const writer = state.policy.jobMode === 'distributed-worker' && !state.policy.readOnly;
    if (state.phase !== 'prepare-pending' && state.cutoff === null)
      ctx.addIssue({ code: 'custom', message: 'Missing build-ready cutoff.' });
    if (
      early &&
      (state.selection !== null ||
        state.observedAt !== null ||
        state.seal !== null ||
        state.deletedPaths.length ||
        state.publicationKey !== null ||
        state.saved ||
        state.workerReceipt)
    )
      ctx.addIssue({ code: 'custom', message: 'Decisions before the freeze.' });
    if (!early && (!state.selection || state.observedAt === null))
      ctx.addIssue({ code: 'custom', message: 'Missing frozen decisions/time.' });
    if (
      (state.phase === 'package-sealed' || (writer && state.phase === 'completed')) &&
      !state.seal
    )
      ctx.addIssue({ code: 'custom', message: 'Missing package seal.' });
    if (state.seal && !writer)
      ctx.addIssue({ code: 'custom', message: 'Only writable workers seal packages.' });
    if (state.phase === 'publication-intent' && !state.publicationKey)
      ctx.addIssue({ code: 'custom', message: 'Missing publication key.' });
    if (state.saved && (!state.publicationKey || state.phase !== 'completed'))
      ctx.addIssue({ code: 'custom', message: 'Invalid saved result.' });
    if (new Set(state.deletedPaths).size !== state.deletedPaths.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate deletion progress.' });
    if (state.selection?.gc.length && !cutoffGcEnabled(state.policy))
      ctx.addIssue({ code: 'custom', message: 'GC decisions violate recorded policy.' });
    if (state.phase === 'deleting' && !cutoffGcEnabled(state.policy))
      ctx.addIssue({ code: 'custom', message: 'Invalid deletion phase.' });
    if (
      state.publicationKey &&
      (state.policy.readOnly ||
        state.policy.jobMode === 'distributed-worker' ||
        !state.publicationKey.startsWith(state.model.currentRefLineagePrefix))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid publication policy/key.' });
    if (state.selection) {
      const selected = new Map(state.selection.upserts.map((e) => [e.relativePath, e]));
      if (state.selection.used.some((p) => selected.has(p)))
        ctx.addIssue({ code: 'custom', message: 'Duplicate usage/upsert.' });
      if (state.seal) {
        const manifest = state.seal.manifest;
        for (const p of manifest.partitions) {
          const definition = state.model.partitions.find((d) => d.id === p.partitionId);
          if (
            !definition ||
            !!p.snapshot !== ownsSnapshot(definition, state.policy.jobMode, state.execution.jobName)
          )
            ctx.addIssue({ code: 'custom', message: 'Sealed snapshot ownership mismatch.' });
        }
        if (
          manifest.buildToolId !== state.model.buildToolId ||
          JSON.stringify(manifest.partitions.map((p) => p.partitionId)) !==
            JSON.stringify(state.model.partitions.map((p) => p.id))
        )
          ctx.addIssue({ code: 'custom', message: 'Seal/model mismatch.' });
        const sealed = manifest.partitions.flatMap((p) =>
          p.upserts.map((e) => ({ ...e, partitionId: p.partitionId })),
        );
        if (
          sealed.length !== selected.size ||
          sealed.some((e) => {
            const n = selected.get(e.relativePath);
            return (
              !n ||
              n.partitionId !== e.partitionId ||
              n.identity.size !== e.size ||
              (n.identity.mode & 0o777) !== e.mode ||
              Math.trunc(n.identity.mtimeMs) !== e.mtimeMs
            );
          })
        )
          ctx.addIssue({ code: 'custom', message: 'Seal/selection mismatch.' });
        if (
          JSON.stringify(manifest.partitions.flatMap((p) => p.usedPaths).sort()) !==
          JSON.stringify([...state.selection.used].sort())
        )
          ctx.addIssue({ code: 'custom', message: 'Seal/usage mismatch.' });
      }
    }
    const owns = createManagedCachePathMatcher(state.model);
    const ownsAny = (name: string) => state.model.partitions.some((p) => owns(p.id, name));
    for (const name of [
      ...state.workers.upserts,
      ...state.workers.used,
      ...(state.selection?.used ?? []),
    ])
      if (!ownsAny(name)) ctx.addIssue({ code: 'custom', message: 'Unmanaged observation path.' });
    if (state.seal)
      for (const p of state.seal.manifest.partitions)
        for (const name of p.usedPaths)
          if (!owns(p.partitionId, name))
            ctx.addIssue({ code: 'custom', message: 'Unmanaged sealed usage.' });
    for (const target of [...(state.selection?.upserts ?? []), ...(state.selection?.gc ?? [])])
      if (!owns(target.partitionId, target.relativePath))
        ctx.addIssue({ code: 'custom', message: 'Unmanaged operation path.' });
    if (state.selection) {
      const targets = [...state.selection.upserts, ...state.selection.gc].map(
        (e) => e.relativePath,
      );
      if (new Set(targets).size !== targets.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate operation target.' });
      const gc = new Set(state.selection.gc.map((e) => e.relativePath));
      if (state.deletedPaths.some((p) => !gc.has(p)))
        ctx.addIssue({ code: 'custom', message: 'Unplanned deletion.' });
    }
  });
export type CutoffJournal = z.infer<typeof cutoffJournalSchema>;
const JOURNAL_PATTERN = /^journal-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u;
const pointerSchema = z
  .object({ schemaVersion: z.literal(1), journal: z.string().regex(JOURNAL_PATTERN) })
  .strict();
export function cutoffJournalPath(invocation: string): string {
  return `${CUTOFF_STATE_DIRECTORY}/journal-${z.string().uuid().parse(invocation)}.json`;
}
export function newCutoffJournal(
  model: CacheModel,
  policy: CutoffPolicy,
  execution: CutoffJournal['execution'],
): CutoffJournal {
  return cutoffJournalSchema.parse({
    schemaVersion: 2,
    invocation: randomUUID(),
    phase: 'prepare-pending',
    model,
    policy,
    execution,
    cutoff: null,
    workers: { upserts: [], used: [] },
    producerArtifacts: [],
    partitionSnapshots: [],
    snapshotWarnings: [],
    restoredKey: null,
    restoreStatus: 'miss',
    observedAt: null,
    selection: null,
    seal: null,
    deletedPaths: [],
    publicationKey: null,
    saved: false,
    workerReceipt: null,
  });
}
export function validateCutoffBudget(
  state: CutoffJournal,
  limits: { records: number; bytes: number } = CUTOFF_JOURNAL_LIMITS,
): void {
  const s = state.selection;
  const records =
    state.workers.upserts.length +
    state.workers.used.length +
    state.producerArtifacts.length +
    state.deletedPaths.length +
    state.partitionSnapshots.reduce((n, s) => n + s.fileCount, 0) +
    (s ? s.upserts.length + s.used.length + s.gc.length : 0) +
    (state.seal
      ? state.seal.manifest.partitions.reduce(
          (n, p) => n + p.upserts.length + p.usedPaths.length,
          0,
        )
      : 0);
  if (records > limits.records || Buffer.byteLength(JSON.stringify(state)) > limits.bytes)
    throw new Error('Cutoff journal exceeds its actual record/byte budget.');
  const needsSeal =
    state.policy.jobMode === 'distributed-worker' && !state.policy.readOnly && !!s && !state.seal;
  // Reserve a complete portable seal and maximum name/checksum fields before opening payloads.
  const reservedSeal =
    needsSeal && s
      ? {
          manifest: {
            schemaVersion: 4,
            buildToolId: state.model.buildToolId,
            partitions: state.model.partitions.map((p, index) => ({
              partitionId: p.id,
              ...(ownsSnapshot(p, state.policy.jobMode, state.execution.jobName)
                ? { snapshot: true }
                : {}),
              upserts: s.upserts
                .filter((e) => e.partitionId === p.id)
                .map((e) => ({
                  relativePath: e.relativePath,
                  payloadPath: 'payload/999999.bin',
                  contentSha256: 'f'.repeat(64),
                  size: e.identity.size,
                  mode: e.identity.mode & 0o777,
                  mtimeMs: Math.trunc(e.identity.mtimeMs),
                })),
              usedPaths: index === 0 ? s.used : [],
            })),
          },
          identity: 'f'.repeat(64),
          artifactName: 'x'.repeat(128),
        }
      : state.seal;
  const projected = {
    ...state,
    seal: reservedSeal,
    deletedPaths: s ? s.gc.map((e) => e.relativePath) : state.deletedPaths,
    publicationKey: 'x'.repeat(512),
  };
  const reservedRecords =
    (s ? Math.max(0, s.gc.length - state.deletedPaths.length) : 0) +
    (needsSeal && s ? s.upserts.length + s.used.length : 0);
  if (
    records + reservedRecords > limits.records ||
    Buffer.byteLength(JSON.stringify(projected)) + 1024 > limits.bytes
  )
    throw new Error('Cutoff journal exceeds its record/byte budget.');
}
async function retire(root: string, keep: ReadonlySet<string>): Promise<void> {
  const file = await metadataPath(root, `${CUTOFF_STATE_DIRECTORY}/current.json`).catch(
    (error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    },
  );
  if (!file) return;
  for await (const entry of await opendir(path.dirname(file))) {
    if (!JOURNAL_PATTERN.test(entry.name) || keep.has(entry.name)) continue;
    const target = path.join(path.dirname(file), entry.name),
      st = await lstat(target);
    if (st.isFile() && !st.isSymbolicLink()) await rm(target);
  }
}
export async function persistCutoffJournal(state: CutoffJournal): Promise<void> {
  cutoffJournalSchema.parse(state);
  validateCutoffBudget(state);
  const root = state.model.cacheRoot,
    name = path.posix.basename(cutoffJournalPath(state.invocation));
  const raw = await readMetadata(root, `${CUTOFF_STATE_DIRECTORY}/current.json`, 4096);
  let previous: string | null | undefined = null;
  if (raw)
    try {
      previous = pointerSchema.parse(JSON.parse(raw)).journal;
    } catch {
      previous = undefined;
    }
  if (previous !== undefined && previous !== name)
    await retire(root, new Set(previous ? [previous, name] : [name]));
  await writeMetadata(
    root,
    cutoffJournalPath(state.invocation),
    state,
    CUTOFF_JOURNAL_LIMITS.bytes,
  );
  await writeMetadata(
    root,
    `${CUTOFF_STATE_DIRECTORY}/current.json`,
    { schemaVersion: 1, journal: name },
    4096,
  );
  await retire(root, new Set([name]));
}
export async function loadCutoffJournal(
  model: CacheModel,
  relative: string,
  invocation?: string,
): Promise<CutoffJournal> {
  if (
    relative !== `${CUTOFF_STATE_DIRECTORY}/${path.posix.basename(relative)}` ||
    !JOURNAL_PATTERN.test(path.posix.basename(relative))
  )
    throw new Error('Invalid cutoff journal path.');
  const pointer = await readMetadata(
    model.cacheRoot,
    `${CUTOFF_STATE_DIRECTORY}/current.json`,
    4096,
  );
  if (
    !pointer ||
    pointerSchema.parse(JSON.parse(pointer)).journal !== path.posix.basename(relative)
  )
    throw new Error('Cutoff journal was superseded or is missing.');
  const raw = await readMetadata(model.cacheRoot, relative, CUTOFF_JOURNAL_LIMITS.bytes);
  if (!raw) throw new Error('Cutoff journal missing.');
  const state = cutoffJournalSchema.parse(JSON.parse(raw));
  validateCutoffBudget(state);
  if (
    JSON.stringify(state.model) !== JSON.stringify(cutoffModelSchema.parse(model)) ||
    relative !== cutoffJournalPath(state.invocation) ||
    (invocation && state.invocation !== invocation)
  )
    throw new Error('Cutoff journal identity mismatch.');
  return state;
}
export async function freezeCutoffSelection(
  state: CutoffJournal,
  selection: CutoffSelection,
  now: number,
): Promise<void> {
  // A prior write can have committed observations before its pointer/retirement step failed.
  const durable = await loadCutoffJournal(
    state.model,
    cutoffJournalPath(state.invocation),
    state.invocation,
  );
  if (durable.selection) Object.assign(state, durable);
  if (state.selection) {
    await persistCutoffJournal(state);
    return;
  }
  const candidate = { ...state, selection, observedAt: now, phase: 'observations-frozen' as const };
  await persistCutoffJournal(candidate);
  Object.assign(state, candidate);
}
export async function verifyCutoffReplay(state: CutoffJournal): Promise<void> {
  if (!state.selection) throw new Error('No frozen cutoff observations.');
  for (const selected of state.partitionSnapshots) {
    const partition = state.model.partitions.find((p) => p.id === selected.partitionId)!;
    // An owner can reconstruct an interrupted first install from frozen live sources.
    if (
      !state.policy.readOnly &&
      selected.source !== 'local' &&
      ownsSnapshot(partition, state.policy.jobMode, state.execution.jobName)
    )
      continue;
    const snapshot = await readPartitionSnapshot(state.model, selected.partitionId);
    if (!snapshot || snapshot.digest !== selected.digest)
      throw new Error('Selected partition snapshot changed.');
  }
  const snapshot = await captureCacheMetadataSnapshot(state.model),
    gc = new Set(state.selection.gc.map((e) => e.relativePath));
  if (fingerprintMetadata(snapshot, gc) !== state.selection.retainedFingerprint)
    throw new Error('Frozen cutoff retained content changed; run prepare again.');
  const actual = new Map(
    snapshot.partitions.flatMap((p) => p.entries.map((e) => [e.relativePath, e.identity] as const)),
  );
  for (const target of [...state.selection.upserts, ...state.selection.gc]) {
    const current = actual.get(target.relativePath);
    if (!current && gc.has(target.relativePath)) continue;
    if (!current || !sameFileIdentity(target.identity, current, true))
      throw new Error(`Frozen cutoff target changed: ${target.relativePath}`);
  }
}
export function cutoffDecisionDigest(state: CutoffJournal): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        invocation: state.invocation,
        cutoff: state.cutoff,
        policy: state.policy,
        selection: state.selection,
        producerArtifacts: state.producerArtifacts,
        partitionSnapshots: state.partitionSnapshots,
      }),
    )
    .digest('hex');
}
export function assertPrepareWorkerBudget(
  state: CutoffJournal,
  workers: WorkerObservations,
  artifacts: string[],
): void {
  validateCutoffBudget({ ...state, workers, producerArtifacts: artifacts });
}
