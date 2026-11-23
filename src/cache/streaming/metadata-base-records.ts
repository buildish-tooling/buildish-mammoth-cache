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
import { decodeRecord, encodeRecord, equal, H, rawSha, type Value } from './encoding';
import { familySchema, shaSchema } from './schema';
import { STREAMING_PROFILES } from './profiles';
import type { ResolvedModel } from './model';
import {
  checkIdentity,
  generationEntrySchema,
  groupsSchema,
  identitySchema,
  keySchema,
  objectKey,
  objectRefSchema,
  recordKey,
  RecoveryGroups,
  type GenerationEntry,
  type ObjectIdentity,
  type ObjectRef,
} from './native-records';

// Protocol: docs/dev/native-base-protocol.md#native-object-layout-and-envelope.
// This control document asserts no payload membership, body digest or portable modes.
export const metadataDescriptorSchema = z.tuple([
  z.literal('base-object'),
  z.literal(2),
  z.literal('native-metadata-v2'),
  identitySchema,
]);
export type MetadataDescriptor = z.infer<typeof metadataDescriptorSchema>;
export function assertMetadataModel(model: ResolvedModel): void {
  equal(
    model.familyProjection.slice(5),
    Object.values(STREAMING_PROFILES),
    'metadata wire profiles',
  );
}
export function createMetadataDescriptor(
  model: ResolvedModel,
  identity: ObjectIdentity,
): {
  descriptor: MetadataDescriptor;
  bytes: Buffer;
  reference: ObjectRef;
} {
  assertMetadataModel(model);
  checkIdentity(identity, model);
  const descriptor = metadataDescriptorSchema.parse([
    'base-object',
    2,
    'native-metadata-v2',
    identity,
  ]);
  const bytes = encodeRecord(descriptor);
  return {
    descriptor,
    bytes,
    reference: ['object-ref', descriptor[3], objectKey(descriptor[3]), bytes.length, rawSha(bytes)],
  };
}
export function decodeMetadataDescriptor(
  bytes: Buffer,
  reference: ObjectRef,
  model: ResolvedModel,
): MetadataDescriptor {
  assertMetadataModel(model);
  const ref = objectRefSchema.parse(reference);
  checkIdentity(ref[1], model);
  if (bytes.length !== ref[3] || rawSha(bytes) !== ref[4])
    throw new Error('Descriptor reference mismatch.');
  const descriptor = metadataDescriptorSchema.parse(decodeRecord(bytes));
  equal(descriptor[3], ref[1], 'descriptor identity');
  return descriptor;
}
const metadataGenerationSchema = z.tuple([
  z.literal('generation'),
  z.literal(2),
  z.literal('generation-v2'),
  familySchema,
  shaSchema,
  shaSchema,
  shaSchema,
  shaSchema,
  z.array(generationEntrySchema).min(1).max(64),
  groupsSchema,
  shaSchema,
  keySchema,
]);
export type MetadataGeneration = z.infer<typeof metadataGenerationSchema>;
export function metadataPartitionDecision(
  g: Pick<MetadataGeneration, 3 | 4 | 5 | 6 | 7 | 8 | 9>,
): string {
  return H('partition-decisions', [
    'partition-decisions',
    2,
    g[3],
    g[4],
    g[5],
    g[6],
    g[7],
    g[8],
    g[9],
  ]);
}
function validate(value: Value, model: ResolvedModel): MetadataGeneration {
  assertMetadataModel(model);
  encodeRecord(value);
  const g = metadataGenerationSchema.parse(value);
  equal(g.slice(3, 5), [model.family, model.id], 'generation model/family');
  if (g[8].length !== model.partitions.length) throw new Error('Incomplete generation partitions.');
  for (const [i, entry] of g[8].entries()) {
    if (entry[1] !== model.partitions[i][0]) throw new Error('Generation partition order.');
    if (entry[0] === 'object') checkIdentity(entry[2][1], model, entry[1]);
  }
  new RecoveryGroups(model).check(g[9]);
  if (g[10] !== metadataPartitionDecision(g) || g[11] !== recordKey(g[3], g[5], g[6], g[10]))
    throw new Error('Generation decision/key mismatch.');
  return g;
}
export function createMetadataGeneration(
  model: ResolvedModel,
  lineage: string,
  writer: string,
  decision: string,
  entries: GenerationEntry[],
  groups: string[][],
): MetadataGeneration {
  const g: MetadataGeneration = [
    'generation',
    2,
    'generation-v2',
    model.family,
    model.id,
    lineage,
    writer,
    decision,
    entries,
    groups,
    '0'.repeat(64),
    'pending',
  ];
  g[10] = metadataPartitionDecision(g);
  g[11] = recordKey(g[3], g[5], g[6], g[10]);
  return validate(g, model);
}
export function decodeMetadataGeneration(
  bytes: Buffer,
  model: ResolvedModel,
  expectedKey?: string,
): MetadataGeneration {
  const g = validate(decodeRecord(bytes), model);
  if (expectedKey !== undefined && g[11] !== expectedKey)
    throw new Error('Unexpected pinned generation key.');
  return g;
}
