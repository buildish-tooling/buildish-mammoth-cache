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
import {
  cutoffDigestSchema,
  cutoffPartitionIdSchema,
  cutoffUpsertSchema,
  cutoffPathSchema,
} from './cutoff-format';
import {
  groovyWorkspaceSchema,
  isGroovyPartition,
  assertGroovyContributions,
} from './groovy-workspaces';
import { createManagedCachePathMatcher } from './manifest';
import { DELTA_ARTIFACT_RESOURCE_LIMITS } from '../delta/discovery';
import type { CacheModel } from './model';

export const GENERATION_RECORD_PATH = '.mammoth/generations-v1/record.json';
export const PARTITION_OBJECT_DIRECTORY = '.mammoth/partition-objects-v1';
export const PARTITION_STORAGE_LIMITS = { bytes: 64 * 1024 * 1024, records: 200_000 } as const;
const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,512}$/u);
const writerSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u);
export const objectIdentitySchema = z
  .object({
    familyKey: keySchema,
    lineagePrefix: keySchema,
    partitionId: cutoffPartitionIdSchema,
    writerId: writerSchema,
    decisionDigest: cutoffDigestSchema,
  })
  .strict();
export const partitionDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: objectIdentitySchema,
    buildToolId: z.string().min(1),
    partitionFingerprint: z.string().min(1),
    kind: z.enum(['aggregate', 'single-writer', 'groovy']),
    files: z
      .array(cutoffUpsertSchema.extend({ payloadPath: z.string().min(1) }))
      .max(PARTITION_STORAGE_LIMITS.records),
    workspaces: z.array(groovyWorkspaceSchema).max(PARTITION_STORAGE_LIMITS.records),
  })
  .strict();
export const partitionReferenceSchema = z
  .object({
    identity: objectIdentitySchema,
    key: keySchema,
    descriptorDigest: cutoffDigestSchema,
    workspaceRoots: z
      .array(z.string().regex(/^caches\/[A-Za-z0-9._-]+\/groovy-dsl\/[a-f0-9]{32}$/u))
      .max(PARTITION_STORAGE_LIMITS.records)
      .optional(),
  })
  .strict();
export const generationEntrySchema = z.discriminatedUnion('kind', [
  z.object({ partitionId: cutoffPartitionIdSchema, kind: z.literal('empty') }).strict(),
  z
    .object({
      partitionId: cutoffPartitionIdSchema,
      kind: z.literal('object'),
      reference: partitionReferenceSchema,
    })
    .strict(),
]);
export const generationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    familyKey: keySchema,
    buildToolId: z.string().min(1),
    partitionFingerprint: z.string().min(1),
    lineagePrefix: keySchema,
    generationId: writerSchema,
    decisionDigest: cutoffDigestSchema,
    key: keySchema,
    partitions: z.array(generationEntrySchema).max(PARTITION_STORAGE_LIMITS.records),
    recoveryGroups: z
      .array(z.array(cutoffPartitionIdSchema).min(1))
      .max(PARTITION_STORAGE_LIMITS.records),
  })
  .strict();
