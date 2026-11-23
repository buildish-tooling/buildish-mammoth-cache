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

import { abortableValues } from './abort';
import { sameObject, type NativeIdentity } from './native';
import type { Value } from './encoding';
import type { LocalRow } from './local-stream';
import { baseName, parentPath, compareName } from './tree-state';
import type { ResolvedModel } from './model';
import type { InstallScratch } from './install-scratch';

// Scratch nodes are a hierarchical, operation-local spool, never a global resident index.
export type IndexedNode = readonly [
  'node',
  'file' | 'directory' | 'protected',
  string,
  Value,
  string | null,
  string,
  number,
  number,
  number,
  number,
  number,
];
// fields: tag,kind,path,N/protected fact,sha,owner-mask,protected-count,childrenStart,childrenEnd,sourceStart,sourceEnd
interface Frame {
  path: string;
  native: NativeIdentity;
  start: number;
  tail: number | null;
  count: number;
  mask: bigint;
  protectedCount: number;
  release: () => void;
}
export function nodeMask(node: IndexedNode): bigint {
  return BigInt('0x' + node[5]);
}
export function partitionBit(model: ResolvedModel, id: string): bigint {
  const index = model.partitions.findIndex((p) => p[0] === id);
  if (index < 0) throw new Error('Unknown indexed partition.');
  return 1n << BigInt(index);
}
export function ownerBit(model: ResolvedModel, path: string): bigint {
  try {
    return partitionBit(model, model.owner(path)[0]);
  } catch {
    return 0n;
  }
}
export async function buildInstallIndex(
  scratch: InstallScratch,
  source: AsyncIterable<LocalRow>,
  model: ResolvedModel,
  partition: string | null,
  signal = new AbortController().signal,
): Promise<number> {
  return buildObservedInstallIndex(scratch, model, partition, signal, async (accept) => {
    for await (const row of abortableValues(source, signal)) await accept(row);
  });
}

