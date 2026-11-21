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

import { InstallScratch } from './install-scratch';
import { IndexDirectories, buildInstallIndex, indexedEntries } from './install-index';
import type { RelocationRoots } from './relocation-roots';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { tuple } from './encoding';
import type { NativeIdentity } from './native';
import type { OwnedStore, Reference } from './owned-store';

// Immutable stage-directory baselines survive SDK/return interruption. The
// private hierarchy is metadata only; source-root membership stays in move plans.
export class StageDirectoryEvidence {
  private busy = false;
  private closed = false;
  private constructor(
    private readonly scratch: InstallScratch,
    private readonly pages: IndexDirectories,
    private readonly options: BaseObjectOptions,
  ) {}
  static async open(
    store: OwnedStore,
    reference: Reference,
    partition: string,
    options: BaseObjectOptions,
  ) {
    const q = store.codec.schemas.ref('stage-evidence').parse(reference),
      scratch = await InstallScratch.create(store, options.budget);
    try {
      const root = await buildInstallIndex(
        scratch,
        store.rows(q, 'stage-evidence', { ...options, partition }, options.signal),
        store.codec.options.model,
        partition,
        options.signal,
      );
      return new StageDirectoryEvidence(scratch, new IndexDirectories(scratch, root), options);
    } catch (error) {
      await settleBaseCleanup([() => scratch.close()], error);
      throw error;
    }
  }
  private async lookup<T>(read: () => Promise<T>): Promise<T> {
    if (this.busy || this.closed) throw new Error('Stage directory evidence unavailable/active.');
    this.busy = true;
    try {
      return await read();
    } finally {
      this.busy = false;
    }
  }
  directory(path: string) {
    return this.lookup(async () => {
      const node = await this.pages.directory(path);
      return node ? (structuredClone(node[3]) as NativeIdentity) : null;
    });
  }
  missingSyntheticChild(path: string, physical: string, shape: RelocationRoots) {
    return this.lookup(async () => {
      const node = await this.pages.directory(path);
      if (!node) throw new Error('Missing stage-directory baseline.');
      for await (const edge of indexedEntries(this.scratch, node)) {
        this.options.signal?.throwIfAborted();
        if (edge[1] !== 'directory') continue;
        const logical = path ? path + '/' + edge[0] : edge[0],
          claim = await shape.claim(logical);
        try {
          if (claim && tuple(claim.value)[0] === 'root') continue;
        } finally {
          claim?.release();
        }
        if (!(await this.scratch.store.root.stat(physical + '/' + edge[0]))) return true;
      }
      return false;
    });
  }
  async close() {
    if (this.busy) throw new Error('Stage-directory lookup active.');
    this.closed = true;
    this.pages.close();
    await this.scratch.close();
  }
}
