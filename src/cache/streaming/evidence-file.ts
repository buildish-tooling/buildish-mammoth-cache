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

import { withAbort } from './abort';
import { filePathSchema } from './schema';
import { lstat, type FileHandle } from 'node:fs/promises';
import { decodeRecords, add, equal, type Value } from './encoding';
import { readLocalRows, type LocalRow } from './local-stream';
import { nativeIdentity, sameNative, type NativeIdentity } from './native';
import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';

const readers = new WeakSet<object>();

export interface EvidenceFileWork {
  validationBytes: number;
  rangeBytes: number;
  lookaheadBytes: number;
  reads: number;
}
/** A complete Q validation survives only in this process and this open native file. */
export class EvidenceFile {
  readonly work: EvidenceFileWork = {
    validationBytes: 0,
    rangeBytes: 0,
    lookaheadBytes: 0,
    reads: 0,
  };
  private headerEnd = 0;
  private footerStart = 0;
  private closed = false;
  private busy = false;
  private constructor(
    private readonly store: OwnedStore,
    readonly reference: Reference,
    readonly partition: string,
    private readonly handle: FileHandle,
    private readonly identity: NativeIdentity,
    private readonly budget: WorkingBudget,
    private readonly releaseContext: () => void,
  ) {}
  // Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
  static async open(
    store: OwnedStore,
    reference: Value,
    partition: string,
    budget: WorkingBudget,
    signal = new AbortController().signal,
    observed?: (row: LocalRow) => Promise<void>,
    maxDirectoryEntries = 100000,
  ): Promise<EvidenceFile> {
    const ref = Object.freeze(
      store.codec.schemas.ref('native-evidence').parse(reference),
    ) as Reference;
    store.codec.schemas.partition.parse(partition);
    signal.throwIfAborted();
    const releaseContext = budget.holdRecord(1024 + Buffer.byteLength(ref[2]));
    let opened: Awaited<ReturnType<typeof store.root.openRead>>;
    try {
      opened = await store.root.openRead(ref[2]);
    } catch (error) {
      releaseContext();
      throw error;
    }
    const { handle, identity } = opened;
    const reader = new EvidenceFile(
      store,
      ref,
      partition,
      handle,
      identity,
      budget,
      releaseContext,
    );
    try {
      if (BigInt(identity[5]) !== BigInt(ref[3])) throw new Error('Evidence file length mismatch.');
      const proof = store.completedStream(reference);
      if (
        proof &&
        proof.purpose === 'native-evidence' &&
        proof.partition === partition &&
        proof.maxDirectoryEntries === maxDirectoryEntries
      ) {
        if (!sameNative(proof.native, identity, true))
          throw new Error('Completed evidence metadata changed.');
        reader.headerEnd = proof.headerEnd;
        reader.footerStart = proof.footerStart;
        if (observed) {
          let record = 0;
          for await (const row of decodeRecords(
            reader.range(0, ref[3], 'validationBytes', signal),
          )) {
            const release = budget.holdRecord(row.raw.length);
            try {
              store.root.work.metadataRowsRead++;
              await withAbort(
                observed({ value: row.value, start: row.start, end: row.end, record: record++ }),
                signal,
              );
            } finally {
              release();
            }
          }
        }
      } else {
        store.root.work.metadataValidations++;
        for await (const row of readLocalRows(
          reader.range(0, ref[3], 'validationBytes', signal),
          'native-evidence',
          { codec: store.codec, budget, partition, maxDirectoryEntries },
          ref,
          signal,
        )) {
          store.root.work.metadataRowsRead++;
          const value = row.value as readonly Value[];
          if (value[0] === 'local-stream') reader.headerEnd = row.end;
          if (value[0] === 'local-end') reader.footerStart = row.start;
          if (observed) await withAbort(observed(row), signal);
        }
      }
      await reader.stable();
      signal.throwIfAborted();
      readers.add(reader);
      return reader;
    } catch (error) {
      await reader.close();
      throw error;
    }
  }
  static assert(reader: EvidenceFile, store: OwnedStore, partition: string) {
    if (
      !readers.has(reader) ||
      reader.closed ||
      reader.store !== store ||
      reader.partition !== partition
    )
      throw new Error('Unbound native evidence reader.');
  }
  private async stable(): Promise<void> {
    if (this.closed) throw new Error('Evidence reader is closed.');
    this.store.root.work.stats += 2;
    const handle = nativeIdentity(await this.handle.stat({ bigint: true }));
    // The owned metadata path is fixed; do not repeat an ancestor inventory per member.
    const named = nativeIdentity(
      await lstat(this.store.root.resolve(this.reference[2]), { bigint: true }),
    );
    if (!sameNative(this.identity, handle, true) || !sameNative(this.identity, named, true))
      throw new Error('Evidence file identity changed.');
  }
  private async *range(
    start: number,
    end: number,
    kind: keyof Pick<EvidenceFileWork, 'validationBytes' | 'rangeBytes' | 'lookaheadBytes'>,
    signal: AbortSignal,
    initial = 65536,
  ): AsyncGenerator<Buffer> {
    let position = start,
      size = initial;
    while (position < end) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(size, end - position));
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, position);
      this.work.reads++;
      if (!bytesRead) throw new Error('Truncated evidence file range.');
      this.work[kind] = add(this.work[kind], bytesRead);
      this.store.root.work.readBytes = add(this.store.root.work.readBytes, bytesRead);
      position = add(position, bytesRead);
      yield buffer.subarray(0, bytesRead);
      size = Math.min(65536, size * 2);
    }
  }
  private async after(end: number, root: string, signal: AbortSignal): Promise<void> {
    for await (const row of decodeRecords(
      this.range(end, this.reference[3], 'lookaheadBytes', signal, 256),
    )) {
      const release = this.budget.holdRecord(row.raw.length);
      try {
        const value = row.value as readonly Value[];
        if (value[0] === 'local-end') {
          if (end !== this.footerStart) throw new Error('Unexpected evidence footer boundary.');
        } else if (
          typeof value[1] !== 'string' ||
          value[1] === root ||
          String(value[1]).startsWith(root + '/')
        )
          throw new Error('Incomplete evidence subtree span.');
        return;
      } finally {
        release();
      }
    }
    throw new Error('Missing outside evidence member.');
  }
  /** Provisional visits: require full success before mutation. Caller proves per-side
   * nonoverlap and physical native ownership; one reader never establishes these alone. */
  async member(
    binding: Value,
    path: string,
    kind: 'file' | 'directory' | null,
    visit: (row: Value, signal: AbortSignal) => Promise<void>,
    signal = new AbortController().signal,
  ): Promise<'file' | 'directory'> {
    filePathSchema.parse(path);
    if (this.closed || this.busy) throw new Error('Evidence reader unavailable or already active.');
    const evidence = this.store.codec.schemas.memberEvidence.parse(binding);
    equal(evidence[1], this.reference, 'evidence reader reference');
    const [, , start, end] = evidence[2];
    if (start < this.headerEnd || end > this.footerStart)
      throw new Error('Evidence span includes framing.');
    this.busy = true;
    try {
      await this.stable();
      // Canonical strings cannot contain physical LF: a preceding LF proves record start.
      for await (const byte of this.range(start - 1, start, 'rangeBytes', signal))
        if (byte[0] !== 10) throw new Error('Evidence span starts inside a record.');
      let count = 0,
        actualKind = kind;
      for await (const record of decodeRecords(this.range(start, end, 'rangeBytes', signal))) {
        const release = this.budget.holdRecord(record.raw.length);
        try {
          const row = record.value as readonly Value[];
          if (count === 0) {
            if (actualKind === null && (row[0] === 'file' || row[0] === 'directory'))
              actualKind = row[0];
            if (row[0] !== actualKind || row[1] !== path)
              throw new Error('Wrong evidence span member.');
          } else if (
            actualKind === 'file' ||
            typeof row[1] !== 'string' ||
            !row[1].startsWith(path + '/')
          )
            throw new Error('Evidence span escapes member.');
          count = add(count);
          signal.throwIfAborted();
          await withAbort(visit(record.value, signal), signal);
          signal.throwIfAborted();
        } finally {
          release();
        }
      }
      if (!count) throw new Error('Empty evidence member span.');
      if (actualKind === 'directory') await this.after(end, path, signal);
      await this.stable();
      signal.throwIfAborted();
      if (actualKind === null) throw new Error('Missing member kind.');
      return actualKind;
    } finally {
      this.busy = false;
    }
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        await this.handle.close();
      } finally {
        this.releaseContext();
      }
    }
  }
}
