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

import { equal, type Value } from './encoding';
import { InstallScratch } from './install-scratch';
import type { InstallAdmission } from './install-admission';
import type { OwnedStore, Reference } from './owned-store';
import type { MetadataInstallContext } from './metadata-install-context';
import type { WorkingBudget } from './tree-state';

export type InstallBatch = readonly ['batch', number, number];
export class InstallReaders {
  kind: 'file' | 'directory' = 'file';
  private readonly metadata: MetadataInstallContext;
  constructor(
    readonly store: OwnedStore,
    readonly budget: WorkingBudget,
    readonly maxDirectoryEntries: number,
    admission: InstallAdmission,
  ) {
    admission.assert(store);
    this.metadata = admission.frozen.metadata;
  }
  async reader(binding: Value, signal: AbortSignal) {
    signal.throwIfAborted();
    this.metadata.assert(this.store);
    return this.metadata.reader(binding);
  }
  async close() {
    /* Original context/index lifetime belongs to admission. */
  }
}

/** Batches already-admitted operations and their original native facts; no source-span replay. */
export class InstallProgram {
  private constructor(
    readonly store: OwnedStore,
    readonly plan: Reference,
    readonly readers: InstallReaders,
    readonly rows: InstallScratch,
    readonly batches: InstallScratch,
  ) {}
  static async create(
    store: OwnedStore,
    plan: Reference,
    readers: InstallReaders,
    signal: AbortSignal,
    targets = { operations: 16384, bytes: 8 * 1024 * 1024 },
    admission?: InstallAdmission,
  ): Promise<InstallProgram> {
    if (!admission) throw new Error('Install program requires admitted operations.');
    admission.assert(store);
    equal(plan, admission.frozen.plan, 'admitted install plan');
    if (![targets.operations, targets.bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid install batch targets.');
    const rows = admission.operations;
    let batches: InstallScratch | undefined;
    try {
      batches = await InstallScratch.create(store, readers.budget);
      let start = 0,
        unitStart = 0,
        unitOperations = 0,
        operations = 0,
        units = 0;
      for await (const page of rows.batches(0, rows.position, signal))
        for (const frame of page) {
          const accepted = frame.value;
          signal.throwIfAborted();
          const item = accepted as readonly Value[],
            row = item[1] as readonly Value[],
            tag = row[0];
          if (tag === 'local-stream' || tag === 'local-end' || tag === 'install-context') continue;
          if (tag === 'install-unit-open') {
            unitStart = frame.start;
            unitOperations = 0;
          }
          if (tag === 'install' || tag === 'install-parent') unitOperations++;
          if (tag === 'install-unit-close') {
            if (
              units > 0 &&
              (operations + unitOperations > targets.operations ||
                frame.end - start > targets.bytes)
            ) {
              await batches.append(['batch', start, unitStart]);
              start = unitStart;
              operations = 0;
              units = 0;
            }
            operations += unitOperations;
            units++;
          }
        }
      if (rows.position > start) await batches.append(['batch', start, rows.position]);
      signal.throwIfAborted();
      return new InstallProgram(store, plan, readers, rows, batches);
    } catch (error) {
      await Promise.allSettled([batches?.close()]);
      throw error;
    }
  }
  async *batchRows(batch: InstallBatch) {
    yield* this.rows.rows(batch[1], batch[2]);
  }
  async close() {
    const results = await Promise.allSettled([this.batches.close()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        'Program scratch cleanup failed.',
      );
  }
}
