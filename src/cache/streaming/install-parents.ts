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

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { decodeRecord, encodeRecord, add, type Value } from './encoding';
import { retireOwnedDirectory } from './owned-retirement';
import { nativeIdentitySchema } from './local-schema';
import type { OwnedStore } from './owned-store';
import type { NativeIdentity } from './native';
import type { WorkingBudget } from './tree-state';
import { filePathSchema } from './schema';

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// This unpublished per-directory ledger is separate from flat EMPTY native objects.
// Only the final plan's inline bindings, never these lookup files, survive as authority.
export class InstallParents {
  readonly prefix: string;
  private constructor(
    private readonly store: OwnedStore,
    prefix: string,
    private readonly ledgerNative: NativeIdentity,
  ) {
    this.prefix = prefix;
  }
  static async create(store: OwnedStore): Promise<InstallParents> {
    const prefix = store.prefix + 'parents/' + randomUUID() + '/';
    await store.makeParents(prefix + 'ledger/pending');
    await store.makeParents(prefix + 'objects/pending');
    return new InstallParents(store, prefix, (await store.root.stat(prefix + 'ledger'))!);
  }
  async claim(logical: string): Promise<readonly [string, NativeIdentity] | null> {
    filePathSchema.parse(logical);
    const key = createHash('sha256').update(logical).digest('hex'),
      recordPath = this.prefix + 'ledger/' + key,
      source = this.prefix + 'objects/' + key;
    const existing = await this.store.root.stat(recordPath);
    if (existing) {
      if (BigInt(existing[5]) > 65536n) throw new Error('Oversized parent ledger record.');
      const chunks: Buffer[] = [];
      for await (const chunk of this.store.root.read(recordPath, existing)) chunks.push(chunk);
      const record = decodeRecord(Buffer.concat(chunks)) as readonly Value[];
      if (
        record[0] !== 'parent' ||
        record[1] !== logical ||
        record[2] !== source ||
        record[4] !== 1
      )
        throw new Error('Parent ledger identity/collision mismatch.');
      nativeIdentitySchema.parse(record[3]);
      return null;
    }
    await mkdir(this.store.root.resolve(source), { mode: 0o755 });
    await this.store.root.syncDirectory(source);
    const native = (await this.store.root.stat(source))!;
    const bytes = encodeRecord(['parent', logical, source, native, 1]);
    await writeFile(this.store.root.resolve(recordPath), bytes, { flag: 'wx', mode: 0o600 });
    this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, bytes.length);
    return [source, native];
  }
  async seal(budget: WorkingBudget): Promise<void> {
    await this.store.root.syncDirectory(this.prefix + 'objects');
    await retireOwnedDirectory(this.store, this.prefix + 'ledger', this.ledgerNative, budget);
  }
}
