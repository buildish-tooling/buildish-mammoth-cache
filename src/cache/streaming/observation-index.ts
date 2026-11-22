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

import type { LocalRow } from './local-stream';
import type { OwnedStore, Reference } from './owned-store';
import { Digest } from './encoding';
import { InstallScratch } from './install-scratch';
import { tuple, equal, encodeRecord, add, type Value } from './encoding';
import { isWorkspaceScaffolding, baseName, compareName, parentPath } from './tree-state';
import type { NativeIdentity } from './native';
import type { BaseObjectOptions } from './base-object';
import { settleBaseCleanup } from './base-object';

export type ObservedUnit = [
  'observed-unit',
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
];
export type ObservedFile = [
  'observed-file',
  string,
  NativeIdentity,
  string,
  Value,
  string,
  string,
  number,
  number,
  number,
];
// Pure frozen-decision summary, not evidence of native GC completion.
// retained-file mask, meaningful descendant-dir mask, remaining owner mask,
// remaining protected count, removed-by-GC flag, direct-GC-change flag,
// complete post-GC immediate child/type digest.
export type ObservedSummary = [
  'post-gc-summary',
  string,
  string,
  string,
  number,
  number,
  number,
  string,
];
export type ObservedDirectory = [
  'observed-directory',
  string,
  NativeIdentity,
  number,
  number,
  number,
  number,
  number,
  number,
  ObservedUnit | null,
  ObservedSummary,
];
export type ObservedNode = ObservedFile | ObservedDirectory;
export type ObservedChild = [
  'observed-child',
  string,
  string,
  string,
  string,
  number | null,
  number,
];
interface Frame {
  path: string;
  native: NativeIdentity;
  start: number;
  projectionEnd: number;
  edges: ObservedChild[];
  charge: number;
  unit: ObservedUnit | null;
  allOwners: bigint;
  retainedFiles: bigint;
  descendantDirs: bigint;
  remainingOwners: bigint;
  originalProtected: number;
  remainingProtected: number;
  childCleanup: boolean;
  deleting: boolean;
  changed: boolean;
}
const indexes = new WeakSet<object>();

