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
import {
  countsSchema,
  familySchema,
  nameSchema,
  partitionSchema,
  positiveSchema,
  shaSchema,
} from './schema';
import type { ResolvedModel } from './model';

// Protocol: docs/dev/native-base-protocol.md#model-family-and-key-identities
export const identitySchema = z.tuple([
  familySchema,
  shaSchema,
  partitionSchema,
  shaSchema,
  shaSchema,
  shaSchema,
]);
export type ObjectIdentity = z.infer<typeof identitySchema>;
export const keySchema = nameSchema.max(512);
export function objectKey(input: ObjectIdentity): string {
  const [family, , partition, lineage, writer, decision] = identitySchema.parse(input);
  return keySchema.parse(`${family}-r-${lineage}-w-${writer}-p-${partition}-d-${decision}`);
}
export function lineagePrefix(family: string, lineage: string): string {
  return familySchema.parse(family) + '-r-' + shaSchema.parse(lineage) + '-g-';
}
export function recordKey(
  family: string,
  lineage: string,
  writer: string,
  decision: string,
): string {
  return keySchema.parse(
    lineagePrefix(family, lineage) + shaSchema.parse(writer) + '-d-' + shaSchema.parse(decision),
  );
}
export const objectRefSchema = z
  .tuple([z.literal('object-ref'), identitySchema, keySchema, positiveSchema.max(65536), shaSchema])
  .refine((r) => r[2] === objectKey(r[1]));
export type ObjectRef = z.infer<typeof objectRefSchema>;
export const envelopeSchema = z
  .tuple([
    z.literal('envelope'),
    z.literal(1),
    z.literal('native-tree-v1'),
    identitySchema,
    z.literal('partition-projection'),
    positiveSchema,
    shaSchema,
    countsSchema,
    shaSchema,
  ])
  .refine((e) => e[7][3] === 0);