/** Feed provisional rows directly from their acceptance pass; expose no index before EOF. */
export async function buildObservedInstallIndex(
  scratch: InstallScratch,
  model: ResolvedModel,
  partition: string | null,
  signal: AbortSignal,
  produce: (accept: (row: LocalRow) => Promise<void>) => Promise<void>,
): Promise<number> {
  signal.throwIfAborted();
  scratch.store.root.work.indexBuilds++;
  const claim = scratch.claim();
  const frames: Frame[] = [];
  let root: number | undefined;
  async function child(offset: number, node: IndexedNode) {
    const parent = frames[frames.length - 1];
    if (!parent) {
      if (root !== undefined) throw new Error('Multiple index roots.');
      root = offset;
      return;
    }
    parent.tail = await scratch.append(
      ['link', parent.tail, baseName(node[2]), node[1], offset],
      claim.token,
    );
    parent.count++;
    parent.mask |= nodeMask(node);
    parent.protectedCount += node[6];
  }
  async function close(end: number) {
    const frame = frames.pop();
    if (!frame) throw new Error('Unbalanced index.');
    let charge = 0;
    const entries: { name: string; kind: string; offset: number }[] = [];
    try {
      let at = frame.tail;
      while (at !== null) {
        signal.throwIfAborted();
        const record = await scratch.record(at);
        try {
          const row = record.value as readonly Value[];
          const name = Buffer.from(String(row[2])).toString('utf8'),
            bytes = 128 + 4 * Buffer.byteLength(name);
          scratch.budget.retain(bytes);
          charge += bytes;
          entries.push({ name, kind: String(row[3]), offset: Number(row[4]) });
          at = row[1] as number | null;
        } finally {
          record.release();
        }
      }
      // Coarse insertion skips recursive output selection. Preserve its native alias
      // check while this already-bounded source name page is available.
      if (partition !== null && (process.platform === 'win32' || process.platform === 'darwin')) {
        const key = (name: string) =>
          process.platform === 'darwin' ? name.normalize('NFD').toUpperCase() : name.toUpperCase();
        entries.sort((a, b) => compareName(key(a.name), key(b.name)));
        for (let n = 1; n < entries.length; n++)
          if (key(entries[n - 1].name) === key(entries[n].name))
            throw new Error('Native case/normalization path alias.');
      }
      entries.sort((a, b) => compareName(a.name, b.name));
      const start = scratch.position;
      for (const entry of entries) {
        signal.throwIfAborted();
        await scratch.append(['edge', entry.name, entry.kind, entry.offset], claim.token);
      }
      const finish = scratch.position;
      if (!frame.count && frame.path) {
        frame.mask =
          partition === null
            ? ownerBit(model, frame.path + '/.workspace-directory-probe')
            : partitionBit(model, partition);
        if (!frame.mask) frame.protectedCount++;
      }
      const node: IndexedNode = [
        'node',
        'directory',
        frame.path,
        frame.native,
        null,
        frame.mask.toString(16),
        frame.protectedCount,
        start,
        finish,
        frame.start,
        end,
      ];
      const offset = await scratch.append(node, claim.token);
      await child(offset, node);
    } finally {
      scratch.budget.release(charge);
      frame.release();
    }
  }
  try {
    await produce(async (record) => {
      signal.throwIfAborted();
      const row = record.value as readonly Value[],
        tag = row[0];
      if (tag === 'local-stream') return;
      if (tag === 'local-end') {
        if (partition !== null) while (frames.length) await close(record.start);
        return;
      }
      if (partition !== null && tag !== 'dir-close') {
        const path = String(row[1]);
        while (frames.length && path !== '' && frames[frames.length - 1].path !== parentPath(path))
          await close(record.start);
      }
      if (tag === 'directory' || tag === 'dir-open') {
        const path = String(row[1]),
          release = scratch.budget.holdRecord(512 + Buffer.byteLength(path));
        frames.push({
          path,
          native: row[2] as NativeIdentity,
          start: record.start,
          tail: null,
          count: 0,
          mask: 0n,
          protectedCount: 0,
          release,
        });
      } else if (tag === 'dir-close') {
        const frame = frames[frames.length - 1];
        if (!frame || frame.path !== row[1]) throw new Error('Unbalanced index directory close.');
        if (row[2] !== undefined) {
          const native = row[2] as NativeIdentity;
          if (!sameObject(frame.native, native))
            throw new Error('Indexed directory replaced during production.');
          frame.native = native;
        }
        await close(record.end);
      } else if (tag === 'file') {
        const mask =
          partition === null ? ownerBit(model, String(row[1])) : partitionBit(model, partition);
        const node: IndexedNode = [
          'node',
          'file',
          String(row[1]),
          row[2],
          row.length === 4 ? String(row[3]) : null,
          mask.toString(16),
          mask ? 0 : 1,
          0,
          0,
          record.start,
          record.end,
        ];
        await child(await scratch.append(node, claim.token), node);
      } else if (tag === 'parent-child') {
        const path = String(row[1]) ? String(row[1]) + '/' + row[2] : String(row[2]);
        const node: IndexedNode = [
          'node',
          'protected',
          path,
          row,
          null,
          '0',
          1,
          0,
          0,
          record.start,
          record.end,
        ];
        await child(await scratch.append(node, claim.token), node);
      } else throw new Error('Unexpected index row.');
    });
    if (frames.length || root === undefined) throw new Error('Incomplete index root.');
    signal.throwIfAborted();
    return root;
  } finally {
    try {
      for (const frame of frames) frame.release();
    } finally {
      claim.release();
    }
  }
}
export async function indexedNode(
  scratch: InstallScratch,
  offset: number,
): Promise<{ node: IndexedNode; release: () => void }> {
  const record = await scratch.record(offset);
  return { node: record.value as IndexedNode, release: record.release };
}
export async function* indexedChildren(
  scratch: InstallScratch,
  node: IndexedNode,
): AsyncGenerator<readonly [string, number]> {
  if (node[1] !== 'directory') return;
  for await (const value of scratch.rows(node[7], node[8])) {
    const row = value as readonly Value[];
    yield [String(row[1]), Number(row[3])];
  }
}

