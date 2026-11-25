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
import { contextSchema, nonceSchema, uintSchema, positiveSchema, nameSchema } from './schema';
import {
  nativeIdentitySchema,
  nativePathSchema,
  policySchema,
  type LocalOptions,
  ownedReferenceSchema,
} from './local-schema';
import { invocationId } from './model';
import { encodeRecord } from './encoding';
import { keySchema } from './native-records';

export function lifecycleDocuments(options: LocalOptions) {
  const ref = <T extends string>(purpose: T) => ownedReferenceSchema(options.invocation, purpose);
  const family = z
    .array(z.union([z.string(), z.number()]))
    .length(12)
    .refine((value) => encodeRecord(value).equals(encodeRecord(options.model.familyProjection)));
  const bindings = z
    .tuple([
      z.literal('bindings'),
      z.literal(2),
      z.literal(options.invocation),
      contextSchema,
      nonceSchema,
      z.tuple([nativePathSchema, nativeIdentitySchema]),
      ref('model'),
      family,
      policySchema,
    ])
    .refine(
      (value) =>
        invocationId(value[3], value[4]) === options.invocation &&
        encodeRecord(value[3]).equals(encodeRecord(options.context)) &&
        value[5][1][2] === 'directory' &&
        value[8][2] === options.role &&
        value[8][3] === options.access,
    );
  const terminal = z
    .tuple([
      z.literal('outcome'),
      z.enum([
        'read-only',
        'no-change',
        'published',
        'worker-uploaded',
        'skipped-not-quiescent',
        'feature-unavailable',
        'abandoned',
      ]),
      keySchema.nullable(),
      positiveSchema.nullable(),
      nameSchema.nullable(),
    ])
    .refine((value) =>
      value[1] === 'worker-uploaded'
        ? value[3] !== null && value[4] !== null && value[2] === null
        : value[3] === null && value[4] === null && (value[1] !== 'published' || value[2] !== null),
    );
  const state = z
    .tuple([
      z.literal('local-state'),
      z.literal(2),
      z.literal(options.invocation),
      uintSchema,
      z.enum(['prepare-pending', 'prepare-failed', 'build-ready', 'post-active', 'completed']),
      ref('bindings'),
      ref('handoff').nullable(),
      terminal.nullable(),
    ])
    .refine(
      (value) =>
        (value[3] !== 0 || value[4] === 'prepare-pending') &&
        (value[4] === 'completed') === (value[7] !== null) &&
        (['prepare-pending', 'prepare-failed'].includes(value[4]) || value[6] !== null),
    );
  return { bindings, 'local-state': state };
}
export type LifecycleBindings = z.infer<ReturnType<typeof lifecycleDocuments>['bindings']>;

export type LifecycleState = z.infer<ReturnType<typeof lifecycleDocuments>['local-state']>;

export type LifecycleTerminal = NonNullable<LifecycleState[7]>;
