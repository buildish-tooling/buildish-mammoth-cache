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

import type { FileHandle } from 'node:fs/promises';
import { add } from './encoding';
import type { WorkingBudget } from './tree-state';

// Private fixed-size write buffer. Ownership never escapes the operation's budget.
export class BufferedWriter {
  static readonly capacity = 65536;
  private buffer?: Buffer;
  private used = 0;
  private failed = false;
  private busy = false;
  private disposed = false;
  private logical: number;
  private physical: number;

  constructor(
    private readonly handle: FileHandle,
    private readonly budget: WorkingBudget,
    private readonly wrote: (bytes: number) => void,
    initial = 0,
    private readonly writeCall: () => void = () => {},
    private readonly beforeFlush?: () => Promise<void>,
    private readonly afterFlush?: () => Promise<void>,
  ) {
    this.logical = initial;
    this.physical = initial;
  }

  get position() {
    return this.logical;
  }

  get written() {
    return this.physical;
  }

  pending(start: number, end: number): Buffer {
    if (
      this.disposed ||
      this.failed ||
      start < this.physical ||
      end > this.logical ||
      end < start
    ) {
      throw new Error('Invalid buffered read.');
    }
    return this.buffer!.subarray(start - this.physical, end - this.physical);
  }

  /** Memory-only fast path; false leaves the caller's bytes untouched for async flush. */
  tryAppend(bytes: Uint8Array): boolean {
    if (this.disposed || this.failed || this.busy) {
      throw new Error('Unavailable buffered writer.');
    }
    if (bytes.byteLength > BufferedWriter.capacity - this.used) {
      return false;
    }
    try {
      if (!this.buffer && bytes.byteLength) {
        this.budget.retain(BufferedWriter.capacity);
        this.buffer = Buffer.allocUnsafe(BufferedWriter.capacity);
      }
      this.buffer?.set(bytes, this.used);
      this.used += bytes.byteLength;
      this.logical = add(this.logical, bytes.byteLength);
      return true;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async append(bytes: Uint8Array): Promise<void> {
    if (this.tryAppend(bytes)) {
      return;
    }
    if (this.disposed || this.failed || this.busy) {
      throw new Error('Unavailable buffered writer.');
    }
    this.busy = true;
    try {
      if (!this.buffer) {
        this.budget.retain(BufferedWriter.capacity);
        this.buffer = Buffer.allocUnsafe(BufferedWriter.capacity);
      }
      let at = 0;
      while (at < bytes.byteLength) {
        const count = Math.min(bytes.byteLength - at, this.buffer.length - this.used);
        this.buffer.set(bytes.subarray(at, at + count), this.used);
        this.used += count;
        at += count;
        this.logical = add(this.logical, count);
        if (this.used === this.buffer.length) {
          await this.flushBytes();
        }
      }
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async flush(): Promise<void> {
    if (this.disposed || this.failed || this.busy) {
      throw new Error('Unavailable buffered writer.');
    }
    this.busy = true;
    try {
      await this.flushBytes();
    } finally {
      this.busy = false;
    }
  }

  private async flushBytes(): Promise<void> {
    try {
      if (this.used) {
        await this.beforeFlush?.();
      }
      let at = 0;
      while (at < this.used) {
        this.writeCall();
        const result = await this.handle.write(this.buffer!, at, this.used - at, this.physical);
        if (
          !Number.isSafeInteger(result.bytesWritten) ||
          result.bytesWritten < 1 ||
          result.bytesWritten > this.used - at
        ) {
          throw new Error('Short buffered write.');
        }
        at += result.bytesWritten;
        this.physical = add(this.physical, result.bytesWritten);
        this.wrote(result.bytesWritten);
      }
      if (this.used) {
        await this.afterFlush?.();
      }
      this.used = 0;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  releaseBuffer(): void {
    if (this.busy) {
      throw new Error('Active buffered writer.');
    }
    if (this.used) {
      throw new Error('Pending buffered bytes.');
    }
    if (this.buffer) {
      this.budget.release(BufferedWriter.capacity);
      this.buffer = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    if (this.busy) {
      throw new Error('Active buffered writer.');
    }
    this.disposed = true;
    if (this.buffer) {
      this.budget.release(BufferedWriter.capacity);
      this.buffer = undefined;
    }
  }
}
