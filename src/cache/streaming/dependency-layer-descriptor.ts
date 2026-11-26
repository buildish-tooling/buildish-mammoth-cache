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
import { cacheInvocationSeedPrefix } from '../metadata-paths';
import { nativeIdentitySchema, ownedPathSchema } from './local-schema';
import { keySchema } from './native-records';

export function dependencyLayerSchema(invocation: string) {
  const prefix = cacheInvocationSeedPrefix(invocation);
  return z.tuple([
    z.literal('gradle-layer'),
    z.literal(1),
    ownedPathSchema(invocation).refine(
      (p) =>
        p.startsWith(prefix) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          p.slice(prefix.length),
        ),
    ),
    nativeIdentitySchema.refine((n) => n[2] === 'directory'),
    keySchema,
    z.string().min(1),
    z.string().min(1),
    // Accept the legacy handoff value. New handoffs leave this slot unset.
    z.literal('9.6.1').nullable(),
  ]);
}

export type DependencyLayer = z.infer<ReturnType<typeof dependencyLayerSchema>>;
