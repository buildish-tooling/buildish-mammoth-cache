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
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { abortableValues } from './abort';
import { nativeIdentity, sameNative, type NativeIdentity, type NativeRoot } from './native';
import { parentPath } from './tree-state';
import { add } from './encoding';
// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence.
// Only an active, checked parent chain authorizes these scoped leaf reads.
export class NativeReadPhase {
  private readonly stack: string[] = [];
  constructor(
    private readonly root: NativeRoot,
    private readonly anchor = '',
  ) {}
  private async stat(path: string): Promise<NativeIdentity> {
    this.root.work.stats++;
    const raw = await lstat(path ? this.root.resolve(path) : this.root.path, { bigint: true });
    if (raw.isFile() && raw.nlink !== 1n)
      throw new Error('Aliased selected preimage is unsupported.');
    return nativeIdentity(raw);
  }
  private async matches(path: string, expected: NativeIdentity): Promise<void> {
    const actual = await this.stat(path);
    if (!sameNative(actual, expected, true)) throw new Error('Frozen native preimage changed.');
    if (actual[3] !== this.root.binding[3]) throw new Error('Cross-filesystem native preimage.');
  }
  async enter(path: string, expected: NativeIdentity): Promise<void> {
    if (
      expected[2] !== 'directory' ||
      (this.stack.length
        ? parentPath(path) !== this.stack[this.stack.length - 1]
        : path !== this.anchor)
    )
      throw new Error('Invalid active native parent chain.');
    await this.matches(path, expected);
    this.stack.push(path);
  }
  async leave(path: string, expected: NativeIdentity): Promise<void> {
    if (this.stack[this.stack.length - 1] !== path)
      throw new Error('Unbalanced native read phase.');
    await this.matches(path, expected);
    this.stack.pop();
  }
  async hash(
    path: string,
    expected: NativeIdentity,
    trusted: string | null,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (
      expected[2] !== 'file' ||
      !this.stack.length ||
      parentPath(path) !== this.stack[this.stack.length - 1]
    )
      throw new Error('Leaf has no checked native parent.');
    await this.matches(path, expected);
    if (trusted !== null) {
      signal.throwIfAborted();
      return trusted;
    }
    this.root.work.opens++;
    const handle = await open(
      this.root.resolve(path),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      this.root.work.stats++;
      if (!sameNative(expected, nativeIdentity(await handle.stat({ bigint: true })), true))
        throw new Error('Preimage changed on open.');
      const hash = createHash('sha256');
      for await (const chunk of abortableValues(
        handle.createReadStream({ autoClose: false, highWaterMark: 65536 }),
        signal,
      )) {
        hash.update(chunk);
        this.root.work.readBytes = add(this.root.work.readBytes, chunk.length);
      }
      this.root.work.stats++;
      if (!sameNative(expected, nativeIdentity(await handle.stat({ bigint: true })), true))
        throw new Error('Preimage changed during hash.');
      await this.matches(path, expected);
      signal.throwIfAborted();
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }
}
