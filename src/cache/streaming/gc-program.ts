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

import { Digest, encodeRecord, equal, tuple, type Value } from './encoding';
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
export type GcBatch = ['gc-batch', number, number, number, number, number, number, number];
// Batch cells: unit-spool start/end, observation nextByte/nextRecord/boundary,
// frame-spool start/end. Ephemeral metadata; only sealed evidence grants authority.
export class GcProgram {
  private constructor(
    readonly index: ObservationIndex,
    readonly units: InstallScratch,
    readonly batches: InstallScratch,
    readonly stacks: InstallScratch,
    readonly final: GcCursor,
  ) {}
  static async create(
    index: ObservationIndex,
    limits: { operations?: number; bytes?: number } = {},
    checkpoints: readonly GcCursor[] = [],
  ): Promise<GcProgram> {
    const operations = limits.operations ?? 16384,
      bytes = limits.bytes ?? 8 * 1024 * 1024;
    if (![operations, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid GC batch thresholds.');
    const store = index.store,
      options = index.options,
      signal = options.signal,
      units = await InstallScratch.create(store, options.budget);
    let batches: InstallScratch | undefined, stacks: InstallScratch | undefined;
    const frames: { row: Frame; release: () => void }[] = [];
    let start = 0,
      count = 0,
      encoded = 0,
      boundary = 0,
      final: GcCursor | undefined,
      unit: readonly Value[] | null = null,
      unitDelete = false;
    const checked = checkpoints.map(() => false);
    try {
      batches = await InstallScratch.create(store, options.budget);
      stacks = await InstallScratch.create(store, options.budget);
      const check = async (end: number, record: number) => {
        for (let i = 0; i < checkpoints.length; i++) {
          const c = checkpoints[i];
          if (c[2] !== end) continue;
          equal(
            c.slice(0, 5),
            ['cursor', index.reference[4], end, record, boundary],
            'original GC cursor boundary',
          );
          if (!frames.length) {
            if (c[5] !== null) throw new Error('Unexpected GC cursor stack.');
          } else {
            if (c[5] === null) throw new Error('Missing GC cursor stack.');
            let n = 0;
            for await (const item of store.rows(
              c[5],
              'cursor-stack',
              { ...options, partition: null },
              signal,
            )) {
              const r = tuple(item.value);
              if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
              if (!frames[n]) throw new Error('Extra GC cursor frame.');
              equal(r, frames[n++].row, 'original GC cursor frame');
            }
            if (n !== frames.length) throw new Error('Missing GC cursor frame.');
          }
          checked[i] = true;
        }
      };
      for (let i = 0; i < checkpoints.length; i++)
        if (checkpoints[i][2] === 0) {
          equal(checkpoints[i], ['cursor', index.reference[4], 0, 0, 0, null], 'initial GC cursor');
          checked[i] = true;
        }
      const flush = async (end: number, record: number) => {
        const a = stacks!.position;
        for (const f of frames) await stacks!.append(f.row);
        await batches!.append([
          'gc-batch',
          start,
          units.position,
          end,
          record,
          boundary,
          a,
          stacks!.position,
        ]);
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
        await check(end, record);
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
                r[6] === 'delete',
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
              await check(item.end, item.record + 1);
              // Includes an empty/retained suffix and the final root boundary.
              await flush(item.end, item.record + 1);
            }
            break;
        }
      }
      if (!final || checked.some((x) => !x))
        throw new Error('GC cursor is not an original semantic boundary.');
      return new GcProgram(index, units, batches, stacks, final);
    } catch (e) {
      await Promise.allSettled([units.close(), batches?.close(), stacks?.close()]);
      throw e;
    } finally {
      for (const f of frames) f.release();
    }
  }
  get initial(): GcCursor {
    return ['cursor', this.index.reference[4], 0, 0, 0, null];
  }
  async cursor(batch: GcBatch): Promise<GcCursor> {
    let stack: Reference | null = null;
    if (batch[6] !== batch[7])
      stack = await this.index.store.writeStream(
        'cursor-stack',
        { ...this.index.options, partition: null },
        this.stacks.rows(batch[6], batch[7]),
        this.index.options.signal,
      );
    return ['cursor', this.index.reference[4], batch[3], batch[4], batch[5], stack];
  }
  async *evidence(start: number, end: number): AsyncGenerator<Value> {
    yield ['gc-context', this.index.reference];
    for await (const v of this.units.rows(start, end)) {
      const r = tuple(v),
        header = tuple(r[1]),
        digest = new Digest('gc-unit');
      digest.update(header);
      yield header;
      for await (const m of originalGcMembers(this.index, header)) {
        m.accept?.();
        digest.update(m.row);
        yield m.row;
      }
      yield ['gc-unit-close', header[1], header[2], digest.digest()];
    }
  }
  async close() {
    const results = await Promise.allSettled([
      this.units.close(),
      this.batches.close(),
      this.stacks.close(),
    ]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'GC program cleanup failed.',
      );
  }
}
