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
  nativeIdentitySchema,
  ownedPathSchema,
  type LocalCodec,
  type Policy,
} from './local-schema';
import { gradleSeedSchema, checkGradleSeed } from './gradle-layer';
import { nameSchema, positiveSchema, uintSchema } from './schema';
import { objectRefSchema, keySchema } from './native-records';
import { pinnedPartitionMetadataSchema, decodePinnedPartitionMetadata } from './partition-metadata';
import { encodeRecord, equal, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import type { NativeOperationOptions } from './native-operation';
import type { MetadataGeneration } from './metadata-base-records';

export function handoffSchemas(codec: LocalCodec) {
  const { invocation, model } = codec.options,
    partition = codec.schemas.partition,
    ref = codec.schemas.ref;
  const origin = z.union([
    z.tuple([z.literal('base'), objectRefSchema.nullable()]),
    z.tuple([z.literal('worker'), nameSchema]),
    z.tuple([z.literal('local'), z.literal(invocation)]),
    z.tuple([z.literal('empty'), z.enum(['miss', 'cold', 'generation'])]),
  ]);
  const snapshot = z
    .tuple([
      z.literal('snapshot'),
      ownedPathSchema(invocation).refine((root) => {
        const suffix = root.slice(('.mammoth/v1/' + invocation + '/snapshots/').length);
        const parts = suffix.split('/');
        return (
          root.startsWith('.mammoth/v1/' + invocation + '/snapshots/') &&
          parts.length === 2 &&
          /^[a-f0-9-]{36}$/.test(parts[0]) &&
          partition.safeParse(parts[1]).success
        );
      }),
      nativeIdentitySchema,
      nativeIdentitySchema,
      origin,
    ])
    .refine((row) => row[2][2] === 'directory' && row[3][2] === 'directory');
  const header = z
    .tuple([
      z.literal('handoff'),
      z.literal(4),
      nameSchema,
      nameSchema.nullable(),
      nameSchema.nullable(),
      positiveSchema,
      z.enum(['enabled', 'disabled']),
      positiveSchema.nullable(),
      z.tuple([keySchema, ref('generation')]).nullable(),
      ref('activity'),
      uintSchema,
      uintSchema.max(16),
      gradleSeedSchema(invocation).nullable(),
    ])
    .refine((row) => row[2] !== row[3]);
  const entry = z
    .tuple([
      z.literal('partition'),
      partition,
      z.enum(['available', 'empty', 'cold', 'miss']),
      z
        .union([
          pinnedPartitionMetadataSchema,
          z.tuple([z.literal('restored-object'), objectRefSchema]),
        ])
        .nullable(),
      snapshot.nullable(),
    ])
    .superRefine((row, ctx) => {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
      if ((row[2] === 'available' || row[2] === 'empty') !== (row[3] !== null)) {
        bad('Availability/pin mismatch.');
      }
      if (row[3]?.[0] === 'restored-object') {
        if (
          row[2] !== 'available' ||
          codec.options.model.tuple[2] !== 'gradle' ||
          model.partitions.find((p) => p[0] === row[1])?.[3] !== 'aggregate' ||
          (codec.options.access !== 'read-only' && codec.options.role !== 'distributed-worker')
        ) {
          bad('Unexpected omitted base reuse summary.');
        }
      } else if (row[3]) {
        equal(
          row[3].slice(3, 7),
          [invocation, model.family, model.id, row[1]],
          'handoff pin identity',
        );
        if ((row[2] === 'empty') !== (row[3][7] === null)) {
          bad('Empty pin/object mismatch.');
        }
      }
      if (row[4]) {
        if (!row[4][1].endsWith('/' + row[1])) {
          bad('Snapshot partition/root mismatch.');
        }
        if (model.partitions.find((p) => p[0] === row[1])?.[3] !== 'single-writer') {
          bad('Snapshot for aggregate partition.');
        }
      }
    });
  return { header, entry, snapshot, origin };
}
export type HandoffHeader = z.infer<ReturnType<typeof handoffSchemas>['header']>;

export type HandoffEntry = z.infer<ReturnType<typeof handoffSchemas>['entry']>;

export type SnapshotDescriptor = z.infer<ReturnType<typeof handoffSchemas>['snapshot']>;

/** Framing validates exactly one bounded header and the ordered O(P) handoff. */
export class HandoffGrammar {
  private count = 0;
  private readonly schemas;

  constructor(private readonly codec: LocalCodec) {
    this.schemas = handoffSchemas(codec);
  }

  accept(value: Value): void {
    if (!this.count) {
      this.schemas.header.parse(value);
    } else {
      const entry = this.schemas.entry.parse(value);
      if (entry[1] !== this.codec.options.model.partitions[this.count - 1]?.[0]) {
        throw new Error('Handoff partition order/completeness mismatch.');
      }
    }
    this.count++;
  }

  finish(): void {
    if (this.count !== this.codec.options.model.partitions.length + 1) {
      throw new Error('Incomplete handoff.');
    }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
/** Data only: no decoded pin, root or index can mint a process-owned source capability. */
export class LifecycleHandoff {
  #closed = false;

  private constructor(
    readonly header: HandoffHeader,
    private readonly store: OwnedStore,
    readonly entries: readonly HandoffEntry[],
    private readonly release: () => void,
  ) {
    freeze(header);
    freeze(entries);
  }

  static async read(
    store: OwnedStore,
    reference: Reference,
    options: NativeOperationOptions,
  ): Promise<LifecycleHandoff> {
    const schemas = handoffSchemas(store.codec),
      entries: HandoffEntry[] = [];
    let header: HandoffHeader | undefined,
      charge = 0;
    try {
      for await (const item of store.rows(
        reference,
        'handoff',
        { ...options, partition: null },
        options.signal,
      )) {
        const value = item.value;
        if (!Array.isArray(value) || value[0] === 'local-stream' || value[0] === 'local-end') {
          continue;
        }
        const bytes = 512 + encodeRecord(value).length * 8;
        options.budget.retain(bytes);
        charge += bytes;
        if (!header) {
          header = schemas.header.parse(value);
        } else {
          entries.push(schemas.entry.parse(value));
        }
      }
      if (!header || entries.length !== store.codec.options.model.partitions.length) {
        throw new Error('Incomplete handoff.');
      }
      return new LifecycleHandoff(header, store, entries, () => options.budget.release(charge));
    } catch (error) {
      options.budget.release(charge);
      throw error;
    }
  }

  assertBound(store: OwnedStore): void {
    if (this.#closed || store !== this.store) {
      throw new Error('Unbound/closed lifecycle handoff.');
    }
  }

  checkGeneration(store: OwnedStore, generation: MetadataGeneration | null, policy: Policy): void {
    if (this.#closed) {
      throw new Error('Closed handoff.');
    }
    checkHandoffGeneration(store, this.header, this.entries, generation, policy);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.release();
    }
  }
}

export function checkHandoffGeneration(
  store: OwnedStore,
  header: HandoffHeader,
  entries: readonly HandoffEntry[],
  generation: MetadataGeneration | null,
  policy: Policy,
): void {
  if (header[12]) {
    checkGradleSeed(store, header[12], generation?.[11] ?? null);
    if (policy[4] !== 'none') {
      throw new Error('Layered handoff requires ordinary restore cleanup.');
    }
    for (const id of [header[12][5], header[12][6]]) {
      if (entries.find((e) => e[1] === id)?.[2] !== 'available') {
        throw new Error('Incomplete seed handoff.');
      }
    }
  }
  if ((generation === null) !== (header[8] === null)) {
    throw new Error('Handoff generation mismatch.');
  }
  if (generation) {
    equal(generation[11], header[8]![0], 'exact frozen generation key');
    equal(
      generation.slice(3, 5),
      [store.codec.options.model.family, store.codec.options.model.id],
      'handoff generation family/model',
    );
  }
  if (generation) {
    for (const group of generation[9]) {
      const cold = group.filter((p) => entries.find((row) => row[1] === p)?.[2] === 'cold');
      if (cold.length && cold.length !== group.length) {
        throw new Error('Partial recovery-group availability.');
      }
      if (
        cold.length &&
        !generation[8].some((entry) => entry[0] === 'object' && group.includes(entry[1]))
      ) {
        throw new Error('Cold recovery group has no restorable object.');
      }
    }
  }
  for (const [i, row] of entries.entries()) {
    if (!generation) {
      if (row[2] !== 'miss' || row[3] !== null) {
        throw new Error('Miss acquired reusable pin.');
      }
    } else if (row[3]?.[0] === 'restored-object') {
      const selected = generation[8][i];
      if (
        policy[4] !== 'none' ||
        row[2] !== 'available' ||
        selected[0] !== 'object' ||
        (policy[3] !== 'read-only' && policy[2] !== 'distributed-worker')
      ) {
        throw new Error('Unexpected omitted base reuse summary.');
      }
      equal(row[3][1], selected[2], 'exact restored object');
    } else if (row[3]) {
      decodePinnedPartitionMetadata(
        encodeRecord(row[3]),
        store.codec.options.model,
        store.codec.options.invocation,
        generation[8][i],
      );
    } else if (row[2] !== 'cold') {
      throw new Error('Selected generation missing availability.');
    }
  }
}