export async function* indexedEntries(
  scratch: InstallScratch,
  node: IndexedNode,
): AsyncGenerator<readonly [string, IndexedNode[1], number]> {
  if (node[1] !== 'directory') return;
  for await (const value of scratch.rows(node[7], node[8])) {
    const row = value as readonly Value[];
    yield [String(row[1]), row[2] as IndexedNode[1], Number(row[3])];
  }
}

/** Active ancestor pages only; arbitrary sibling lookups never rescan a whole index. */
export class IndexDirectories {
  private readonly frames: {
    path: string;
    offset: number;
    node: IndexedNode;
    release: () => void;
    entries: { name: string; kind: IndexedNode[1]; offset: number }[] | null;
    charge: number;
  }[] = [];
  constructor(
    private readonly scratch: InstallScratch,
    private readonly root: number,
  ) {}
  private async push(offset: number) {
    const lease = await indexedNode(this.scratch, offset);
    this.frames.push({
      path: lease.node[2],
      offset,
      node: lease.node,
      release: lease.release,
      entries: null,
      charge: 0,
    });
  }
  private pop() {
    const frame = this.frames.pop()!;
    this.scratch.budget.release(frame.charge);
    frame.release();
  }
  async directory(path: string): Promise<IndexedNode | null> {
    if (!this.frames.length) await this.push(this.root);
    while (
      this.frames.length > 1 &&
      this.frames[this.frames.length - 1].path !== path &&
      !path.startsWith(this.frames[this.frames.length - 1].path + '/')
    )
      this.pop();
    let frame = this.frames[this.frames.length - 1];
    if (frame.path === path) return frame.node;
    const suffix = frame.path ? path.slice(frame.path.length + 1) : path;
    for (const name of suffix.split('/').filter(Boolean)) {
      if (frame.entries === null) {
        frame.entries = [];
        for await (const edge of indexedEntries(this.scratch, frame.node)) {
          const owned = Buffer.from(edge[0]).toString(),
            charge = 128 + 4 * Buffer.byteLength(owned);
          this.scratch.budget.retain(charge);
          frame.charge += charge;
          frame.entries.push({ name: owned, kind: edge[1], offset: edge[2] });
        }
      }
      let low = 0,
        high = frame.entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareName(frame.entries[middle].name, name) < 0) low = middle + 1;
        else high = middle;
      }
      const child = frame.entries[low];
      if (!child || child.name !== name || child.kind !== 'directory') return null;
      await this.push(child.offset);
      frame = this.frames[this.frames.length - 1];
    }
    return frame.node;
  }
  /** A borrowed directory page; member records retain their own explicit lease. */
  async member(path: string): Promise<{ node: IndexedNode; release(): void } | null> {
    if (path === '') return indexedNode(this.scratch, this.root);
    const directory = await this.directory(parentPath(path));
    if (!directory) return null;
    const frame = this.frames[this.frames.length - 1];
    if (frame.entries === null) {
      frame.entries = [];
      for await (const edge of indexedEntries(this.scratch, frame.node)) {
        const name = Buffer.from(edge[0]).toString(),
          charge = 128 + 4 * Buffer.byteLength(name);
        this.scratch.budget.retain(charge);
        frame.charge += charge;
        frame.entries.push({ name, kind: edge[1], offset: edge[2] });
      }
    }
    const name = baseName(path);
    let low = 0,
      high = frame.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareName(frame.entries[middle].name, name) < 0) low = middle + 1;
      else high = middle;
    }
    const entry = frame.entries[low];
    return entry?.name === name ? indexedNode(this.scratch, entry.offset) : null;
  }
  close() {
    while (this.frames.length) this.pop();
  }
}