export const partitionBaselineSchema = z
  .object({
    partitionId: cutoffPartitionIdSchema,
    status: z.enum(['restored', 'empty', 'missing']),
    reference: partitionReferenceSchema.nullable(),
    descriptor: partitionDescriptorSchema.nullable(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      (entry.status === 'restored') !== (entry.reference !== null && entry.descriptor !== null) ||
      (entry.status !== 'restored' && (entry.reference !== null || entry.descriptor !== null))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid restored partition baseline.' });
  });
export type PartitionDescriptor = z.infer<typeof partitionDescriptorSchema>;
export type PartitionReference = z.infer<typeof partitionReferenceSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
export type PartitionBaseline = z.infer<typeof partitionBaselineSchema>;
export type GenerationEntry = z.infer<typeof generationEntrySchema>;

export function storageDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function partitionObjectKey(identity: PartitionReference['identity']): string {
  return keySchema.parse(
    `${identity.familyKey}-partition-${identity.partitionId}-object-${storageDigest(identity.lineagePrefix).slice(0, 16)}-${identity.writerId}-${identity.decisionDigest}`,
  );
}
export function partitionObjectRoot(id: string): string {
  return `${PARTITION_OBJECT_DIRECTORY}/${cutoffPartitionIdSchema.parse(id)}`;
}
/** Stable relative arguments for each immutable object; Groovy roots come from its reference. */
export function partitionObjectPaths(
  root: string,
  id: string,
  model: CacheModel,
  workspaceRoots?: readonly string[],
): string[] {
  const partition = model.partitions.find((p) => p.id === id);
  if (!partition) throw new Error('Unknown partition archive.');
  const kind = partitionTransportKind(model, id);
  if (kind === 'groovy' && !workspaceRoots?.length)
    throw new Error('Missing native Groovy archive roots.');
  const payloads =
    kind === 'single-writer'
      ? [path.join(root, `.mammoth/partition-snapshots-v1/${id}/payload/*.bin`)]
      : [
          ...(kind === 'groovy'
            ? workspaceRoots!.map((p) => p + '/**')
            : partition.relativeIncludeGlobs
          ).map((p) => path.join(root, p)),
          ...partition.relativeExcludeGlobs.map((p) => '!' + path.join(root, p)),
          ...(kind === 'groovy' ? [`!${root}/**/gc.properties`, `!${root}/**/*.lock`] : []),
          `!${root}/**/.[mM][aA][mM][mM][oO][tT][hH]/**`,
          `!${root}/**/.[mM][aA][mM][mM][oO][tT][hH][ .]*/**`,
        ];
  return [...payloads, path.join(root, partitionObjectRoot(id), 'object.json'), `!${root}/**/`];
}
export function generationRecordPaths(root: string): string[] {
  return [path.join(root, GENERATION_RECORD_PATH)];
}
function assertFamily(model: CacheModel, family: string, tool: string, fingerprint: string) {
  if (
    family !== model.cacheFamilyKey ||
    tool !== model.buildToolId ||
    fingerprint !== model.partitionFingerprint
  )
    throw new Error('Partition storage family/layout/build-tool mismatch.');
}
function assertLineage(model: CacheModel, lineage: string) {
  if (![model.currentRefLineagePrefix, ...model.fallbackRefLineagePrefixes].includes(lineage))
    throw new Error('Partition storage origin is outside requested cache lineages.');
}
export function validatePartitionReference(
  model: CacheModel,
  reference: PartitionReference,
  partitionId: string,
): void {
  assertLineage(model, reference.identity.lineagePrefix);
  if (
    reference.identity.familyKey !== model.cacheFamilyKey ||
    reference.identity.partitionId !== partitionId ||
    reference.key !== partitionObjectKey(reference.identity)
  )
    throw new Error('Partition object reference identity/key mismatch.');
  if (partitionTransportKind(model, partitionId) === 'groovy') {
    const roots = reference.workspaceRoots,
      owns = createManagedCachePathMatcher(model);
    if (
      !roots?.length ||
      roots.some(
        (p, i) =>
          !owns(partitionId, p + '/metadata.bin') || (i > 0 && roots[i - 1]!.localeCompare(p) >= 0),
      )
    )
      throw new Error('Invalid Groovy partition archive roots.');
  } else if (reference.workspaceRoots !== undefined)
    throw new Error('Unexpected Groovy archive roots.');
}
export function partitionTransportKind(model: CacheModel, id: string): PartitionDescriptor['kind'] {
  const partition = model.partitions.find((p) => p.id === id);
  if (!partition) throw new Error('Unknown partition.');
  return partition.publication === 'single-writer'
    ? 'single-writer'
    : model.buildToolId === 'gradle' && isGroovyPartition(partition)
      ? 'groovy'
      : 'aggregate';
}
export function validatePartitionDescriptor(
  model: CacheModel,
  value: unknown,
  reference: PartitionReference,
): PartitionDescriptor {
  const descriptor = partitionDescriptorSchema.parse(value);
  assertFamily(
    model,
    descriptor.identity.familyKey,
    descriptor.buildToolId,
    descriptor.partitionFingerprint,
  );
  validatePartitionReference(model, reference, descriptor.identity.partitionId);
  if (
    storageDigest(descriptor) !== reference.descriptorDigest ||
    JSON.stringify(descriptor.identity) !== JSON.stringify(reference.identity) ||
    descriptor.kind !== partitionTransportKind(model, descriptor.identity.partitionId)
  )
    throw new Error('Partition descriptor digest/identity/transport mismatch.');
  if (
    descriptor.kind !== 'aggregate' &&
    descriptor.files.reduce((n, e) => n + e.size, 0) >
      DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes
  )
    throw new Error('Partition snapshot/workspace expanded payload exceeds resource budget.');
  if (!descriptor.files.length)
    throw new Error('Empty partitions require explicit generation entries.');
  const owns = createManagedCachePathMatcher(model);
  for (const [i, entry] of descriptor.files.entries()) {
    cutoffPathSchema.parse(entry.relativePath);
    if (
      !owns(descriptor.identity.partitionId, entry.relativePath) ||
      entry.payloadPath !==
        (descriptor.kind === 'single-writer'
          ? `.mammoth/partition-snapshots-v1/${descriptor.identity.partitionId}/payload/${String(i + 1).padStart(6, '0')}.bin`
          : entry.relativePath) ||
      (i > 0 && descriptor.files[i - 1]!.relativePath.localeCompare(entry.relativePath) >= 0)
    )
      throw new Error('Invalid partition payload ownership/order.');
  }
  if (
    descriptor.kind === 'groovy' &&
    JSON.stringify(descriptor.workspaces.map((w) => w.root)) !==
      JSON.stringify(reference.workspaceRoots)
  )
    throw new Error('Groovy archive roots/descriptor mismatch.');
  if (descriptor.kind === 'groovy')
    assertGroovyContributions(
      model,
      [
        {
          partitionId: descriptor.identity.partitionId,
          workspaces: descriptor.workspaces,
          upserts: descriptor.files.map((e, i) => ({
            ...e,
            payloadPath: `payload/${String(i + 1).padStart(6, '0')}.bin`,
          })),
        },
      ],
      owns,
    );
  else if (descriptor.workspaces.length) throw new Error('Unexpected workspace metadata.');
  assertStorageBudget(
    descriptor,
    descriptor.files.length +
      descriptor.workspaces.reduce((n, w) => n + 1 + w.files.length + w.emptyDirectories.length, 0),
  );
  return descriptor;
}
export function validateGenerationRecord(
  model: CacheModel,
  value: unknown,
  matchedKey: string,
): GenerationRecord {
  const record = generationRecordSchema.parse(value);
  assertFamily(model, record.familyKey, record.buildToolId, record.partitionFingerprint);
  assertLineage(model, record.lineagePrefix);
  if (
    record.key !== matchedKey ||
    record.key !==
      `${record.lineagePrefix}${record.generationId}-${record.decisionDigest.slice(0, 12)}` ||
    JSON.stringify(record.partitions.map((p) => p.partitionId)) !==
      JSON.stringify(model.partitions.map((p) => p.id))
  )
    throw new Error('Generation record identity/partition layout mismatch.');
  for (const entry of record.partitions)
    if (entry.kind === 'object')
      validatePartitionReference(model, entry.reference, entry.partitionId);
  const grouped = record.recoveryGroups.flat();
  if (
    grouped.length !== record.partitions.length ||
    new Set(grouped).size !== grouped.length ||
    grouped.some((id) => !model.partitions.some((p) => p.id === id))
  )
    throw new Error('Invalid partition recovery groups.');
  assertStorageBudget(record, record.partitions.length + grouped.length);
  return record;
}
export function assertStorageBudget(value: unknown, records: number): void {
  if (
    records > PARTITION_STORAGE_LIMITS.records ||
    Buffer.byteLength(JSON.stringify(value)) > PARTITION_STORAGE_LIMITS.bytes
  )
    throw new Error('Partition storage exceeds record/byte budget.');
}
/** Connected Maven directory owners recover together, without coupling unrelated uploads. */
export function createRecoveryGroups(
  model: CacheModel,
  descriptors: readonly PartitionDescriptor[],
): string[][] {
  const groups = model.partitions.map((p) => [p.id]);
  if (model.buildToolId !== 'maven') return groups;
  const owners = new Map<string, string>();
  for (const descriptor of descriptors)
    for (const entry of descriptor.files) {
      if (!entry.relativePath.startsWith('repository/')) continue;
      const directory = path.posix.dirname(entry.relativePath);
      const previous = owners.get(directory);
      if (previous && previous !== descriptor.identity.partitionId) {
        const a = groups.find((g) => g.includes(previous))!;
        const b = groups.find((g) => g.includes(descriptor.identity.partitionId))!;
        if (a !== b) {
          a.push(...b);
          groups.splice(groups.indexOf(b), 1);
        }
      }
      owners.set(directory, descriptor.identity.partitionId);
    }
  return groups.map((g) => g.sort());
}
