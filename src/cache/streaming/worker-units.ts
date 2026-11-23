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

import { equal, tuple, type Value } from './encoding';
import { normalizeMode } from './tree-state';
import { unitSchema, type Unit } from './schema';
import type { WorkerFile } from './worker-codec';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';
import type { WorkerMergeCursor } from './worker-merge';
import type { WorkerStage } from './worker-stage';
import type { ActivityProjection } from './worker-activity';
import { WorkerSpool } from './worker-spool';

export interface UnitMergeContext {
  readonly store: OwnedStore;
  readonly stage: WorkerStage;
  readonly activity: ActivityProjection;
  readonly budget: WorkingBudget;
  readonly signal: AbortSignal;
  advance(c: WorkerMergeCursor): Promise<void>;
  selected(c: WorkerMergeCursor): boolean;
  warning(message: string): void;
}
const row = (c: WorkerMergeCursor) => (c.head?.type === 'control' ? tuple(c.head.value) : []);
/** Whole-unit arbitration; losing shapes never enter the selected native tree. */
export async function mergeCompleteUnit(
  group: WorkerMergeCursor[],
  root: string,
  context: UnitMergeContext,
): Promise<void> {
  const { store, stage, activity, budget, signal } = context;
  const eligible = group
      .filter(context.selected)
      .sort((a, b) => (a.input.job < b.input.job ? -1 : a.input.job > b.input.job ? 1 : 0)),
    winner = eligible[0];
  const facts: WorkerSpool[] = [],
    readers: AsyncIterator<Value>[] = [],
    comparisons: string[] = [],
    policies = new Set<string>();
  const definition = (c: WorkerMergeCursor): Unit => {
    const r = row(c);
    if (r[0] !== 'unit-open') throw new Error('Missing complete-unit frontier.');
    const u = unitSchema.parse(r.slice(2, 5));
    if (u[1] !== root) throw new Error('Unaligned complete-unit root.');
    return u;
  };
  const descriptors = new Map(group.map((c) => [c, definition(c)]));
  const policy = (partition: string) => {
    const p = store.codec.options.model.partitions.find((p) => p[0] === partition)!;
    policies.add(p[5]);
    if (policies.size > 1) throw new Error('Mixed complete-unit conflict-handling policies.');
    return p[5];
  };
  async function drain(c: WorkerMergeCursor, selected: boolean, collect: boolean): Promise<void> {
    const unit = descriptors.get(c)!,
      nested: string[] = [];
    let spool: WorkerSpool | undefined, owner: string | undefined;
    if (selected) await activity.unitOpen(unit, 'upsert', signal);
    await context.advance(c);
    while (row(c)[0] !== 'unit-close') {
      signal.throwIfAborted();
      const h = c.head;
      if (!h) throw new Error('Incomplete unit archive.');
      if (h.type === 'file') {
        const f: WorkerFile = h.file,
          header = f.header;
        owner ??= f.partition;
        const handling = selected || collect ? policy(f.partition) : 'default';
        let pending: Awaited<ReturnType<WorkerStage['write']>> | undefined;
        try {
          if (selected) pending = await stage.write(f, signal);
          else
            for await (const b of f.body) {
              void b;
              signal.throwIfAborted();
            }
          await context.advance(c);
          const meta = row(c);
          if (meta[0] !== 'file-meta') throw new Error('Missing validated unit file metadata.');
          let mode = header.mode,
            time = header.mtimeMs;
          if (selected && handling === 'default')
            for (const reader of readers) {
              const next = await reader.next();
              if (next.done) throw new Error('Different complete-unit member set.');
              const other = tuple(next.value);
              if (
                other[1] !== f.path ||
                other[2] !== f.partition ||
                other[3] !== meta[3] ||
                other[4] !== header.size
              )
                throw new Error('Different complete-unit member/content facts.');
              if (unit[0] !== 'maven-directory' && other[5] !== header.mode)
                throw new Error('Different workspace file mode.');
              mode = 0o644 | ((mode | Number(other[5])) & 0o111);
              time = Math.max(time, Number(other[6]));
            }
          mode = normalizeMode(store.codec.options.model.tuple[2], f.path, mode);
          if (selected) {
            await pending!.finish(String(meta[3]), header.size, mode, time);
            await activity.member('upsert', f.path, f.partition, signal);
          } else if (collect && handling === 'default') {
            if (!spool) {
              spool = await WorkerSpool.create(store, budget);
              facts.push(spool);
            }
            await spool.append(
              [
                'unit-file',
                f.path,
                f.partition,
                String(meta[3]),
                header.size,
                header.mode,
                header.mtimeMs,
              ],
              signal,
            );
          }
          await context.advance(c);
        } finally {
          await pending?.close();
        }
      } else {
        const r = row(c);
        if (r[0] === 'dir-open') {
          const path = String(r[2]);
          nested.push(path);
          if (selected) {
            stage.enter(path);
            await activity.enter(path, signal);
          }
        } else if (r[0] === 'dir-close') {
          const path = String(r[2]);
          if (nested.pop() !== path) throw new Error('Unbalanced selected unit subtree.');
          if (selected) {
            if (owner) await stage.ensure(owner, signal);
            await stage.leave(path, signal);
            await activity.leave(path, signal);
          }
        } else throw new Error('Unexpected complete-unit event.');
        await context.advance(c);
      }
    }
    if (nested.length) throw new Error('Unit closed inside child directory.');
    const close = row(c);
    equal(close.slice(2, 4), unit.slice(0, 2), 'complete-unit close');
    if (selected || collect) {
      comparisons.push(String(close[6]));
      if (!owner) policy(store.codec.options.model.owner(root + '/.workspace-directory-probe')[0]);
    }
    if (spool) {
      spool.seal(signal);
      readers.push(spool.rows(signal)[Symbol.asyncIterator]());
    }
    if (selected) {
      if (!owner)
        await stage.ensure(
          store.codec.options.model.owner(root + '/.workspace-directory-probe')[0],
          signal,
        );
      if ([...policies][0] === 'default')
        for (const reader of readers)
          if (!(await reader.next()).done) throw new Error('Different complete-unit member set.');
      await activity.unitClose(signal);
    }
    await context.advance(c);
  }
  const cleanup = async () => {
    for (const reader of readers) await reader.return?.();
    const settled = await Promise.allSettled(facts.map((s) => s.dispose()));
    const errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Unit metadata cleanup failed.',
      );
  };
  try {
    // Pause winner on its unit header while independently validating losers. Metadata
    // spools exist only for strict portable-attribute reconciliation, never payloads.
    for (const c of group) if (c !== winner) await drain(c, false, context.selected(c));
    if (winner) await drain(winner, true, false);
    if (new Set(comparisons).size > 1) {
      if ([...policies][0] !== 'choose-worker-directory')
        throw new Error('Prohibited complete-unit conflict.');
      context.warning('Selected complete worker unit at ' + root);
    }
  } finally {
    await cleanup();
  }
}
