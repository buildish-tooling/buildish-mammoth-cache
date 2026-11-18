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
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CacheModel } from './model';
import type { CutoffJournal } from './cutoff-state';
import { cutoffUpsertSchema } from './cutoff-format';
import {
  GROOVY_WORKSPACE_METADATA,
  groovyWorkspaceSchema,
  hasGroovyPartitions,
  inspectGroovyTree,
  assertGroovyContributions,
} from './groovy-workspaces';
import { applyGroovyWorkspaces } from './groovy-apply';
import { createManagedCachePathMatcher, captureCacheMetadataSnapshot } from './manifest';
import { fingerprintMetadata } from './cutoff-selection';
import { copyGuardedFile } from './guarded-files';
import { readMetadata, writeMetadata, metadataPath } from './metadata-io';
import { DELTA_ARTIFACT_RESOURCE_LIMITS } from '../delta/discovery';

export const GROOVY_BASE_DIRECTORY = '.mammoth/groovy-base-v1';
const MAX_BYTES = 64 * 1024 * 1024;
const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    familyKey: z.string(),
    partitionFingerprint: z.string(),
    units: z
      .array(
        z
          .object({
            partitionId: z.string(),
            workspace: groovyWorkspaceSchema,
            entries: z.array(cutoffUpsertSchema),
          })
          .strict(),
      )
      .max(200_000),
  })
  .strict();
function validateCatalog(model: CacheModel, value: unknown) {
  const catalog = catalogSchema.parse(value);
  if (
    catalog.familyKey !== model.cacheFamilyKey ||
    catalog.partitionFingerprint !== model.partitionFingerprint
  )
    throw new Error('Groovy base metadata family/layout mismatch.');
  const byPartition = new Map<
    string,
    {
      partitionId: string;
      upserts: z.infer<typeof cutoffUpsertSchema>[];
      workspaces: z.infer<typeof groovyWorkspaceSchema>[];
    }
  >();
  let count = 0,
    bytes = 0;
  const payloads = new Set<string>();
  for (const unit of catalog.units) {
    const p = byPartition.get(unit.partitionId) ?? {
      partitionId: unit.partitionId,
      upserts: [],
      workspaces: [],
    };
    p.upserts.push(...unit.entries);
    p.workspaces.push(unit.workspace);
    byPartition.set(unit.partitionId, p);
    count +=
      1 +
      unit.entries.length +
      unit.workspace.files.length +
      unit.workspace.emptyDirectories.length;
    for (const entry of unit.entries) {
      if (payloads.has(entry.payloadPath)) throw new Error('Duplicate Groovy base payload.');
      payloads.add(entry.payloadPath);
      bytes += entry.size;
    }
  }
  if (
    count > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries ||
    bytes > DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes ||
    Buffer.byteLength(JSON.stringify(catalog)) > MAX_BYTES
  )
    throw new Error('Groovy base transport exceeds resource budget.');
  assertGroovyContributions(model, [...byPartition.values()], createManagedCachePathMatcher(model));
  return catalog;
}
export async function resetGroovyBaseTransport(model: CacheModel): Promise<void> {
  if (!hasGroovyPartitions(model)) return;
  const tree = await inspectGroovyTree(model.cacheRoot, GROOVY_BASE_DIRECTORY, false);
  if (tree) await rm(path.join(model.cacheRoot, GROOVY_BASE_DIRECTORY), { recursive: true });
  const old = await metadataPath(model.cacheRoot, GROOVY_WORKSPACE_METADATA).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (old) {
    await readMetadata(model.cacheRoot, GROOVY_WORKSPACE_METADATA, MAX_BYTES);
    await rm(old, { force: true });
  }
}
/** Stable archive patterns keep the GitHub cache client's path-derived version compatible. */
export async function stageGroovyBase(state: CutoffJournal): Promise<void> {
  const model = state.model;
  if (!hasGroovyPartitions(model)) return;
  if (!state.selection) throw new Error('Groovy publication requires frozen observations.');
  const snapshot = await captureCacheMetadataSnapshot(model),
    gc = new Set(state.selection.gc.map((e) => e.relativePath));
  if (fingerprintMetadata(snapshot, gc) !== state.selection.retainedFingerprint)
    throw new Error('Frozen Groovy publication sources changed.');
  const current = new Map(
    snapshot.partitions.flatMap((p) => p.entries.map((e) => [e.relativePath, e] as const)),
  );
  const units = (state.selection.workspaces ?? []).filter(
    (u) => !u.workspace.files.every((f) => gc.has(f)),
  );
  const catalog: z.infer<typeof catalogSchema> = {
    schemaVersion: 1,
    familyKey: model.cacheFamilyKey,
    partitionFingerprint: model.partitionFingerprint,
    units: [],
  };
  let index = 0;
  for (const unit of units)
    catalog.units.push({
      partitionId: unit.partitionId,
      workspace: unit.workspace,
      entries: unit.workspace.files.map((relativePath) => {
        const entry = current.get(relativePath);
        if (!entry) throw new Error('Frozen Groovy base file disappeared.');
        return {
          relativePath,
          payloadPath: `payload/${String(++index).padStart(6, '0')}.bin`,
          contentSha256: '0'.repeat(64),
          size: entry.identity.size,
          mode: entry.identity.mode & 0o777,
          mtimeMs: Math.trunc(entry.identity.mtimeMs),
        };
      }),
    });
  validateCatalog(model, catalog);
  await resetGroovyBaseTransport(model);
  await metadataPath(model.cacheRoot, GROOVY_BASE_DIRECTORY + '/payload/reserved', true);
  for (const unit of catalog.units)
    for (const entry of unit.entries) {
      entry.contentSha256 = await copyGuardedFile(
        model.cacheRoot,
        entry.relativePath,
        path.join(model.cacheRoot, GROOVY_BASE_DIRECTORY, entry.payloadPath),
        { size: entry.size, mode: entry.mode, mtimeMs: entry.mtimeMs },
        current.get(entry.relativePath)!.identity,
      );
    }
  validateCatalog(model, catalog);
  await writeMetadata(model.cacheRoot, GROOVY_WORKSPACE_METADATA, catalog, MAX_BYTES);
}
export async function restoreGroovyBase(model: CacheModel, hit: boolean): Promise<void> {
  if (!hasGroovyPartitions(model) || !hit) return;
  const raw = await readMetadata(model.cacheRoot, GROOVY_WORKSPACE_METADATA, MAX_BYTES);
  if (raw === null) throw new Error('Restored Groovy base metadata is missing.');
  const catalog = validateCatalog(model, JSON.parse(raw));
  const expected = new Set(
    catalog.units.flatMap((u) => u.entries.map((e) => GROOVY_BASE_DIRECTORY + '/' + e.payloadPath)),
  );
  const tree = await inspectGroovyTree(model.cacheRoot, GROOVY_BASE_DIRECTORY, false);
  if (
    (tree?.files.length ?? 0) !== expected.size ||
    tree?.files.some((f) => !expected.has(f.relativePath))
  )
    throw new Error('Restored Groovy base payload membership mismatch.');
  // Each unit is staged and verified before mutating its destination. Failed prepare
  // cannot publish, even if a later unit is rejected after an earlier one was applied.
  await applyGroovyWorkspaces(
    catalog.units.map((u) => ({
      ...u,
      rootDirectory: path.join(model.cacheRoot, GROOVY_BASE_DIRECTORY),
    })),
    model,
  );
}
