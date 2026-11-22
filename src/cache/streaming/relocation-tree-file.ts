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

import { lstat, type FileHandle } from 'node:fs/promises';
import { decodeRecords, encodeRecord, tuple, equal, add, type Value } from './encoding';
import { FrozenBaseTree } from './base-frozen-tree';
import { readNativeTree } from './native-tree';
import { nativeIdentity, sameNative, type NativeIdentity } from './native';
import { NativeHashBuffer } from './native-read-phase';
import { spanSchema } from './local-schema';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';

const readers = new WeakSet<object>();

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans.
// A complete immutable tree validation is tied to this open native file. Member
// ranges never rescan the full tree; exact plan boundaries are checked separately.
export class RelocationTreeFile {
  readonly hashes: NativeHashBuffer;
  readonly work = { validationBytes: 0, rangeBytes: 0, reads: 0 };
  private closed = false;
  private closing = false;
  private failedClose = false;
  private busy = false;
  private headerEnd = 0;
  private footerStart = 0;
  private constructor(
    readonly tree: FrozenBaseTree,
    private readonly handle: FileHandle,
    private readonly native: NativeIdentity,
    private readonly options: BaseObjectOptions,
    private readonly release: () => void,
  ) {
    this.hashes = new NativeHashBuffer(options.budget);
  }
  static async open(tree: FrozenBaseTree, options: BaseObjectOptions): Promise<RelocationTreeFile> {
    FrozenBaseTree.assert(tree);
    options = Object.freeze({ ...options });
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    await tree.assertStable(options);
    const release = options.budget.holdRecord(1024 + Buffer.byteLength(tree.tree[2]));
    let reader: RelocationTreeFile | undefined;
    try {
      const opened = await tree.store.root.openRead(tree.tree[2]);
      reader = new RelocationTreeFile(tree, opened.handle, opened.identity, options, release);
      if (BigInt(opened.identity[5]) !== BigInt(tree.tree[3]))
        throw new Error('Tree metadata length mismatch.');
      await readNativeTree(
        reader.bytes(0, tree.tree[3], 'validationBytes', signal),
        { ...options, model: tree.store.codec.options.model, identity: tree.reference[1] },
        tree.envelope,
        async (value) => {
          const r = tuple(value);
          if (r[0] === 'tree') reader!.headerEnd = encodeRecord(value).length;
          if (r[0] === 'end') reader!.footerStart = tree.tree[3] - encodeRecord(value).length;
        },
        signal,
      );
      await reader.stable();
      signal.throwIfAborted();
      readers.add(reader);
      return reader;
    } catch (error) {
      if (reader) await settleBaseCleanup([() => reader!.close()], error);
      else release();
      throw error;
    }
  }
  static assert(reader: RelocationTreeFile, tree: FrozenBaseTree) {
    if (
      !readers.has(reader) ||
      reader.closed ||
      reader.closing ||
      reader.failedClose ||
      reader.tree !== tree
    )
      throw new Error('Unbound relocation tree reader.');
  }
  private async stable() {
    if (this.closed || this.closing || this.failedClose) throw new Error('Closed relocation tree.');
    const { store } = this.tree;
    store.root.work.stats += 2;
    const actual = nativeIdentity(await this.handle.stat({ bigint: true })),
      named = nativeIdentity(await lstat(store.root.resolve(this.tree.tree[2]), { bigint: true }));
    if (!sameNative(this.native, actual, true) || !sameNative(this.native, named, true))
      throw new Error('Relocation tree metadata changed.');
  }
  private async *bytes(
    start: number,
    end: number,
    counter: 'validationBytes' | 'rangeBytes',
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    for (let at = start; at < end;) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(65536, end - at)),
        { bytesRead } = await this.handle.read(buffer, 0, buffer.length, at);
      this.work.reads++;
      if (!bytesRead) throw new Error('Truncated relocation tree range.');
      this.work[counter] = add(this.work[counter], bytesRead);
      this.tree.store.root.work.readBytes = add(this.tree.store.root.work.readBytes, bytesRead);
      at += bytesRead;
      signal.throwIfAborted();
      yield buffer.subarray(0, bytesRead);
    }
  }
  async *records(
    span: Value,
    signal = this.options.signal ?? new AbortController().signal,
  ): AsyncGenerator<Value> {
    if (this.busy || this.closed || this.closing || this.failedClose)
      throw new Error('Relocation tree reader unavailable.');
    const ref = spanSchema.parse(span);
    equal(ref[1], this.tree.tree[4], 'bound portable tree span');
    if (ref[2] < this.headerEnd || ref[3] > this.footerStart)
      throw new Error('Portable member span includes framing.');
    this.busy = true;
    try {
      await this.stable();
      signal.throwIfAborted();
      for await (const byte of this.bytes(ref[2] - 1, ref[2], 'rangeBytes', signal))
        if (byte[0] !== 10) throw new Error('Portable span starts inside a record.');
      for await (const frame of decodeRecords(this.bytes(ref[2], ref[3], 'rangeBytes', signal))) {
        const release = this.options.budget.holdRecord(frame.raw.length);
        try {
          signal.throwIfAborted();
          yield frame.value;
        } finally {
          release();
        }
      }
      await this.stable();
      signal.throwIfAborted();
    } finally {
      this.busy = false;
    }
  }
  async close() {
    if (this.closed) return;
    if (this.busy || this.closing) throw new Error('Active relocation tree range/cleanup.');
    this.hashes.dispose();
    this.closing = true;
    try {
      await this.handle.close();
      this.closed = true;
      this.release();
    } catch (error) {
      this.failedClose = true;
      throw error;
    } finally {
      this.closing = false;
    }
  }
}
