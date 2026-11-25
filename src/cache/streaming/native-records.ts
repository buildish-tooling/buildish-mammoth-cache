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
import { equal } from './encoding';
import { familySchema, nameSchema, partitionSchema, positiveSchema, shaSchema } from './schema';
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

export const generationEntrySchema = z.union([
  z.tuple([z.literal('empty'), partitionSchema]),
  z.tuple([z.literal('object'), partitionSchema, objectRefSchema]),
]);
export type GenerationEntry = z.infer<typeof generationEntrySchema>;

export const groupsSchema = z.array(z.array(partitionSchema).min(1).max(64)).min(1).max(64);
export function checkIdentity(
  identity: ObjectIdentity,
  model: ResolvedModel,
  partition = identity[2],
): void {
  identitySchema.parse(identity);
  equal(identity.slice(0, 3), [model.family, model.id, partition], 'object identity');
  if (!model.partitions.some((p) => p[0] === partition)) {
    throw new Error('Unknown object partition.');
  }
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
    if (index < 0) {
      throw new Error('Unknown recovery partition.');
    }
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
    if (owners.length > 64) {
      throw new Error('Unbounded coordinate ownership frontier.');
    }
    const indices = owners.map((id) => this.index(id));
    if (this.model.tuple[2] !== 'maven' && new Set(indices).size > 1) {
      throw new Error('Only Maven direct units connect recovery partitions.');
    }
    for (const i of indices.slice(1)) {
      this.parents[this.root(i)] = this.root(indices[0]);
    }
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
    if (flattened.length !== this.ids.length || new Set(flattened).size !== this.ids.length) {
      throw new Error('Incomplete/duplicate recovery groups.');
    }
    let previous = -1;
    for (const group of groups) {
      const indices = group.map((id) => this.index(id));
      if (indices[0] <= previous || indices.some((i, n) => n > 0 && i <= indices[n - 1])) {
        throw new Error('Recovery group order.');
      }
      previous = indices[0];
    }
    if (this.model.tuple[2] !== 'maven' && groups.some((g) => g.length !== 1)) {
      throw new Error('Non-Maven recovery groups must be singletons.');
    }
    const declared = (id: string) => groups.findIndex((g) => g.includes(id));
    for (const actual of this.groups()) {
      if (actual.some((id) => declared(id) !== declared(actual[0]))) {
        throw new Error('Observed connectivity crosses recovery groups.');
      }
    }
    if (!available) {
      return groups;
    }
    for (const id of available) {
      this.index(id);
    }
    const cold: string[][] = [];
    for (const group of groups) {
      if (group.some((id) => !available.has(id))) {
        cold.push(group);
        continue;
      }
      const root = this.root(this.index(group[0]));
      if (group.some((id) => this.root(this.index(id)) !== root)) {
        throw new Error('Invented recovery-group join.');
      }
    }
    return cold;
  }
}
