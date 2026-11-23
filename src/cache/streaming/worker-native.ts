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

import type { OwnedStore } from './owned-store';
import { InstallScratch } from './install-scratch';
import { buildObservedInstallIndex, indexedNode, indexedEntries } from './install-index';
import { WorkerStage, type StagedPartition } from './worker-stage';
import { walkNative } from './native-walk';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { tuple, type Value } from './encoding';
import type { WorkingBudget } from './tree-state';
import { assertCompletedWorkerInputs, type WorkerMergeResult } from './worker-merge';

async function* workerNativeRows(
  store: OwnedStore,
  part: StagedPartition,
  budget: WorkingBudget,
  signal: AbortSignal,
  maxDirectoryEntries: number,
  renamed: boolean,
): AsyncGenerator<Value> {
  const files = part.facts.rows(signal)[Symbol.asyncIterator](),
    directories = part.directories.rows(signal)[Symbol.asyncIterator]();
  const retire = async () => {
    const settled = await Promise.allSettled([
        files.return?.(undefined),
        directories.return?.(undefined),
      ]),
      errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Worker evidence reader cleanup failed.',
      );
  };
  try {
    for await (const e of walkNative(store.root, part.nativeRoot, {
      budget,
      signal,
      maxDirectoryEntries,
      logicalRoot: '',
      metadata: 'reject',
    })) {
      if (e.tag === 'protected-child')
        throw new Error('Protected child in selected worker staging.');
      if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
        throw new Error('Aliased/cross-filesystem selected staging.');
      if (e.tag === 'directory-open') yield ['directory', e.path, e.identity];
      else if (e.tag === 'directory-close') {
        const next = await directories.next();
        if (next.done) throw new Error('Extra native worker directory.');
        const fact = tuple(next.value);
        if (
          fact[1] !== e.path ||
          !(renamed && e.path === ''
            ? sameRename(fact[2] as NativeIdentity, e.identity)
            : sameNative(fact[2] as NativeIdentity, e.identity, true))
        )
          throw new Error('Selected worker directory changed.');
        yield ['dir-close', e.path, e.identity];
      } else {
        if (e.tag !== 'file') throw new Error('Unexpected selected snapshot event.');
        const next = await files.next();
        if (next.done) throw new Error('Extra native worker file.');
        const fact = tuple(next.value);
        if (
          fact[1] !== e.path ||
          fact[2] !== part.partition ||
          !sameNative(fact[3] as NativeIdentity, e.identity, true)
        )
          throw new Error('Selected worker file changed.');
        yield ['file', e.path, e.identity];
      }
    }
    if (!(await files.next()).done || !(await directories.next()).done)
      throw new Error('Missing selected worker native member.');
  } finally {
    await retire();
  }
}

const nativeIndexes = new WeakSet<WorkerNativeIndex>();
/** Generic final-native acceptance; only claimWorker can grant completed-input provenance. */
export class WorkerNativeIndex {
  #active = true;
  #transferred = false;
  private constructor(
    readonly store: OwnedStore,
    readonly scratch: InstallScratch,
    readonly budget: WorkingBudget,
    readonly maxDirectoryEntries: number,
    private readonly sources: readonly { part: StagedPartition; index: number }[],
  ) {
    nativeIndexes.add(this);
  }
  static assert(source: WorkerNativeIndex, store = source.store): void {
    if (!nativeIndexes.has(source) || !source.#active || source.store !== store)
      throw new Error('Unavailable final worker native index.');
  }
  get partitions(): readonly string[] {
    WorkerNativeIndex.assert(this);
    return this.sources.map((s) => s.part.partition);
  }
  root(partition: string): number {
    WorkerNativeIndex.assert(this);
    const source = this.sources.find((s) => s.part.partition === partition);
    if (!source) throw new Error('Unknown final native partition.');
    return source.index;
  }
  nativeRoot(partition: string): string {
    WorkerNativeIndex.assert(this);
    const source = this.sources.find((s) => s.part.partition === partition);
    if (!source) throw new Error('Unknown final native partition.');
    return source.part.nativeRoot;
  }
  node(offset: number) {
    WorkerNativeIndex.assert(this);
    return indexedNode(this.scratch, offset);
  }
  children(node: Parameters<typeof indexedEntries>[1]) {
    WorkerNativeIndex.assert(this);
    return indexedEntries(this.scratch, node);
  }
  static async capture(
    store: OwnedStore,
    parts: readonly StagedPartition[],
    budget: WorkingBudget,
    signal: AbortSignal,
    maxDirectoryEntries = 100000,
  ): Promise<WorkerNativeIndex> {
    if (
      parts.length > store.codec.options.model.partitions.length ||
      new Set(parts.map((p) => p.partition)).size !== parts.length
    )
      throw new Error('Duplicate/unbounded final native partitions.');
    const scratch = await InstallScratch.create(store, budget),
      sources: { part: StagedPartition; index: number }[] = [];
    try {
      for (const part of parts) {
        let ordinal = 0;
        const index = await buildObservedInstallIndex(
          scratch,
          store.codec.options.model,
          part.partition,
          signal,
          async (accept) => {
            for await (const value of workerNativeRows(
              store,
              part,
              budget,
              signal,
              maxDirectoryEntries,
              true,
            )) {
              const row = tuple(value);
              // Delta SHA has completed its verification/conflict consumer; the
              // installer/activity hierarchy carries only final native facts.
              const metadata = row[0] === 'file' ? row.slice(0, 3) : value;
              await accept({ value: metadata, start: ordinal, end: ++ordinal, record: ordinal });
            }
          },
        );
        sources.push({ part, index });
      }
      await scratch.flush();
      signal.throwIfAborted();
      return new WorkerNativeIndex(store, scratch, budget, maxDirectoryEntries, sources);
    } catch (error) {
      try {
        await scratch.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Final native index cleanup failed.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
  static claimWorker(
    source: WorkerNativeIndex,
    store: OwnedStore,
    result: WorkerMergeResult,
    budget: WorkingBudget,
    max: number,
    signal: AbortSignal,
  ) {
    WorkerNativeIndex.assert(source, store);
    signal.throwIfAborted();
    const completed = assertCompletedWorkerInputs(store, result);
    if (
      source.budget !== budget ||
      source.maxDirectoryEntries !== max ||
      completed.max !== max ||
      result.stage.budget !== budget
    )
      throw new Error('Final worker index policy mismatch.');
    for (const { part } of source.sources)
      WorkerStage.assertPublishedInstall(result.stage, store, part);
    source.#active = false;
    source.#transferred = true;
    return {
      scratch: source.scratch,
      parts: source.sources.map(({ part, index }) => ({
        partition: part.partition,
        nativeRoot: part.nativeRoot,
        index,
      })),
    };
  }
  async dispose(): Promise<void> {
    this.#active = false;
    if (!this.#transferred) await this.scratch.close();
  }
}
