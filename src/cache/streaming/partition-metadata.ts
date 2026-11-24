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
import { workspaceKind } from '../immutable-workspaces';
import { add, decodeRecord, Digest, encodeRecord, equal } from './encoding';
import { nativeIdentitySchema } from './local-schema';
import type { NativeIdentity } from './native';
import type { ResolvedModel } from './model';
import { objectRefSchema, type GenerationEntry } from './native-records';
import { assertMetadataModel } from './metadata-base-records';
import {
  familySchema,
  filePathSchema,
  partitionSchema,
  pathSchema,
  shaSchema,
  uintSchema,
  type Unit,
} from './schema';
import {
  isWorkspaceRoot,
  isWorkspaceScaffolding,
  recognizedRoot,
  TreeState,
  type WorkingBudget,
} from './tree-state';
import { UnitMarkers } from './unit-markers';

// Operation-local rows. Full identities retain original activity clocks for GC;
// semantic summaries below exclude those clocks. These rows never enter a base archive/handoff.
export const nativeMetadataRowSchema = z.union([
  z.tuple([
    z.literal('dir-open'),
    pathSchema,
    nativeIdentitySchema.refine((n) => n[2] === 'directory'),
  ]),
  z.tuple([
    z.literal('dir-close'),
    pathSchema,
    nativeIdentitySchema.refine((n) => n[2] === 'directory'),
  ]),
  z.tuple([z.literal('file'), filePathSchema, nativeIdentitySchema.refine((n) => n[2] === 'file')]),
]);
export type NativeMetadataRow = z.infer<typeof nativeMetadataRowSchema>;
export const metadataSummaryProfileSchema = z.tuple([
  z.literal('native-metadata-summary'),
  z.literal(1),
  z.enum(['unix-mode-0777', 'windows-owner-writable']),
  z.literal('native-mtime-ns'),
  z.literal('files-first-utf8-dfs'),
]);
export type MetadataSummaryProfile = z.infer<typeof metadataSummaryProfileSchema>;
export function metadataSummaryProfile(platform = process.platform): MetadataSummaryProfile {
  return [
    'native-metadata-summary',
    1,
    platform === 'win32' ? 'windows-owner-writable' : 'unix-mode-0777',
    'native-mtime-ns',
    'files-first-utf8-dfs',
  ];
}
export const partitionMetadataSchema = z.tuple([
  z.literal('partition-metadata'),
  z.literal(1),
  shaSchema,
  uintSchema,
  uintSchema,
  uintSchema,
]);
export type PartitionMetadata = z.infer<typeof partitionMetadataSchema>;
export function emptyPartitionMetadata(profile: MetadataSummaryProfile): PartitionMetadata {
  const normalized = metadataSummaryProfileSchema.parse(profile);
  return [
    'partition-metadata',
    1,
    new Digest('partition-native-metadata').update(normalized).digest(),
    0,
    0,
    0,
  ];
}
/** Metadata fingerprint, file count, meaningful directory count, total file length. */
export class PartitionMetadataSummary {
  private readonly digest = new Digest('partition-native-metadata');
  private readonly tree: TreeState;
  private files = 0;
  private directories = 0;
  private bytes = 0;
  private finished = false;
  private readonly profile: MetadataSummaryProfile;
  private workspace: {
    unit: Unit;
    markers: UnitMarkers;
    jars: UnitMarkers | null;
    hasJar: boolean;
  } | null = null;
  constructor(
    private readonly model: ResolvedModel,
    private readonly partition: string,
    budget: WorkingBudget,
    profile = metadataSummaryProfile(),
    maxDirectoryEntries?: number,
    private readonly validateMembers = true,
  ) {
    this.profile = metadataSummaryProfileSchema.parse(profile);
    if (!model.partitions.some((p) => p[0] === partition))
      throw new Error('Unknown metadata partition.');
    this.tree = new TreeState(budget, maxDirectoryEntries);
    this.digest.update(this.profile);
  }
  private permission(n: NativeIdentity): number {
    return this.profile[2] === 'windows-owner-writable' ? n[6] & 0o200 : n[6] & 0o777;
  }
  private owner(path: string) {
    if (recognizedRoot(this.model, path) === path)
      throw new Error('Workspace root must be a directory.');
    if (this.model.owner(path)[0] !== this.partition)
      throw new Error('Wrong native metadata partition.');
  }
  /** Rows must come from one ordered stable selected-source phase, before its consumers mutate. */
  accept(row: NativeMetadataRow): void {
    if (this.finished) throw new Error('Metadata summary is finished.');
    const [tag, path, n] = row;
    if (tag === 'dir-open') {
      this.tree.open(path);
      if (this.validateMembers && isWorkspaceRoot(this.model, path)) {
        if (this.workspace) throw new Error('Nested workspace root.');
        const kind = workspaceKind(path),
          unit: Unit = [kind, path, 'subtree'];
        this.workspace = {
          unit,
          markers: new UnitMarkers(unit),
          jars:
            kind === 'kotlin-accessor-directories'
              ? new UnitMarkers(['kotlin-accessor-jars', path, 'subtree'])
              : null,
          hasJar: false,
        };
      }
      this.workspace?.markers.directory(path);
      this.workspace?.jars?.directory(path);
      if (path && !isWorkspaceScaffolding(this.model, path)) {
        this.directories = add(this.directories);
        this.digest.update(['directory', path, this.permission(n)]);
      }
    } else if (tag === 'file') {
      this.tree.file(path);
      if (this.validateMembers) this.owner(path);
      const size = uintSchema.parse(Number(n[5]));
      this.files = add(this.files);
      this.bytes = add(this.bytes, size);
      this.digest.update(['file', path, size, n[8], this.permission(n)]);
      this.workspace?.markers.file(path);
      this.workspace?.jars?.file(path);
      if (
        this.workspace &&
        (path === this.workspace.unit[1] + '/classes.jar' ||
          path === this.workspace.unit[1] + '/sources.jar')
      )
        this.workspace.hasJar = true;
    } else {
      if (
        this.validateMembers &&
        path &&
        this.tree.leaf &&
        !isWorkspaceScaffolding(this.model, path)
      )
        this.owner(path + '/.workspace-directory-probe');
      if (this.workspace?.unit[1] === path) {
        (this.workspace.hasJar && this.workspace.jars
          ? this.workspace.jars
          : this.workspace.markers
        ).finish();
        this.workspace = null;
      }
      this.tree.close(path);
    }
  }
  finish(): PartitionMetadata {
    if (this.finished || !this.tree.complete || this.workspace)
      throw new Error('Incomplete metadata summary.');
    this.finished = true;
    return [
      'partition-metadata',
      1,
      this.digest.digest(),
      this.files,
      this.directories,
      this.bytes,
    ];
  }
  dispose(): void {
    this.finished = true;
    this.tree.dispose();
  }
}
// Only O(partitions) aggregates survive main/post. The object ref is the exact
// materialized input before extras/workers; null represents a declared-empty entry.
export const pinnedPartitionMetadataSchema = z.tuple([
  z.literal('pinned-partition-metadata'),
  z.literal(2),
  z.literal('local-v2'),
  shaSchema,
  familySchema,
  shaSchema,
  partitionSchema,
  objectRefSchema.nullable(),
  metadataSummaryProfileSchema,
  partitionMetadataSchema,
]);
export type PinnedPartitionMetadata = z.infer<typeof pinnedPartitionMetadataSchema>;
export function decodePinnedPartitionMetadata(
  bytes: Buffer,
  model: ResolvedModel,
  invocation: string,
  selected: GenerationEntry,
): PinnedPartitionMetadata {
  assertMetadataModel(model);
  const p = pinnedPartitionMetadataSchema.parse(decodeRecord(bytes));
  equal(
    p.slice(3, 7),
    [invocation, model.family, model.id, selected[1]],
    'pinned metadata provenance',
  );
  equal(p[7], selected[0] === 'object' ? selected[2] : null, 'pinned materialized object');
  if (!model.partitions.some((partition) => partition[0] === p[6]))
    throw new Error('Unknown pinned partition.');
  if (p[7] === null) equal(p[9], emptyPartitionMetadata(p[8]), 'declared-empty metadata');
  return p;
}
export function encodePinnedPartitionMetadata(pin: PinnedPartitionMetadata): Buffer {
  return encodeRecord(pinnedPartitionMetadataSchema.parse(pin));
}
