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
import { lifecycleDocuments } from './lifecycle-documents';
import { decodeRecord, encodeRecord, H, rawSha, type Value } from './encoding';
import type { ResolvedModel } from './model';
import {
  componentSchema,
  contextSchema,
  filePathSchema,
  nameSchema,
  nonceSchema,
  partitionSchema,
  pathSchema,
  relativePathSchema,
  positiveSchema,
  shaSchema,
  scopeSchema,
  uintSchema,
  unitKindSchema,
  unitSchema,
  unique,
  type Context,
} from './schema';

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
export interface LocalOptions {
  readonly invocation: string;
  readonly model: ResolvedModel;
  readonly context: Context;
  readonly role: Role;
  readonly access: Access;
}
export const semanticUnitSchema = z.union([
  z.tuple([z.literal('file'), filePathSchema, z.literal('file')]),
  unitSchema,
]);
export function ownedPathSchema(invocation: string) {
  shaSchema.parse(invocation);
  const prefix = '.mammoth/v1/' + invocation + '/';
  return relativePathSchema.refine(
    (p) =>
      p.startsWith(prefix) &&
      p.length > prefix.length &&
      p
        .slice(prefix.length)
        .split('/')[0]
        .replace(/[ .]+$/u, '')
        .toUpperCase() !== 'RETIRED',
  ); // Detached garbage cannot be a live reference/source.
}
export const referencePurposes = [
  'bindings',
  'model',
  'handoff',
  'activity',
  'installations',
  'observations',
  'install-plan',
  'worker-archive',
  'envelope',
  'generation',
] as const;
export const ownedReferenceSchema = <T extends string>(invocation: string, purpose: T) => {
  z.enum(referencePurposes).parse(purpose);
  return z.tuple([
    z.literal('ref'),
    z.literal(purpose),
    ownedPathSchema(invocation),
    positiveSchema,
    shaSchema,
  ]);
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
export function localSchemas(options: LocalOptions) {
  shaSchema.parse(options.invocation);
  contextSchema.parse(options.context);
  roleSchema.parse(options.role);
  accessSchema.parse(options.access);
  assert(options.context[7] === options.model.tuple[2], 'Local context build tool mismatch.');
  const prefix = '.mammoth/v1/' + options.invocation + '/',
    owned = ownedPathSchema(options.invocation),
    partition = partitionSchema.refine((p) =>
      options.model.partitions.some((part) => part[0] === p),
    ),
    ref = <T extends string>(purpose: T) => ownedReferenceSchema(options.invocation, purpose),
    installMember = z.tuple([
      z.literal('metadata-member'),
      nonceSchema,
      z.enum(['source', 'current']),
      partition,
      uintSchema,
    ]);
  const registration = z.tuple([
    z.literal('gradle-installation'),
    z.literal(1),
    z.literal(options.invocation),
    nativePathSchema,
    nameSchema,
    nativePathSchema,
    nativePathSchema,
  ]);
  const install = z
    .tuple([
      z.literal('install'),
      positiveSchema,
      filePathSchema,
      owned.nullable(),
      installMember.nullable(),
      installMember.nullable(),
      z.enum(['insert', 'replace', 'delete']),
      owned.nullable(),
    ])
    .refine((row) =>
      row[6] === 'insert'
        ? row[3] !== null && row[4] !== null && row[5] === null && row[7] === null
        : row[6] === 'replace'
          ? row[3] !== null && row[4] !== null && row[5] !== null && row[7] !== null
          : row[3] === null && row[4] === null && row[5] !== null && row[7] !== null,
    )
    .refine(
      (row) =>
        row[3] === null ||
        row[7] === null ||
        !(row[3] === row[7] || row[3].startsWith(row[7] + '/') || row[7].startsWith(row[3] + '/')),
    );
  return {
    options,
    prefix,
    owned,
    partition,
    ref,
    installMember,
    rows: {
      registration,
      install,
      installParent: z
        .tuple([
          z.literal('install-parent'),
          positiveSchema,
          filePathSchema,
          owned,
          nativeIdentitySchema,
        ])
        .refine((row) => row[4][2] === 'directory'),
      observationFile: z
        .tuple([
          z.literal('file'),
          componentSchema,
          partition,
          nativeIdentitySchema,
          z.enum(['none', 'used', 'upsert']),
          z.enum(['retain', 'delete']),
        ])
        .refine((row) => row[3][2] === 'file'),
      observationDirectory: z
        .tuple([z.literal('dir-open'), pathSchema, nativeIdentitySchema])
        .refine((row) => row[2][2] === 'directory'),
      child: z.tuple([
        z.literal('child'),
        componentSchema,
        z.enum(['file', 'directory', 'symlink', 'other']),
        decimalSchema,
        decimalSchema,
      ]),
      observationUnit: z.tuple([
        z.literal('unit-open'),
        unitKindSchema,
        pathSchema,
        scopeSchema,
        z.enum(['none', 'used', 'upsert']),
        z.enum(['retain', 'delete']),
        shaSchema,
      ]),
    },
    documents: {
      ...lifecycleDocuments(options),
      current: z.tuple([
        z.literal('current'),
        z.literal(1),
        z.literal(options.invocation),
        z.literal(prefix + 'state.json'),
      ]),
      'gradle-capture-failed': z.tuple([
        z.literal('gradle-capture-failed'),
        z.literal(1),
        z.literal(options.invocation),
      ]),
      'gradle-installation': registration,
    },
  };
}
export type LocalSchemas = ReturnType<typeof localSchemas>;
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
    if (!['prepare-pending', 'prepare-failed'].includes(s[4]))
      assert(b[8][7] !== null && s[6] !== null, 'Missing successful build cutoff/handoff.');
  }
}