export type Envelope = z.infer<typeof envelopeSchema>;
export const generationEntrySchema = z.union([
  z.tuple([z.literal('empty'), partitionSchema]),
  z.tuple([z.literal('object'), partitionSchema, objectRefSchema]),
]);
export type GenerationEntry = z.infer<typeof generationEntrySchema>;
export const groupsSchema = z.array(z.array(partitionSchema).min(1).max(64)).min(1).max(64);
const generationSchema = z.tuple([
  z.literal('generation'),
  z.literal(1),
  z.literal('generation-v1'),
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
export type Generation = z.infer<typeof generationSchema>;
export function checkIdentity(
  identity: ObjectIdentity,
  model: ResolvedModel,
  partition = identity[2],
): void {
  identitySchema.parse(identity);
  equal(identity.slice(0, 3), [model.family, model.id, partition], 'object identity');
  if (!model.partitions.some((p) => p[0] === partition))
    throw new Error('Unknown object partition.');
}
export function decodeEnvelope(bytes: Uint8Array, ref: ObjectRef, model: ResolvedModel): Envelope {
  objectRefSchema.parse(ref);
  checkIdentity(ref[1], model);
  // Raw envelope binding precedes any use of its tree assertions.
  if (bytes.byteLength !== ref[3] || rawSha(bytes) !== ref[4])
    throw new Error('Envelope reference mismatch.');
  const envelope = envelopeSchema.parse(decodeRecord(Buffer.from(bytes)));
  equal(envelope[3], ref[1], 'envelope identity');
  return envelope;
}
export function partitionDecision(input: Pick<Generation, 3 | 4 | 5 | 6 | 7 | 8 | 9>): string {
  return H('partition-decisions', [
    'partition-decisions',
    1,
    input[3],
    input[4],
    input[5],
    input[6],
    input[7],
    input[8],
    input[9],
  ]);
}
function validateGeneration(value: Value, model: ResolvedModel): Generation {
  encodeRecord(value); // Admission before cloning a decoded configuration record.
  const g = generationSchema.parse(value);
  equal(g.slice(3, 5), [model.family, model.id], 'generation model/family');
  if (g[8].length !== model.partitions.length) throw new Error('Incomplete generation partitions.');
  for (const [i, e] of g[8].entries()) {
    if (e[1] !== model.partitions[i][0]) throw new Error('Generation partition order.');
    if (e[0] === 'object') checkIdentity(e[2][1], model, e[1]);
  }
  new RecoveryGroups(model).check(g[9]);
  if (g[10] !== partitionDecision(g) || g[11] !== recordKey(g[3], g[5], g[6], g[10]))
    throw new Error('Generation decision/key mismatch.');
  return g;
}
export function decodeGeneration(
  bytes: Buffer,
  model: ResolvedModel,
  expectedKey?: string,
): Generation {
  const g = validateGeneration(decodeRecord(bytes), model);
  if (expectedKey !== undefined && g[11] !== expectedKey)
    throw new Error('Unexpected pinned generation key.');
  return g;
}
export function createGeneration(
  model: ResolvedModel,
  lineage: string,
  writer: string,
  decision: string,
  entries: GenerationEntry[],
  groups: string[][],
): Generation {
  const candidate: Generation = [
    'generation',
    1,
    'generation-v1',
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
  candidate[10] = partitionDecision(candidate);
  candidate[11] = recordKey(model.family, lineage, writer, candidate[10]);
  return validateGeneration(candidate, model);
}
// Protocol: docs/dev/native-base-protocol.md#recovery-groups
/** Only model partitions are retained. Caller co-reads trees and supplies one coordinate's owners. */
export class RecoveryGroups {
  private readonly parents: number[];
  private readonly ids: string[];
  constructor(private readonly model: ResolvedModel) {
    this.ids = model.partitions.map((p) => p[0]);
    this.parents = this.ids.map((_, i) => i);
  }
  private index(id: string): number {
    const index = this.ids.indexOf(id);
    if (index < 0) throw new Error('Unknown recovery partition.');
    return index;
  }
  private root(i: number): number {
    while (this.parents[i] !== i) {
      this.parents[i] = this.parents[this.parents[i]];
      i = this.parents[i];
    }
    return i;
  }
  observe(owners: readonly string[]): void {
    if (owners.length > 64) throw new Error('Unbounded coordinate ownership frontier.');
    const indices = owners.map((id) => this.index(id));
    if (this.model.tuple[2] !== 'maven' && new Set(indices).size > 1)
      throw new Error('Only Maven direct units connect recovery partitions.');
    for (const i of indices.slice(1)) this.parents[this.root(i)] = this.root(indices[0]);
  }
  groups(): string[][] {
    const groups = new Map<number, string[]>();
    for (const [i, id] of this.ids.entries()) {
      const root = this.root(i);
      const group = groups.get(root) ?? [];
      group.push(id);
      groups.set(root, group);
    }
    return [...groups.values()];
  }
  check(input: string[][], available?: ReadonlySet<string>): string[][] {
    const groups = groupsSchema.parse(input),
      flattened = groups.flat();
    if (flattened.length !== this.ids.length || new Set(flattened).size !== this.ids.length)
      throw new Error('Incomplete/duplicate recovery groups.');
    let previous = -1;
    for (const group of groups) {
      const indices = group.map((id) => this.index(id));
      if (indices[0] <= previous || indices.some((i, n) => n > 0 && i <= indices[n - 1]))
        throw new Error('Recovery group order.');
      previous = indices[0];
    }
    if (this.model.tuple[2] !== 'maven' && groups.some((g) => g.length !== 1))
      throw new Error('Non-Maven recovery groups must be singletons.');
    const declared = (id: string) => groups.findIndex((g) => g.includes(id));
    for (const actual of this.groups())
      if (actual.some((id) => declared(id) !== declared(actual[0])))
        throw new Error('Observed connectivity crosses recovery groups.');
    if (!available) return groups;
    for (const id of available) this.index(id);
    const cold: string[][] = [];
    for (const group of groups) {
      if (group.some((id) => !available.has(id))) {
        cold.push(group);
        continue;
      }
      const root = this.root(this.index(group[0]));
      if (group.some((id) => this.root(this.index(id)) !== root))
        throw new Error('Invented recovery-group join.');
    }
    return cold;
  }
}
