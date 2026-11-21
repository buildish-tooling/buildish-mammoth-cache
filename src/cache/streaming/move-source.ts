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

import { decodeRecords, equal, tuple, encodeRecord, type Value } from './encoding';
import type { ObservationIndex } from './observation-index';
import { type ObservedNode } from './observation-index';
import { FrozenBaseTree } from './base-frozen-tree';
import { compareMembership, normalizeMode } from './tree-state';
import { sameNative, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import type { OwnedStore, Reference } from './owned-store';

export interface MoveSourceBinding {
  readonly partition: string;
  readonly evidence: Reference;
  readonly tree: FrozenBaseTree;
  readonly owned: Reference | null;
}
export async function checkCompleteGc(index: ObservationIndex) {
  const { store } = index,
    state = store.codec.schemas.documents['local-state'].parse(await store.state());
  equal(state[6], index.reference, 'source original observation');
  if (!state[10]) throw new Error('Source has no completed GC cursor.');
  const p = store.codec.schemas.documents['gc-progress'].parse(
    await store.readDocument(state[10], 'gc-progress'),
  );
  equal(p[3], index.reference, 'source GC observation');
  equal(p[4], index.completed, 'complete source GC cursor');
  if (p[5] !== null || (await store.readFixed(store.prefix + 'gc-intent.json')))
    throw new Error('Source has active GC ownership.');
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans.
// Complete immutable native/tree correspondence and ORIGINAL observation identity,
// not current filesystem/return permission. All live source frontiers join in one
// global order; no partition repeatedly reloads full original directory pages.
export async function checkMoveSourceBindings(
  original: ObservationIndex,
  bindings: readonly MoveSourceBinding[],
  options: BaseObjectOptions,
) {
  const { store } = original,
    signal = options.signal ?? new AbortController().signal;
  if (bindings.length > store.codec.options.model.partitions.length)
    throw new Error('Move source frontier exceeded.');
  await checkCompleteGc(original);
  const cursors: {
      p: string;
      iterator: AsyncIterator<readonly Value[]>;
      head: IteratorResult<readonly Value[]>;
    }[] = [],
    owned: AsyncIterator<readonly Value[]>[] = [],
    live = new Set<string>(),
    walk = original.walk();
  let head: IteratorResult<ObservedNode> | undefined,
    failure: unknown,
    releasePrevious: () => void = () => {};
  const compare = (kind: string, path: string, n: ObservedNode) =>
    compareMembership(
      ['member', kind === 'file' ? 'file' : 'unit', path],
      ['member', n[0] === 'observed-file' ? 'file' : 'unit', n[1]],
    );
  const omitted = (n: ObservedNode) => {
    if (n[0] === 'observed-file' && n[6] === 'retain' && live.has(n[3]))
      throw new Error('Post-GC move source omits a retained file.');
  };
  try {
    for (const b of bindings) {
      FrozenBaseTree.assert(b.tree, store);
      equal(b.partition, b.tree.reference[1][2], 'source tree partition');
      const iterator = projection(store, b, options)[Symbol.asyncIterator]();
      if (b.owned) {
        equal(b.evidence, b.owned, 'exact committed owned source');
        owned.push(iterator);
      } else {
        if (
          store.codec.options.model.partitions.find((p) => p[0] === b.partition)?.[3] !==
            'aggregate' ||
          live.has(b.partition)
        )
          throw new Error('Invalid live move source.');
        live.add(b.partition);
        cursors.push({ p: b.partition, iterator, head: await iterator.next() });
      }
    }
    for (const iterator of owned) while (!(await iterator.next()).done) signal.throwIfAborted();
    head = await walk.next();
    let previous: readonly Value[] | null = null;
    while (true) {
      signal.throwIfAborted();
      let current: (typeof cursors)[number] | undefined;
      for (const c of cursors)
        if (
          !c.head.done &&
          (!current ||
            compareMembership(
              ['member', c.head.value[0] === 'file' ? 'file' : 'unit', c.head.value[1]],
              [
                'member',
                current.head.value![0] === 'file' ? 'file' : 'unit',
                current.head.value![1],
              ],
            ) < 0)
        )
          current = c;
      if (!current) break;
      const r = current.head.value!,
        path = String(r[1]);
      while (!head.done && compare(String(r[0]), path, head.value) > 0) {
        omitted(head.value);
        head = await walk.next();
      }
      if (head.done || compare(String(r[0]), path, head.value) !== 0)
        throw new Error('Move source contains a foreign original member.');
      const n = head.value,
        native = r[2] as NativeIdentity;
      if (n[0] === 'observed-file') {
        if (n[3] !== current.p || n[6] !== 'retain' || !sameNative(n[2], native, true))
          throw new Error('Move source rewrote original retained file evidence.');
      } else if (
        n[10][5] !== 0 ||
        !sameDirectoryObject(n[2], native) ||
        (n[10][6] === 0 && !sameNative(n[2], native, true))
      )
        throw new Error('Move source rewrote original directory evidence.');
      if (
        previous &&
        previous[0] === r[0] &&
        previous[1] === r[1] &&
        !sameNative(previous[2] as NativeIdentity, native, true)
      )
        throw new Error('Shared post-GC source directory baselines disagree.');
      // Retain only the duplicate directory's small N until the next frontier item.
      releasePrevious();
      releasePrevious = () => {};
      previous = r[0] === 'directory' ? ['directory', path, native] : null;
      if (previous) releasePrevious = options.budget.holdRecord(encodeRecord(previous).length);
      current.head = await current.iterator.next();
      const duplicates = cursors.some(
        (c) => !c.head.done && c.head.value[0] === r[0] && c.head.value[1] === path,
      );
      if (!duplicates) {
        previous = null;
        releasePrevious();
        releasePrevious = () => {};
        head = await walk.next();
      }
    }
    while (!head.done) {
      omitted(head.value);
      head = await walk.next();
    }
    for (const b of bindings) await b.tree.assertStable(options);
  } catch (e) {
    failure = e;
  }
  await settleBaseCleanup(
    [
      () => releasePrevious(),
      () => walk.return(undefined),
      ...cursors.map((c) => () => c.iterator.return?.()),
      ...owned.map((c) => () => c.return?.()),
    ],
    failure,
  );
  if (failure !== undefined) throw failure;
  signal.throwIfAborted();
}
async function* projection(
  store: OwnedStore,
  binding: MoveSourceBinding,
  options: BaseObjectOptions,
): AsyncGenerator<readonly Value[]> {
  const signal = options.signal ?? new AbortController().signal,
    portable = decodeRecords(store.read(binding.tree.tree, 'native-tree')),
    dirs: { path: string; release: () => void }[] = [];
  let end = false;
  const next = async () => {
    while (true) {
      signal.throwIfAborted();
      const f = await portable.next();
      if (f.done) return null;
      const r = tuple(f.value.value),
        release = options.budget.holdRecord(f.value.raw.length);
      if (r[0] === 'dir-open' || r[0] === 'file') return { r, release };
      try {
        if (r[0] === 'dir-close') {
          const d = dirs.pop();
          if (!d || d.path !== r[1]) throw new Error('Source portable stack mismatch.');
          d.release();
        }
        if (r[0] === 'end') end = true;
      } finally {
        release();
      }
    }
  };
  let failure: unknown;
  try {
    for await (const item of store.rows(
      binding.evidence,
      'native-evidence',
      { ...options, partition: binding.partition },
      signal,
    )) {
      const r = tuple(item.value);
      if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
      const p = await next();
      if (!p) throw new Error('Extra post-GC native source member.');
      try {
        if (r[0] === 'directory') {
          if (p.r[0] !== 'dir-open' || p.r[1] !== r[1])
            throw new Error('Post-GC source directory/tree mismatch.');
          dirs.push({
            path: String(r[1]),
            release: options.budget.holdRecord(512 + Buffer.byteLength(String(r[1]))),
          });
        } else {
          const parent = dirs[dirs.length - 1]?.path;
          if (
            parent === undefined ||
            p.r[0] !== 'file' ||
            (parent ? parent + '/' + p.r[1] : p.r[1]) !== r[1]
          )
            throw new Error('Post-GC source file/tree mismatch.');
          const n = r[2] as NativeIdentity;
          equal(
            [
              Number(n[5]),
              normalizeMode(store.codec.options.model.tuple[2], String(r[1]), n[6]),
              Number(BigInt(n[8]) / 1000000n),
              r[3],
            ],
            p.r.slice(2),
            'source native/hash portable correspondence',
          );
        }
      } finally {
        p.release();
      }
      yield r;
    }
    const extra = await next();
    if (extra) {
      extra.release();
      throw new Error('Portable tree omits post-GC source correspondence.');
    }
    if (!end || dirs.length) throw new Error('Unsealed post-GC source correspondence.');
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    for (const d of dirs) d.release();
    await settleBaseCleanup([() => portable.return(undefined)], failure);
  }
}
