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

import { EvidenceFile } from './evidence-file';
import { InstallScratch } from './install-scratch';
import { IndexDirectories, buildInstallIndex, indexedEntries } from './install-index';
import { RelocationProgram, type MoveRow } from './relocation-program';
import { settleBaseCleanup } from './base-object';
import { Digest } from './encoding';
import type { NativeIdentity } from './native';

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans.
// Private disk hierarchy of the bound post-GC Q. Active parent pages only; no
// payload reads or mutable authority. Full Q/EOF is admitted before member ranges.
export class RelocationSource {
  private busy = false;
  private closing = false;
  private closed = false;
  private failedClose = false;
  private constructor(
    readonly program: RelocationProgram,
    readonly evidence: EvidenceFile,
    private readonly scratch: InstallScratch,
    private readonly directories: IndexDirectories,
  ) {}
  static async open(program: RelocationProgram) {
    RelocationProgram.assert(program);
    const { store, options } = program.publication,
      scratch = await InstallScratch.create(store, options.budget);
    let evidence: EvidenceFile | undefined;
    try {
      evidence = await EvidenceFile.open(
        store,
        program.source,
        program.partition,
        options.budget,
        options.signal,
        undefined,
        options.maxDirectoryEntries,
      );
      const root = await buildInstallIndex(
        scratch,
        store.rows(
          program.source,
          'native-evidence',
          { ...options, partition: program.partition },
          options.signal,
        ),
        store.codec.options.model,
        program.partition,
        options.signal,
      );
      return new RelocationSource(program, evidence, scratch, new IndexDirectories(scratch, root));
    } catch (error) {
      await settleBaseCleanup([() => evidence?.close(), () => scratch.close()], error);
      throw error;
    }
  }
  private async lookup<T>(read: () => Promise<T>): Promise<T> {
    if (this.busy || this.closing || this.closed || this.failedClose)
      throw new Error('Relocation source unavailable or lookup active.');
    this.busy = true;
    try {
      return await read();
    } finally {
      this.busy = false;
    }
  }
  async member(move: MoveRow) {
    return this.lookup(async () => {
      const lease = await this.directories.member(move[4]);
      if (!lease) throw new Error('Move absent from bound post-GC source.');
      try {
        if (lease.node[1] !== move[5]) throw new Error('Wrong post-GC move member kind.');
        return {
          native: structuredClone(lease.node[3]) as NativeIdentity,
          span: ['span', this.program.source[4], lease.node[9], lease.node[10]] as const,
        };
      } finally {
        lease.release();
      }
    });
  }
  async directory(path: string) {
    return this.lookup(async () => {
      const n = await this.directories.directory(path);
      return n ? (structuredClone(n[3]) as NativeIdentity) : null;
    });
  }
  async projection(path: string): Promise<string> {
    return this.lookup(async () => {
      const n = await this.directories.directory(path);
      if (!n) throw new Error('Missing source projection directory.');
      const digest = new Digest('ancestor-children');
      for await (const edge of indexedEntries(this.scratch, n)) {
        this.program.publication.options.signal?.throwIfAborted();
        digest.update([edge[0], edge[1]]);
      }
      return digest.digest();
    });
  }
  async close() {
    if (this.closed) return;
    if (this.busy || this.closing) throw new Error('Relocation source lookup/cleanup active.');
    this.closing = true;
    try {
      this.directories.close();
      await settleBaseCleanup([() => this.evidence.close(), () => this.scratch.close()]);
      this.closed = true;
    } catch (error) {
      this.failedClose = true;
      throw error;
    } finally {
      this.closing = false;
    }
  }
}
