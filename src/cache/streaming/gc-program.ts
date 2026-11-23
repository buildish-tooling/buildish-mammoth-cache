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

import { encodeRecord, tuple, type Value } from './encoding';
import { InstallScratch } from './install-scratch';
import { originalGcMembers } from './gc-metadata';
import type { ObservationIndex } from './observation-index';
import type { Reference } from './owned-store';

export type GcCursor = ['cursor', string, number, number, number, Reference | null];
type Frame = [
  'frame',
  number,
  string,
  'files' | 'directories',
  string | null,
  string | null,
  Value,
];
export type GcBatch = ['gc-batch', number, number];
// Batch cells: unit-spool start/end, observation nextByte/nextRecord/boundary,
// frame-spool start/end. Ephemeral work bound to the original process-owned index.
export class GcProgram {
  private constructor(
    readonly index: ObservationIndex,
    readonly units: InstallScratch,
    readonly batches: InstallScratch,
    readonly final: GcCursor,
  ) {}
  static async create(
    index: ObservationIndex,
    limits: { operations?: number; bytes?: number } = {},
  ): Promise<GcProgram> {
    const operations = limits.operations ?? 16384,
      bytes = limits.bytes ?? 8 * 1024 * 1024;
    if (![operations, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid GC batch thresholds.');
    const store = index.store,
      options = index.options,
      signal = options.signal,
      units = await InstallScratch.create(store, options.budget);
    let batches: InstallScratch | undefined;
    const frames: { row: Frame; release: () => void }[] = [];
    let start = 0,
      count = 0,
      encoded = 0,
      boundary = 0,
      final: GcCursor | undefined,
      unit: readonly Value[] | null = null,
      unitDelete = false;
    try {
      batches = await InstallScratch.create(store, options.budget);
      const flush = async (_end: number, _record: number) => {
        await batches!.append(['gc-batch', start, units.position]);
        start = units.position;
        count = 0;
        encoded = 0;
      };
      const finishUnit = async (
        header: readonly Value[],
        deleting: boolean,
        end: number,
        record: number,
      ) => {
        boundary++;
        if (deleting) {
          let targets = 0,
            size = encodeRecord(header).length;
          for await (const m of originalGcMembers(index, header)) {
            m.accept?.();
            size += encodeRecord(m.row).length;
            if (tuple(m.row)[0] === 'target') targets++;
          }
          await units.append(['gc-source-unit', header, end, record, boundary]);
          count += targets;
          encoded += size;
        }
        // Close only AFTER complete units: one oversized unit remains indivisible.
        if (count >= operations || encoded >= bytes) await flush(end, record);
      };
      for await (const item of store.rows(
        index.reference,
        'observations',
        { ...options, partition: null },
        signal,
      )) {
        signal?.throwIfAborted();
        const r = tuple(item.value),
          f = frames[frames.length - 1];
        switch (r[0]) {
          case 'dir-open': {
            const path = String(r[1]);
            if (f) {
              f.row[3] = 'directories';
              f.row[5] = path.slice(path.lastIndexOf('/') + 1);
            }
            frames.push({
              row: ['frame', frames.length, path, 'files', null, null, null],
              release: options.budget.holdRecord(512 + Buffer.byteLength(path)),
            });
            break;
          }
          case 'unit-open':
            if (unit) throw new Error('Nested GC observation units.');
            unit = ['gc-unit-open', ...r.slice(1, 4)];
            unitDelete = r[5] === 'delete';
            f.row[6] = r.slice(1, 4);
            break;
          case 'file': {
            f.row[4] = String(r[1]);
            if (!unit) {
              const path = f.row[2] ? f.row[2] + '/' + r[1] : String(r[1]);
              await finishUnit(
                ['gc-unit-open', 'file', path, 'file'],
                r[5] === 'delete',
                item.end,
                item.record + 1,
              );
            }
            break;
          }
          case 'unit-close':
            f.row[6] = null;
            if (!unit) throw new Error('Missing GC observation unit.');
            await finishUnit(unit, unitDelete, item.end, item.record + 1);
            unit = null;
            break;
          case 'dir-close':
            frames.pop()!.release();
            if (!frames.length) {
              boundary++;
              final = ['cursor', index.reference[4], item.end, item.record + 1, boundary, null];
              // Includes an empty/retained suffix and the final root boundary.
              await flush(item.end, item.record + 1);
            }
            break;
        }
      }
      if (!final) throw new Error('GC cursor is not an original semantic boundary.');
      return new GcProgram(index, units, batches, final);
    } catch (e) {
      await Promise.allSettled([units.close(), batches?.close()]);
      throw e;
    } finally {
      for (const f of frames) f.release();
    }
  }
  async *evidence(start: number, end: number): AsyncGenerator<Value> {
    yield ['gc-context', this.index.reference];
    for await (const v of this.units.rows(start, end)) {
      const r = tuple(v),
        header = tuple(r[1]);
      yield header;
      for await (const m of originalGcMembers(this.index, header)) {
        m.accept?.();
        yield m.row;
      }
      yield ['gc-unit-close', header[1], header[2]];
    }
  }
  async close() {
    const results = await Promise.allSettled([this.units.close(), this.batches.close()]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'GC program cleanup failed.',
      );
  }
}
