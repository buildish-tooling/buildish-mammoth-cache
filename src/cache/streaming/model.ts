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
import { createCacheGlobMatcher } from '../manifest';
import { validatePartitionConflictHandling } from '../model';
import { isCacheMetadataPath } from '../metadata-paths';
import { canonical, encodeRecord, H, scalar, tuple as requireTuple, type Value } from './encoding';
import {
  buildToolSchema,
  contextSchema,
  familySchema,
  nameSchema,
  nonceSchema,
  partitionSchema,
  positiveSchema,
  shaSchema,
  unique,
} from './schema';
import { STREAMING_PROFILES, streamingFamilyId } from './profiles';

// Protocol: docs/dev/native-base-protocol.md#model-family-and-key-identities
const globs = z
  .array(
    nameSchema.refine(
      (v) =>
        !v.includes('\\') &&
        !v.includes('\0') &&
        !v.startsWith('/') &&
        !/^[a-zA-Z]:/.test(v) &&
        !v.split('/').includes('..'),
    ),
  )
  .refine(unique);
export const partitionDefinitionSchema = z
  .tuple([
    partitionSchema,
    globs.min(1),
    globs,
    z.enum(['aggregate', 'single-writer']),
    nameSchema.nullable(),
    z.enum(['default', 'choose-worker-entry', 'choose-worker-directory']),
  ])
  .refine((p) => p[3] === 'single-writer' || p[4] === null)
  .refine((p) => {
    try {
      encodeRecord(['partition', ...p]);
      return true;
    } catch {
      return false;
    }
  });
export type Partition = z.infer<typeof partitionDefinitionSchema>;
export const modelSchema = z
  .tuple([
    z.literal('model'),
    z.literal(1),
    buildToolSchema,
    globs.min(1),
    z.array(partitionDefinitionSchema).min(1).max(64),
  ])
  .refine((v) => unique(v[4].map((p) => p[0])))
  .refine((v) => {
    try {
      encodeRecord(['model-header', v[2], v[3]]);
      return true;
    } catch {
      return false;
    }
  })
  .refine((v) => v[4].every((p) => v[3].every((glob) => p[2].includes(glob))));
export type ModelTuple = z.infer<typeof modelSchema>;
export interface ResolvedModel {
  readonly tuple: ModelTuple;
  readonly id: string;
  readonly family: string;
  readonly familyProjection: readonly ['family', 1, string, number, string, ...string[]];
  readonly partitions: readonly Partition[];
  owner(path: string): Partition;
}
export function resolveModel(input: unknown, prefix: string, schemaVersion: number): ResolvedModel {
  const raw = requireTuple(input as Value, 'model', 5);
  const partitions = requireTuple(raw[4]);
  if (partitions.length < 1 || partitions.length > 64)
    throw new Error('Model partition admission exceeded.');
  encodeRecord(['model-header', raw[2], raw[3]]);
  for (const partition of partitions)
    encodeRecord(['partition', ...requireTuple(partition, undefined, 6)]);
  const tuple = modelSchema.parse(input);
  validatePartitionConflictHandling(
    tuple[2],
    tuple[4].map((p) => ({
      id: p[0],
      displayName: p[0],
      description: '',
      relativeIncludeGlobs: p[1],
      relativeExcludeGlobs: p[2],
      absoluteIncludeGlobs: [],
      absoluteExcludeGlobs: [],
      publication: p[3],
      ...(p[4] === null ? {} : { writer: p[4] }),
      ...(p[5] === 'default' ? {} : { conflictHandling: p[5] }),
    })),
  );
  scalar(prefix);
  positiveSchema.parse(schemaVersion);
  const id = H('model', tuple);
  const familyProjection = [
    'family',
    1,
    prefix,
    schemaVersion,
    id,
    ...Object.values(STREAMING_PROFILES),
  ] as const;
  const family = streamingFamilyId(tuple[2], H('family', familyProjection));
  const hard = createCacheGlobMatcher(tuple[3]);
  const parts = tuple[4].map((p) => ({
    p,
    includes: createCacheGlobMatcher(p[1]),
    excludes: createCacheGlobMatcher(p[2]),
  }));
  return {
    tuple,
    id,
    family,
    familyProjection,
    partitions: tuple[4],
    owner(path) {
      if (isCacheMetadataPath(path) || hard(path))
        throw new Error('Reserved/excluded managed path.');
      let owner: Partition | undefined;
      for (const item of parts)
        if (item.includes(path) && !item.excludes(path)) {
          if (owner) throw new Error('Ambiguous partition ownership.');
          owner = item.p;
        }
      if (!owner) throw new Error('Unowned managed path.');
      return owner;
    },
  };
}
export function invocationId(context: unknown, nonce: string): string {
  return H('invocation', ['invocation', 1, contextSchema.parse(context), nonceSchema.parse(nonce)]);
}
export function writerId(invocation: string, context: unknown): string {
  return H('writer', ['writer', 1, shaSchema.parse(invocation), contextSchema.parse(context)]);
}
export function lineageId(ref: string): string {
  return H('lineage', ['ref', nameSchema.parse(ref)]);
}
export const decisionSchema = z.tuple([
  z.literal('decision'),
  z.literal(1),
  shaSchema,
  shaSchema,
  familySchema,
  shaSchema,
  shaSchema,
  nameSchema.nullable(),
  shaSchema,
  shaSchema,
]);
export type Decision = z.infer<typeof decisionSchema>;
export function decisionId(decision: unknown): string {
  return H('decision', decisionSchema.parse(decision));
}
export function sameModel(a: ResolvedModel, b: ResolvedModel): boolean {
  return canonical([a.id, a.family]).equals(canonical([b.id, b.family]));
}
