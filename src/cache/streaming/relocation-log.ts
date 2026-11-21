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

import { readLocalPrefix } from './local-stream';
import { InstallScratch } from './install-scratch';
import { tuple, type Value } from './encoding';
import type { OwnedStore, Prefix } from './owned-store';
import type { BaseObjectOptions } from './base-object';

// One committed-prefix reconstruction per reader/reload. Private spool rows stay
// provisional until the entire bound P has validated; never reread P per batch.
export async function relocationLog(
  store: OwnedStore,
  prefix: Prefix | null,
  partition: string,
  options: BaseObjectOptions,
) {
  const scratch = await InstallScratch.create(store, options.budget);
  try {
    if (prefix) {
      const n = await store.root.stat(prefix[2]);
      if (!n || BigInt(n[5]) < BigInt(prefix[3])) throw new Error('Missing relocation prefix.');
      const bytes = (async function* () {
        let left = prefix[3];
        for await (const chunk of store.root.read(prefix[2], n)) {
          if (left === 0) break;
          const size = Math.min(left, chunk.length);
          yield chunk.subarray(0, size);
          left -= size;
        }
      })();
      const result = await readLocalPrefix(
        bytes,
        prefix[1] as 'outbound-evidence' | 'return-evidence',
        { codec: store.codec, ...options, partition },
        prefix,
        async (value) => {
          if (tuple(value)[0] === 'transition') await scratch.append(value);
        },
        options.signal,
      );
      result.grammar.dispose();
    }
    return scratch;
  } catch (error) {
    await scratch.close();
    throw error;
  }
}
export class TransitionCursor {
  private readonly iterator;
  private head: IteratorResult<Value> | undefined;
  constructor(scratch: InstallScratch) {
    this.iterator = scratch.rows(0, scratch.position);
  }
  async take(index: number): Promise<readonly Value[] | null> {
    const next = this.head ?? (await this.iterator.next());
    this.head = undefined;
    if (next.done) return null;
    const row = tuple(next.value);
    if (Number(row[1]) < index) throw new Error('Unconsumed/foreign relocation transition.');
    if (Number(row[1]) > index) {
      this.head = next;
      return null;
    }
    return row;
  }
  async finish() {
    if (!(this.head ?? (await this.iterator.next())).done)
      throw new Error('Trailing relocation transition.');
  }
  async close() {
    await this.iterator.return(undefined);
  }
}
