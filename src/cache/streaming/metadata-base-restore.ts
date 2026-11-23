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

import { randomUUID } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import type { BaseCacheBackend } from '../backend';
import type { OwnedStore, Reference } from './owned-store';
import type { NativeOperationOptions } from './native-operation';
import { settleNativeCleanup } from './native-operation';
import { lineageId } from './model';
import { lineagePrefix } from './native-records';
import { decodeMetadataGeneration, type MetadataGeneration } from './metadata-base-records';
import { metadataBaseObjectPaths } from './metadata-base-source';
import { MetadataInstallContext } from './metadata-install-context';
import { nativeBaseFile, baseRecordPaths } from './base-layout';
import { sameNative, sameObject, type NativeIdentity } from './native';
import { retireOwnedDirectory } from './owned-retirement';
import {
  emptyPartitionMetadata,
  metadataSummaryProfile,
  type PinnedPartitionMetadata,
} from './partition-metadata';
import { nameSchema } from './schema';
import type { HandoffEntry } from './lifecycle-handoff';

/** Bounded v2 control read; no payload/catalogue read and no second control content pass. */
export async function readMetadataGeneration(
  store: OwnedStore,
  reference: Reference,
  key: string,
  options: NativeOperationOptions,
): Promise<MetadataGeneration> {
  if (reference[3] > 65536) throw new Error('Generation exceeds admission.');
  const release = options.budget.holdRecord(reference[3]);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of store.read(reference, 'generation')) {
      options.signal?.throwIfAborted();
      chunks.push(chunk);
    }
    return decodeMetadataGeneration(Buffer.concat(chunks), store.codec.options.model, key);
  } finally {
    release();
  }
}

