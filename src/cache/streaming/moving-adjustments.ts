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

import { RelocationRoots } from './relocation-roots';
import type { RelocationProgram } from './relocation-program';
import { type MoveRow } from './relocation-program';
import type { RelocationSource } from './relocation-source';
import { compareMembership } from './tree-state';
import { sameRename, type NativeIdentity } from './native';
import { equal, tuple, type Value } from './encoding';
import type { Reference } from './owned-store';

// Protocol: docs/dev/cache-lifecycle-protocol.md#stage-barrier-return-and-adjustments.
// Fully validated current metadata only, in a sparse private disk hierarchy. The
// caller must still check native root/complete ancestor projections before use.
export class MovingAdjustments {
  private constructor(
    readonly reference: Reference | null,
    private readonly roots: RelocationRoots,
    readonly highestEpoch: number,
  ) {
    if (reference) Object.freeze(reference);
    Object.freeze(this);
  }
  static async open(
    program: RelocationProgram,
    source: RelocationSource,
    reference: Reference | null,
  ) {
    const { store, options } = program.publication;
    let highest = 0;
    const moves = (async function* () {
        for await (const range of program.ranges()) yield* program.moves(range);
      })(),
      data = (async function* (): AsyncGenerator<readonly [string, Value]> {
        if (!reference) return;
        let head = await moves.next();
        for await (const item of store.rows(
          reference,
          'adjustments',
          { ...options, partition: program.partition },
          options.signal,
        )) {
          const row = tuple(item.value);
          if (row[0] === 'local-stream' || row[0] === 'local-end') continue;
          if (row[0] === 'ancestor-effect') {
            yield [String(row[1]), row];
            continue;
          }
          while (
            !head.done &&
            compareMembership(
              ['member', head.value[5] === 'file' ? 'file' : 'unit', head.value[4]],
              [
                'member',
                (row[3] as NativeIdentity)[2] === 'file' ? 'file' : 'unit',
                String(row[1]),
              ],
            ) < 0
          )
            head = await moves.next();
          if (head.done || head.value[4] !== row[1])
            throw new Error('Adjustment is not a frozen move root.');
          const move = head.value,
            fact = await source.member(move);
          equal(row[4], move[7], 'adjustment original source span');
          equal(row[5], move[6], 'adjustment portable span');
          if (!sameRename(fact.native, row[3] as NativeIdentity))
            throw new Error('Adjustment rewrote frozen source identity.');
          highest = Math.max(highest, Number(row[2]));
          yield [move[4], ['adjustment', row]];
          head = await moves.next();
        }
      })();
    try {
      const roots = await RelocationRoots.create(store, options.budget, data, options.signal);
      return new MovingAdjustments(reference, roots, highest);
    } finally {
      await data.return(undefined);
      await moves.return(undefined);
    }
  }
  async root(move: MoveRow): Promise<readonly Value[] | null> {
    const claim = await this.roots.claim(move[4]);
    try {
      const r = claim ? tuple(claim.value) : [];
      return r[0] === 'adjustment' ? structuredClone(tuple(r[1])) : null;
    } finally {
      claim?.release();
    }
  }
  async effect(path: string): Promise<readonly Value[] | null> {
    const claim = await this.roots.claim(path);
    try {
      const r = claim ? tuple(claim.value) : [];
      return r[0] === 'context' && r[2] ? structuredClone(tuple(r[2])) : null;
    } finally {
      claim?.release();
    }
  }
  async close() {
    await this.roots.close();
  }
}
