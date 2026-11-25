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
import { scalar } from './encoding';
import { isCacheMetadataPath } from '../metadata-paths';

// Protocol: docs/dev/cache-protocol.md#profiles-and-common-rules
export const uintSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((v) => !Object.is(v, -0));
export const positiveSchema = uintSchema.refine((v) => v > 0);
export const textSchema = z.string().refine((v) => {
  try {
    scalar(v);
    return true;
  } catch {
    return false;
  }
});
export const nameSchema = textSchema.min(1);
export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nonceSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const partitionSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
export const buildToolSchema = z.enum(['gradle', 'maven']);
export const familySchema = z.string().regex(/^mammoth-s1-(?:gradle|maven)-[a-f0-9]{64}$/);
export const componentSchema = nameSchema.refine(
  (v) => v !== '.' && v !== '..' && !/[\\/\0]/.test(v) && !/^[a-zA-Z]:/.test(v),
);
export const relativePathSchema = textSchema.refine(
  (v) =>
    Buffer.byteLength(v) <= 16384 &&
    (v === '' || v.split('/').every((p) => componentSchema.safeParse(p).success)),
);
export const pathSchema = relativePathSchema.refine((v) => !isCacheMetadataPath(v));
export const filePathSchema = pathSchema.refine((v) => v.length > 0);
export const countsSchema = z.tuple([uintSchema, uintSchema, uintSchema, uintSchema, uintSchema]);
export type Counts = z.infer<typeof countsSchema>;

export const contextSchema = z.tuple([
  nameSchema,
  nameSchema,
  nameSchema,
  nameSchema,
  nameSchema,
  positiveSchema,
  nameSchema,
  buildToolSchema,
]);
export type Context = z.infer<typeof contextSchema>;

export const unitKindSchema = z.enum([
  'maven-directory',
  'artifact-transform',
  'groovy',
  'kotlin-script',
  'kotlin-accessor-jars',
  'kotlin-accessor-directories',
  'kotlin-plugin-spec-accessors',
]);
export type UnitKind = z.infer<typeof unitKindSchema>;

export const scopeSchema = z.enum(['direct', 'subtree']);
export const unitSchema = z
  .tuple([unitKindSchema, filePathSchema, scopeSchema])
  .refine(([kind, , scope]) => (kind === 'maven-directory') === (scope === 'direct'));
export type Unit = z.infer<typeof unitSchema>;

export const modeSchema = uintSchema.max(511).refine((v) => v === (0o644 | (v & 0o111)));
export const portableSchema = z.tuple([
  z.literal('portable'),
  uintSchema,
  modeSchema,
  uintSchema,
  shaSchema,
]);
export function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}