/** Owns SDK extraction roots until independent snapshots and installation finish. */
export class MetadataBaseRestore {
  #disposed = false;
  readonly #roots: { path: string; native?: NativeIdentity }[] = [];
  generation: MetadataGeneration | null = null;
  record: Reference | null = null;
  key: string | null = null;
  context: MetadataInstallContext | undefined;
  entries: HandoffEntry[] = [];
  private constructor(
    readonly store: OwnedStore,
    readonly options: NativeOperationOptions,
  ) {}
  private async root(): Promise<{ path: string; native?: NativeIdentity }> {
    const owner: { path: string; native?: NativeIdentity } = {
      path: this.store.prefix + 'base/' + randomUUID(),
    };
    this.#roots.push(owner);
    await this.store.makeParents(owner.path + '/pending');
    owner.native = (await this.store.root.stat(owner.path))!;
    return owner;
  }
  private async checkedExtraction(
    owner: { path: string; native?: NativeIdentity },
    found: boolean,
  ): Promise<void> {
    const actual = await this.store.root.stat(owner.path);
    if (
      !owner.native ||
      !actual ||
      !sameObject(owner.native, actual) ||
      owner.native[6] !== actual[6]
    )
      throw new Error('SDK extraction root changed.');
    if (!found) {
      this.store.root.work.nativeListings++;
      for await (const entry of await opendir(this.store.root.resolve(owner.path), {
        bufferSize: 1,
      }))
        throw new Error('Missing SDK result left partial extraction: ' + entry.name);
    }
  }
  static async acquire(
    store: OwnedStore,
    backend: BaseCacheBackend | null,
    refs: { currentRef: string; defaultRef?: string },
    options: NativeOperationOptions,
  ): Promise<MetadataBaseRestore> {
    const result = new MetadataBaseRestore(store, Object.freeze({ ...options }));
    const signal = options.signal ?? new AbortController().signal,
      model = store.codec.options.model;
    try {
      if (backend?.isFeatureAvailable()) {
        if (!backend.capabilities.supportsNewestPrefixRestore)
          throw new Error('Native generation discovery unavailable.');
        const allowed = [nameSchema.parse(refs.currentRef)];
        if (refs.defaultRef && refs.defaultRef !== refs.currentRef)
          allowed.push(nameSchema.parse(refs.defaultRef));
        const prefixes = allowed.map((ref) => lineagePrefix(model.family, lineageId(ref))),
          owner = await result.root();
        const key = await backend.restoreCache(
          baseRecordPaths(store, owner.path),
          prefixes[0],
          prefixes.slice(1),
          { archiveRoot: store.root.resolve(owner.path) },
        );
        signal.throwIfAborted();
        await result.checkedExtraction(owner, key !== undefined);
        if (key !== undefined) {
          if (!prefixes.some((prefix) => key.startsWith(prefix)))
            throw new Error('Unauthorized generation lineage.');
          const file = owner.path + '/record.json',
            before = await nativeBaseFile(store, file, 65536);
          const release = options.budget.holdRecord(Number(before[5]));
          try {
            const chunks: Buffer[] = [];
            for await (const bytes of store.root.read(file, before)) {
              signal.throwIfAborted();
              chunks.push(bytes);
            }
            if (!sameNative(before, await nativeBaseFile(store, file, 65536), true))
              throw new Error('Generation changed during control admission.');
            const bytes = Buffer.concat(chunks),
              generation = decodeMetadataGeneration(bytes, model, key);
            if (!allowed.map(lineageId).includes(generation[5]))
              throw new Error('Unauthorized generation lineage.');
            store.root.work.nativeListings++;
            let recordSeen = false;
            for await (const entry of await opendir(store.root.resolve(owner.path), {
              bufferSize: 2,
            })) {
              if (recordSeen || entry.name !== 'record.json')
                throw new Error('Unexpected generation extraction member.');
              recordSeen = true;
            }
            if (!recordSeen) throw new Error('Missing generation extraction record.');
            result.generation = generation;
            result.key = key;
            result.record = await store.write(
              'generation',
              (async function* () {
                yield bytes;
              })(),
              signal,
            );
          } finally {
            release();
          }
        }
      }
      const offered: { partition: string; root: string }[] = [];
      for (const entry of result.generation?.[8] ?? [])
        if (entry[0] === 'object') {
          const owner = await result.root();
          const key = await backend!.restoreCache(
            metadataBaseObjectPaths(store, owner.path),
            entry[2][2],
            [],
            { archiveRoot: store.root.resolve(owner.path) },
          );
          signal.throwIfAborted();
          if (key !== undefined && key !== entry[2][2])
            throw new Error('Native object exact-key mismatch.');
          await result.checkedExtraction(owner, key !== undefined);
          if (key !== undefined) offered.push({ partition: entry[1], root: owner.path });
        }
      result.context = result.generation
        ? await MetadataInstallContext.discover(store, result.generation, offered, options)
        : await MetadataInstallContext.empty(store, options);
      const cold = new Set(result.context.cold.flat()),
        profile = metadataSummaryProfile();
      for (const partition of model.partitions) {
        const selected = result.generation?.[8].find((entry) => entry[1] === partition[0]);
        let pin: PinnedPartitionMetadata | null = null;
        const status: HandoffEntry[2] = !selected
          ? 'miss'
          : cold.has(partition[0])
            ? 'cold'
            : selected[0] === 'empty'
              ? 'empty'
              : 'available';
        if (status === 'available') {
          const input = result.context.source(partition[0]);
          if (input?.upstream.kind !== 'native-metadata')
            throw new Error('Missing admitted native pin source.');
          pin = input.upstream.source.pin();
        } else if (status === 'empty')
          pin = [
            'pinned-partition-metadata',
            2,
            'local-v2',
            store.codec.options.invocation,
            model.family,
            model.id,
            partition[0],
            null,
            profile,
            emptyPartitionMetadata(profile),
          ];
        // Captured now, before any extras, worker or installer overlay may change the live root.
        result.entries.push(['partition', partition[0], status, pin, null]);
      }
      signal.throwIfAborted();
      return result;
    } catch (error) {
      await settleNativeCleanup([() => result.dispose()], error);
      throw error;
    }
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await settleNativeCleanup([
      () => this.context?.dispose(),
      ...this.#roots.map((owner) => async () => {
        if (owner.native)
          await retireOwnedDirectory(this.store, owner.path, owner.native, this.options.budget);
        else if (await this.store.root.stat(owner.path))
          throw new Error(
            'Unresolved extraction root retained at ' + this.store.root.resolve(owner.path),
          );
      }),
    ]);
  }
}
