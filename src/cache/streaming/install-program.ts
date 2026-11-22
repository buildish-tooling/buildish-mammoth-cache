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

import { decodeRecords, equal, type Value } from './encoding';
import { EvidenceFile } from './evidence-file';
import { InstallScratch } from './install-scratch';
import type { InstallAdmission } from './install-admission';
import type { InstallCursor } from './install-batches';
import type { OwnedStore, Reference } from './owned-store';
import { NativeHashBuffer } from './native-read-phase';
import type { WorkingBudget } from './tree-state';

export type InstallBatch = readonly ['batch', InstallCursor, InstallCursor, number, number];
export class InstallReaders {
  readonly hashes: NativeHashBuffer;
  private readonly readers = new Map<string, EvidenceFile>();
  private readonly owned = new Set<EvidenceFile>();
  private readonly preimages = new Map<string, Reference>();
  get preimageReferences(): Reference[] {
    return [...this.preimages.values()];
  }
  kind: 'file' | 'directory' = 'file';
  constructor(
    readonly store: OwnedStore,
    readonly budget: WorkingBudget,
    readonly maxDirectoryEntries: number,
    admission?: InstallAdmission,
    readonly allowOld = false,
  ) {
    this.hashes = new NativeHashBuffer(budget);
    for (const reader of [...(admission?.source ?? []), ...(admission?.old ?? [])])
      if (reader) this.readers.set(reader.reference[2], reader);
  }
  async reader(binding: Value, signal: AbortSignal) {
    const e = this.store.codec.schemas.memberEvidence.parse(binding),
      ref = e[1];
    const existing = this.readers.get(ref[2]);
    if (existing) {
      equal(existing.reference, ref, 'native reference');
      return existing;
    }
    if (this.readers.size >= this.store.codec.options.model.partitions.length * 2)
      throw new Error('More than one source/preimage reference per partition.');
    // The first row is only a bounded partition hint. EvidenceFile verifies the
    // entire header, raw reference, grammar and EOF before this reader escapes.
    let partition: string | undefined;
    for await (const record of decodeRecords(this.store.root.read(ref[2]))) {
      const row = record.value;
      if (!Array.isArray(row) || row[0] !== 'local-stream')
        throw new Error('Missing native header.');
      partition = this.store.codec.schemas.partition.parse(row[6]);
      break;
    }
    if (!partition) throw new Error('Empty native reference.');
    const reader = await EvidenceFile.open(
      this.store,
      ref,
      partition,
      this.budget,
      signal,
      undefined,
      this.maxDirectoryEntries,
    );
    this.readers.set(ref[2], reader);
    this.owned.add(reader);
    return reader;
  }
  async before(value: Value, signal: AbortSignal) {
    if (!Array.isArray(value) || value[0] !== 'install') return;
    const op = this.store.codec.schemas.rows.install.parse(value);
    if (!this.allowOld && op[6] !== 'insert')
      throw new Error('Replacement/deletion slice not enabled.');
    let source: EvidenceFile | null = null,
      old: EvidenceFile | null = null;
    if (op[4]) source = await this.reader(op[4], signal);
    if (op[5]) {
      old = await this.reader(op[5], signal);
      this.preimages.set(old.reference[2], old.reference);
    }
    if (source && old && source.partition !== old.partition)
      throw new Error('Mixed source/preimage partitions.');
    if (source && op[3] !== this.store.prefix + 'install/' + source.partition + '/' + op[2])
      throw new Error('Unbound disposable source path.');
    if (op[7] !== null && op[7] !== this.store.prefix + 'backups/' + op[1])
      throw new Error('Unbound backup path.');
    const binding = (op[4] ?? op[5])!;
    const reader = (source ?? old)!;
    this.kind = await reader.member(binding, op[2], null, async () => {}, signal);
  }
  async close() {
    this.hashes.dispose();
    const results = await Promise.allSettled([...this.owned].map((r) => r.close()));
    this.owned.clear();
    this.readers.clear();
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((r) => r.reason),
        'Install reader cleanup failed.',
      );
  }
}