// Protocol: docs/dev/cache-lifecycle-protocol.md#shared-gc-parent-projections.
// Complete original-Q validation once, then operation-local disk index. Not durable
// state, a per-file resident catalogue or authority to adopt current native facts.
export class ObservationIndex {
  private readonly life = {
    disposed: false,
    retiring: false,
    active: 0,
    busy: false,
    lookup: false,
  };
  private readonly directories: ObservationDirectories;
  private constructor(
    readonly store: OwnedStore,
    readonly reference: Reference,
    readonly root: number,
    private readonly scratch: InstallScratch,
    readonly options: BaseObjectOptions,
    readonly rows: number,
    readonly completed: ['cursor', string, number, number, number, null],
  ) {
    this.directories = new ObservationDirectories(this);
    indexes.add(this);
    Object.freeze(reference);
    Object.freeze(completed);
    Object.freeze(this);
  }
  static assert(index: ObservationIndex, store = index.store): void {
    if (!indexes.has(index) || index.store !== store || index.life.disposed || index.life.retiring)
      throw new Error('Unavailable observation index.');
    index.options.signal?.throwIfAborted();
  }
  private static async builder(store: OwnedStore, input: BaseObjectOptions) {
    const options = Object.freeze({ ...input }),
      signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const scratch = await InstallScratch.create(store, options.budget),
      frames: Frame[] = [];
    let root: number | undefined,
      count = 0,
      boundary = 0,
      unitActive = false,
      completed: ['cursor', string, number, number, number, null] | undefined,
      transferred = false;
    const edge = (frame: Frame, name: string, kind: string): ObservedChild => {
      // Two sorted child categories, retaining only the active parent page.
      let lo = 0,
        hi = frame.edges.length;
      const compare = (a: ObservedChild) =>
        Number(a[2] === 'directory') - Number(kind === 'directory') || compareName(a[1], name);
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compare(frame.edges[mid]) < 0) lo = mid + 1;
        else hi = mid;
      }
      const e = frame.edges[lo];
      if (!e || e[1] !== name || e[2] !== kind)
        throw new Error('Observation fact lacks projected child.');
      return e;
    };
    const accept = async (item: LocalRow) => {
      signal.throwIfAborted();
      count++;
      const r = tuple(item.value),
        frame = frames[frames.length - 1];
      if (r[0] === 'local-stream' || r[0] === 'local-end') return;
      if (r[0] === 'dir-open') {
        const charge = 1024 + 4 * (item.end - item.start);
        options.budget.retain(charge);
        frames.push({
          path: String(r[1]),
          native: [...(r[2] as NativeIdentity)],
          start: item.start,
          projectionEnd: item.end,
          edges: [],
          charge,
          unit: null,
          allOwners: 0n,
          retainedFiles: 0n,
          descendantDirs: 0n,
          remainingOwners: 0n,
          originalProtected: 0,
          remainingProtected: 0,
          childCleanup: true,
          deleting: frame?.deleting ?? false,
          changed: false,
        });
      } else if (r[0] === 'child') {
        const charge =
          160 + 4 * (Buffer.byteLength(String(r[1])) + String(r[3]).length + String(r[4]).length);
        options.budget.retain(charge);
        frame.charge += charge;
        frame.edges.push([
          'observed-child',
          String(r[1]),
          String(r[2]),
          String(r[3]),
          String(r[4]),
          null,
          0,
        ]);
        frame.projectionEnd = item.end;
      } else if (r[0] === 'file') {
        if (!unitActive) boundary = add(boundary);
        const path = frame.path ? frame.path + '/' + r[1] : String(r[1]),
          n = r[3] as NativeIdentity;
        const e = edge(frame, String(r[1]), 'file'),
          bit = 1n << BigInt(store.codec.options.model.partitions.findIndex((p) => p[0] === r[2]));
        frame.allOwners |= bit;
        if (r[6] === 'retain') {
          frame.retainedFiles |= bit;
          frame.remainingOwners |= bit;
        } else frame.changed = true;
        e[6] = r[6] === 'delete' ? 1 : 0;
        equal([e[3], e[4]], [n[3], n[4]], 'projected file identity');
        e[5] = await scratch.append([
          'observed-file',
          path,
          n,
          r[2],
          r[4],
          r[5],
          r[6],
          item.start,
          item.end,
          item.record,
        ]);
      } else if (r[0] === 'unit-open') {
        unitActive = true;
        if (r[3] === 'subtree' && r[5] === 'delete') frame.deleting = true;
        const charge = 256 + 4 * encodeRecord(r).length;
        options.budget.retain(charge);
        frame.charge += charge;
        frame.unit = [
          'observed-unit',
          String(r[1]),
          String(r[2]),
          String(r[3]),
          String(r[4]),
          String(r[5]),
          String(r[6]),
          item.start,
          0,
        ];
      } else if (r[0] === 'unit-close') {
        unitActive = false;
        boundary = add(boundary);
        if (!frame.unit) throw new Error('Missing observation unit.');
        frame.unit[8] = item.end;
      } else if (r[0] === 'dir-close') {
        frames.pop();
        try {
          let declaredOwner = 0n;
          try {
            if (!isWorkspaceScaffolding(store.codec.options.model, frame.path)) {
              const p = store.codec.options.model.owner(
                frame.path + '/.workspace-directory-probe',
              )[0];
              declaredOwner =
                1n << BigInt(store.codec.options.model.partitions.findIndex((d) => d[0] === p));
            }
          } catch {
            /* unowned directory scaffold */
          }
          const protectedHere = frame.edges.filter((e) => e[5] === null).length;
          frame.originalProtected = add(frame.originalProtected, protectedHere);
          frame.remainingProtected = add(frame.remainingProtected, protectedHere);
          if (!frame.allOwners) frame.allOwners = declaredOwner;
          const removed =
            frame.deleting &&
            !isWorkspaceScaffolding(store.codec.options.model, frame.path) &&
            frame.childCleanup &&
            !frame.originalProtected &&
            frame.allOwners !== 0n &&
            (frame.allOwners & (frame.allOwners - 1n)) === 0n;
          if (!removed && !frame.remainingOwners && !frame.remainingProtected) {
            if (declaredOwner) frame.remainingOwners = declaredOwner;
            else frame.remainingProtected = 1;
          }
          // The observation already has two sorted categories. Merge them by
          // name for the full post-GC projection digest, without a second sort
          // or retaining another directory-width table.
          const digest = new Digest('ancestor-children');
          let split = frame.edges.findIndex((e) => e[2] === 'directory');
          if (split < 0) split = frame.edges.length;
          let left = 0,
            right = split;
          while (left < split || right < frame.edges.length) {
            signal.throwIfAborted();
            const e =
              right === frame.edges.length ||
              (left < split && compareName(frame.edges[left][1], frame.edges[right][1]) < 0)
                ? frame.edges[left++]
                : frame.edges[right++];
            if (!e[6]) digest.update([e[1], e[2]]);
          }
          const summary: ObservedSummary = [
            'post-gc-summary',
            frame.retainedFiles.toString(16),
            frame.descendantDirs.toString(16),
            frame.remainingOwners.toString(16),
            frame.remainingProtected,
            Number(removed),
            Number(frame.changed),
            digest.digest(),
          ];
          const start = scratch.position;
          for (const e of frame.edges) await scratch.append(e);
          const end = scratch.position,
            offset = await scratch.append([
              'observed-directory',
              frame.path,
              frame.native,
              frame.start,
              frame.projectionEnd,
              frame.start,
              item.end,
              start,
              end,
              frame.unit,
              summary,
            ]);
          const parent = frames[frames.length - 1];
          if (parent) {
            parent.allOwners |= frame.allOwners;
            parent.originalProtected = add(parent.originalProtected, frame.originalProtected);
            parent.childCleanup &&= removed;
            if (removed) parent.changed = true;
            else {
              parent.retainedFiles |= frame.retainedFiles;
              parent.descendantDirs |= frame.descendantDirs | declaredOwner;
              parent.remainingOwners |= frame.remainingOwners;
              parent.remainingProtected = add(parent.remainingProtected, frame.remainingProtected);
            }
            const e = edge(parent, baseName(frame.path), 'directory');
            equal([e[3], e[4]], [frame.native[3], frame.native[4]], 'projected directory identity');
            e[5] = offset;
            e[6] = Number(removed);
          } else {
            if (root !== undefined) throw new Error('Multiple observation roots.');
            root = offset;
            completed = ['cursor', '0'.repeat(64), item.end, item.record + 1, add(boundary), null];
          }
        } finally {
          options.budget.release(frame.charge);
        }
      }
    };
    return {
      accept,
      finish(reference: Reference) {
        if (transferred || root === undefined || frames.length || !completed)
          throw new Error('Incomplete observation index.');
        signal.throwIfAborted();
        completed[1] = reference[4];
        transferred = true;
        return new ObservationIndex(store, reference, root, scratch, options, count, completed);
      },
      async dispose() {
        if (transferred) return;
        for (const frame of frames) options.budget.release(frame.charge);
        frames.length = 0;
        await scratch.close();
      },
    };
  }
  static async open(
    store: OwnedStore,
    reference: Reference,
    input: BaseObjectOptions,
  ): Promise<ObservationIndex> {
    reference = store.codec.schemas.ref('observations').parse(reference);
    const builder = await this.builder(store, input);
    try {
      for await (const row of store.rows(
        reference,
        'observations',
        { ...input, partition: null },
        input.signal,
      ))
        await builder.accept(row);
      return builder.finish(reference);
    } catch (error) {
      await settleBaseCleanup([() => builder.dispose()], error);
      throw error;
    }
  }
  /** Only the actual strict writer can feed this builder and bind its completed Q. */
  static async write(
    store: OwnedStore,
    records: AsyncIterable<Value>,
    input: BaseObjectOptions,
  ): Promise<ObservationIndex> {
    const builder = await this.builder(store, input);
    try {
      const reference = await store.writeStream(
        'observations',
        { ...input, partition: null },
        records,
        input.signal,
        builder.accept,
      );
      if (!store.completedStream(reference))
        throw new Error('Missing completed observation writer.');
      return builder.finish(reference);
    } catch (error) {
      await settleBaseCleanup([() => builder.dispose()], error);
      throw error;
    }
  }
  get work() {
    return this.scratch.work;
  }
  async node(offset: number): Promise<{ node: ObservedNode; release: () => void }> {
    ObservationIndex.assert(this);
    this.life.active++;
    let r: Awaited<ReturnType<InstallScratch['record']>> | undefined;
    try {
      r = await this.scratch.record(offset);
      ObservationIndex.assert(this);
      const n = tuple(r.value);
      if (n[0] !== 'observed-directory' && n[0] !== 'observed-file')
        throw new Error('Invalid observation node.');
      let held = true;
      return {
        node: r.value as ObservedNode,
        release: () => {
          if (held) {
            held = false;
            r!.release();
            this.life.active--;
          }
        },
      };
    } catch (error) {
      r?.release();
      this.life.active--;
      throw error;
    }
  }
  async *children(node: ObservedDirectory): AsyncGenerator<ObservedChild> {
    ObservationIndex.assert(this);
    this.life.active++;
    try {
      for await (const row of this.scratch.rows(node[7], node[8])) {
        ObservationIndex.assert(this);
        yield row as ObservedChild;
      }
    } finally {
      this.life.active--;
    }
  }
  async *walk(offset = this.root): AsyncGenerator<ObservedNode> {
    const lease = await this.node(offset);
    try {
      yield lease.node;
      if (lease.node[0] === 'observed-directory')
        for await (const e of this.children(lease.node)) if (e[5] !== null) yield* this.walk(e[5]);
    } finally {
      lease.release();
    }
  }
  private async lookup<T>(read: () => Promise<T>): Promise<T> {
    ObservationIndex.assert(this);
    if (this.life.lookup) throw new Error('Observation directory lookup active.');
    this.life.lookup = true;
    try {
      return await read();
    } finally {
      this.life.lookup = false;
    }
  }
  async directory(
    path: string,
  ): Promise<{ node: ObservedDirectory; offset: number; release: () => void }> {
    return this.lookup(async () => {
      const page = await this.directories.get(path),
        lease = await this.node(page.offset);
      return { node: lease.node as ObservedDirectory, offset: page.offset, release: lease.release };
    });
  }
  async file(path: string): Promise<{ node: ObservedFile; offset: number; release: () => void }> {
    return this.lookup(async () => {
      const page = await this.directories.get(parentPath(path)),
        entry = await this.directories.child(page, baseName(path), 'file');
      if (!entry || entry[5] === null) throw new Error('Unknown observed managed file.');
      const lease = await this.node(entry[5]);
      if (lease.node[0] !== 'observed-file' || lease.node[1] !== path) {
        lease.release();
        throw new Error('Wrong observation file.');
      }
      return { node: lease.node, offset: entry[5], release: lease.release };
    });
  }
  async checkFile(path: string, partition: string, native: NativeIdentity): Promise<void> {
    const lease = await this.file(path);
    try {
      equal([lease.node[3], lease.node[2]], [partition, native], 'original GC target');
      if (lease.node[6] !== 'delete') throw new Error('GC target was retained.');
    } finally {
      lease.release();
    }
  }
  async checkParent(path: string, span: Value): Promise<void> {
    const r = tuple(span, 'span', 4);
    if (r[1] !== this.reference[4]) throw new Error('Foreign observation parent span.');
    const lease = await this.directory(path);
    try {
      equal(
        r,
        ['span', this.reference[4], lease.node[3], lease.node[4]],
        'complete original parent projection',
      );
    } finally {
      lease.release();
    }
  }
  async dispose(): Promise<void> {
    if (this.life.disposed) return;
    if (this.life.busy) throw new Error('Observation retirement active.');
    if (this.life.lookup) throw new Error('Observation directory lookup active.');
    this.life.retiring = true;
    this.life.busy = true;
    try {
      this.directories.close();
      if (this.life.active) throw new Error('Observation index still has active readers.');
      await this.scratch.close();
      this.life.disposed = true;
    } finally {
      this.life.busy = false;
    }
  }
}
interface DirectoryPage {
  offset: number;
  node: ObservedDirectory;
  release: () => void;
  entries: ObservedChild[] | null;
  charge: number;
}
// One charged page per active ancestor. Shared-parent target admissions use a
// binary lookup, not a repeated directory/projection scan for each file or batch.
class ObservationDirectories {
  private readonly frames: DirectoryPage[] = [];
  constructor(private readonly index: ObservationIndex) {}
  private async push(offset: number) {
    const lease = await this.index.node(offset);
    if (lease.node[0] !== 'observed-directory') {
      lease.release();
      throw new Error('Expected observation directory.');
    }
    this.frames.push({
      offset,
      node: lease.node,
      release: lease.release,
      entries: null,
      charge: 0,
    });
  }
  private pop() {
    const p = this.frames.pop()!;
    this.index.options.budget.release(p.charge);
    p.release();
  }
  async child(page: DirectoryPage, name: string, kind: string): Promise<ObservedChild | undefined> {
    if (page.entries === null) {
      page.entries = [];
      for await (const entry of this.index.children(page.node)) {
        const n = 160 + 4 * (Buffer.byteLength(entry[1]) + entry[3].length + entry[4].length);
        this.index.options.budget.retain(n);
        page.charge += n;
        page.entries.push(entry);
      }
    }
    let lo = 0,
      hi = page.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1,
        e = page.entries[mid],
        c = Number(e[2] === 'directory') - Number(kind === 'directory') || compareName(e[1], name);
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    const e = page.entries[lo];
    return e?.[1] === name && e[2] === kind ? e : undefined;
  }
  async get(path: string): Promise<DirectoryPage> {
    ObservationIndex.assert(this.index);
    if (!this.frames.length) await this.push(this.index.root);
    while (this.frames.length > 1) {
      const top = this.frames[this.frames.length - 1].node[1];
      if (top === path || path.startsWith(top + '/')) break;
      this.pop();
    }
    let page = this.frames[this.frames.length - 1];
    if (page.node[1] === path) return page;
    const suffix = page.node[1] ? path.slice(page.node[1].length + 1) : path;
    for (const name of suffix.split('/').filter(Boolean)) {
      const e = await this.child(page, name, 'directory');
      if (!e || e[5] === null) throw new Error('Unknown observed directory.');
      await this.push(e[5]);
      page = this.frames[this.frames.length - 1];
    }
    if (page.node[1] !== path) throw new Error('Wrong observation directory binding.');
    return page;
  }
  close(): void {
    while (this.frames.length) this.pop();
  }
}
