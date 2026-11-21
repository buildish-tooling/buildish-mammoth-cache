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
import { indexedNode, indexedEntries, type IndexedNode } from './install-index';
import { changeNode, changeChildren, type ChangeNode } from './install-changes';
import type { InstallScratch } from './install-scratch';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { compareName } from './tree-state';
import { sameDirectoryObject } from './install-member';

export interface ChangeOutcome {
  readonly entryChanged: boolean;
  /** Operations prove their entire endpoint; parent rows still require the complete child join. */
  readonly opaque: boolean;
  readonly parent?: NativeIdentity | null;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Frozen/current/route frontiers are bounded by active hierarchy, never total files.
export async function checkInstallProjection(
  scratch: InstallScratch,
  beforeRoot: number,
  actualRoot: number,
  routes: readonly number[],
  inspect: (row: Value, actual: IndexedNode | null) => Promise<ChangeOutcome>,
  signal = new AbortController().signal,
): Promise<void> {
  async function visit(
    before: number | null,
    actual: number | null,
    changes: readonly number[],
  ): Promise<boolean> {
    signal.throwIfAborted();
    const leases: { release: () => void }[] = [];
    try {
      const b = before === null ? null : await indexedNode(scratch, before);
      if (b) leases.push(b);
      const a = actual === null ? null : await indexedNode(scratch, actual);
      if (a) leases.push(a);
      const cs: ChangeNode[] = [];
      for (const offset of changes) {
        const c = await changeNode(scratch, offset);
        leases.push(c);
        cs.push(c.node);
      }
      const payloads = cs.filter((c) => c[2] !== null);
      if (payloads.length > 1) throw new Error('Overlapping install route authority.');
      const outcome = payloads.length ? await inspect(payloads[0][2]!, a?.node ?? null) : null;
      if (outcome?.opaque) {
        if (cs.some((c) => c[3] !== c[4]))
          throw new Error('Overlapping operation/descendant authority.');
        return outcome.entryChanged;
      }
      const bn = b?.node ?? null,
        an = a?.node ?? null;
      if (!cs.length && (!bn || !an)) throw new Error('Unexpected frozen/current membership.');
      if ((bn && bn[1] !== 'directory') || (an && an[1] !== 'directory')) {
        if (cs.length || !bn || !an || bn[1] !== an[1])
          throw new Error('Changed structural install parent.');
        if (bn[1] === 'protected') equal(bn[3], an[3], 'protected current child');
        else if (!sameNative(bn[3] as NativeIdentity, an[3] as NativeIdentity, true))
          throw new Error('Unattributed current file change.');
        return false;
      }
      if (!bn && !outcome) throw new Error('Missing structural parent authority.');
      const iterators: AsyncGenerator<readonly [string, number]>[] = [];
      async function* entries(node: IndexedNode | null) {
        if (node) for await (const e of indexedEntries(scratch, node)) yield [e[0], e[2]] as const;
      }
      iterators.push(entries(bn), entries(an));
      for (const c of cs) iterators.push(changeChildren(scratch, c));
      let directChange = false;
      try {
        const heads = await Promise.all(iterators.map((i) => i.next()));
        while (heads.some((h) => !h.done)) {
          signal.throwIfAborted();
          let name: string | undefined;
          for (const h of heads)
            if (!h.done && (name === undefined || compareName(h.value[0], name) < 0))
              name = h.value[0];
          const selected = heads.map((h) => (!h.done && h.value[0] === name ? h.value[1] : null));
          directChange =
            (await visit(
              selected[0],
              selected[1],
              selected.slice(2).filter((n): n is number => n !== null),
            )) || directChange;
          for (let i = 0; i < heads.length; i++)
            if (selected[i] !== null) heads[i] = await iterators[i].next();
        }
      } finally {
        await Promise.all(iterators.map((i) => i.return(undefined as never)));
      }
      if (outcome) {
        if (outcome.parent === null) {
          if (an) throw new Error('Unexpected pending created parent.');
        } else if (!an || !outcome.parent || an[3] === null)
          throw new Error('Missing created parent.');
        else {
          const expected = outcome.parent,
            observed = an[3] as NativeIdentity;
          if (!directChange && !sameRename(expected, observed))
            throw new Error('Unattributed empty parent change.');
          if (
            expected[2] !== observed[2] ||
            expected[3] !== observed[3] ||
            expected[4] !== observed[4] ||
            expected[6] !== observed[6] ||
            (process.platform !== 'win32' && expected[10] !== observed[10])
          )
            throw new Error('Created parent identity changed.');
        }
        return outcome.entryChanged;
      }
      if (!bn || !an) throw new Error('Unexplained structural directory absence.');
      const expected = bn[3] as NativeIdentity,
        observed = an[3] as NativeIdentity;
      if (
        directChange
          ? !sameDirectoryObject(expected, observed)
          : !sameNative(expected, observed, true)
      )
        throw new Error('Unattributed structural parent change.');
      return false;
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
  }
  await visit(beforeRoot, actualRoot, routes);
}
