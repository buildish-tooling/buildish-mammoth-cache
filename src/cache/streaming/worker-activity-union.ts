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

import { directoryBreadthError } from './tree-state';
import { WorkerNativeIndex } from './worker-native';
import type { ActivityProjection } from './worker-activity';
import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { baseName, compareName, joinPath } from './tree-state';
import { tuple, equal, type Value } from './encoding';
interface Cursor {
  reader: AsyncIterator<Value>;
  head: readonly Value[] | null;
  selected: boolean;
}

// Protocol: docs/dev/cache-protocol.md#usage-validation.
// K-way membership union; upserts suppress usage at exact files or complete units.
// Temporary projections contain no hashes and never become a global name index.
export async function writeSelectedActivity(
  store: OwnedStore,
  projections: readonly ActivityProjection[],
  selected: WorkerNativeIndex,
  budget: WorkingBudget,
  signal: AbortSignal,
  maxDirectoryEntries = 100000,
  work = { listings: 0, indexDirectories: 0 },
): Promise<Reference> {
  const cursors: Cursor[] = projections.map((p) => ({
    reader: p.spool.rows(signal)[Symbol.asyncIterator](),
    head: null,
    selected: p.kind === 'upsert',
  }));
  interface Root {
    offset: number;
  }
  interface Entry {
    kind: 'file' | 'directory';
    parents: Root[];
    seen: boolean;
  }
  async function shape(roots: readonly Root[], path: string) {
    const names = new Map<string, Entry>();
    let charge = 0;
    const release = budget.holdRecord(roots.length * 512);
    try {
      for (const root of roots) {
        WorkerNativeIndex.assert(selected, store);
        const lease = await selected.node(root.offset);
        try {
          if (lease.node[1] !== 'directory' || lease.node[2] !== path) {
            throw new Error('Selected activity index directory mismatch.');
          }
          work.indexDirectories++;
          let count = 0;
          for await (const edge of selected.children(lease.node)) {
            signal.throwIfAborted();
            if (++count > maxDirectoryEntries) {
              throw directoryBreadthError(path, maxDirectoryEntries, 'worker activity merge');
            }
            const entry = { name: edge[0] },
              kind = edge[1];
            if (kind !== 'file' && kind !== 'directory') {
              throw new Error('Unsupported selected indexed child.');
            }
            let value = names.get(entry.name);
            if (value) {
              if (value.kind !== kind || kind === 'file') {
                throw new Error('Conflicting selected native topology.');
              }
            } else {
              if (names.size === maxDirectoryEntries) {
                throw directoryBreadthError(path, maxDirectoryEntries, 'worker activity merge');
              }
              const bytes = 128 + 4 * Buffer.byteLength(entry.name);
              budget.retain(bytes);
              charge += bytes;
              value = { kind, parents: [], seen: false };
              names.set(Buffer.from(entry.name).toString('utf8'), value);
            }
            if (kind === 'directory') {
              budget.retain(16);
              charge += 16;
              value.parents.push({ offset: edge[2] });
            }
          }
        } finally {
          lease.release();
        }
      }
      return {
        names,
        release: () => {
          budget.release(charge);
          release();
        },
      };
    } catch (error) {
      budget.release(charge);
      release();
      throw error;
    }
  }
  const advance = async (c: Cursor) => {
    const n = await c.reader.next();
    c.head = n.done ? null : tuple(n.value);
  };
  const check = (c: Cursor, tag: string, path: string) => {
    if (c.head?.[0] !== tag || c.head[1] !== path) {
      throw new Error('Activity union hierarchy mismatch.');
    }
  };
  const skipUnit = async (c: Cursor) => {
    const root = c.head![2];
    await advance(c);
    while (c.head?.[0] !== 'unit-close') {
      if (!c.head) {
        throw new Error('Truncated usage unit.');
      }
      await advance(c);
    }
    if (c.head[2] !== root) {
      throw new Error('Wrong suppressed usage unit.');
    }
    await advance(c);
  };
  const skipDirectory = async (c: Cursor) => {
    let depth = 0;
    do {
      if (!c.head) {
        throw new Error('Truncated suppressed usage directory.');
      }
      if (c.head[0] === 'dir-open') {
        depth++;
      } else if (c.head[0] === 'dir-close') {
        depth--;
      }
      await advance(c);
    } while (depth);
  };
  async function* files(
    group: Cursor[],
    path: string,
    owners: Set<string> | null,
    names: Map<string, Entry>,
  ): AsyncGenerator<Value> {
    while (true) {
      const ready = group.filter((c) => c.head?.[0] === 'upsert' || c.head?.[0] === 'used');
      if (!ready.length) {
        return;
      }
      const name = ready.map((c) => String(c.head![1])).sort(compareName)[0],
        same = ready.filter((c) => c.head![1] === name),
        partition = store.codec.options.model.owner(joinPath(path, name));
      for (const c of same) {
        if (c.head![2] !== partition[0]) {
          throw new Error('Wrong activity partition.');
        }
      }
      const upsert = same.some((c) => c.head![0] === 'upsert'),
        native = names.get(name);
      if (upsert) {
        if (!native || native.kind !== 'file') {
          throw new Error('Selected activity differs from native payload.');
        }
        native.seen = true;
      }
      if (upsert) {
        owners?.add(partition[0]);
      }
      // Selected directory topology wins over a usage-only file of the same name.
      if (upsert || native?.kind !== 'directory') {
        yield [upsert ? 'upsert' : 'used', name, partition[0]];
      }
      for (const c of same) {
        await advance(c);
      }
    }
  }
  async function* directory(
    group: Cursor[],
    path: string,
    roots: readonly Root[],
  ): AsyncGenerator<Value> {
    const native = await shape(roots, path);
    try {
      for (const c of group) {
        check(c, 'dir-open', path);
      }
      yield ['dir-open', path];
      for (const c of group) {
        await advance(c);
      }
      let units = group.filter((c) => c.head?.[0] === 'unit-open'),
        chosen = units.filter((c) => c.head![4] === 'upsert');
      if (chosen.length) {
        // One complete worker Maven view may span aggregate partitions, but distinct
        // snapshot/aggregate publication channels may never each claim that coordinate.
        if (chosen.length > 1 && chosen[0].head![1] === 'maven-directory') {
          throw new Error('Mixed Maven publication ownership of selected unit.');
        }
        for (const c of units) {
          if (c.head![4] === 'used') {
            await skipUnit(c);
          }
        }
        units = chosen;
      } else {
        chosen = units;
      }
      const unit = chosen[0]?.head,
        owners = unit ? new Set<string>() : null;
      if (unit) {
        for (const c of units) {
          equal(c.head!.slice(1), unit.slice(1), 'activity unit declaration');
        }
        yield unit;
        for (const c of units) {
          await advance(c);
        }
      }
      yield* files(group, path, owners, native.names);
      if (unit && unit[3] === 'direct') {
        if (
          owners &&
          owners.size > 1 &&
          [...owners].some(
            (id) =>
              store.codec.options.model.partitions.find((p) => p[0] === id)![3] === 'single-writer',
          )
        ) {
          throw new Error('Mixed Maven publication ownership of selected files.');
        }
        yield ['unit-close', unit[1], path];
        for (const c of units) {
          if (c.head?.[0] !== 'unit-close' || c.head[2] !== path) {
            throw new Error('Incomplete direct activity unit.');
          }
          await advance(c);
        }
      }
      while (true) {
        const ready = group.filter((c) => c.head?.[0] === 'dir-open');
        if (!ready.length) {
          break;
        }
        const child = ready
          .map((c) => String(c.head![1]))
          .sort((a, b) => compareName(baseName(a), baseName(b)))[0];
        const same = ready.filter((c) => c.head![1] === child),
          name = baseName(child),
          entry = native.names.get(name);
        if (entry?.kind === 'file') {
          if (same.some((c) => c.selected)) {
            throw new Error('Selected activity topology collision.');
          }
          for (const c of same) {
            await skipDirectory(c);
          }
          continue;
        }
        const children: Root[] = [];
        if (entry) {
          if (!same.some((c) => c.selected)) {
            throw new Error('Missing selected activity directory.');
          }
          entry.seen = true;
          children.push(...entry.parents);
        }
        yield* directory(same, child, children);
      }
      if (unit && unit[3] === 'subtree') {
        yield ['unit-close', unit[1], path];
        for (const c of units) {
          if (c.head?.[0] !== 'unit-close' || c.head[2] !== path) {
            throw new Error('Incomplete subtree activity unit.');
          }
          await advance(c);
        }
      }
      for (const entry of native.names.values()) {
        if (!entry.seen) {
          throw new Error('Missing selected native activity member.');
        }
      }
      for (const c of group) {
        check(c, 'dir-close', path);
      }
      yield ['dir-close', path];
      for (const c of group) {
        await advance(c);
      }
    } finally {
      native.release();
    }
  }
  async function* rows(): AsyncGenerator<Value> {
    for (const c of cursors) {
      await advance(c);
    }
    if (!cursors.length) {
      yield ['dir-open', ''];
      yield ['dir-close', ''];
      return;
    }
    const roots: Root[] = [];
    WorkerNativeIndex.assert(selected, store);
    if (selected.budget !== budget || selected.maxDirectoryEntries !== maxDirectoryEntries) {
      throw new Error('Selected activity index budget/policy mismatch.');
    }
    for (const partition of selected.partitions) {
      roots.push({ offset: selected.root(partition) });
    }
    yield* directory(cursors, '', roots);
    if (cursors.some((c) => c.head)) {
      throw new Error('Trailing activity projection.');
    }
  }
  let failure: unknown;
  const retire = async () => {
    const settled = await Promise.allSettled(cursors.map((c) => c.reader.return?.()));
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length) {
      throw new AggregateError(
        failure ? [failure, ...errors] : errors,
        'Activity reader cleanup failed.',
        { cause: failure },
      );
    }
  };
  try {
    return await store.writeStream(
      'activity',
      { budget, partition: null, maxDirectoryEntries },
      rows(),
      signal,
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await retire();
  }
}
