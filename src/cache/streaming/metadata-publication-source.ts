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

import { encodeRecord } from './encoding';
import type { OwnedStore } from './owned-store';
import { InstallScratch } from './install-scratch';
import {
  buildObservedInstallIndex,
  indexedEntries,
  indexedNode,
  nodeMask,
  partitionBit,
  type IndexedNode,
} from './install-index';
import type { IndexedMetadataInput } from './metadata-install-context';
import { DiscoveredMetadataBase, type MetadataDiscoveryOptions } from './metadata-base-source';
import { walkNative } from './native-walk';
import { assertMetadataModel } from './metadata-base-records';
import { PartitionMetadataSummary, type PartitionMetadata } from './partition-metadata';
import type { NativeIdentity } from './native';
import { GcSurvivorOwner } from './gc-execute';
import { MetadataSnapshot } from './metadata-snapshot';
import type { ObservedDirectory } from './observation-index';

type PublicationNodeLease = Awaited<ReturnType<typeof indexedNode>> & {
  orderedChildren?: () => ReturnType<typeof indexedEntries>;
};

interface PublicationHierarchy {
  assert(): void;
  node(offset: number): Promise<PublicationNodeLease>;
  children(node: IndexedNode): ReturnType<typeof indexedEntries>;
  release(): void;
}

