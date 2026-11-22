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
import { buildInstallIndex, indexedNode } from './install-index';
import { selectInstall, type Selection, type InstallUnit } from './install-selection';
import { captureInstallPreimages, type CapturedSelection } from './install-preimages';
import { captureInstallCurrent } from './install-current';
import { InstallParents } from './install-parents';
import type { VerifiedIncoming } from './install-evidence';
import type { WorkingBudget } from './tree-state';
import { parentPath } from './tree-state';
import type { NativeIdentity } from './native';

export interface FrozenInstall {
  readonly store: OwnedStore;
  readonly plan: Reference;
  readonly current: Reference;
  readonly inputs: readonly VerifiedIncoming[];
  readonly preimages: readonly (Reference | null)[];
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
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
/** Fully selected sources are producer receipts, never raw serialized verification flags. */
export async function freezeInstallPlan(
  store: OwnedStore,
  suppliedInputs: readonly VerifiedIncoming[],
  budget: WorkingBudget,
  options: {
    trustedOld?: readonly VerifiedIncoming[];
    /** True-hit base restore only; complete incoming contexts include empty cold partitions. */
    pruneAggregates?: boolean;
    signal?: AbortSignal;
    maxDirectoryEntries?: number;
  } = {},
): Promise<FrozenInstall> {
  const inputs = Object.freeze([...suppliedInputs]),
    trustedOld = Object.freeze([...(options.trustedOld ?? [])]);
  const signal = options.signal ?? new AbortController().signal,
    model = store.codec.options.model,
    maxDirectoryEntries = options.maxDirectoryEntries ?? 100000;
  signal.throwIfAborted();
  if (
    inputs.length > model.partitions.length ||
    new Set(inputs.map((i) => i.partition)).size !== inputs.length
  )
    throw new Error('Duplicate source partition projection.');
  for (const input of inputs)
    input.assertBound(store, input.partition, input.evidence, input.nativeRoot);
  await store.assertNoIntents();
  if (options.pruneAggregates) {
    const state = store.codec.schemas.documents['local-state'].parse(await store.state());
    const bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(state[5], 'bindings'),
    );
    if (
      state[4] !== 'prepare-pending' ||
      bindings[8][4] !== 'prune-managed' ||
      bindings[9] === null ||
      inputs.length !== model.partitions.length ||
      inputs.some((i) => i.origin !== 'trusted-base')
    )
      throw new Error('Aggregate pruning requires a bound base hit and every partition context.');
  }
  const current = await captureInstallCurrent(store, { budget, signal, maxDirectoryEntries });
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
    const scratch = await spool(),
      aggregate = await spool(),
      parents = await InstallParents.create(store);
    const currentRoot = await buildInstallIndex(
        scratch,
        store.rows(
          current,
          'install-current',
          { budget, partition: null, maxDirectoryEntries },
          signal,
        ),
        model,
        null,
        signal,
      ),
      desired = [];
    for (const input of inputs)
      desired.push({
        partition: model.partitions.findIndex((p) => p[0] === input.partition),
        root: await buildInstallIndex(
          scratch,
          store.rows(
            input.evidence,
            'native-evidence',
            { budget, partition: input.partition, maxDirectoryEntries },
            signal,
          ),
          model,
          input.partition,
          signal,
        ),
      });
    const selected = await selectInstall(
        scratch,
        model,
        currentRoot,
        desired,
        signal,
        maxDirectoryEntries,
        options.pruneAggregates ?? false,
      ),
      captured = await captureInstallPreimages(
        store,
        scratch,
        selected,
        trustedOld,
        signal,
        maxDirectoryEntries,
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
    if (captured.root !== null) await route(captured.root, null);
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
        op = lease.value as CapturedSelection;
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
            sourceEvidence = [
              'evidence',
              input.evidence,
              ['span', input.evidence[4], node.node[9], node.node[10]],
            ];
          } finally {
            node.release();
          }
        }
        const old = op[6] === null ? null : captured.references[p];
        if (op[6] !== null && !old) throw new Error('Missing selected preimage reference.');
        const destination = old ? ['evidence', old, ['span', old[4], op[10], op[11]]] : null;
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
      yield ['install-context', current];
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
      plan: Object.freeze(plan) as Reference,
      current: Object.freeze(current) as Reference,
      inputs: Object.freeze([...inputs]),
      preimages: Object.freeze(
        captured.references.map((q) => (q ? (Object.freeze(q) as Reference) : null)),
      ),
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
