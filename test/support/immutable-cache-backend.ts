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

import { mkdir, readFile, writeFile, chmod, utimes, stat } from 'node:fs/promises';
import path from 'node:path';
import * as glob from '@actions/glob';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
  type BaseCacheOperationOptions,
} from '../../src/cache/backend';
import type { CacheModel } from '../../src/cache/model';
import { createCacheGeneration } from '../../src/cache/model';
import { GENERATION_RECORD_PATH } from '../../src/cache/partition-format';
import { writeMetadata } from '../../src/cache/metadata-io';
import { packCacheFiles, unpackCacheFiles } from './archive-round-trip';

/** Immutable/version-aware fixture; optional real archives use the shared GNU-tar helper. */
export class ImmutableCacheBackend implements BaseCacheBackend {
  readonly capabilities = STANDARD_BASE_CACHE_BACKEND_CAPABILITIES;
  readonly entries: {
    id: number;
    key: string;
    version: string;
    files: { name: string; bytes: Buffer; mode: number; mtime: Date }[];
    archive?: string;
  }[] = [];
  readonly unavailableKeys = new Set<string>();
  readonly transfers: {
    operation: 'save' | 'restore' | 'lookup';
    key: string;
    paths: string[];
    members: string[];
    bytes: number;
  }[] = [];
  constructor(readonly archiveDirectory?: string) {}
  isFeatureAvailable() {
    return true;
  }
  root(paths: string[], options?: BaseCacheOperationOptions) {
    return (
      options?.archiveRoot ?? paths[0]?.replace(/^!/, '').split('/.mammoth/')[0] ?? process.cwd()
    );
  }
  version(paths: string[], root: string) {
    return JSON.stringify(
      paths.map(
        (p) =>
          (p.startsWith('!') ? '!' : '') +
          path.relative(root, p.replace(/^!/, '')).split(path.sep).join('/'),
      ),
    );
  }
  async lookupCache(paths: string[], key: string, options?: BaseCacheOperationOptions) {
    return this.restoreCache(paths, key, [], { ...options, lookupOnly: true });
  }
  async restoreCache(
    paths: string[],
    primary: string,
    fallbacks: string[] = [],
    options?: BaseCacheOperationOptions,
  ): Promise<string | undefined> {
    const root = this.root(paths, options),
      version = this.version(paths, root);
    const entry = [primary, ...fallbacks].flatMap((prefix) =>
      [...this.entries]
        .reverse()
        .filter(
          (e) =>
            e.key.startsWith(prefix) && e.version === version && !this.unavailableKeys.has(e.key),
        ),
    )[0];
    if (!entry) return undefined;
    this.transfers.push({
      operation: options?.lookupOnly ? 'lookup' : 'restore',
      key: entry.key,
      paths,
      members: entry.files.map((f) => f.name),
      bytes: options?.lookupOnly ? 0 : entry.files.reduce((n, f) => n + f.bytes.length, 0),
    });
    if (!options?.lookupOnly) {
      if (entry.archive) await unpackCacheFiles(root, entry.archive);
      else
        for (const file of entry.files) {
          const target = path.join(root, file.name);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file.bytes);
          await chmod(target, file.mode);
          await utimes(target, file.mtime, file.mtime);
        }
    }
    return entry.key;
  }
  async saveCache(
    paths: string[],
    key: string,
    options?: BaseCacheOperationOptions,
  ): Promise<number> {
    if (this.entries.some((e) => e.key === key))
      throw new Error(`Immutable cache key '${key}' already exists.`);
    const root = this.root(paths, options);
    const selected = paths.length
      ? await (
          await glob.create(paths.join('\n'), {
            implicitDescendants: false,
            followSymbolicLinks: false,
          })
        ).glob()
      : [];
    const files = [];
    for (const file of selected) {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('Directory in archive.');
      files.push({
        name: path.relative(root, file),
        bytes: await readFile(file),
        mode: st.mode & 0o777,
        mtime: st.mtime,
      });
    }
    const id = this.entries.length + 1;
    const archive =
      this.archiveDirectory && files.length
        ? await packCacheFiles(
            root,
            files.map((f) => f.name),
            path.join(this.archiveDirectory, String(id)),
          )
        : undefined;
    this.entries.push({ id, key, version: this.version(paths, root), files, archive });
    this.transfers.push({
      operation: 'save',
      key,
      paths,
      members: files.map((f) => f.name),
      bytes: files.reduce((n, f) => n + f.bytes.length, 0),
    });
    return id;
  }
  isMissingPathsError() {
    return false;
  }
  get savedKeys() {
    return this.entries.map((e) => e.key);
  }
}

/** Valid explicit-empty record for tests concerned only with record selection/status. */
export async function restoreEmptyGeneration(
  model: CacheModel,
  root: string,
  lineage = model.currentRefLineagePrefix,
  digest = 'a'.repeat(64),
): Promise<string> {
  const generation = createCacheGeneration(
    { ...model, currentRefLineagePrefix: lineage, plannedGenerationId: 'seed' },
    digest,
  );
  await writeMetadata(
    root,
    GENERATION_RECORD_PATH,
    {
      schemaVersion: 3,
      familyKey: model.cacheFamilyKey,
      buildToolId: model.buildToolId,
      partitionFingerprint: model.partitionFingerprint,
      lineagePrefix: lineage,
      generationId: generation.generationId,
      decisionDigest: digest,
      key: generation.key,
      partitions: model.partitions.map((p) => ({ partitionId: p.id, kind: 'empty' })),
      recoveryGroups: model.partitions.map((p) => [p.id]),
    },
    64 * 1024 * 1024,
  );
  return generation.key;
}
