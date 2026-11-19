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

import { mkdtemp, mkdir, rm, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { BaseCacheBackend } from './backend';
import type { CacheModel } from './model';
import { metadataPath, readMetadata } from './metadata-io';
import { stagePartitionSnapshot, snapshotPartitions } from './partition-snapshots';
import { installPartitionObject, readPartitionObject } from './partition-transport';
import {
  assertStorageBudget,
  GENERATION_RECORD_PATH,
  PARTITION_STORAGE_LIMITS,
  generationRecordPaths,
  partitionObjectPaths,
  validateGenerationRecord,
  createRecoveryGroups,
  type PartitionBaseline,
  type GenerationRecord,
} from './partition-format';

export interface RestoredGeneration {
  selectedKey: string | null;
  partitions: PartitionBaseline[];
}
/** Missing immutable objects are cold independently, except connected Maven directory owners. */
export async function restorePartitionedGeneration(
  model: CacheModel,
  backend: BaseCacheBackend,
  exactKey?: string,
  pinned?: readonly { partitionId: string; status: string }[],
): Promise<RestoredGeneration> {
  const marker = await metadataPath(model.cacheRoot, '.mammoth/restore-staging/reserved', true);
  const scratch = await mkdtemp(path.join(path.dirname(marker), 'generation-'));
  const partitions: PartitionBaseline[] = model.partitions.map((p) => ({
    partitionId: p.id,
    status: 'missing',
    reference: null,
    descriptor: null,
  }));
  try {
    const recordRoot = path.join(scratch, 'record');
    await mkdir(recordRoot);
    const selectedKey = await backend.restoreCache(
      generationRecordPaths(recordRoot),
      exactKey ?? model.currentRefLineagePrefix,
      exactKey ? [] : [...model.fallbackRefLineagePrefixes],
      { archiveRoot: recordRoot },
    );
    if (exactKey && selectedKey !== exactKey)
      throw new Error('Pinned cache generation was unavailable during cleanup.');
    if (!selectedKey) return { selectedKey: null, partitions };
    if (
      ![model.currentRefLineagePrefix, ...model.fallbackRefLineagePrefixes].some(
        (prefix) => selectedKey.startsWith(prefix) && selectedKey.length > prefix.length,
      )
    )
      throw new Error(
        `Cache backend returned key '${selectedKey}' outside the requested cache lineages.`,
      );
    const raw = await readMetadata(
      recordRoot,
      GENERATION_RECORD_PATH,
      PARTITION_STORAGE_LIMITS.bytes,
    );
    if (!raw) throw new Error('Restored generation record is missing.');
    const record = validateGenerationRecord(model, JSON.parse(raw), selectedKey);
    for (const [i, entry] of record.partitions.entries()) {
      if (pinned?.some((p) => p.partitionId === entry.partitionId && p.status === 'missing'))
        continue;
      if (entry.kind === 'empty') {
        partitions[i]!.status = 'empty';
        continue;
      }
      const root = path.join(scratch, entry.partitionId);
      await mkdir(root);
      const matched = await backend.restoreCache(
        partitionObjectPaths(
          root,
          entry.partitionId,
          model,
          entry.reference.workspaceRoots,
          entry.reference.ordinaryPaths,
        ),
        entry.reference.key,
        [],
        { archiveRoot: root },
      );
      if (matched !== entry.reference.key) continue;
      partitions[i] = {
        partitionId: entry.partitionId,
        status: 'restored',
        reference: entry.reference,
        descriptor: await readPartitionObject(model, root, entry.reference),
      };
      assertStorageBudget(
        partitions,
        partitions.reduce((n, p) => n + 1 + (p.descriptor?.files.length ?? 0), 0),
      );
    }
    assertStorageBudget(
      partitions,
      partitions.reduce((n, p) => n + 1 + (p.descriptor?.files.length ?? 0), 0),
    );
    validateRecoveryGroups(model, record, partitions);
    for (const group of record.recoveryGroups)
      if (group.some((id) => partitions.find((p) => p.partitionId === id)!.status === 'missing'))
        for (const id of group)
          partitions[model.partitions.findIndex((p) => p.id === id)] = {
            partitionId: id,
            status: 'missing',
            reference: null,
            descriptor: null,
          };
    if (
      pinned?.some(
        (p) =>
          p.status !== 'missing' &&
          partitions.find((v) => v.partitionId === p.partitionId)?.status === 'missing',
      )
    )
      throw new Error('Pinned cache partition was unavailable during cleanup.');
    // Group availability and every transport are validated before the first live installation.
    for (const entry of partitions)
      if (entry.descriptor)
        await installPartitionObject(
          model,
          path.join(scratch, entry.partitionId),
          entry.descriptor,
        );
    for (const partition of snapshotPartitions(model))
      if (!partitions.find((p) => p.partitionId === partition.id)?.descriptor)
        await stagePartitionSnapshot(model, partition.id, model.cacheRoot, []);
    return { selectedKey, partitions };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
function validateRecoveryGroups(
  model: CacheModel,
  record: GenerationRecord,
  partitions: PartitionBaseline[],
) {
  const actual = createRecoveryGroups(
    model,
    partitions.flatMap((p) => (p.descriptor ? [p.descriptor] : [])),
  );
  if (
    actual.some(
      (group) =>
        !record.recoveryGroups.some((declared) => group.every((id) => declared.includes(id))),
    )
  )
    throw new Error('Generation recovery groups split a Maven directory.');
  // Fully available groups must contain no invented connections.
  for (const group of record.recoveryGroups)
    if (
      group.every((id) => partitions.find((p) => p.partitionId === id)!.status !== 'missing') &&
      !actual.some(
        (derived) => derived.length === group.length && group.every((id) => derived.includes(id)),
      )
    )
      throw new Error('Generation recovery group does not match partition membership.');
}

/** Retire only our abandoned root-local extraction directories before starting a new prepare. */
export async function resetPartitionRestoreStaging(model: CacheModel): Promise<void> {
  const marker = await metadataPath(model.cacheRoot, '.mammoth/restore-staging/reserved').catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!marker) return;
  for await (const entry of await opendir(path.dirname(marker)))
    if (
      /^generation-[A-Za-z0-9]{6}$/u.test(entry.name) &&
      entry.isDirectory() &&
      !entry.isSymbolicLink()
    )
      await rm(path.join(path.dirname(marker), entry.name), { recursive: true });
}