/** One verified plan pass; fixed-size batch descriptors and operation bytes spool sequentially. */
export class InstallProgram {
  private constructor(
    readonly store: OwnedStore,
    readonly plan: Reference,
    readonly readers: InstallReaders,
    readonly rows: InstallScratch,
    readonly batches: InstallScratch,
    readonly context: Reference,
    readonly initial: InstallCursor,
    readonly end: InstallCursor,
  ) {}
  static async create(
    store: OwnedStore,
    plan: Reference,
    readers: InstallReaders,
    signal: AbortSignal,
    targets = { operations: 16384, bytes: 8 * 1024 * 1024 },
  ): Promise<InstallProgram> {
    if (![targets.operations, targets.bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid install batch targets.');
    const rows = await InstallScratch.create(store, readers.budget);
    let batches: InstallScratch | undefined;
    try {
      batches = await InstallScratch.create(store, readers.budget);
      let context: Reference | undefined,
        initial: InstallCursor | undefined,
        end: InstallCursor | undefined;
      let unitStart: InstallCursor | undefined,
        unitOffset = 0,
        unitOperations = 0;
      let batch: InstallBatch | undefined,
        batchOperations = 0,
        boundary = 0;
      for await (const record of store.rows(
        plan,
        'install-plan',
        {
          budget: readers.budget,
          partition: null,
          maxDirectoryEntries: readers.maxDirectoryEntries,
          installKind: () => readers.kind,
        },
        signal,
        (v) => readers.before(v, signal),
      )) {
        const value = record.value as readonly Value[];
        if (value[0] === 'install-context') {
          context = store.codec.schemas.ref('install-current').parse(value[1]);
          initial = ['cursor', plan[4], record.end, record.record + 1, 0, null];
          end = initial;
        }
        if (value[0] === 'install-unit-open') {
          unitStart = ['cursor', plan[4], record.start, record.record, boundary, null];
          unitOffset = rows.position;
          unitOperations = 0;
        }
        if (value[0] === 'install' || value[0] === 'install-parent') unitOperations++;
        if (
          value[0] !== 'local-stream' &&
          value[0] !== 'local-end' &&
          value[0] !== 'install-context'
        )
          await rows.append(record.value);
        if (value[0] === 'install-unit-close') {
          if (!unitStart) throw new Error('Missing unit start.');
          end = ['cursor', plan[4], record.end, record.record + 1, ++boundary, null];
          await batches.append(['unit-boundary', unitStart, end, unitOffset, rows.position]);
          if (
            batch &&
            (batchOperations + unitOperations > targets.operations ||
              record.end - batch[1][2] > targets.bytes)
          ) {
            await batches.append(batch);
            batch = undefined;
            batchOperations = 0;
          }
          batch = batch
            ? ['batch', batch[1], end, batch[3], rows.position]
            : ['batch', unitStart, end, unitOffset, rows.position];
          batchOperations += unitOperations;
        }
      }
      if (batch) await batches.append(batch);
      if (!context || !initial || !end) throw new Error('Missing install context.');
      signal.throwIfAborted();
      return new InstallProgram(store, plan, readers, rows, batches, context, initial, end);
    } catch (error) {
      await Promise.allSettled([rows.close(), batches?.close()]);
      throw error;
    }
  }
  async range(start: InstallCursor, end: InstallCursor): Promise<InstallBatch> {
    let first: number | undefined, last: number | undefined;
    for await (const value of this.batches.rows(0, this.batches.position)) {
      const row = value as readonly Value[];
      if (row[0] !== 'unit-boundary') continue;
      if (JSON.stringify(row[1]) === JSON.stringify(start)) first = Number(row[3]);
      if (JSON.stringify(row[2]) === JSON.stringify(end)) last = Number(row[4]);
    }
    if (first === undefined || last === undefined || last < first)
      throw new Error('Intent is not an actual complete-unit plan range.');
    return ['batch', start, end, first, last];
  }
  async *batchRows(batch: InstallBatch) {
    yield ['install-context', this.context] as Value;
    yield* this.rows.rows(batch[3], batch[4]);
  }
  async close() {
    const results = await Promise.allSettled([this.rows.close(), this.batches.close()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        'Program scratch cleanup failed.',
      );
  }
}
