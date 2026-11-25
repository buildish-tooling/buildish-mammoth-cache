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

import { cacheInvocationSnapshotPrefix } from '../metadata-paths';
import { constants } from 'node:fs';
import { mkdir, open, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { OwnedStore } from './owned-store';
import type { NativeOperationOptions } from './native-operation';
import { settleNativeCleanup } from './native-operation';
import { InstallScratch } from './install-scratch';
import {
  buildObservedInstallIndex,
  indexedNode,
  indexedEntries,
  nodeMask,
  partitionBit,
} from './install-index';
import type { MetadataPublicationSource } from './metadata-publication-source';
import { WorkerNativeIndex } from './worker-native';
import { NativeReadPhase } from './native-read-phase';
import { walkNative } from './native-walk';
import { nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import { parentPath, joinPath } from './tree-state';
import { handoffSchemas, type SnapshotDescriptor } from './lifecycle-handoff';
import { retireOwnedDirectory } from './owned-retirement';
import { add, type Value } from './encoding';

const snapshots = new WeakSet<MetadataSnapshot>();
/** Independent payload and its actual producer index; persisted descriptors are data only. */
export class MetadataSnapshot {
  #active = true;
  #borrowers = 0;
  #retired = false;

  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly nativeRoot: string,
    readonly scratch: InstallScratch,
    readonly index: number,
    readonly options: NativeOperationOptions,
    private readonly descriptor: SnapshotDescriptor,
    readonly bytes: number,
  ) {
    snapshots.add(this);
    Object.freeze(this);
  }

  static assertReceipt(snapshot: MetadataSnapshot, store: OwnedStore, partition: string): void {
    if (
      !snapshots.has(snapshot) ||
      !snapshot.#active ||
      snapshot.store !== store ||
      snapshot.partition !== partition
    ) {
      throw new Error('Unavailable independent metadata snapshot.');
    }
  }

  assertBound(store: OwnedStore, partition: string): void {
    MetadataSnapshot.assertReceipt(this, store, partition);
  }

  sourceDescriptor(): SnapshotDescriptor {
    this.assertBound(this.store, this.partition);
    return structuredClone(this.descriptor);
  }

  borrow(): () => void {
    this.assertBound(this.store, this.partition);
    this.#borrowers++;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#borrowers--;
      }
    };
  }

  async verify(
    signal: AbortSignal,
    budget = this.options.budget,
    max = this.options.maxDirectoryEntries ?? 100000,
  ): Promise<void> {
    this.assertBound(this.store, this.partition);
    signal.throwIfAborted();
    if (budget !== this.options.budget || max !== (this.options.maxDirectoryEntries ?? 100000)) {
      throw new Error('Snapshot policy/budget mismatch.');
    }
    const parent = await this.store.root.stat(parentPath(this.nativeRoot)),
      root = await this.store.root.stat(this.nativeRoot);
    if (
      !parent ||
      !root ||
      !sameObject(parent, this.descriptor[2]) ||
      parent[6] !== this.descriptor[2][6] ||
      !sameNative(root, this.descriptor[3], true)
    ) {
      throw new Error('Independent snapshot root/parent changed.');
    }
    signal.throwIfAborted();
  }

  node(offset: number) {
    this.assertBound(this.store, this.partition);
    return indexedNode(this.scratch, offset);
  }

  children(node: Parameters<typeof indexedEntries>[1]) {
    this.assertBound(this.store, this.partition);
    return indexedEntries(this.scratch, node);
  }

  static async copy(
    source: MetadataPublicationSource | WorkerNativeIndex,
    partition: string,
    origin: SnapshotDescriptor[4],
    options: NativeOperationOptions,
  ): Promise<MetadataSnapshot> {
    const worker = source instanceof WorkerNativeIndex;
    if (worker) {
      WorkerNativeIndex.assert(source);
    } else {
      source.assert();
    }
    const store = source.store,
      max = options.maxDirectoryEntries ?? 100000;
    const sourceBudget = worker ? source.budget : source.options.budget,
      sourceMax = worker
        ? source.maxDirectoryEntries
        : (source.options.maxDirectoryEntries ?? 100000);
    if (sourceBudget !== options.budget || sourceMax !== max) {
      throw new Error('Snapshot copy policy/budget mismatch.');
    }
    const root = worker ? source.root(partition) : source.index,
      nativeRoot = worker ? source.nativeRoot(partition) : source.nativeRoot;
    const signal = options.signal ?? new AbortController().signal;
    const phase = new NativeReadPhase(store.root, nativeRoot),
      bit = partitionBit(store.codec.options.model, partition);
    return MetadataSnapshot.produce(store, partition, origin, options, async (target, accept) => {
      async function visit(offset: number, physicalRoot = false): Promise<void> {
        signal.throwIfAborted();
        if (worker) {
          WorkerNativeIndex.assert(source, store);
        } else {
          source.assert();
        }
        const lease = await source.node(offset);
        try {
          const node = lease.node;
          if (!physicalRoot && !(nodeMask(node) & bit)) {
            return;
          }
          const path = node[2],
            expected = node[3] as NativeIdentity,
            input = path ? joinPath(nativeRoot, path) : nativeRoot,
            output = path ? target + '/' + path : target;
          if (node[1] === 'protected') {
            throw new Error('Protected member in independent snapshot.');
          }
          if (node[1] === 'file') {
            if (store.codec.options.model.owner(path)[0] !== partition) {
              throw new Error('Snapshot file ownership mismatch.');
            }
            store.root.work.opens++;
            const handle = await open(
              store.root.resolve(output),
              constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                (constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              let bytes = 0;
              for await (const chunk of phase.read(input, expected, signal)) {
                signal.throwIfAborted();
                await handle.writeFile(chunk);
                bytes += chunk.length;
                store.root.work.writeBytes += chunk.length;
              }
              if (BigInt(bytes) !== BigInt(expected[5])) {
                throw new Error('Snapshot copy length mismatch.');
              }
              await handle.chmod(expected[6] & 0o777);
              store.root.work.modeChanges++;
              await handle.utimes(Number(expected[7]) / 1e9, Number(expected[8]) / 1e9);
              store.root.work.stats++;
              const native = nativeIdentity(await handle.stat({ bigint: true }));
              if (native[3] !== store.root.binding[3] || BigInt(native[5]) !== BigInt(bytes)) {
                throw new Error('Invalid copied snapshot native output.');
              }
              await handle.close();
              await accept(['file', path, native]);
            } finally {
              await handle.close();
            }
          } else {
            await phase.enter(input, expected);
            if (path) {
              await mkdir(store.root.resolve(output), { mode: 0o700 });
              store.root.work.directoryCreations++;
            }
            const created = (await store.root.stat(output))!;
            await accept(['dir-open', path, created]);
            for await (const edge of source.children(node)) {
              if (edge[1] === 'file') {
                await visit(edge[2]);
              }
            }
            for await (const edge of source.children(node)) {
              if (edge[1] === 'directory') {
                await visit(edge[2]);
              }
            }
            await phase.leave(input, expected);
            await chmod(store.root.resolve(output), expected[6] & 0o777);
            store.root.work.modeChanges++;
            await accept(['dir-close', path, (await store.root.stat(output))!]);
          }
        } finally {
          lease.release();
        }
      }
      await visit(root, true);
    });
  }

  static empty(
    store: OwnedStore,
    partition: string,
    origin: SnapshotDescriptor[4],
    options: NativeOperationOptions,
  ) {
    return MetadataSnapshot.produce(store, partition, origin, options, async (target, accept) => {
      const native = (await store.root.stat(target))!;
      await accept(['dir-open', '', native]);
      await accept(['dir-close', '', native]);
    });
  }

  private static async produce(
    store: OwnedStore,
    partition: string,
    origin: SnapshotDescriptor[4],
    options: NativeOperationOptions,
    produce: (target: string, accept: (value: Value) => Promise<void>) => Promise<void>,
  ): Promise<MetadataSnapshot> {
    if (
      store.codec.options.model.partitions.find((p) => p[0] === partition)?.[3] !== 'single-writer'
    ) {
      throw new Error('Independent snapshot requires authoritative partition.');
    }
    options = Object.freeze({ ...options });
    const signal = options.signal ?? new AbortController().signal,
      parent = cacheInvocationSnapshotPrefix(store.codec.options.invocation) + randomUUID(),
      target = parent + '/' + partition;
    let owner: NativeIdentity | null = null,
      scratch: InstallScratch | undefined;
    try {
      await store.makeParents(target + '/pending');
      owner = await store.root.stat(parent);
      scratch = await InstallScratch.create(store, options.budget);
      let ordinal = 0,
        payloadBytes = 0;
      const index = await buildObservedInstallIndex(
        scratch,
        store.codec.options.model,
        partition,
        signal,
        async (accept) => {
          await produce(target, async (value) => {
            const row = value as Value[];
            if (row[0] === 'file') {
              payloadBytes = add(payloadBytes, Number((row[2] as NativeIdentity)[5]));
            }
            await accept({ value, start: ordinal, end: ++ordinal, record: ordinal });
          });
        },
      );
      await scratch.flush();
      const rootNative = (await store.root.stat(target))!,
        parentNative = (await store.root.stat(parent))!;
      const descriptor = handoffSchemas(store.codec).snapshot.parse([
        'snapshot',
        target,
        parentNative,
        rootNative,
        origin,
      ]);
      signal.throwIfAborted();
      return new MetadataSnapshot(
        store,
        partition,
        target,
        scratch,
        index,
        options,
        descriptor,
        payloadBytes,
      );
    } catch (error) {
      await settleNativeCleanup(
        [
          () => scratch?.close(),
          async () => {
            if (owner) {
              await retireOwnedDirectory(store, parent, owner, options.budget);
            } else if (await store.root.stat(parent)) {
              throw new Error('Unresolved snapshot copy retained at ' + store.root.resolve(parent));
            }
          },
        ],
        error,
      );
      throw error;
    }
  }

  /** Current handoff cleanup only: checks exact private endpoints, grants no source/index authority. */
  static async retireHandoff(
    store: OwnedStore,
    supplied: SnapshotDescriptor,
    options: NativeOperationOptions,
  ): Promise<void> {
    const descriptor = handoffSchemas(store.codec).snapshot.parse(supplied),
      parent = parentPath(descriptor[1]);
    options.signal?.throwIfAborted();
    await store.root.parents(parent);
    const actualParent = await store.root.stat(parent),
      actualRoot = await store.root.stat(descriptor[1]);
    if (
      !actualParent ||
      !actualRoot ||
      !sameObject(actualParent, descriptor[2]) ||
      actualParent[6] !== descriptor[2][6] ||
      !sameNative(actualRoot, descriptor[3], true)
    ) {
      throw new Error(
        'Snapshot cleanup ownership changed; retained at ' + store.root.resolve(parent),
      );
    }
    options.signal?.throwIfAborted();
    await retireOwnedDirectory(store, parent, descriptor[2], options.budget);
  }

  /** Fresh post admission of the actual independent root; descriptor bits grant no source capability. */
  static async admit(
    store: OwnedStore,
    supplied: SnapshotDescriptor,
    options: NativeOperationOptions,
  ): Promise<MetadataSnapshot> {
    const descriptor = handoffSchemas(store.codec).snapshot.parse(supplied),
      nativeRoot = descriptor[1],
      partition = nativeRoot.slice(nativeRoot.lastIndexOf('/') + 1),
      signal = options.signal ?? new AbortController().signal,
      scratch = await InstallScratch.create(store, options.budget);
    try {
      const endpoint = async () => {
        const parent = await store.root.stat(parentPath(nativeRoot)),
          root = await store.root.stat(nativeRoot);
        if (
          !parent ||
          !root ||
          !sameObject(parent, descriptor[2]) ||
          parent[6] !== descriptor[2][6] ||
          !sameNative(root, descriptor[3], true)
        ) {
          throw new Error('Persisted snapshot root/parent changed.');
        }
      };
      await endpoint();
      let ordinal = 0,
        payloadBytes = 0;
      const index = await buildObservedInstallIndex(
        scratch,
        store.codec.options.model,
        partition,
        signal,
        async (accept) => {
          for await (const event of walkNative(store.root, nativeRoot, {
            ...options,
            logicalRoot: '',
            metadata: 'reject',
          })) {
            if (
              event.tag === 'protected-child' ||
              event.identity[3] !== store.root.binding[3] ||
              (event.tag === 'file' && event.links !== '1')
            ) {
              throw new Error('Invalid independent snapshot native member.');
            }
            if (event.tag === 'file') {
              if (store.codec.options.model.owner(event.path)[0] !== partition) {
                throw new Error('Independent snapshot partition mismatch.');
              }
              payloadBytes = add(payloadBytes, Number(event.identity[5]));
            }
            const value: Value = [
              event.tag === 'file'
                ? 'file'
                : event.tag === 'directory-open'
                  ? 'dir-open'
                  : 'dir-close',
              event.path,
              event.identity,
            ];
            await accept({ value, start: ordinal, end: ++ordinal, record: ordinal });
          }
        },
      );
      await scratch.flush();
      await endpoint();
      signal.throwIfAborted();
      return new MetadataSnapshot(
        store,
        partition,
        nativeRoot,
        scratch,
        index,
        Object.freeze({ ...options }),
        descriptor,
        payloadBytes,
      );
    } catch (error) {
      await settleNativeCleanup([() => scratch.close()], error);
      throw error;
    }
  }

  async retire(): Promise<void> {
    if (this.#retired) {
      return;
    }
    if (this.#borrowers) {
      throw new Error('Independent snapshot hierarchy still borrowed.');
    }
    await settleNativeCleanup([
      () => this.dispose(),
      () =>
        retireOwnedDirectory(
          this.store,
          parentPath(this.nativeRoot),
          this.descriptor[2],
          this.options.budget,
        ),
    ]);
    this.#retired = true;
  }

  async dispose(): Promise<void> {
    if (this.#borrowers) {
      throw new Error('Independent snapshot hierarchy still borrowed.');
    }
    if (!this.#active) {
      return;
    }
    this.#active = false;
    await this.scratch.close();
  }
}
