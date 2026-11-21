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

import { open, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeRecords, encodeRecord, add, type Value } from './encoding';
import { parentPath } from './tree-state';
import { nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';

export interface ScratchWork {
  reads: number;
  readBytes: number;
  writes: number;
  writeBytes: number;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Unpublished operation-local metadata only. Never a mutable Q/P or restart authority.
export class InstallScratch {
  readonly work: ScratchWork = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 };
  private end = 0;
  private closed = false;
  private failed = false;
  private owner: symbol | null = null;
  private writing = false;
  private constructor(
    readonly store: OwnedStore,
    readonly path: string,
    private readonly handle: FileHandle,
    readonly budget: WorkingBudget,
    private readonly directoryNative: NativeIdentity,
  ) {}
  static async create(store: OwnedStore, budget: WorkingBudget): Promise<InstallScratch> {
    const name = store.prefix + 'planning/' + randomUUID() + '/scratch.ndjson';
    await store.makeParents(name);
    const native = await store.root.stat(parentPath(name));
    if (!native) throw new Error('Missing scratch directory.');
    store.root.work.opens++;
    const handle = await open(store.root.resolve(name), 'wx+', 0o600);
    return new InstallScratch(store, name, handle, budget, native);
  }
  get position(): number {
    return this.end;
  }
  claim(): { token: symbol; release: () => void } {
    if (this.owner || this.closed || this.failed)
      throw new Error('Scratch already claimed or unavailable.');
    const token = Symbol('scratch-owner');
    this.owner = token;
    return {
      token,
      release: () => {
        if (this.owner === token) this.owner = null;
      },
    };
  }
  async append(value: Value, owner?: symbol, encoded?: (bytes: Buffer) => void): Promise<number> {
    if (this.closed || this.failed) throw new Error('Scratch is closed or failed.');
    if (this.writing || (this.owner !== null && this.owner !== owner))
      throw new Error('Scratch write is already claimed.');
    const bytes = encodeRecord(value),
      release = this.budget.holdRecord(bytes.length),
      start = this.end;
    this.writing = true;
    try {
      let at = 0;
      while (at < bytes.length) {
        const written = await this.handle.write(bytes, at, bytes.length - at, this.end);
        if (!written.bytesWritten) throw new Error('Short scratch write.');
        at += written.bytesWritten;
        this.end = add(this.end, written.bytesWritten);
      }
      this.work.writes++;
      this.work.writeBytes = add(this.work.writeBytes, bytes.length);
      this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, bytes.length);
      this.store.root.work.scratchWriteBytes = add(
        this.store.root.work.scratchWriteBytes,
        bytes.length,
      );
      encoded?.(bytes);
      return start;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.writing = false;
      release();
    }
  }
  private async *bytes(start: number, end: number, initial = 65536): AsyncGenerator<Buffer> {
    let at = start,
      size = initial;
    while (at < end) {
      const buffer = Buffer.allocUnsafe(Math.min(size, end - at));
      const result = await this.handle.read(buffer, 0, buffer.length, at);
      if (!result.bytesRead) throw new Error('Truncated scratch.');
      this.work.reads++;
      this.work.readBytes = add(this.work.readBytes, result.bytesRead);
      this.store.root.work.readBytes = add(this.store.root.work.readBytes, result.bytesRead);
      this.store.root.work.scratchReadBytes = add(
        this.store.root.work.scratchReadBytes,
        result.bytesRead,
      );
      at += result.bytesRead;
      yield buffer.subarray(0, result.bytesRead);
      size = Math.min(size * 2, 65536);
    }
  }
  async record(offset: number): Promise<{ value: Value; release: () => void; bytes: number }> {
    if (
      this.closed ||
      this.failed ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= this.end
    )
      throw new Error('Invalid scratch offset.');
    for await (const row of decodeRecords(this.bytes(offset, this.end, 256)))
      return {
        value: row.value,
        release: this.budget.holdRecord(row.raw.length),
        bytes: row.raw.length,
      };
    throw new Error('Missing scratch record.');
  }
  async *rows(
    start: number,
    end: number,
    encoded?: (bytes: Buffer) => void,
  ): AsyncGenerator<Value> {
    if (
      this.closed ||
      this.failed ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      end > this.end
    )
      throw new Error('Invalid scratch span.');
    for await (const row of decodeRecords(this.bytes(start, end))) {
      const release = this.budget.holdRecord(row.raw.length);
      try {
        encoded?.(row.raw);
        yield row.value;
      } finally {
        release();
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.owner || this.writing) throw new Error('Cannot close active scratch.');
    this.closed = true;
    let expected: ReturnType<typeof nativeIdentity> | undefined;
    let failure: unknown;
    try {
      expected = nativeIdentity(await this.handle.stat({ bigint: true }));
    } catch (error) {
      failure = error;
    }
    try {
      await this.handle.close();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Scratch stat/close failed.')
        : error;
    }
    if (failure) throw failure;
    const named = await this.store.root.stat(this.path);
    if (!named || !expected || !sameNative(expected, named, true))
      throw new Error('Scratch path changed; preserving unknown file.');
    await unlink(this.store.root.resolve(this.path));
    this.store.root.work.unlinks++;
    const directory = parentPath(this.path),
      native = await this.store.root.stat(directory);
    if (
      !native ||
      !sameObject(this.directoryNative, native) ||
      native[6] !== this.directoryNative[6]
    )
      throw new Error('Scratch directory changed.');
    await rmdir(this.store.root.resolve(directory));
    this.store.root.work.directoryRemovals++;
    await this.store.root.syncDirectory(parentPath(directory));
  }
}
