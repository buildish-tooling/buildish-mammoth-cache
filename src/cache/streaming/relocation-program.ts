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

import { add, equal, encodeRecord, tuple, type Value } from './encoding';
import { InstallScratch } from './install-scratch';
import { FrozenMovingPublication } from './base-moving-publication';
import type { OwnedStore, Reference } from './owned-store';
import type { BatchTargets } from './install-batches';
export type MoveRow = ReturnType<OwnedStore['codec']['schemas']['rows']['move']['parse']>;
export type MoveCursor = ['cursor', string, number, number, number, null];
export interface MoveRange {
  readonly start: MoveCursor;
  readonly end: MoveCursor;
  readonly rootsStart: number;
  readonly rootsEnd: number;
  readonly firstIndex: number;
  readonly lastIndex: number;
}
const programs = new WeakSet<object>();
type UnitRow = ['move-unit-range', MoveCursor, MoveCursor, number, number, number, number, number];
// Protocol: docs/dev/cache-lifecycle-protocol.md#partition-wide-relocation-marker.
// Full immutable plan/EOF first, then private complete-unit ranges. No native
// authority, per-root durable checkpoint, whole-prefix scan per batch or size quota.
export class RelocationProgram {
  private closed = false;
  private constructor(
    readonly publication: FrozenMovingPublication,
    readonly partition: string,
    readonly plan: Reference,
    readonly source: Reference,
    readonly roots: InstallScratch,
    readonly units: InstallScratch,
    readonly final: MoveCursor,
    readonly rootCount: number,
    private readonly limits: Required<BatchTargets>,
  ) {
    programs.add(this);
  }
  static assert(program: RelocationProgram) {
    if (!programs.has(program) || program.closed)
      throw new Error('Unavailable relocation program.');
    FrozenMovingPublication.assert(program.publication);
  }
  get initial(): MoveCursor {
    return ['cursor', this.plan[4], 0, 0, 0, null];
  }
  static async create(
    publication: FrozenMovingPublication,
    partition: string,
    checkpoints: readonly Value[] = [],
    limits: BatchTargets = {},
  ): Promise<RelocationProgram> {
    FrozenMovingPublication.assert(publication);
    const row = publication.choices.find((r) => r[1] === partition);
    if (row?.[0] !== 'new') throw new Error('Relocation requires a changed partition.');
    const plan = row[6],
      { store, options } = publication,
      operations = limits.operations ?? 16384,
      bytes = limits.bytes ?? 8 * 1024 * 1024;
    if (![operations, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('Invalid relocation batch thresholds.');
    if (checkpoints.length > 4) throw new Error('Relocation cursor frontier exceeded.');
    const cursors = checkpoints.map((c) => store.codec.schemas.cursor.parse(c)),
      found = cursors.map(() => false),
      initial: MoveCursor = ['cursor', plan[4], 0, 0, 0, null];
    for (let i = 0; i < cursors.length; i++) {
      if (cursors[i][1] !== plan[4] || cursors[i][5] !== null)
        throw new Error('Relocation cursor binding mismatch.');
      if (cursors[i][2] === 0) {
        equal(cursors[i], initial, 'initial relocation cursor');
        found[i] = true;
      }
    }
    const roots = await InstallScratch.create(store, options.budget);
    let units: InstallScratch | undefined,
      source: Reference | undefined,
      failure: unknown,
      final = initial,
      count = 0,
      boundary = 0,
      start: MoveCursor = initial,
      unitStart = 0,
      firstIndex = 0,
      encoded = 0,
      open = false;
    try {
      units = await InstallScratch.create(store, options.budget);
      for await (const item of store.rows(
        plan,
        'move-plan',
        { ...options, partition },
        options.signal,
      )) {
        const r = tuple(item.value);
        if (r[0] === 'local-stream')
          final = ['cursor', plan[4], item.end, item.record + 1, 0, null];
        else if (r[0] === 'move-source') {
          source = store.codec.schemas.ref('native-evidence').parse(r[1]);
          final = ['cursor', plan[4], item.end, item.record + 1, 0, null];
        } else if (r[0] === 'move-unit-open') {
          start = count === 0 ? initial : final;
          unitStart = roots.position;
          firstIndex = count + 1;
          encoded = encodeRecord(r).length;
          open = true;
        } else if (r[0] === 'move') {
          if (!open) throw new Error('Move outside complete unit.');
          await roots.append(store.codec.schemas.rows.move.parse(r));
          count++;
          encoded = add(encoded, encodeRecord(r).length);
        } else if (r[0] === 'move-unit-close') {
          encoded = add(encoded, encodeRecord(r).length);
          final = ['cursor', plan[4], item.end, item.record + 1, ++boundary, null];
          await units.append([
            'move-unit-range',
            start,
            final,
            unitStart,
            roots.position,
            firstIndex,
            count,
            encoded,
          ]);
          open = false;
          for (let i = 0; i < cursors.length; i++)
            if (cursors[i][2] === final[2]) {
              equal(cursors[i], final, 'actual complete relocation boundary');
              found[i] = true;
            }
        }
      }
      if (open) throw new Error('Unclosed relocation unit.');
      if (!source) throw new Error('Missing original transfer source.');
      // An empty transport plan has a complete header boundary, without a move.
      if (!count)
        for (let i = 0; i < cursors.length; i++)
          if (cursors[i][2] === final[2]) {
            equal(cursors[i], final, 'empty relocation boundary');
            found[i] = true;
          }
      if (found.some((x) => !x))
        throw new Error('Relocation cursor is not an actual complete boundary.');
      options.signal?.throwIfAborted();
      return new RelocationProgram(
        publication,
        partition,
        plan,
        source,
        roots,
        units,
        final,
        count,
        {
          operations,
          bytes,
        },
      );
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (failure !== undefined) await Promise.allSettled([roots.close(), units?.close()]);
    }
  }
  async index(cursor: MoveCursor): Promise<number> {
    this.publication.store.codec.schemas.cursor.parse(cursor);
    if (cursor[5] !== null) throw new Error('Relocation cursor must have an empty frame stack.');
    equal(cursor[1], this.plan[4], 'relocation root-count source');
    if (cursor[4] === 0) {
      if (cursor[2] !== 0) equal(cursor, this.final, 'empty relocation cursor');
      else equal(cursor, this.initial, 'initial relocation cursor');
      return 0;
    }
    for await (const v of this.units.rows(0, this.units.position)) {
      const u = v as UnitRow;
      if (u[2][4] === cursor[4]) {
        equal(u[2], cursor, 'relocation complete root boundary');
        return u[6];
      }
    }
    throw new Error('Unknown relocation cursor.');
  }
  async *ranges(from = this.initial, to = this.final): AsyncGenerator<MoveRange> {
    let current: MoveRange | undefined,
      operations = 0,
      bytes = 0;
    // One sequential reconstruction per direction/reload, not a unit scan per batch.
    for await (const v of this.units.rows(0, this.units.position)) {
      this.publication.options.signal?.throwIfAborted();
      const u = v as UnitRow;
      if (u[2][4] <= from[4]) continue;
      if (u[2][4] > to[4]) break;
      const n = u[6] - u[5] + 1;
      if (
        current &&
        (operations + n > this.limits.operations || bytes + u[7] > this.limits.bytes)
      ) {
        yield current;
        current = undefined;
        operations = 0;
        bytes = 0;
      }
      current = current
        ? { ...current, end: u[2], rootsEnd: u[4], lastIndex: u[6] }
        : {
            start: u[1],
            end: u[2],
            rootsStart: u[3],
            rootsEnd: u[4],
            firstIndex: u[5],
            lastIndex: u[6],
          };
      operations += n;
      bytes += u[7];
    }
    if (current) yield current;
  }
  async *moves(range: MoveRange): AsyncGenerator<MoveRow> {
    for await (const row of this.roots.rows(range.rootsStart, range.rootsEnd)) {
      this.publication.options.signal?.throwIfAborted();
      yield row as MoveRow;
    }
  }
  async close() {
    if (this.closed) return;
    const results = await Promise.allSettled([this.roots.close(), this.units.close()]),
      errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Relocation program cleanup failed.',
      );
    this.closed = true;
  }
}
