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
import type { LocalOptions } from './local-schema';
import { createCacheGlobMatcher } from '../glob';
import { validatePartitionConflictHandling, type CacheModelDefinition } from '../model';
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
const partitionFields = [
  partitionSchema,
  globs.min(1),
  globs,
  z.enum(['aggregate', 'single-writer']),
  nameSchema.nullable(),
  z.enum(['default', 'choose-worker-entry', 'choose-worker-directory']),
] as const;
// Canonical optional configuration: omit an empty list; a present list is nonempty.
export const partitionDefinitionSchema = z
  .union([z.tuple(partitionFields), z.tuple([...partitionFields, globs.min(1)])])
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
/** The writable job whose complete local snapshot is authoritative for publication. */
export function ownsLocalSnapshot(
  partition: Partition,
  options: Pick<LocalOptions, 'role' | 'access' | 'context'>,
): boolean {
  return (
    options.access === 'writable' &&
    partition[3] === 'single-writer' &&
    (options.role === 'standalone' ||
      partition[4] === options.context[4] ||
      (options.role === 'distributed-aggregator' && partition[4] === null))
  );
}

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
  admissionScope(): AdmissionScope;
  purge(path: string): readonly string[];
}
export interface AdmissionScope {
  readonly hasDescendants: boolean;
  child(path: string): AdmissionScope | undefined;
  owner(): Partition | undefined;
  blocksUnsafeLeaf(): boolean;
}
export function resolveModel(input: unknown, prefix: string, schemaVersion: number): ResolvedModel {
  return resolveModelWithProfiles(input, prefix, schemaVersion, STREAMING_PROFILES);
}

function resolveModelWithProfiles(
  input: unknown,
  prefix: string,
  schemaVersion: number,
  profiles: { readonly [K in keyof typeof STREAMING_PROFILES]: string },
): ResolvedModel {
  const raw = requireTuple(input as Value, 'model', 5);
  const partitions = requireTuple(raw[4]);
  if (partitions.length < 1 || partitions.length > 64)
    throw new Error('Model partition admission exceeded.');
  encodeRecord(['model-header', raw[2], raw[3]]);
  for (const partition of partitions) encodeRecord(['partition', ...requireTuple(partition)]);
  const tuple = modelSchema.parse(input);
  validatePartitionConflictHandling(
    tuple[2],
    tuple[4].map((p) => ({
      id: p[0],
      displayName: p[0],
      description: '',
      relativeIncludeGlobs: p[1],
      relativeExcludeGlobs: p[2],
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
    ...Object.values(profiles),
  ] as const;
  const family = streamingFamilyId(tuple[2], H('family', familyProjection));
  const hard = createCacheGlobMatcher(tuple[3]);
  for (const p of tuple[4])
    for (const rule of p[6] ?? []) {
      let prefix = '';
      for (const segment of rule.split('/')) {
        if (segment.includes('*')) break;
        prefix = prefix ? prefix + '/' + segment : segment;
        if (isCacheMetadataPath(prefix) || hard(prefix + '/.workspace-directory-probe'))
          throw new Error('Purge rule targets a reserved or opaque hard-pruned scope.');
      }
    }
  const parts = tuple[4].map((p) => ({
    p,
    includes: createCacheGlobMatcher(p[1]),
    excludes: createCacheGlobMatcher(p[2]),
    purge: createCacheGlobMatcher(p[6] ?? []),
  }));
  const findOwner = (path: string, candidates: typeof parts) => {
    let owner: Partition | undefined;
    for (const item of candidates)
      if (item.includes(path) && !item.excludes(path) && !item.purge(path)) {
        if (owner) throw new Error('Ambiguous partition ownership.');
        owner = item.p;
      }
    return owner;
  };
  function admissionScope(
    path: string,
    candidates: typeof parts,
    descendants: typeof parts,
  ): AdmissionScope {
    return {
      hasDescendants: descendants.length !== 0,
      owner: () => findOwner(path, candidates),
      blocksUnsafeLeaf: () => candidates.some((item) => !item.excludes(path) && !item.purge(path)),
      child(child) {
        if (isCacheMetadataPath(child) || hard(child, 'subtree')) return undefined;
        const matching: typeof parts = [],
          below: typeof parts = [];
        for (const item of descendants) {
          if (item.excludes(child, 'subtree') || item.purge(child, 'subtree')) continue;
          if (item.includes(child, 'descendants')) below.push(item);
          else if (item.includes(child) && !item.excludes(child) && !item.purge(child))
            matching.push(item);
        }
        return matching.length || below.length
          ? admissionScope(child, [...below, ...matching], below)
          : undefined;
      },
    };
  }
  return {
    tuple,
    id,
    family,
    familyProjection,
    partitions: tuple[4],
    admissionScope: () => admissionScope('', [], parts),
    purge(path) {
      if (isCacheMetadataPath(path)) return [];
      const claims = parts.filter((item) => item.purge(path));
      if (!claims.length) return [];
      if (!hard(path)) {
        const owners = parts.filter((item) => item.includes(path) && !item.excludes(path));
        if (owners.length > 1 || owners.some((owner) => !claims.includes(owner)))
          throw new Error('Purge conflicts with original partition ownership.');
      }
      return claims.map((item) => item.p[0]);
    },
    owner(path) {
      if (isCacheMetadataPath(path) || hard(path))
        throw new Error('Reserved/excluded managed path.');
      const owner = findOwner(path, parts);
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

/** Resolve the existing normalized configuration once; freeze these exact rows in modelRef. */
export function resolveCacheModel(
  model: CacheModelDefinition,
  prefix: string,
  schemaVersion: number,
): ResolvedModel {
  return resolveModel(
    [
      'model',
      1,
      model.buildToolId,
      model.hardCacheExcludeGlobs,
      model.partitions.map((p) => [
        p.id,
        p.relativeIncludeGlobs,
        p.relativeExcludeGlobs,
        p.publication ?? 'aggregate',
        p.writer ?? null,
        p.conflictHandling ?? 'default',
        ...(p.purgeableGlobs?.length ? [p.purgeableGlobs] : []),
      ]),
    ],
    prefix,
    schemaVersion,
  );
}
