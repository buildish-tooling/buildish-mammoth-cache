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

import type { Value } from './encoding';
import { canonical } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import { InstallScratch } from './install-scratch';
import { buildObservedInstallIndex, indexedNode } from './install-index';
import { selectInstall, type Selection, type InstallUnit } from './install-selection';
import { installCurrentRows } from './install-current';
import { InstallParents } from './install-parents';
import type { IndexedMetadataInput } from './metadata-install-context';
import { type MetadataInstallContext } from './metadata-install-context';
export type InstallInput = IndexedMetadataInput;
import type { WorkingBudget } from './tree-state';
import { parentPath } from './tree-state';
import type { NativeIdentity } from './native';

export interface FrozenInstall {
  readonly store: OwnedStore;
  readonly plan: Reference;
  readonly inputs: readonly InstallInput[];
  readonly metadata: MetadataInstallContext;
  readonly parentsPrefix: string;
  readonly maxDirectoryEntries: number;
}
interface InstallIndexes {
  readonly scratch: InstallScratch;
  readonly current: number;
  readonly sources: ReadonlyMap<number, number>;
}
const indexes = new WeakMap<FrozenInstall, InstallIndexes>();
export async function takeInstallIndexes(
  store: OwnedStore,
  frozen: FrozenInstall,
): Promise<InstallIndexes | undefined> {
  assertFrozenInstall(store, frozen);
  frozen.metadata?.assert(store);
  const value = indexes.get(frozen);
  if (!value) return undefined;
  indexes.delete(frozen);
  try {
    await value.scratch.reopen();
    return value;
  } catch (error) {
    await value.scratch.close();
    throw error;
  }
}
const frozenPlans = new WeakSet<object>();
export function assertFrozenInstall(store: OwnedStore, plan: FrozenInstall): void {
  if (!frozenPlans.has(plan) || plan.store !== store)
    throw new Error('Install requires this process-owned frozen plan.');
}
/** Staged metadata path: the original discovery index remains the sole per-file source. */
export async function freezeMetadataInstallPlan(
  store: OwnedStore,
  context: MetadataInstallContext,
  budget: WorkingBudget,
  options: { pruneAggregates?: boolean; signal?: AbortSignal; maxDirectoryEntries?: number } = {},
): Promise<FrozenInstall> {
  context.assert(store);
  if (
    context.budget !== budget ||
    (options.maxDirectoryEntries ?? 100000) !== context.maxDirectoryEntries
  )
    throw new Error('Metadata install policy/budget mismatch.');
  try {
    return await freezePlan(store, context.take(), budget, options, context);
  } catch (error) {
    try {
      await context.dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Metadata freeze/context cleanup failed; owned locations retained under ' +
          store.root.resolve(store.prefix.slice(0, -1)),
        { cause: cleanup },
      );
    }
    throw error;
  }
}
async function freezePlan(
  store: OwnedStore,
  suppliedInputs: readonly InstallInput[],
  budget: WorkingBudget,
  options: {
    pruneAggregates?: boolean;
    signal?: AbortSignal;
    maxDirectoryEntries?: number;
  },
  metadata: MetadataInstallContext,
): Promise<FrozenInstall> {
  const inputs = Object.freeze([...suppliedInputs]);
  const signal = options.signal ?? new AbortController().signal,
    model = store.codec.options.model,
    maxDirectoryEntries = options.maxDirectoryEntries ?? 100000;
  signal.throwIfAborted();
  if (
    inputs.length > model.partitions.length ||
    new Set(inputs.map((i) => i.partition)).size !== inputs.length
  )
    throw new Error('Duplicate source partition projection.');
  for (const input of inputs) input.assertBound(store);
  await store.assertNoIntents();
  if (options.pruneAggregates && inputs.length !== model.partitions.length)
    throw new Error('Cannot prune incomplete/cold metadata contexts.');
  await store.makeParents(store.prefix + 'files/pending');
  const owned: InstallScratch[] = [];
  let retained: InstallScratch | undefined;
  async function spool() {
    const value = await InstallScratch.create(store, budget);
    owned.push(value);
    return value;
  }
  const routes: (InstallScratch | null)[] = model.partitions.map(() => null);
  const activeParents: { path: string; old: number | null; release: () => void }[] = [];
  let kind: 'file' | 'directory' = 'file';
  try {
    const scratch = metadata.scratch,
      aggregate = await spool(),
      parents = await InstallParents.create(store);
    let ordinal = 0;
    const currentRoot = await buildObservedInstallIndex(
        scratch,
        model,
        null,
        signal,
        async (accept) => {
          for await (const value of installCurrentRows(store, {
            budget,
            signal,
            maxDirectoryEntries,
          }))
            await accept({ value, start: ordinal, end: ++ordinal, record: ordinal });
        },
      ),
      desired = inputs.map((input) => ({
        partition: model.partitions.findIndex((p) => p[0] === input.partition),
        root: input.index,
      }));
    metadata.bindCurrent(currentRoot);
    const selected = await selectInstall(
      scratch,
      model,
      currentRoot,
      desired,
      signal,
      maxDirectoryEntries,
      options.pruneAggregates ?? false,
    );
    async function route(offset: number, ancestor: number | null): Promise<void> {
      signal.throwIfAborted();
      const lease = await scratch.record(offset),
        node = lease.value as Selection;
      try {
        if (node[1] === 'operation') {
          let sink = aggregate;
          if (model.partitions[node[4]][3] === 'single-writer') {
            if (!routes[node[4]]) routes[node[4]] = await spool();
            sink = routes[node[4]]!;
          }
          await sink.append(['route', offset, ancestor]);
          return;
        }
        const chain = await scratch.append(['ancestor', node[2], node[6], ancestor]);
        for (const type of ['file', 'directory'])
          for await (const raw of scratch.rows(node[8], node[9])) {
            const edge = raw as readonly Value[];
            if (edge[4] === type) await route(Number(edge[2]), chain);
          }
      } finally {
        lease.release();
      }
    }
    if (selected !== null) await route(selected, null);
    let index = 0;
    async function* prepareAncestors(chain: number | null, path: string): AsyncGenerator<Value> {
      const parent = parentPath(path);
      while (
        activeParents.length &&
        parent !== activeParents[activeParents.length - 1].path &&
        !parent.startsWith(activeParents[activeParents.length - 1].path + '/')
      )
        activeParents.pop()!.release();
      if (activeParents.length && activeParents[activeParents.length - 1].path === parent) return;
      const pending: { path: string; old: number | null; release: () => void }[] = [];
      try {
        while (chain !== null) {
          const row = await scratch.record(chain);
          try {
            const value = row.value as readonly Value[];
            if (activeParents.length && value[1] === activeParents[activeParents.length - 1].path)
              break;
            pending.push({
              path: Buffer.from(String(value[1])).toString(),
              old: value[2] as number | null,
              release: budget.holdRecord(row.bytes),
            });
            chain = value[3] as number | null;
          } finally {
            row.release();
          }
        }
        while (pending.length) {
          signal.throwIfAborted();
          const frame = pending.pop()!;
          activeParents.push(frame);
          if (!frame.path) continue;
          if (frame.old === null) {
            const binding = await parents.claim(frame.path);
            if (binding) yield ['install-parent', ++index, frame.path, binding[0], binding[1]];
          } else {
            const node = await indexedNode(scratch, frame.old);
            try {
              if ((node.node[3] as NativeIdentity)[3] !== store.root.binding[3])
                throw new Error('Cross-filesystem install parent.');
            } finally {
              node.release();
            }
          }
        }
      } finally {
        for (const frame of pending) frame.release();
      }
    }
    async function* operation(route: readonly Value[]): AsyncGenerator<Value> {
      signal.throwIfAborted();
      const lease = await scratch.record(Number(route[1])),
        op = lease.value as Selection;
      try {
        yield* prepareAncestors(route[2] as number | null, op[2]);
        const p = op[4],
          input = inputs.find((i) => i.partition === model.partitions[p][0]);
        let sourcePath: string | null = null,
          sourceEvidence: Value = null;
        if (op[5] !== null) {
          if (!input) throw new Error('Missing desired producer receipt.');
          const node = await indexedNode(scratch, op[5]);
          try {
            sourcePath = input.nativeRoot + '/' + op[2];
            sourceEvidence = metadata.selector('source', input.partition, op[5]);
          } finally {
            node.release();
          }
        }
        const old = op[6] !== null;
        const destination: Value = old
          ? metadata.selector('current', model.partitions[p][0], op[6]!)
          : null;
        kind = op[3];
        const number = ++index;
        yield [
          'install',
          number,
          op[2],
          sourcePath,
          sourceEvidence,
          destination,
          sourcePath === null ? 'delete' : old ? 'replace' : 'insert',
          old ? store.prefix + 'backups/' + String(number) : null,
        ];
      } finally {
        lease.release();
      }
    }
    async function* rows(): AsyncGenerator<Value> {
      yield ['install-context', metadata.nonce];
      let previous: InstallUnit | null = null;
      for await (const raw of aggregate.rows(0, aggregate.position)) {
        const record = raw as readonly Value[],
          lease = await scratch.record(Number(record[1]));
        try {
          const op = lease.value as Selection,
            u = op[7]!;
          if (!previous || !canonical(previous).equals(canonical(u))) {
            if (previous) yield ['install-unit-close', previous[0], previous[1]];
            yield ['install-unit-open', ...u];
            previous = u;
          }
          yield* operation(record);
        } finally {
          lease.release();
        }
      }
      if (previous) yield ['install-unit-close', previous[0], previous[1]];
      for (let p = 0; p < model.partitions.length; p++)
        if (
          inputs.some((i) => i.partition === model.partitions[p][0]) &&
          model.partitions[p][3] === 'single-writer'
        ) {
          const u: InstallUnit = ['snapshot', model.partitions[p][0], 'partition'];
          yield ['install-unit-open', ...u];
          for (const frame of activeParents) frame.release();
          activeParents.length = 0;
          if (routes[p])
            for await (const route of routes[p]!.rows(0, routes[p]!.position))
              yield* operation(route as readonly Value[]);
          yield ['install-unit-close', u[0], u[1]];
        }
      await parents.seal(budget);
    }
    const plan = await store.writeStream(
      'install-plan',
      { budget, partition: null, installKind: () => kind, maxDirectoryEntries },
      rows(),
      signal,
    );
    signal.throwIfAborted();
    const frozen: FrozenInstall = Object.freeze({
      store,
      metadata,
      plan: Object.freeze(plan) as Reference,
      inputs: Object.freeze([...inputs]),
      parentsPrefix: parents.prefix,
      maxDirectoryEntries,
    });
    await scratch.park();
    indexes.set(frozen, {
      scratch,
      current: currentRoot,
      sources: new Map(desired.map((d) => [d.partition, d.root])),
    });
    retained = scratch;
    frozenPlans.add(frozen);
    return frozen;
  } finally {
    for (const frame of activeParents) frame.release();
    await Promise.all(owned.filter((s) => s !== retained).map((s) => s.close()));
  }
}