const sources = new WeakSet<MetadataPublicationSource>();
/** Staged, operation-local source. LS4 supplies its genuine survivor owner to this same index seam. */
export class MetadataPublicationSource {
  #active = true;
  #claimed = false;
  #leased = false;
  readonly #releaseMetadata: () => void;
  private constructor(
    readonly store: OwnedStore,
    readonly nativeRoot: string,
    private readonly scratch: InstallScratch | null,
    readonly index: number,
    readonly options: MetadataDiscoveryOptions,
    private readonly metadata: ReadonlyMap<string, PartitionMetadata>,
    private readonly borrowed: IndexedMetadataInput | null,
    private readonly hierarchy: PublicationHierarchy | null = null,
  ) {
    this.#releaseMetadata = options.budget.holdRecord(
      1024 + encodeRecord([...metadata.values()]).length * 4,
    );
    sources.add(this);
    Object.freeze(this);
  }
  assert(): void {
    if (!sources.has(this) || !this.#active)
      throw new Error('Closed/unbound metadata publication source.');
    this.hierarchy?.assert();
    if (this.borrowed) {
      this.borrowed.assertBound(this.store);
      if (this.borrowed.upstream.kind !== 'native-metadata')
        throw new Error('Expected native source.');
      DiscoveredMetadataBase.assertReceipt(this.borrowed.upstream.source, this.store);
    }
  }
  claim(): void {
    this.assert();
    if (this.#claimed) throw new Error('Metadata publication source already attempted.');
    this.#claimed = true;
    this.#leased = true;
  }
  release(): void {
    this.#leased = false;
  }
  summary(partition: string): PartitionMetadata {
    this.assert();
    const value = this.metadata.get(partition);
    if (!value) throw new Error('Unavailable metadata source partition.');
    return structuredClone(value);
  }
  /** Active hierarchy view. A future genuine survivor owner adapts these reads without a new catalogue. */
  node(offset: number): ReturnType<typeof indexedNode> {
    this.assert();
    return this.hierarchy ? this.hierarchy.node(offset) : indexedNode(this.scratch!, offset);
  }
  children(node: IndexedNode): ReturnType<typeof indexedEntries> {
    this.assert();
    return this.hierarchy ? this.hierarchy.children(node) : indexedEntries(this.scratch!, node);
  }
  /** Borrow only the exact live native input; decoded refs/index offsets grant no authority. */
  static borrow(input: IndexedMetadataInput): MetadataPublicationSource {
    input.assertBound(input.context.store);
    if (input.upstream.kind !== 'native-metadata')
      throw new Error('Expected admitted native metadata.');
    const source = input.upstream.source;
    DiscoveredMetadataBase.assertReceipt(source, input.context.store);
    if (source.nativeRoot !== input.nativeRoot || source.partition !== input.partition)
      throw new Error('Metadata source root/partition mismatch.');
    return new MetadataPublicationSource(
      input.context.store,
      input.nativeRoot,
      input.context.scratch,
      input.index,
      Object.freeze({
        budget: input.context.budget,
        maxDirectoryEntries: input.context.maxDirectoryEntries,
      }),
      new Map([[input.partition, source.summary]]),
      input,
    );
  }
  /** The copied or freshly admitted independent root retains its original index owner. */
  static async snapshot(snapshot: MetadataSnapshot): Promise<MetadataPublicationSource> {
    MetadataSnapshot.assertReceipt(snapshot, snapshot.store, snapshot.partition);
    const release = snapshot.borrow();
    const hierarchy: PublicationHierarchy = {
      assert: () => MetadataSnapshot.assertReceipt(snapshot, snapshot.store, snapshot.partition),
      release,
      node: (offset) => snapshot.node(offset),
      children: (node) => snapshot.children(node),
    };
    try {
      const metadata = await foldMetadata(
        snapshot.store,
        snapshot.options,
        snapshot.index,
        hierarchy,
      );
      return new MetadataPublicationSource(
        snapshot.store,
        snapshot.nativeRoot,
        null,
        snapshot.index,
        snapshot.options,
        metadata,
        null,
        hierarchy,
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Borrow actual completed GC outcomes without rebuilding the original hierarchy. */
  static async survivors(owner: GcSurvivorOwner): Promise<MetadataPublicationSource> {
    GcSurvivorOwner.assertReceipt(owner);
    const index = owner.index,
      release = owner.borrow(),
      store = index.store;
    async function* survivingChildren(node: ObservedDirectory): ReturnType<typeof indexedEntries> {
      GcSurvivorOwner.assertReceipt(owner);
      for await (const edge of index.children(node)) {
        GcSurvivorOwner.assertReceipt(owner);
        if (edge[5] !== null && !edge[6]) yield [edge[1], edge[2] as IndexedNode[1], edge[5]];
      }
    }
    const hierarchy: PublicationHierarchy = {
      assert: () => owner.assert(),
      release,
      async node(offset) {
        GcSurvivorOwner.assertReceipt(owner);
        const lease = await index.node(offset);
        try {
          const observed = lease.node;
          let node: IndexedNode;
          if (observed[0] === 'observed-file') {
            if (observed[5] === 'delete') throw new Error('Deleted survivor file.');
            node = [
              'node',
              'file',
              observed[1],
              observed[2],
              null,
              partitionBit(store.codec.options.model, observed[3]).toString(16),
              0,
              0,
              0,
              observed[6],
              observed[7],
            ];
          } else {
            if (observed[10][5]) throw new Error('Deleted survivor directory.');
            node = [
              'node',
              'directory',
              observed[1],
              (await owner.changedDirectoryNative(observed[1])) ?? observed[2],
              null,
              observed[10][3],
              observed[10][4],
              offset,
              offset,
              observed[5],
              observed[6],
            ];
          }
          const uncharge = index.options.budget.holdRecord(256 + encodeRecord(node).length * 4);
          return {
            node,
            // The strict observation writer admits non-directory children before directories.
            orderedChildren:
              observed[0] === 'observed-directory' ? () => survivingChildren(observed) : undefined,
            release: () => {
              uncharge();
              lease.release();
            },
          };
        } catch (error) {
          lease.release();
          throw error;
        }
      },
      async *children(node) {
        GcSurvivorOwner.assertReceipt(owner);
        if (node[1] !== 'directory') return;
        const lease = await index.node(node[7]);
        try {
          if (lease.node[0] !== 'observed-directory' || lease.node[1] !== node[2])
            throw new Error('Survivor directory cursor mismatch.');
          yield* survivingChildren(lease.node);
        } finally {
          lease.release();
        }
      },
    };
    try {
      const metadata = await foldMetadata(store, index.options, index.root, hierarchy);
      return new MetadataPublicationSource(
        store,
        '',
        null,
        index.root,
        index.options,
        metadata,
        null,
        hierarchy,
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Real initial native discovery for independent source producers; never recapture a post survivor view. */
  static async capture(
    store: OwnedStore,
    nativeRoot: string,
    options: MetadataDiscoveryOptions,
  ): Promise<MetadataPublicationSource> {
    assertMetadataModel(store.codec.options.model);
    options = Object.freeze({ ...options });
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const scratch = await InstallScratch.create(store, options.budget);
    try {
      let ordinal = 0;
      const index = await buildObservedInstallIndex(
        scratch,
        store.codec.options.model,
        null,
        signal,
        async (accept) => {
          for await (const e of walkNative(store.root, nativeRoot, {
            ...options,
            logicalRoot: '',
            metadata: 'exclude',
          })) {
            if (e.tag === 'protected-child')
              throw new Error('Unexpected protected publication source.');
            if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
              throw new Error('Aliased/cross-filesystem publication source.');
            await accept({
              value: [
                e.tag === 'file' ? 'file' : e.tag === 'directory-open' ? 'dir-open' : 'dir-close',
                e.path,
                e.identity,
              ],
              start: ordinal,
              end: ++ordinal,
              record: ordinal,
            });
          }
        },
      );
      await scratch.flush();
      const metadata = await foldMetadata(store, options, index, {
        assert() {},
        release() {},
        node: (offset) => indexedNode(scratch, offset),
        children: (node) => indexedEntries(scratch, node),
      });
      signal.throwIfAborted();
      return new MetadataPublicationSource(
        store,
        nativeRoot,
        scratch,
        index,
        options,
        metadata,
        null,
      );
    } catch (error) {
      try {
        await scratch.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Metadata source cleanup failed.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
  async dispose(): Promise<void> {
    if (this.#leased) throw new Error('Publication source has an active SDK/move lifetime.');
    if (!this.#active) return;
    this.#active = false;
    this.#releaseMetadata();
    this.hierarchy?.release();
    if (!this.borrowed && this.scratch) await this.scratch.close();
  }
}

async function foldMetadata(
  store: OwnedStore,
  options: MetadataDiscoveryOptions,
  root: number,
  hierarchy: PublicationHierarchy,
): Promise<ReadonlyMap<string, PartitionMetadata>> {
  const summaries = new Map(
    store.codec.options.model.partitions.map((p) => [
      p[0],
      new PartitionMetadataSummary(
        store.codec.options.model,
        p[0],
        options.budget,
        undefined,
        options.maxDirectoryEntries,
      ),
    ]),
  );
  async function visit(offset: number, physicalRoot = false): Promise<void> {
    options.signal?.throwIfAborted();
    hierarchy.assert();
    const lease = await hierarchy.node(offset);
    let releaseFrame = () => {};
    try {
      const node = lease.node,
        mask = nodeMask(node),
        selected = [...summaries].filter(
          ([p]) => physicalRoot || (mask & partitionBit(store.codec.options.model, p)) !== 0n,
        );
      releaseFrame = options.budget.holdRecord(128 + selected.length * 64);
      if (node[1] === 'file') {
        for (const [, summary] of selected)
          summary.accept(['file', node[2], node[3] as NativeIdentity]);
      } else if (node[1] === 'directory') {
        for (const [, summary] of selected)
          summary.accept(['dir-open', node[2], node[3] as NativeIdentity]);
        if (lease.orderedChildren) {
          for await (const edge of lease.orderedChildren()) await visit(edge[2]);
        } else {
          for await (const edge of hierarchy.children(node))
            if (edge[1] === 'file') await visit(edge[2]);
          for await (const edge of hierarchy.children(node))
            if (edge[1] === 'directory') await visit(edge[2]);
        }
        for (const [, summary] of selected)
          summary.accept(['dir-close', node[2], node[3] as NativeIdentity]);
      }
    } finally {
      releaseFrame();
      lease.release();
    }
  }
  try {
    await visit(root, true);
    return new Map([...summaries].map(([p, summary]) => [p, summary.finish()]));
  } finally {
    for (const summary of summaries.values()) summary.dispose();
  }
}

const sets = new WeakSet<MetadataPublicationSet>();
/** Genuine source selection only. LS4 binds its survivor owner and independent snapshot owners here. */
export class MetadataPublicationSet {
  #claimed = false;
  readonly store: OwnedStore;
  readonly options: MetadataDiscoveryOptions;
  private constructor(private readonly selected: ReadonlyMap<string, MetadataPublicationSource>) {
    const first = selected.values().next().value!;
    this.store = first.store;
    const signals = [
      ...new Set(
        [...selected.values()].map((s) => s.options.signal).filter((s): s is AbortSignal => !!s),
      ),
    ];
    this.options = Object.freeze({
      ...first.options,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
    sets.add(this);
    Object.freeze(this);
  }
  static select(
    live: MetadataPublicationSource,
    overrides: readonly (readonly [string, MetadataPublicationSource])[] = [],
  ): MetadataPublicationSet {
    live.assert();
    if (
      overrides.length > live.store.codec.options.model.partitions.length ||
      new Set(overrides.map((p) => p[0])).size !== overrides.length
    )
      throw new Error('Duplicate/unbounded metadata source overrides.');
    const selected = new Map(live.store.codec.options.model.partitions.map((p) => [p[0], live]));
    for (const [p, source] of overrides) {
      source.assert();
      const partition = live.store.codec.options.model.partitions.find((part) => part[0] === p);
      if (
        partition?.[3] !== 'single-writer' ||
        source.store !== live.store ||
        source.options.budget !== live.options.budget ||
        (source.options.maxDirectoryEntries ?? 100000) !==
          (live.options.maxDirectoryEntries ?? 100000)
      )
        throw new Error('Snapshot source owner/model/policy mismatch.');
      source.summary(p);
      selected.set(p, source);
    }
    for (const [p, source] of selected) source.summary(p);
    return new MetadataPublicationSet(selected);
  }
  assert(): void {
    if (!sets.has(this)) throw new Error('Unbound metadata source set.');
    for (const source of new Set(this.selected.values())) source.assert();
  }
  components(): readonly {
    readonly source: MetadataPublicationSource;
    readonly partitions: readonly string[];
  }[] {
    this.assert();
    const components = new Map<MetadataPublicationSource, string[]>();
    for (const [p, source] of this.selected) {
      let partitions = components.get(source);
      if (!partitions) components.set(source, (partitions = []));
      partitions.push(p);
    }
    return [...components].map(([source, partitions]) => ({ source, partitions }));
  }
  summary(partition: string): PartitionMetadata {
    if (!sets.has(this)) throw new Error('Unbound metadata source set.');
    const source = this.selected.get(partition);
    if (!source) throw new Error('Missing selected partition source.');
    return source.summary(partition);
  }
  assertPartition(partition: string): void {
    if (!sets.has(this)) throw new Error('Unbound metadata source set.');
    const source = this.selected.get(partition);
    if (!source) throw new Error('Missing selected partition source.');
    source.assert();
  }
  claim(): void {
    this.assert();
    if (this.#claimed) throw new Error('Metadata publication source set already attempted.');
    this.#claimed = true;
    const claimed: MetadataPublicationSource[] = [];
    try {
      for (const source of new Set(this.selected.values())) {
        source.claim();
        claimed.push(source);
      }
    } catch (error) {
      for (const source of claimed) source.release();
      throw error;
    }
  }
  release(): void {
    for (const source of new Set(this.selected.values())) source.release();
  }
}
