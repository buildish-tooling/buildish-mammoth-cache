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

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { add, encodeRecord, equal, type Value } from './encoding';
import { DiscoveredMetadataBase, type MetadataDiscoveryOptions } from './metadata-base-source';
import { decodeMetadataGeneration, type MetadataGeneration } from './metadata-base-records';
import { InstallScratch } from './install-scratch';
import {
  buildObservedInstallIndex,
  indexedEntries,
  indexedNode,
  IndexDirectories,
  nodeHasDirectFiles,
  nodeMask,
  partitionBit,
  type IndexedNode,
} from './install-index';
import { RecoveryGroups } from './native-records';
import type { NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';
import { compareMembership, type WorkingBudget } from './tree-state';
import { retireOwnedDirectory } from './owned-retirement';

export type MetadataMember = readonly [
  'metadata-member',
  string,
  'source' | 'current',
  string,
  number,
];
import { WorkerNativeIndex } from './worker-native';
import type { WorkerMergeResult } from './worker-merge';

const contexts = new WeakSet<MetadataInstallContext>();
const inputs = new WeakSet<IndexedMetadataInput>();
/** Only the active index is retained. A selector is not a disk reference or a native capability. */
export class MetadataMemberReader {
  private readonly directories: IndexDirectories;
  constructor(
    readonly context: MetadataInstallContext,
    readonly side: 'source' | 'current',
    readonly partition: string,
    readonly root: number,
  ) {
    this.directories = new IndexDirectories(context.scratch, root);
  }
  async rootNode(
    binding: Value,
    path: string,
    kind: 'file' | 'directory' | null,
  ): Promise<IndexedNode> {
    const selector = this.context.parse(binding, this.side, this.partition);
    const lease = await indexedNode(this.context.scratch, selector[4]);
    try {
      const node = lease.node;
      if (
        (node[1] !== 'file' && node[1] !== 'directory') ||
        node[2] !== path ||
        (kind !== null && node[1] !== kind)
      )
        throw new Error('Wrong metadata member path/kind.');
      if (
        node[6] !== 0 ||
        nodeMask(node) !== partitionBit(this.context.store.codec.options.model, this.partition)
      )
        throw new Error('Metadata member crosses ownership.');
      const expected = await this.directories.member(path);
      if (!expected) throw new Error('Metadata selector outside its original index.');
      try {
        equal(node, expected.node, 'metadata index member');
      } finally {
        expected.release();
      }
      this.context.work.rootSelections++;
      return structuredClone(node);
    } finally {
      lease.release();
    }
  }
  async member(
    binding: Value,
    path: string,
    kind: 'file' | 'directory' | null,
    visit: (row: Value, signal: AbortSignal) => Promise<void>,
    signal = new AbortController().signal,
  ): Promise<'file' | 'directory'> {
    const node = await this.rootNode(binding, path, kind),
      selector = this.context.parse(binding, this.side, this.partition);
    await this.visit(selector[4], visit, signal);
    return node[1] as 'file' | 'directory';
  }
  private async visit(
    offset: number,
    accept: (row: Value, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    this.context.assert(this.context.store);
    signal.throwIfAborted();
    const lease = await indexedNode(this.context.scratch, offset);
    try {
      const node = lease.node;
      if (
        node[6] !== 0 ||
        nodeMask(node) !== partitionBit(this.context.store.codec.options.model, this.partition) ||
        (node[1] !== 'file' && node[1] !== 'directory')
      )
        throw new Error('Metadata member crosses ownership.');
      this.context.work.memberRows++;
      await accept([node[1] === 'file' ? 'file' : 'directory', node[2], node[3]], signal);
      if (node[1] === 'directory')
        for (const kind of ['file', 'directory'])
          for await (const edge of indexedEntries(this.context.scratch, node))
            if (edge[1] === kind) await this.visit(edge[2], accept, signal);
    } finally {
      lease.release();
    }
  }
  async directoryNative(path: string): Promise<NativeIdentity | null> {
    this.context.assert(this.context.store);
    const node = await this.directories.directory(path);
    return node ? (structuredClone(node[3]) as NativeIdentity) : null;
  }
  close() {
    this.directories.close();
  }
}
/** Genuine one-phase incoming metadata, with no evidence file or invented hash. */
export class IndexedMetadataInput {
  readonly origin = 'indexed-metadata';
  private constructor(
    readonly context: MetadataInstallContext,
    readonly partition: string,
    readonly nativeRoot: string,
    readonly index: number,
    readonly upstream:
      | { readonly kind: 'native-metadata'; readonly source: DiscoveredMetadataBase }
      | { readonly kind: 'verified-worker' }
      | { readonly kind: 'declared-empty' },
  ) {
    inputs.add(this);
  }
  static create(
    context: MetadataInstallContext,
    partition: string,
    nativeRoot: string,
    index: number,
    upstream: IndexedMetadataInput['upstream'],
  ) {
    context.assert(context.store);
    return new IndexedMetadataInput(context, partition, nativeRoot, index, upstream);
  }
  assertBound(store: OwnedStore): void {
    if (!inputs.has(this)) throw new Error('Unknown metadata input receipt.');
    this.context.assert(store);
    if (this.context.source(this.partition) !== this)
      throw new Error('Wrong metadata input context.');
  }
}
/** One operation, at most P source and P current readers; never a per-file resident map. */
export class MetadataInstallContext {
  readonly nonce = randomBytes(16).toString('hex');
  private active = true;
  private taken = false;
  private current: number | null = null;
  private readonly sources = new Map<string, IndexedMetadataInput>();
  private readonly readers = new Map<string, MetadataMemberReader>();
  private readonly discoveries: DiscoveredMetadataBase[] = [];
  private readonly empties: { path: string; native?: NativeIdentity }[] = [];
  private coldGroups: string[][] = [];
  get cold(): readonly (readonly string[])[] {
    return this.coldGroups.map((group) => [...group]);
  }
  readonly work = { rootSelections: 0, memberRows: 0, coordinateNodes: 0, coordinateEdges: 0 };
  private constructor(
    readonly store: OwnedStore,
    readonly scratch: InstallScratch,
    readonly budget: WorkingBudget,
    readonly maxDirectoryEntries: number,
  ) {
    contexts.add(this);
  }
  assert(store: OwnedStore) {
    if (!contexts.has(this) || !this.active || this.store !== store)
      throw new Error('Metadata install context is closed/unbound.');
  }
  source(partition: string): IndexedMetadataInput | undefined {
    return this.sources.get(partition);
  }
  take(): readonly IndexedMetadataInput[] {
    this.assert(this.store);
    if (this.taken) throw new Error('Metadata indexes already consumed.');
    this.taken = true;
    const cold = new Set(this.coldGroups.flat());
    return [...this.sources.values()].filter(
      (input) => !cold.has(input.partition) || input.upstream.kind === 'declared-empty',
    );
  }
  bindCurrent(root: number): void {
    this.assert(this.store);
    if (this.current !== null) throw new Error('Current index already bound.');
    this.current = root;
  }
  selector(side: 'source' | 'current', partition: string, offset: number): MetadataMember {
    this.assert(this.store);
    return ['metadata-member', this.nonce, side, partition, offset];
  }
  parse(binding: Value, side?: 'source' | 'current', partition?: string): MetadataMember {
    this.assert(this.store);
    const value = this.store.codec.schemas.installMember.parse(binding);
    if (
      value[0] !== 'metadata-member' ||
      value[1] !== this.nonce ||
      (side !== undefined && value[2] !== side) ||
      (partition !== undefined && value[3] !== partition)
    )
      throw new Error('Metadata member context/role/partition mismatch.');
    return value;
  }
  reader(binding: Value): MetadataMemberReader {
    const value = this.parse(binding),
      key = value[2] + ':' + value[3];
    let reader = this.readers.get(key);
    if (!reader) {
      const root = value[2] === 'current' ? this.current : this.sources.get(value[3])?.index;
      if (root === null || root === undefined) throw new Error('Missing original metadata index.');
      reader = new MetadataMemberReader(this, value[2], value[3], root);
      this.readers.set(key, reader);
    }
    return reader;
  }
  close(): void {
    if (!this.active) return;
    this.active = false;
    contexts.delete(this);
    for (const reader of this.readers.values()) reader.close();
    this.readers.clear();
    for (const discovery of this.discoveries) discovery.close();
    this.sources.clear();
  }
  async dispose(): Promise<void> {
    this.close();
    const results = await Promise.allSettled([
      this.scratch.close(),
      ...this.empties.map((empty) =>
        empty.native
          ? retireOwnedDirectory(this.store, empty.path, empty.native, this.budget)
          : (async () => {
              if (await this.store.root.stat(empty.path))
                throw new Error(
                  'Unresolved created empty root retained at ' +
                    this.store.root.resolve(empty.path),
                );
            })(),
      ),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((r) => r.reason),
        'Metadata context disposal failed.',
      );
    this.empties.length = 0;
  }
  static async empty(
    store: OwnedStore,
    options: MetadataDiscoveryOptions,
  ): Promise<MetadataInstallContext> {
    return new MetadataInstallContext(
      store,
      await InstallScratch.create(store, options.budget),
      options.budget,
      options.maxDirectoryEntries ?? 100000,
    );
  }
  /** Explicit missing/cold replacement policy, with real owned empty native bytes. */
  async declareEmpty(partition: string, signal = new AbortController().signal): Promise<void> {
    this.assert(this.store);
    if (this.taken) throw new Error('Metadata indexes already consumed.');
    this.store.codec.schemas.partition.parse(partition);
    if (this.sources.has(partition) && !this.coldGroups.some((group) => group.includes(partition)))
      throw new Error('Cannot replace available metadata source with empty.');
    const nativeRoot = this.store.prefix + 'base/' + randomUUID();
    await this.store.makeParents(nativeRoot);
    const pending: { path: string; native?: NativeIdentity } = { path: nativeRoot };
    this.empties.push(pending);
    signal.throwIfAborted();
    await mkdir(this.store.root.resolve(nativeRoot));
    const native = (await this.store.root.stat(nativeRoot))!;
    pending.native = native;
    const index = await buildObservedInstallIndex(
      this.scratch,
      this.store.codec.options.model,
      partition,
      signal,
      async (accept) => {
        await accept({ value: ['dir-open', '', native], start: 0, end: 1, record: 0 });
        await accept({ value: ['dir-close', '', native], start: 1, end: 2, record: 1 });
      },
    );
    this.sources.set(
      partition,
      IndexedMetadataInput.create(this, partition, nativeRoot, index, { kind: 'declared-empty' }),
    );
  }
  /** Transfers the same final producer index after activity/snapshot gates, never decoding an authorization flag. */
  static fromWorkerNative(
    store: OwnedStore,
    source: WorkerNativeIndex,
    result: WorkerMergeResult,
    options: MetadataDiscoveryOptions,
  ): MetadataInstallContext {
    const claimed = WorkerNativeIndex.claimWorker(
      source,
      store,
      result,
      options.budget,
      options.maxDirectoryEntries ?? 100000,
      options.signal ?? new AbortController().signal,
    );
    const context = new MetadataInstallContext(
      store,
      claimed.scratch,
      options.budget,
      options.maxDirectoryEntries ?? 100000,
    );
    for (const part of claimed.parts)
      context.sources.set(
        part.partition,
        IndexedMetadataInput.create(context, part.partition, part.nativeRoot, part.index, {
          kind: 'verified-worker',
        }),
      );
    return context;
  }
  /** Stage only: SDK extraction must complete before offering these immutable object roots. */
  static async discover(
    store: OwnedStore,
    supplied: MetadataGeneration,
    materialized: readonly { readonly partition: string; readonly root: string }[],
    options: MetadataDiscoveryOptions,
  ): Promise<MetadataInstallContext> {
    const generation = decodeMetadataGeneration(encodeRecord(supplied), store.codec.options.model);
    if (
      materialized.length > store.codec.options.model.partitions.length ||
      new Set(materialized.map((p) => p.partition)).size !== materialized.length
    )
      throw new Error('Duplicate/unbounded metadata sources.');
    for (const supplied of materialized)
      if (!generation[8].some((e) => e[0] === 'object' && e[1] === supplied.partition))
        throw new Error('Unknown/non-object materialized source.');
    const context = new MetadataInstallContext(
      store,
      await InstallScratch.create(store, options.budget),
      options.budget,
      options.maxDirectoryEntries ?? 100000,
    );
    const signal = options.signal ?? new AbortController().signal,
      available = new Set<string>();
    try {
      for (const entry of generation[8]) {
        const offered = materialized.find((p) => p.partition === entry[1]);
        if (entry[0] === 'object' && !offered) continue;
        let discovery: DiscoveredMetadataBase | undefined,
          ordinal = 0,
          nativeRoot = '';
        const index = await buildObservedInstallIndex(
          context.scratch,
          store.codec.options.model,
          entry[1],
          signal,
          async (accept) => {
            if (entry[0] === 'object') {
              discovery = await DiscoveredMetadataBase.discover(
                store,
                offered!.root,
                entry[2],
                options,
                async (row) => {
                  await accept({
                    value: row,
                    start: ordinal,
                    end: add(ordinal),
                    record: ordinal++,
                  });
                },
              );
              context.discoveries.push(discovery);
              nativeRoot = discovery.nativeRoot;
            } else {
              nativeRoot = store.prefix + 'base/' + randomUUID();
              await store.makeParents(nativeRoot);
              const pending: { path: string; native?: NativeIdentity } = { path: nativeRoot };
              context.empties.push(pending);
              await mkdir(store.root.resolve(nativeRoot));
              const native = (await store.root.stat(nativeRoot))!;
              pending.native = native;
              await accept({ value: ['dir-open', '', native], start: 0, end: 1, record: 0 });
              await accept({ value: ['dir-close', '', native], start: 1, end: 2, record: 1 });
            }
          },
          { trackDirectFiles: store.codec.options.model.tuple[2] === 'maven' },
        );
        context.sources.set(
          entry[1],
          IndexedMetadataInput.create(
            context,
            entry[1],
            nativeRoot,
            index,
            discovery ? { kind: 'native-metadata', source: discovery } : { kind: 'declared-empty' },
          ),
        );
        available.add(entry[1]);
      }
      const groups = await deriveMetadataGroups(context, signal);
      context.coldGroups = groups.check(generation[9], available);
      signal.throwIfAborted();
      return context;
    } catch (error) {
      try {
        await context.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Metadata admission/cleanup failed.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
}
/** Walk each existing index once, holding only directory depth and P coordinate heads. */
async function deriveMetadataGroups(
  context: MetadataInstallContext,
  signal: AbortSignal,
): Promise<RecoveryGroups> {
  const model = context.store.codec.options.model,
    groups = new RecoveryGroups(model);
  if (model.tuple[2] !== 'maven') return groups;
  async function* coordinates(offset: number): AsyncGenerator<string> {
    signal.throwIfAborted();
    const lease = await indexedNode(context.scratch, offset);
    try {
      context.work.coordinateNodes++;
      const node: IndexedNode = lease.node;
      if (node[1] !== 'directory') return;
      if (
        nodeHasDirectFiles(node) &&
        (node[2] === 'repository' || node[2].startsWith('repository/'))
      )
        yield node[2];
      for await (const edge of indexedEntries(context.scratch, node)) {
        context.work.coordinateEdges++;
        if (edge[1] === 'directory') yield* coordinates(edge[2]);
      }
    } finally {
      lease.release();
    }
  }
  const cursors: {
    partition: string;
    iterator: AsyncGenerator<string>;
    head: IteratorResult<string>;
  }[] = [];
  try {
    for (const partition of model.partitions) {
      const source = context.source(partition[0]);
      if (!source) continue;
      const iterator = coordinates(source.index);
      cursors.push({ partition: source.partition, iterator, head: await iterator.next() });
    }
    const compare = (a: string, b: string) =>
      compareMembership(['member', 'unit', a], ['member', 'unit', b]);
    while (cursors.some((c) => !c.head.done)) {
      signal.throwIfAborted();
      let root: string | undefined;
      for (const c of cursors)
        if (!c.head.done && (root === undefined || compare(c.head.value, root) < 0))
          root = c.head.value;
      const matching = cursors.filter((c) => !c.head.done && c.head.value === root);
      groups.observe(matching.map((c) => c.partition));
      for (const c of matching) c.head = await c.iterator.next();
    }
    return groups;
  } finally {
    for (const c of cursors) await c.iterator.return(undefined);
  }
}
