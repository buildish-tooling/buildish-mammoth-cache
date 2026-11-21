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

import { randomUUID } from 'node:crypto';
import { decodeRecords, tuple, add, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import { ProvisionalBaseSet } from './base-generation';
import { ValidatedBaseObject, settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { FrozenBaseTree } from './base-frozen-tree';
import { RecoveryGroups } from './native-records';
import { compareMembership, parentPath } from './tree-state';
import { sameNative, sameRename, type NativeIdentity } from './native';
import {
  copyBaseSnapshot,
  syncBasePayload,
  movedBaseEvidence,
  type BaseCopy,
} from './base-evidence';
import { PreparedWorkerSnapshot } from './worker-snapshot';
import { VerifiedIncoming } from './install-evidence';
import { recoverInstall, executeInstall } from './install-execute';
import { freezeInstallPlan } from './install-plan';
import { retireOwnedDirectory } from './owned-retirement';

// Protocol: docs/dev/native-base-protocol.md#recovery-groups.
// One direct-unit root frontier per input, never a coordinate/file catalogue.
export async function deriveBaseGroups(
  store: OwnedStore,
  objects: readonly (ValidatedBaseObject | FrozenBaseTree)[],
  options: BaseObjectOptions,
): Promise<RecoveryGroups> {
  options = Object.freeze({ ...options });
  if (objects.length > 64) throw new Error('Base group frontier admission exceeded.');
  objects = Object.freeze([...objects]);
  const owners = new Set<string>();
  for (const object of objects) {
    if (object instanceof FrozenBaseTree) FrozenBaseTree.assert(object, store);
    else ValidatedBaseObject.assertReceipt(object, store);
    if (owners.has(object.reference[1][2])) throw new Error('Duplicate base group projection.');
    owners.add(object.reference[1][2]);
  }
  const groups = new RecoveryGroups(store.codec.options.model),
    signal = options.signal ?? new AbortController().signal;
  const cursors: {
    partition: string;
    iterator: AsyncIterator<string>;
    head: IteratorResult<string>;
  }[] = [];
  async function* roots(object: ValidatedBaseObject | FrozenBaseTree): AsyncGenerator<string> {
    for await (const row of decodeRecords(store.read(object.tree, 'native-tree'))) {
      signal.throwIfAborted();
      const release = options.budget.holdRecord(row.raw.length);
      try {
        const r = tuple(row.value);
        if (r[0] === 'unit-open' && r[1] === 'maven-directory') yield String(r[2]);
      } finally {
        release();
      }
    }
  }
  let failure: unknown;
  try {
    for (const object of objects) {
      if (object instanceof FrozenBaseTree) FrozenBaseTree.assert(object, store);
      else ValidatedBaseObject.assertReceipt(object, store);
      const iterator = roots(object)[Symbol.asyncIterator]();
      const cursor = { partition: object.reference[1][2], iterator, head: await iterator.next() };
      cursors.push(cursor);
    }
    const compare = (a: string, b: string) =>
      compareMembership(['member', 'unit', a], ['member', 'unit', b]);
    while (cursors.some((c) => !c.head.done)) {
      signal.throwIfAborted();
      let root: string | undefined;
      for (const c of cursors)
        if (!c.head.done && (root === undefined || compare(c.head.value, root) < 0))
          root = c.head.value;
      const matching = cursors.filter((c) => !c.head.done && c.head.value === root);
      groups.observe(matching.map((c) => c.partition));
      for (const c of matching) c.head = await c.iterator.next();
    }
    return groups;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await settleBaseCleanup(
      cursors.map((c) => () => c.iterator.return?.(undefined)),
      failure,
    );
  }
}
export interface AcceptedBaseGeneration {
  readonly incoming: readonly VerifiedIncoming[];
  readonly snapshots: readonly PreparedWorkerSnapshot[];
  readonly cold: readonly (readonly string[])[];
  readonly baseline: Value;
  readonly snapshotCopyBytes: number;
}
const accepted = new WeakMap<object, { store: OwnedStore; max: number }>();
interface Move {
  from: string;
  to: string;
  before: NativeIdentity;
  after?: NativeIdentity;
}
/** All object/group gates precede publication; actual live changes remain exclusively V4a. */
export async function acceptBaseGeneration(
  store: OwnedStore,
  set: ProvisionalBaseSet,
  options: BaseObjectOptions,
): Promise<AcceptedBaseGeneration> {
  options = Object.freeze({ ...options });
  ProvisionalBaseSet.assertReceipt(set, store);
  const release = set.claim(),
    signal = options.signal ?? new AbortController().signal,
    moves: Move[] = [],
    copies: BaseCopy[] = [],
    emptyOwners: { root: string; native: NativeIdentity }[] = [];
  let adopted = false,
    failure: unknown;
  try {
    await recoverInstall(store, options.budget, signal);
    await store.assertNoIntents();
    await set.pin.assertStable();
    const objects = set.downloads.flatMap((d) => (d.object ? [d.object] : []));
    for (const object of objects) await object.verifyStable(options);
    const groups = await deriveBaseGroups(store, objects, options),
      cold = groups.check(set.pin.generation[9], set.available()),
      unavailable = new Set(cold.flat()),
      stages: { partition: string; root: string; evidence: Reference; provenance: string }[] = [];
    // Every available input was validated before choosing the complete groups to apply.
    for (const entry of set.pin.generation[8]) {
      if (unavailable.has(entry[1])) continue;
      if (entry[0] === 'object') {
        const object = objects.find((o) => o.reference[1][2] === entry[1])!;
        stages.push({
          partition: entry[1],
          root: object.payload,
          evidence: object.evidence,
          provenance: entry[2][2],
        });
      } else {
        const container = store.prefix + 'base/' + randomUUID(),
          root = container + '/empty';
        await store.makeParents(root + '/placeholder');
        const owner = (await store.root.stat(container))!;
        emptyOwners.push({ root: container, native: owner });
        const n = (await store.root.stat(root))!;
        const evidence = await store.writeStream(
          'native-evidence',
          { ...options, partition: entry[1] },
          (async function* () {
            yield ['directory', '', n] as Value;
          })(),
          signal,
        );
        stages.push({ partition: entry[1], root, evidence, provenance: set.pin.key });
      }
    }
    const move = async (from: string, to: string, native: NativeIdentity) => {
      await store.makeParents(to);
      if (await store.root.stat(to)) throw new Error('Unexpected native incoming target.');
      const attempt: Move = { from, to, before: native };
      moves.push(attempt);
      const after = await store.root.renameAbsent(from, to, native);
      attempt.after = after;
      await store.root.syncDirectory(parentPath(from));
      await store.root.syncDirectory(parentPath(to));
      return after;
    };
    const incomingFacts: { partition: string; root: string; evidence: Reference }[] = [],
      snapshotFacts: {
        partition: string;
        root: string;
        evidence: Reference;
        provenance: string;
      }[] = [];
    let snapshotCopyBytes = 0;
    for (const stage of stages) {
      signal.throwIfAborted();
      const partition = store.codec.options.model.partitions.find((p) => p[0] === stage.partition)!;
      if (partition[3] === 'single-writer') {
        const copy = await copyBaseSnapshot(
          store,
          stage.root,
          stage.evidence,
          stage.partition,
          options,
        );
        copies.push(copy);
        snapshotCopyBytes = add(snapshotCopyBytes, copy.bytes);
        const root = store.prefix + 'snapshots/' + randomUUID() + '/' + stage.partition,
          native = await move(copy.root, root, copy.native),
          evidence = await movedBaseEvidence(
            store,
            copy.evidence,
            stage.partition,
            native,
            options,
          );
        snapshotFacts.push({
          partition: stage.partition,
          root,
          evidence,
          provenance: stage.provenance,
        });
      }
      const source = await syncBasePayload(
          store,
          stage.root,
          stage.evidence,
          stage.partition,
          options,
        ),
        root = store.prefix + 'install/' + stage.partition,
        native = await move(stage.root, root, source),
        evidence = await movedBaseEvidence(store, stage.evidence, stage.partition, native, options);
      incomingFacts.push({ partition: stage.partition, root, evidence });
    }
    await set.pin.assertStable();
    // Unselected available inputs still belong to the common gate; none become optional malformed data.
    for (const object of objects)
      if (unavailable.has(object.reference[1][2])) await object.verifyStable(options);
    const check = () => {
      ProvisionalBaseSet.assertReceipt(set, store);
      signal.throwIfAborted();
    };
    const snapshots: PreparedWorkerSnapshot[] = [],
      incoming: VerifiedIncoming[] = [];
    for (const s of snapshotFacts)
      snapshots.push(
        await PreparedWorkerSnapshot.verify(
          store,
          {
            partition: s.partition,
            nativeRoot: s.root,
            evidence: s.evidence,
            provenance: s.provenance,
            finishVerification: async (binding) => {
              check();
              return binding;
            },
          },
          options.budget,
          options,
        ),
      );
    for (const s of incomingFacts)
      incoming.push(
        await VerifiedIncoming.verify(
          store,
          {
            partition: s.partition,
            nativeRoot: s.root,
            evidence: s.evidence,
            origin: 'trusted-base',
            finishVerification: async (binding) => {
              check();
              return binding;
            },
          },
          options,
        ),
      );
    check();
    // Copy only the bounded generation metadata into invocation ownership before releasing the download pin.
    const baseline = Object.freeze(
      await store.write('generation', store.read(set.pin.record, 'generation'), signal),
    ) as Reference;
    await set.pin.assertStable();
    check();
    adopted = true;
    await settleBaseCleanup([
      ...copies.map((c) => () => c.dispose()),
      ...emptyOwners.map(
        (o) => () => retireOwnedDirectory(store, o.root, o.native, options.budget),
      ),
    ]);
    signal.throwIfAborted();
    const result = Object.freeze({
      incoming: Object.freeze(incoming),
      snapshots: Object.freeze(snapshots),
      cold: Object.freeze(cold.map((g) => Object.freeze(g))),
      baseline: Object.freeze(['baseline', set.pin.key, baseline]),
      snapshotCopyBytes,
    });
    accepted.set(result, { store, max: options.maxDirectoryEntries ?? 100000 });
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (!adopted) {
        const rollback = async () => {
          for (const m of [...moves].reverse()) {
            const source = await store.root.stat(m.from),
              target = await store.root.stat(m.to);
            if (source && sameNative(m.before, source, true)) continue; // syscall did not move our object; never touch a foreign target.
            if (
              source ||
              !target ||
              !(m.after ? sameNative(m.after, target, true) : sameRename(m.before, target))
            )
              throw new Error('Base incoming rollback endpoints ambiguous.');
            await store.root.renameAbsent(m.to, m.from, target);
            await store.root.syncDirectory(parentPath(m.from));
            await store.root.syncDirectory(parentPath(m.to));
          }
        };
        await settleBaseCleanup([rollback], failure);
        await settleBaseCleanup(
          [
            ...copies.map((c) => () => c.dispose()),
            ...emptyOwners.map(
              (o) => () => retireOwnedDirectory(store, o.root, o.native, options.budget),
            ),
          ],
          failure,
        );
      }
    } finally {
      release();
    }
  }
}
export async function installBaseGeneration(
  store: OwnedStore,
  result: AcceptedBaseGeneration,
  options: BaseObjectOptions,
): Promise<void> {
  const binding = accepted.get(result);
  if (!binding || binding.store !== store) throw new Error('Unbound accepted base generation.');
  const plan = await freezeInstallPlan(store, result.incoming, options.budget, {
    signal: options.signal,
    maxDirectoryEntries: binding.max,
  });
  await executeInstall(store, plan, options.budget, { signal: options.signal });
}
