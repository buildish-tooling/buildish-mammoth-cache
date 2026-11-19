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
import { workspaceSchema } from './immutable-workspaces';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import { isCacheMetadataPath } from './metadata-paths';
import { canonicalTimestampMs } from '../util/timestamps';

export const CUTOFF_CACHE_SCHEMA_VERSION = 8;
export const CUTOFF_MANIFEST_SCHEMA_VERSION = 7;
export const CUTOFF_PACKAGE_SCHEMA_VERSION = 8;
export const CUTOFF_LIFECYCLE_SCHEMA_VERSION = 8;
export const cutoffPathSchema = z.string().refine((value) => {
  try {
    validateNormalizedRelativePosixPath(value, 'Cutoff path', 'cache root');
    return !isCacheMetadataPath(value);
  } catch {
    return false;
  }
});
export const cutoffPartitionIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
export const cutoffDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const cutoffTimeSchema = z.number().finite().nonnegative();
export const cutoffUpsertSchema = z
  .object({
    relativePath: cutoffPathSchema,
    payloadPath: z.string().regex(/^payload\/[0-9]{6}\.bin$/u),
    contentSha256: cutoffDigestSchema,
    size: z.number().int().nonnegative(),
    mode: z.number().int().min(0).max(0o777),
    mtimeMs: cutoffTimeSchema.transform(canonicalTimestampMs),
  })
  .strict();
export type CutoffUpsert = z.infer<typeof cutoffUpsertSchema>;
function sortedUnique(values: readonly string[], ctx: z.RefinementCtx) {
  for (let i = 1; i < values.length; i++)
    if (values[i - 1]!.localeCompare(values[i]!) >= 0)
      ctx.addIssue({ code: 'custom', message: 'Paths must be sorted and unique.' });
}
export const cutoffPartitionSchema = z
  .object({
    partitionId: cutoffPartitionIdSchema,
    workspaces: z.array(workspaceSchema).max(200_000).optional(),
    /** True means upserts are the complete configured partition, including intentional empty. */
    snapshot: z.literal(true).optional(),
    upserts: z.array(cutoffUpsertSchema).superRefine((v, ctx) =>
      sortedUnique(
        v.map((e) => e.relativePath),
        ctx,
      ),
    ),
    usedPaths: z.array(cutoffPathSchema).superRefine(sortedUnique),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.snapshot && value.usedPaths.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Complete snapshots cannot contain usage-only paths.',
      });
    const upserts = new Set(value.upserts.map((e) => e.relativePath));
    if (value.usedPaths.some((p) => upserts.has(p)))
      ctx.addIssue({ code: 'custom', message: 'Upserts already cover usage.' });
  });
export const cutoffManifestSchema = z
  .object({
    schemaVersion: z.literal(CUTOFF_MANIFEST_SCHEMA_VERSION),
    buildToolId: z.string().min(1),
    partitions: z.array(cutoffPartitionSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    const payloads = new Set<string>();
    for (const p of value.partitions) {
      if (ids.has(p.partitionId)) ctx.addIssue({ code: 'custom', message: 'Duplicate partition.' });
      ids.add(p.partitionId);
      for (const entry of p.upserts) {
        if (payloads.has(entry.payloadPath))
          ctx.addIssue({ code: 'custom', message: 'Duplicate payload locator.' });
        payloads.add(entry.payloadPath);
      }
      for (const name of [...p.usedPaths, ...p.upserts.map((e) => e.relativePath)]) {
        if (paths.has(name)) ctx.addIssue({ code: 'custom', message: 'Duplicate path ownership.' });
        paths.add(name);
      }
    }
  });
export type CutoffManifest = z.infer<typeof cutoffManifestSchema>;
