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

import path from 'node:path';
import { z } from 'zod';
import { decodeRecord, encodeRecord, H, rawSha, type Value } from './encoding';
import { decisionId, decisionSchema, invocationId, type ResolvedModel } from './model';
import {
  identitySchema,
  objectKey,
  objectRefSchema,
  keySchema,
  checkIdentity,
} from './native-records';
import {
  componentSchema,
  contextSchema,
  filePathSchema,
  nameSchema,
  nonceSchema,
  partitionSchema,
  pathSchema,
  portableSchema,
  positiveSchema,
  relativePathSchema,
  shaSchema,
  scopeSchema,
  textSchema,
  uintSchema,
  unitKindSchema,
  unitSchema,
  unique,
  type Context,
} from './schema';

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence
export const decimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export const nanosecondSchema = z.string().regex(/^(?:0|-?[1-9][0-9]*)$/);
export const nativeIdentitySchema = z.tuple([
  z.literal('native'),
  z.literal(1),
  z.enum(['file', 'directory']),
  decimalSchema,
  decimalSchema,
  decimalSchema,
  uintSchema,
  nanosecondSchema,
  nanosecondSchema,
  nanosecondSchema,
  nanosecondSchema.nullable(),
]);
export const nativePathSchema = nameSchema.refine((v) => {
  if (v.includes('\0')) return false;
  if (v.startsWith('/'))
    return path.posix.isAbsolute(v) && !v.split('/').some((s) => s === '.' || s === '..');
  return (
    (/^[a-zA-Z]:[\\/]/.test(v) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(v)) &&
    path.win32.isAbsolute(v) &&
    !v.split(/[\\/]/).some((s) => s === '.' || s === '..')
  );
});
export const spanSchema = z
  .tuple([z.literal('span'), shaSchema, uintSchema, positiveSchema])
  .refine((s) => s[2] < s[3]);
export const roleSchema = z.enum(['standalone', 'distributed-worker', 'distributed-aggregator']);
export const accessSchema = z.enum(['writable', 'read-only']);
export type Role = z.infer<typeof roleSchema>;
export type Access = z.infer<typeof accessSchema>;
export const policySchema = z
  .tuple([
    z.literal('policy'),
    z.literal(1),
    roleSchema,
    accessSchema,
    z.enum(['none', 'prune-managed']),
    z.enum(['off', 'timestamp']),
    uintSchema.nullable(),
    uintSchema.nullable(),
    z.enum(['strict', 'newer-mtime']),
    positiveSchema,
    z.array(nameSchema).max(16).refine(unique),
  ])
  .refine((p) => (p[5] === 'off') === (p[6] === null));
