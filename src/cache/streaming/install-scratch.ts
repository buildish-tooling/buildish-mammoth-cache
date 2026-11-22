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

import { constants } from 'node:fs';
import { open, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { decodeRecords, encodeRecord, add, type Value } from './encoding';
import { BufferedWriter } from './buffered-writer';
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
  private readonly writer: BufferedWriter;
  private closed = false;
  private parked = false;
  private readOnly = false;
  private reading = false;
  private physicalReaders = 0;
  private readonly pages: { start: number; end: number; bytes: Buffer }[] = [];
  private failed = false;
  private owner: symbol | null = null;
  private writing = false;
  private constructor(
    readonly store: OwnedStore,
    readonly path: string,
    private handle: FileHandle,
    readonly budget: WorkingBudget,
    private readonly directoryNative: NativeIdentity,
    private fileNative: NativeIdentity,
  ) {
    this.writer = new BufferedWriter(
      handle,
      budget,
      (bytes) => {
        this.work.writeBytes = add(this.work.writeBytes, bytes);
        store.root.work.writeBytes = add(store.root.work.writeBytes, bytes);
        store.root.work.scratchWriteBytes = add(store.root.work.scratchWriteBytes, bytes);
      },
      0,
      () => {
        store.root.work.scratchWriteCalls++;
      },
      () => this.assertStable(),
      async () => {
        store.root.work.stats++;
        const raw = await handle.stat({ bigint: true }),
          after = nativeIdentity(raw);
        if (
          raw.nlink !== 1n ||
          Number(raw.size) !== this.writer.written ||
          fileNative.some((v, i) => ![5, 7, 8, 9].includes(i) && v !== after[i])
        )
          throw new Error('Scratch changed during buffered write.');
        this.fileNative = after;
      },
    );
  }
  static async create(store: OwnedStore, budget: WorkingBudget): Promise<InstallScratch> {
    const name = store.prefix + 'planning/' + randomUUID() + '/scratch.ndjson';
    await store.makeParents(name);
    const native = await store.root.stat(parentPath(name));
    if (!native) throw new Error('Missing scratch directory.');
    store.root.work.opens++;
    const handle = await open(store.root.resolve(name), 'wx+', 0o600);
    try {
      store.root.work.stats++;
      return new InstallScratch(
        store,
        name,
        handle,
        budget,
        native,
        nativeIdentity(await handle.stat({ bigint: true })),
      );
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  get position(): number {
    return this.end;
  }
  claim(): { token: symbol; release: () => void } {
    if (this.owner || this.closed || this.failed || this.parked || this.readOnly || this.reading)
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
    if (this.closed || this.failed || this.parked || this.readOnly)
      throw new Error('Scratch is closed or failed.');
    if (this.writing || this.physicalReaders > 0 || (this.owner !== null && this.owner !== owner))
      throw new Error('Scratch write is already claimed.');
    this.store.root.work.metadataRowsWritten++;
    const bytes = encodeRecord(value),
      release = this.budget.holdRecord(bytes.length),
      start = this.end;
    this.writing = true;
    try {
      await this.writer.append(bytes);
      this.end = this.writer.position;
      this.work.writes++; // Logical records; root.work.scratchWriteCalls counts handle writes.
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
  async assertStable(): Promise<void> {
    if (this.closed || this.failed || this.parked) throw new Error('Unavailable scratch.');
    this.store.root.work.stats++;
    if (
      !sameNative(this.fileNative, nativeIdentity(await this.handle.stat({ bigint: true })), true)
    )
      throw new Error('Changed scratch backing file.');
  }
  async flush(): Promise<void> {
    if (
      this.closed ||
      this.failed ||
      this.parked ||
      this.writing ||
      this.physicalReaders > 0 ||
      this.owner
    )
      throw new Error('Scratch is busy/failed.');
    this.writing = true;
    try {
      if (this.writer.position === this.writer.written) await this.assertStable();
      await this.writer.flush();
      this.writer.releaseBuffer();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.writing = false;
    }
  }
  // Closed immutable scratch stays invocation-owned; only this process can reopen its proof.
  async park(): Promise<void> {
    await this.flush();
    this.releaseReadCache();
    if (this.closed || this.writing || this.owner || this.parked)
      throw new Error('Scratch is active.');
    this.writing = true;
    try {
      await this.assertStable();
      const named = await this.store.root.stat(this.path);
      if (!named || !sameNative(named, this.fileNative, true))
        throw new Error('Scratch path changed.');
      await this.handle.close();
      this.writer.dispose();
      this.parked = true;
      this.readOnly = true;
    } finally {
      this.writing = false;
    }
  }
  async reopen(): Promise<void> {
    if (!this.parked || this.closed || this.writing) throw new Error('Scratch is not parked.');
    this.writing = true;
    let handle: FileHandle | undefined;
    try {
      const named = await this.store.root.stat(this.path);
      if (!named || !sameNative(named, this.fileNative, true))
        throw new Error('Parked scratch changed.');
      this.store.root.work.opens++;
      handle = await open(
        this.store.root.resolve(this.path),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      this.store.root.work.stats++;
      if (!sameNative(this.fileNative, nativeIdentity(await handle.stat({ bigint: true })), true))
        throw new Error('Parked scratch changed while opening.');
      this.handle = handle;
      handle = undefined;
      this.parked = false;
    } finally {
      await handle?.close();
      this.writing = false;
    }
  }
  releaseReadCache(): void {
    if (this.reading) throw new Error('Active scratch read.');
    this.budget.release(this.pages.length * 65536);
    this.pages.length = 0;
  }
  private async diskRead(buffer: Buffer, length: number, at: number): Promise<number> {
    this.store.root.work.scratchReadCalls++;
    const { bytesRead } = await this.handle.read(buffer, 0, length, at);
    if (!bytesRead) throw new Error('Truncated scratch.');
    this.work.reads++;
    this.work.readBytes = add(this.work.readBytes, bytesRead);
    this.store.root.work.readBytes = add(this.store.root.work.readBytes, bytesRead);
    this.store.root.work.scratchReadBytes = add(this.store.root.work.scratchReadBytes, bytesRead);
    return bytesRead;
  }
  private async readPhysical(buffer: Buffer, at: number): Promise<number> {
    this.physicalReaders++;
    try {
      // A concurrent reader uses its own destination; no shared loading-page mutation.
      if (this.reading)
        return await this.diskRead(buffer, Math.min(buffer.length, this.writer.written - at), at);
      this.reading = true;
      try {
        let index = this.pages.findIndex((p) => at >= p.start && at < p.end);
        let page = index < 0 ? undefined : this.pages.splice(index, 1)[0];
        if (!page) {
          const start = Math.floor(at / 65536) * 65536;
          index = this.pages.findIndex((p) => p.start === start);
          page =
            index >= 0
              ? this.pages.splice(index, 1)[0]
              : this.pages.length === 2
                ? this.pages.pop()
                : undefined;
          if (!page) {
            this.budget.retain(65536);
            page = { start, end: start, bytes: Buffer.allocUnsafe(65536) };
          }
          // Keep the charge/owner discoverable even if the actual read fails.
          this.pages.unshift(page);
          page.start = start;
          page.end = start;
          const limit = Math.min(65536, this.writer.written - start);
          let count = 0;
          while (count < limit)
            count += await this.diskRead(page.bytes.subarray(count), limit - count, start + count);
          page.end = start + count;
        } else this.pages.unshift(page);
        const count = Math.min(buffer.length, page.end - at);
        buffer.set(page.bytes.subarray(at - page.start, at - page.start + count));
        return count;
      } finally {
        this.reading = false;
      }
    } finally {
      this.physicalReaders--;
    }
  }
  private async *bytes(start: number, end: number, initial = 65536): AsyncGenerator<Buffer> {
    let at = start,
      size = initial;
    while (at < end) {
      if (this.writing) throw new Error('Cannot read active scratch writer.');
      const buffer = Buffer.allocUnsafe(Math.min(size, end - at));
      let bytesRead: number;
      if (at >= this.writer.written) {
        bytesRead = Math.min(buffer.length, this.end - at);
        buffer.set(this.writer.pending(at, at + bytesRead));
      } else {
        bytesRead = await this.readPhysical(buffer, at);
      }
      at += bytesRead;
      yield buffer.subarray(0, bytesRead);
      size = Math.min(size * 2, 65536);
    }
  }
  async record(offset: number): Promise<{ value: Value; release: () => void; bytes: number }> {
    if (
      this.closed ||
      this.parked ||
      this.failed ||
      this.writing ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= this.end
    )
      throw new Error('Invalid scratch offset.');
    for await (const row of decodeRecords(this.bytes(offset, this.end, 256))) {
      this.store.root.work.metadataRowsRead++;
      return {
        value: row.value,
        release: this.budget.holdRecord(row.raw.length),
        bytes: row.raw.length,
      };
    }
    throw new Error('Missing scratch record.');
  }
  async *rows(
    start: number,
    end: number,
    encoded?: (bytes: Buffer) => void,
  ): AsyncGenerator<Value> {
    if (
      this.closed ||
      this.parked ||
      this.failed ||
      this.writing ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      end > this.end
    )
      throw new Error('Invalid scratch span.');
    for await (const row of decodeRecords(this.bytes(start, end))) {
      this.store.root.work.metadataRowsRead++;
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
    if (this.owner || this.writing || this.physicalReaders > 0)
      throw new Error('Cannot close active scratch.');
    this.releaseReadCache();
    this.writer.dispose(); // Unpublished scratch has no readers; pending bytes can be discarded.
    this.closed = true;
    let expected: ReturnType<typeof nativeIdentity> | undefined;
    let failure: unknown;
    try {
      expected = this.parked
        ? this.fileNative
        : nativeIdentity(await this.handle.stat({ bigint: true }));
    } catch (error) {
      failure = error;
    }
    try {
      if (!this.parked) await this.handle.close();
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
  }
}