export type Policy = z.infer<typeof policySchema>;
export const policyId = (input: Policy): string => H('policy', policySchema.parse(input));
const phases = [
  'prepare-pending',
  'build-ready',
  'quiescent',
  'observations-frozen',
  'gc-complete',
  'objects-frozen',
  'relocating',
  'staged',
  'object-saved',
  'returning',
  'sources-returned',
  'final-source-barrier',
  'record-saved',
  'package-frozen',
  'worker-uploaded',
  'completed',
] as const;
export type LocalPhase = (typeof phases)[number];
export interface LocalOptions {
  readonly invocation: string;
  readonly model: ResolvedModel;
  readonly context: Context;
  readonly role: Role;
  readonly access: Access;
}
const typeSchema = z.enum(['file', 'directory', 'symlink', 'other']);
export const semanticUnitSchema = z.union([
  z.tuple([z.literal('file'), filePathSchema, z.literal('file')]),
  unitSchema,
]);
/** Cursor arithmetic checks shape, not the referenced stream's actual record boundary. */
export function cursorAtOrBefore(a: readonly Value[], b: readonly Value[]): boolean {
  return (
    a[1] === b[1] &&
    Number(a[2]) <= Number(b[2]) &&
    Number(a[3]) <= Number(b[3]) &&
    Number(a[4]) <= Number(b[4])
  );
}
function same(a: Value, b: Value): boolean {
  return encodeRecord(a).equals(encodeRecord(b));
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#immutable-references-and-append-prefixes
/** Build schemas once per independently bound invocation, never once per file. */
export function localSchemas(options: LocalOptions) {
  shaSchema.parse(options.invocation);
  contextSchema.parse(options.context);
  roleSchema.parse(options.role);
  accessSchema.parse(options.access);
  assert(options.context[7] === options.model.tuple[2], 'Local context build tool mismatch.');
  const invocation = z.literal(options.invocation),
    prefix = '.mammoth/v1/' + options.invocation + '/';
  const owned = relativePathSchema.refine(
    (p) =>
      p.startsWith(prefix) &&
      p.length > prefix.length &&
      p
        .slice(prefix.length)
        .split('/')[0]
        .replace(/[ .]+$/u, '')
        .toUpperCase() !== 'RETIRED',
  ); // Detached garbage cannot be a live reference/source.
  const partition = partitionSchema.refine((p) => options.model.partitions.some((d) => d[0] === p));
  const ref = <T extends string>(purpose: T) =>
    z.tuple([z.literal('ref'), z.literal(purpose), owned, positiveSchema, shaSchema]);
  const appendPrefix = <T extends string>(purpose: T) =>
    z.tuple([
      z.literal('prefix'),
      z.literal(purpose),
      owned,
      positiveSchema,
      uintSchema,
      shaSchema,
    ]);
  const cursor = z.tuple([
    z.literal('cursor'),
    shaSchema,
    uintSchema,
    uintSchema,
    uintSchema,
    ref('cursor-stack').nullable(),
  ]);
  const retainedOwned = owned.refine(
    (p) =>
      p
        .slice(prefix.length)
        .split('/')[0]
        .replace(/[ .]+$/u, '')
        .toUpperCase() !== 'INSTALL',
  );
  const source = z
    .tuple([
      partition,
      z.enum(['baseline', 'local-writer', 'worker-writer']),
      z.tuple([z.enum(['baseline', 'local-writer', 'worker-writer']), nameSchema]),
      ref('native-evidence'),
      retainedOwned,
    ])
    .refine((s) => s[1] === s[2][0] && (s[1] !== 'local-writer' || s[2][1] === options.invocation))
    .refine((s) => options.model.partitions.find((p) => p[0] === s[0])?.[3] === 'single-writer');
  const archive = ref('worker-archive');
  const producer = z
    .tuple([nameSchema, nameSchema, shaSchema, contextSchema, archive])
    .refine((p) => p[2] === p[4][4] && p[3][7] === options.model.tuple[2]);
  const registration = z.tuple([
    z.literal('gradle-installation'),
    z.literal(1),
    invocation,
    nativePathSchema,
    nameSchema,
    nativePathSchema,
    nativePathSchema,
  ]);
  const receipt = z
    .tuple([
      z.literal('object-receipt'),
      z.literal(1),
      partition,
      keySchema,
      shaSchema,
      shaSchema,
      z.union([
        z.tuple([z.literal('save'), nameSchema]),
        z.tuple([z.literal('readback'), keySchema]),
      ]),
    ])
    .refine((r) => r[6][0] !== 'readback' || r[6][1] === r[3])
    .refine(
      (r) =>
        r[3].startsWith(options.model.family + '-r-') && r[3].endsWith('-p-' + r[2] + '-d-' + r[5]),
    );
  const artifactReceipt = z.tuple([
    z.literal('artifact-receipt'),
    nameSchema,
    nameSchema,
    shaSchema,
  ]);
  const worker = z
    .tuple([archive, nameSchema, shaSchema, artifactReceipt.nullable()])
    .refine((w) => w[0][4] === w[2] && (w[3] === null || (w[3][2] === w[1] && w[3][3] === w[2])));
  const postSources =
    options.role === 'distributed-worker' ? ref('worker-sources') : ref('post-sources');
  const bindings = z
    .tuple([
      z.literal('bindings'),
      z.literal(1),
      invocation,
      contextSchema,
      nonceSchema,
      z.tuple([nativePathSchema, nativeIdentitySchema]),
      ref('model'),
      z.tuple([
        z.literal('family'),
        z.literal(1),
        textSchema,
        positiveSchema,
        shaSchema,
        z.literal('worker-tar-v1'),
        z.literal('native-tree-v1'),
        z.literal('generation-v1'),
        z.literal('local-v1'),
        z.literal('path-policy-v1'),
        z.literal('unit-policy-v1'),
        z.literal('glob-policy-v1'),
      ]),
      policySchema,
      z.tuple([z.literal('baseline'), keySchema, ref('generation')]).nullable(),
      ref('producers'),
      ref('prepare-sources'),
      ref('activity').nullable(),
    ])
    .refine(
      (b) =>
        invocationId(b[3], b[4]) === options.invocation &&
        same(b[3], options.context) &&
        b[5][1][2] === 'directory',
    )
    .refine(
      (b) =>
        same(b[7], options.model.familyProjection) &&
        b[8][2] === options.role &&
        b[8][3] === options.access,
    );
  const current = z.tuple([
    z.literal('current'),
    z.literal(1),
    invocation,
    z.literal(prefix + 'state.json'),
  ]);
  const quiescence = z.tuple([
    z.literal('quiescence'),
    z.literal(1),
    invocation,
    ref('installations'),
    z.literal('all-exited'),
    uintSchema,
  ]);
  const progress = <T extends 'gc' | 'install'>(kind: T) =>
    z
      .tuple([
        z.literal(`${kind}-progress`),
        z.literal(1),
        invocation,
        ref(kind === 'gc' ? 'observations' : 'install-plan'),
        cursor,
        z.literal(prefix + kind + '-intent.json').nullable(),
      ])
      .refine((p) => p[3][4] === p[4][1]);
  const intent = <T extends 'gc' | 'install'>(kind: T) =>
    z
      .tuple([
        z.literal(`${kind}-intent`),
        z.literal(1),
        invocation,
        ref(kind === 'gc' ? 'observations' : 'install-plan'),
        cursor,
        cursor,
        ref(kind === 'gc' ? 'gc-evidence' : 'install-evidence'),
      ])
      .refine((p) => p[3][4] === p[4][1] && cursorAtOrBefore(p[4], p[5]) && p[4][4] < p[5][4]);
  const publication = z
    .tuple([
      z.literal('publication'),
      z.literal(1),
      invocation,
      decisionSchema,
      shaSchema,
      ref('post-sources'),
      ref('publication-partitions'),
      ref('generation'),
      keySchema,
    ])
    .refine(
      (p) =>
        p[3][2] === options.invocation &&
        p[3][3] === options.model.id &&
        p[3][4] === options.model.family &&
        decisionId(p[3]) === p[4] &&
        p[3][9] === p[5][4],
    );
  const relocation = z
    .tuple([
      z.literal('relocation'),
      z.literal(1),
      invocation,
      partition,
      positiveSchema,
      ref('move-plan'),
      ref('adjustments').nullable(),
      z.enum(['outbound', 'staged', 'saving', 'returning', 'sources-returned']),
      cursor,
      cursor,
      z.tuple([z.enum(['outbound', 'return']), cursor, cursor]).nullable(),
      appendPrefix('outbound-evidence').nullable(),
      appendPrefix('return-evidence').nullable(),
      z.union([appendPrefix('adjustments'), ref('adjustments')]).nullable(),
      ref('stage-evidence').nullable(),
    ])
    .refine((r) => r[5][4] === r[8][1] && cursorAtOrBefore(r[9], r[8]))
    .refine(
      (r) =>
        r[10] === null ||
        (cursorAtOrBefore(r[10][1], r[10][2]) &&
          r[10][1][4] < r[10][2][4] &&
          (r[10][0] === 'return'
            ? r[7] === 'returning' && same(r[10][1], r[9]) && cursorAtOrBefore(r[10][2], r[8])
            : r[7] === 'outbound'
              ? same(r[10][1], r[8])
              : r[7] === 'returning' && cursorAtOrBefore(r[10][2], r[8]))),
    )
    .refine(
      (r) =>
        !['staged', 'saving'].includes(r[7]) || (r[10] === null && r[14] !== null && r[9][4] === 0),
    )
    .refine(
      (r) =>
        r[7] !== 'sources-returned' || (same(r[8], r[9]) && r[10] === null && r[13]?.[0] === 'ref'),
    );
  const state = z
    .tuple([
      z.literal('local-state'),
      z.literal(1),
      invocation,
      uintSchema,
      z.enum(phases),
      ref('bindings'),
      ref('observations').nullable(),
      postSources.nullable(),
      ref('publication').nullable(),
      ref('partition-state').nullable(),
      ref('gc-progress').nullable(),
      ref('install-progress').nullable(),
      worker.nullable(),
      ref('quiescence').nullable(),
      z
        .enum([
          'read-only',
          'no-change',
          'published',
          'worker-uploaded',
          'skipped-not-quiescent',
          'abandoned',
        ])
        .nullable(),
    ])
    .superRefine((s, ctx) => {
      const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
      if (s[3] === 0 && s[4] !== 'prepare-pending') bad('Initial state must be prepare-pending.');
      const phase = s[4],
        completed = phase === 'completed',
        outcome = s[14];
      if (completed !== (outcome !== null)) bad('Outcome/phase mismatch.');
      const post =
        [
          'observations-frozen',
          'gc-complete',
          'objects-frozen',
          'relocating',
          'staged',
          'object-saved',
          'returning',
          'sources-returned',
          'final-source-barrier',
          'record-saved',
          'package-frozen',
          'worker-uploaded',
        ].includes(phase) ||
        (completed && ['no-change', 'published', 'worker-uploaded'].includes(outcome!));
      if (post && (s[6] === null || s[10] === null)) bad('Missing frozen observation/GC evidence.');
      const base =
        [
          'objects-frozen',
          'relocating',
          'staged',
          'object-saved',
          'returning',
          'sources-returned',
          'final-source-barrier',
          'record-saved',
        ].includes(phase) ||
        (completed && (outcome === 'published' || outcome === 'no-change'));
      if (
        base &&
        (options.role === 'distributed-worker' || s[7] === null || s[8] === null || s[9] === null)
      )
        bad('Missing base publication state.');
      const packaging =
        ['package-frozen', 'worker-uploaded'].includes(phase) ||
        (completed && outcome === 'worker-uploaded');
      if (packaging && (options.role !== 'distributed-worker' || s[7] === null || s[12] === null))
        bad('Missing worker package state.');
      if ((phase === 'worker-uploaded' || outcome === 'worker-uploaded') && s[12]?.[3] == null)
        bad('Missing artifact receipt.');
      if (
        options.role === 'distributed-worker' &&
        ['no-change', 'skipped-not-quiescent'].includes(outcome!)
      )
        bad('Worker requires completion artifact.');
      if (options.role !== 'distributed-worker' && s[12] !== null)
        bad('Worker ref in base publisher.');
      if (
        options.role === 'distributed-worker' &&
        (s[8] !== null || phase === 'quiescent' || s[13] !== null)
      )
        bad('Worker uses base lifecycle.');
      if (
        options.access === 'read-only' &&
        (!['prepare-pending', 'build-ready', 'completed'].includes(phase) ||
          s[6] !== null ||
          s[7] !== null ||
          s[8] !== null ||
          s[10] !== null ||
          s[12] !== null ||
          s[13] !== null)
      )
        bad('Read-only post mutation state.');
      if (outcome === 'read-only' && options.access !== 'read-only')
        bad('Read-only outcome mismatch.');
      if (
        options.access === 'read-only' &&
        completed &&
        !['read-only', 'abandoned'].includes(outcome!)
      )
        bad('Writable outcome in read-only state.');
      if (
        (base || phase === 'quiescent' || post) &&
        options.model.tuple[2] === 'gradle' &&
        options.role !== 'distributed-worker' &&
        s[13] === null
      )
        bad('Missing Gradle quiescence ref.');
    });
  const partitionState = z
    .tuple([
      z.literal('partition-state'),
      partition,
      z
        .tuple([
          z.literal('baseline-partition'),
          z.enum(['restored', 'empty', 'missing']),
          objectRefSchema.nullable(),
        ])
        .refine((b) => (b[1] === 'restored') === (b[2] !== null)),
      ref('adjustments').nullable(),
      source.nullable(),
      receipt.nullable(),
      owned.nullable(),
    ])
    .refine((p) => {
      if (p[2][2]) checkIdentity(p[2][2][1], options.model, p[1]);
      return (
        (p[4] === null || p[4][0] === p[1]) &&
        (p[5] === null || p[5][2] === p[1]) &&
        (p[5] === null || p[6] === null) &&
        (p[6] === null || p[6] === prefix + 'relocation/' + p[1] + '.json')
      );
    });
  const memberEvidence = z
    .tuple([z.literal('evidence'), ref('native-evidence'), spanSchema])
    .refine((r) => r[2][1] === r[1][4] && r[2][3] <= r[1][3]);
  const install = z
    .tuple([
      z.literal('install'),
      positiveSchema,
      filePathSchema,
      owned.nullable(),
      memberEvidence.nullable(),
      memberEvidence.nullable(),
      z.enum(['insert', 'replace', 'delete']),
      owned.nullable(),
    ])
    .refine((r) =>
      r[6] === 'insert'
        ? r[3] !== null && r[4] !== null && r[5] === null && r[7] === null
        : r[6] === 'replace'
          ? r[3] !== null && r[4] !== null && r[5] !== null && r[7] !== null
          : r[3] === null && r[4] === null && r[5] !== null && r[7] !== null,
    )
    .refine(
      (r) =>
        r[3] === null ||
        r[7] === null ||
        !(r[3] === r[7] || r[3].startsWith(r[7] + '/') || r[7].startsWith(r[3] + '/')),
    );
  const move = z
    .tuple([
      z.literal('move'),
      positiveSchema,
      z.enum(['live', 'owned']),
      relativePathSchema,
      filePathSchema,
      z.enum(['file', 'directory']),
      spanSchema,
      spanSchema,
    ])
    .refine((r) => (r[2] === 'live' ? r[3] === r[4] : owned.safeParse(r[3]).success));
  const publicationPartition = z.union([
    z.tuple([z.literal('empty'), partition]),
    z.tuple([z.literal('reuse'), partition, objectRefSchema]).refine((r) => {
      checkIdentity(r[2][1], options.model, r[1]);
      return true;
    }),
    z
      .tuple([
        z.literal('new'),
        partition,
        identitySchema,
        keySchema,
        ref('envelope'),
        ref('native-tree'),
        ref('move-plan'),
      ])
      .refine((r) => {
        checkIdentity(r[2], options.model, r[1]);
        return r[3] === objectKey(r[2]);
      }),
  ]);
  const frame = z.tuple([
    z.literal('frame'),
    uintSchema,
    pathSchema,
    z.enum(['files', 'directories']),
    componentSchema.nullable(),
    componentSchema.nullable(),
    unitSchema.nullable(),
  ]);
  const rows = {
    frame,
    source,
    producer,
    registration,
    partitionState,
    install,
    installParent: z
      .tuple([
        z.literal('install-parent'),
        positiveSchema,
        filePathSchema,
        owned,
        nativeIdentitySchema,
      ])
      .refine((r) => r[4][2] === 'directory'),
    move,
    publicationPartition,
    observationFile: z
      .tuple([
        z.literal('file'),
        componentSchema,
        partition,
        nativeIdentitySchema,
        portableSchema.nullable(),
        z.enum(['none', 'used', 'upsert']),
        z.enum(['retain', 'delete']),
      ])
      .refine((r) => r[3][2] === 'file'),
    observationDirectory: z
      .tuple([z.literal('dir-open'), pathSchema, nativeIdentitySchema])
      .refine((r) => r[2][2] === 'directory'),
    child: z.tuple([z.literal('child'), componentSchema, typeSchema, decimalSchema, decimalSchema]),
    observationUnit: z.tuple([
      z.literal('unit-open'),
      unitKindSchema,
      pathSchema,
      scopeSchema,
      z.enum(['none', 'used', 'upsert']),
      z.enum(['retain', 'delete']),
      shaSchema,
    ]),
    evidenceDirectory: z
      .tuple([z.literal('directory'), pathSchema, nativeIdentitySchema])
      .refine((r) => r[2][2] === 'directory'),
    evidenceFile: z
      .tuple([z.literal('file'), filePathSchema, nativeIdentitySchema, shaSchema])
      .refine((r) => r[2][2] === 'file'),
    gcTarget: z.tuple([z.literal('target'), filePathSchema, partition, nativeIdentitySchema]),
    parentChild: z.tuple([
      z.literal('parent-child'),
      pathSchema,
      componentSchema,
      typeSchema,
      decimalSchema,
      decimalSchema,
    ]),
    transition: z
      .tuple([
        z.literal('transition'),
        positiveSchema,
        positiveSchema,
        z.enum(['outbound', 'return']),
        nativeIdentitySchema,
        nativeIdentitySchema,
        spanSchema,
      ])
      .refine((r) => r[4][2] === r[5][2] && r[4][3] === r[5][3] && r[4][4] === r[5][4]),
    adjust: z.tuple([
      z.literal('adjust'),
      pathSchema,
      positiveSchema,
      nativeIdentitySchema,
      spanSchema,
      spanSchema,
    ]),
    ancestorEffect: z.tuple([
      z.literal('ancestor-effect'),
      pathSchema,
      decimalSchema,
      decimalSchema,
      shaSchema,
    ]),
  };
  return {
    options,
    prefix,
    owned,
    partition,
    ref,
    appendPrefix,
    cursor,
    memberEvidence,
    source,
    rows,
    documents: {
      current,
      bindings,
      retirement: z
        .tuple([
          z.literal('retirement'),
          z.literal(1),
          invocation,
          shaSchema,
          nativeIdentitySchema,
          shaSchema,
          nativeIdentitySchema,
        ])
        .refine(
          (r) =>
            r[3] !== options.invocation &&
            r[4][2] === 'directory' &&
            r[6][2] === 'directory' &&
            r[4][3] === r[6][3],
        ),
      'local-state': state,
      quiescence,
      'gradle-installation': registration,
      'gc-progress': progress('gc'),
      'gc-intent': intent('gc'),
      'install-progress': progress('install'),
      'install-intent': intent('install'),
      publication,
      relocation,
      'object-receipt': receipt,
    },
  };
}
export type LocalSchemas = ReturnType<typeof localSchemas>;
// Protocol: docs/dev/cache-lifecycle-protocol.md#mutable-root-state-and-partition-cells
export class LocalCodec {
  readonly schemas: LocalSchemas;
  constructor(readonly options: LocalOptions) {
    this.schemas = localSchemas(options);
  }
  validate(value: Value): Value {
    encodeRecord(value);
    if (
      !Array.isArray(value) ||
      typeof value[0] !== 'string' ||
      !Object.hasOwn(this.schemas.documents, value[0])
    )
      throw new Error('Unknown local document.');
    return this.schemas.documents[value[0] as keyof LocalSchemas['documents']].parse(value);
  }
  encode(value: Value): Buffer {
    return encodeRecord(this.validate(value));
  }
  decode(bytes: Buffer): Value {
    return this.validate(decodeRecord(bytes));
  }
  decodeReferenced(bytes: Buffer, reference: Value): Value {
    if (
      !Array.isArray(reference) ||
      typeof reference[1] !== 'string' ||
      !Object.hasOwn(this.schemas.documents, reference[1])
    )
      throw new Error('Unknown local document reference purpose.');
    const ref = this.schemas.ref(reference[1]).parse(reference);
    assert(
      bytes.length === ref[3] && rawSha(bytes) === ref[4],
      'Local document reference bytes mismatch.',
    );
    const value = this.decode(bytes);
    assert(Array.isArray(value) && value[0] === ref[1], 'Local document purpose mismatch.');
    return value;
  }
  checkStateBindings(state: Value, bindings: Value): void {
    const s = this.schemas.documents['local-state'].parse(this.validate(state));
    const b = this.schemas.documents.bindings.parse(this.validate(bindings));
    const bytes = this.encode(b);
    assert(s[5][3] === bytes.length && s[5][4] === rawSha(bytes), 'State bindings ref mismatch.');
    if (s[4] !== 'prepare-pending' && !(s[4] === 'completed' && s[14] === 'abandoned'))
      assert(b[8][7] !== null && b[12] !== null, 'Missing build-ready cutoff/activity.');
  }
}
