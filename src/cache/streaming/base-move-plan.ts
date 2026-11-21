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

import type { PartitionSummaries } from './partition-summaries';
import { LiveBaseInputs, type LivePartitionSource } from './live-base-inputs';
import { FrozenBaseTree } from './base-frozen-tree';
import { InstallScratch } from './install-scratch';
import {
  buildInstallIndex,
  indexedNode,
  indexedEntries,
  nodeMask,
  partitionBit,
  type IndexedNode,
} from './install-index';
import { checkMoveSourceBindings } from './move-source';
import { ObservationIndex } from './observation-index';
import { WorkerSpool } from './worker-spool';
import { decodeRecords, tuple, equal, encodeRecord, type Value } from './encoding';
import { workspaceKind } from '../immutable-workspaces';
import { isWorkspaceRoot, compareMembership } from './tree-state';
import { settleBaseCleanup } from './base-object';
import type { LocalRow } from './local-stream';
import type { OwnedStore, Reference } from './owned-store';
import type { BaseObjectOptions } from './base-object';

type Group = readonly [string, string, string];
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans.
// One global native metadata index/walk routes aggregate roots to P bounded sinks.
// Owned snapshots each have their own independent retained projection. No moves.
export async function freezeMovePlans(
  input: LiveBaseInputs,
  trees: readonly FrozenBaseTree[],
  summaries?: PartitionSummaries,
): Promise<ReadonlyMap<string, Reference>> {
  LiveBaseInputs.assert(input);
  const { store, options } = input.view,
    signal = options.signal ?? new AbortController().signal,
    model = store.codec.options.model,
    selected = new Map<string, FrozenBaseTree>(),
    spools = new Map<string, WorkerSpool>(),
    presences = new Map<string, WorkerSpool>(),
    result = new Map<string, Reference>();
  summaries?.assert(model);
  for (const t of trees) {
    FrozenBaseTree.assert(t, store);
    const p = t.reference[1][2];
    if (selected.has(p)) throw new Error('Duplicate move partition.');
    selected.set(p, t);
  }
  const scratch = await InstallScratch.create(store, options.budget);
  let observations: ObservationIndex | undefined, failure: unknown;
  try {
    observations = await ObservationIndex.open(store, input.view.observations, options);
    for (const p of selected.keys()) spools.set(p, await WorkerSpool.create(store, options.budget));
    async function* liveRows(): AsyncGenerator<LocalRow> {
      let at = 0;
      for await (const value of input.view.rows())
        yield { value, start: at, end: ++at, record: at - 1 };
    }
    const root = await buildInstallIndex(scratch, liveRows(), model, null, signal);
    const emit = async (p: string, row: Value) => {
      await spools.get(p)!.append(row, signal);
    };
    const indexOf = (mask: bigint) =>
      model.partitions.findIndex((p) => mask === partitionBit(model, p[0]));
    const rootRow = async (p: string, node: IndexedNode, source: LivePartitionSource) => {
      let span: Value;
      if (!source.nativeRoot) {
        const original =
          node[1] === 'file'
            ? await observations!.file(node[2])
            : await observations!.directory(node[2]);
        try {
          const n = original.node;
          span = [
            'span',
            input.view.observations[4],
            n[0] === 'observed-file' ? n[7] : n[5],
            n[0] === 'observed-file' ? n[8] : n[6],
          ];
        } finally {
          original.release();
        }
      } else span = ['span', source.evidence[4], node[9], node[10]];
      summaries?.root(p, node[1] as 'file' | 'directory');
      await emit(p, [
        'move-candidate',
        source.nativeRoot ? 'owned' : 'live',
        source.nativeRoot ? source.nativeRoot + '/' + node[2] : node[2],
        node[2],
        node[1],
        span,
      ]);
    };
    async function group(p: string, descriptor: Group, body: () => Promise<number>) {
      await emit(p, ['move-unit-open', ...descriptor]);
      const count = await body();
      if (!count) throw new Error('Empty transfer group.');
      await emit(p, ['move-unit-close', descriptor[0], descriptor[1], count]);
    }
    async function workspace(node: IndexedNode): Promise<Group | null> {
      if (!isWorkspaceRoot(model, node[2])) return null;
      let jar = false;
      for await (const [name, kind] of indexedEntries(scratch, node))
        if (kind === 'file' && (name === 'classes.jar' || name === 'sources.jar')) jar = true;
      return [workspaceKind(node[2], jar ? [node[2] + '/classes.jar'] : []), node[2], 'subtree'];
    }
    async function visit(
      offset: number,
      owned: LivePartitionSource | null,
      active: { p: string; group: Group } | null = null,
    ): Promise<number> {
      signal.throwIfAborted();
      const lease = await indexedNode(scratch, offset),
        n = lease.node;
      try {
        if (n[1] === 'protected') return 0;
        const pi = indexOf(nodeMask(n)),
          p = pi < 0 ? null : model.partitions[pi][0],
          source = owned ?? (p ? input.partitions.find((s) => s.partition === p)! : null),
          contributes =
            p !== null &&
            selected.has(p) &&
            (owned !== null || model.partitions[pi][3] === 'aggregate');
        const maven =
          model.tuple[2] === 'maven' && (n[2] === 'repository' || n[2].startsWith('repository/'));
        let directories = false;
        if (n[1] === 'directory' && maven)
          for await (const e of indexedEntries(scratch, n))
            if (e[1] === 'directory') {
              directories = true;
              break;
            }
        const eligible = !!n[2] && n[6] === 0 && contributes;
        const scope = n[1] === 'directory' ? await workspace(n) : null;
        if (summaries && n[1] === 'directory' && n[2] && !eligible) {
          const reason = n[6]
            ? 'excluded or unmanaged entries remain'
            : pi < 0
              ? 'mixed partition ownership'
              : 'unselected contents';
          for (const id of selected.keys())
            if ((nodeMask(n) & partitionBit(model, id)) !== 0n) summaries.hint(id, reason, n[2]);
        }
        if (eligible) {
          if (active) {
            if (active.p !== p) throw new Error('Split transfer workspace owner.');
            await rootRow(p!, n, source!);
            return 1;
          }
          const descriptor: Group =
            n[1] === 'file'
              ? ['file', n[2], 'file']
              : (scope ??
                // Physical ancestors may contain several complete direct Maven units.
                (maven && !directories
                  ? ['maven-directory', n[2], 'direct']
                  : ['directory', n[2], 'subtree']));
          await group(p!, descriptor, async () => {
            await rootRow(p!, n, source!);
            return 1;
          });
          return 1;
        }
        if (n[1] === 'file') {
          if (!contributes) return 0;
          if (active) {
            await rootRow(p!, n, source!);
            return 1;
          }
          throw new Error('File transfer requires its complete semantic unit.');
        }
        if (scope && !active && contributes) {
          let count = 0;
          await group(p!, scope, async () => {
            count = await children(n, owned, { p: p!, group: scope });
            return count;
          });
          return count;
        }
        return children(n, owned, active);
      } finally {
        lease.release();
      }
    }
    async function children(
      n: IndexedNode,
      owned: LivePartitionSource | null,
      active: { p: string; group: Group } | null,
    ): Promise<number> {
      let count = 0;
      const direct = new Map<string, number>(),
        maven =
          model.tuple[2] === 'maven' && (n[2] === 'repository' || n[2].startsWith('repository/'));
      // Indexed pages are name sorted; traverse two sequential categories without
      // retaining NativeN records/roots across the whole immediate directory.
      for await (const [, kind, offset] of indexedEntries(scratch, n))
        if (kind === 'file') {
          const child = await indexedNode(scratch, offset);
          try {
            const mask = nodeMask(child.node),
              pi = indexOf(mask),
              p = pi < 0 ? null : model.partitions[pi][0];
            if (!p || !selected.has(p) || (!owned && model.partitions[pi][3] !== 'aggregate'))
              continue;
            if (maven && !active) {
              if (!direct.has(p)) {
                await emit(p, ['move-unit-open', 'maven-directory', n[2], 'direct']);
                direct.set(p, 0);
              }
              await rootRow(
                p,
                child.node,
                owned ?? input.partitions.find((s) => s.partition === p)!,
              );
              direct.set(p, direct.get(p)! + 1);
              count++;
            } else count += await visit(offset, owned, active);
          } finally {
            child.release();
          }
        }
      for (const [p, roots] of direct)
        await emit(p, ['move-unit-close', 'maven-directory', n[2], roots]);
      for await (const [, kind, offset] of indexedEntries(scratch, n))
        if (kind === 'directory') count += await visit(offset, owned, active);
      return count;
    }
    await visit(root, null);
    for (const source of input.partitions)
      if (source.nativeRoot && selected.has(source.partition)) {
        const root = await buildInstallIndex(
          scratch,
          store.rows(
            source.evidence,
            'native-evidence',
            { ...options, partition: source.partition },
            signal,
          ),
          model,
          source.partition,
          signal,
        );
        await visit(root, source);
      }
    for (const [p, spool] of spools) {
      spool.seal(signal);
      const t = selected.get(p)!,
        reader = new TreeSpans(
          t,
          options,
          input.partitions.find((s) => s.partition === p)!.nativeRoot
            ? undefined
            : (path) => recordPresence(store, presences, p, path, options),
        );
      try {
        let index = 0;
        async function* rows(): AsyncGenerator<Value> {
          yield [
            'move-source',
            input.partitions.find((source) => source.partition === p)!.evidence,
          ];
          for await (const v of spool.rows(signal)) {
            const r = tuple(v);
            if (r[0] !== 'move-candidate') yield v;
            else
              yield [
                'move',
                ++index,
                r[1],
                r[2],
                r[3],
                r[4],
                await reader.member(String(r[3]), String(r[4])),
                r[5],
              ];
          }
          await reader.finish();
        }
        result.set(
          p,
          await store.writeStream('move-plan', { ...options, partition: p }, rows(), signal),
        );
        await t.assertStable(options);
      } finally {
        await reader.close();
      }
    }
    await checkPresences(observations!, presences, options);
    await input.view.assertStable();
  } catch (e) {
    failure = e;
  }
  try {
    await settleBaseCleanup(
      [
        () => observations?.dispose(),
        () => scratch.close(),
        ...[...spools.values(), ...presences.values()].map((s) => () => s.dispose()),
      ],
      failure,
    );
  } catch (e) {
    failure = e;
  }
  if (failure !== undefined) throw failure;
  signal.throwIfAborted();
  return result;
}

class TreeSpans {
  private readonly iterator;
  private readonly paths: { path: string; child: boolean; release: () => void }[] = [];
  constructor(
    private readonly tree: FrozenBaseTree,
    private readonly options: BaseObjectOptions,
    private readonly emptyPresence?: (path: string) => Promise<void>,
  ) {
    this.iterator = decodeRecords(tree.store.read(tree.tree, 'native-tree'));
  }
  private async next() {
    const next = await this.iterator.next();
    if (next.done) return null;
    const f = next.value,
      r = tuple(f.value),
      release = this.options.budget.holdRecord(f.raw.length);
    try {
      const tag = String(r[0]);
      let path: string | null = null,
        empty = false;
      if (tag === 'dir-open') {
        if (this.paths.length) this.paths[this.paths.length - 1].child = true;
        path = String(r[1]);
        this.paths.push({
          path,
          child: false,
          release: this.options.budget.holdRecord(512 + Buffer.byteLength(path)),
        });
      } else if (tag === 'dir-close') {
        path = String(r[1]);
        const frame = this.paths.pop();
        if (!frame || frame.path !== path) throw new Error('Tree span stack mismatch.');
        empty = !!path && !frame.child;
        frame.release();
      } else if (tag === 'file') {
        const parent = this.paths[this.paths.length - 1]?.path;
        if (parent === undefined) throw new Error('Tree file without parent.');
        this.paths[this.paths.length - 1].child = true;
        path = parent ? parent + '/' + r[1] : String(r[1]);
      }
      return { tag, path, start: f.start, end: f.end, empty };
    } finally {
      release();
    }
  }
  async member(path: string, kind: string, direct = false): Promise<Value> {
    const signal = this.options.signal;
    while (true) {
      signal?.throwIfAborted();
      const r = await this.next();
      if (!r) throw new Error('Missing exact portable transfer member.');
      if (r.path !== path || r.tag !== (kind === 'directory' ? 'dir-open' : 'file')) {
        await this.uncovered(r);
        continue;
      }
      if (kind === 'file') return ['span', this.tree.tree[4], r.start, r.end];
      while (true) {
        signal?.throwIfAborted();
        const end = await this.next();
        if (!end) throw new Error('Incomplete portable transfer subtree.');
        if (direct && end.tag === 'dir-open')
          throw new Error('Direct Maven directory move contains a child directory.');
        if (end.path === path && end.tag === 'dir-close')
          return ['span', this.tree.tree[4], r.start, end.end];
      }
    }
  }
  private async uncovered(r: { tag: string; empty: boolean; path: string | null }) {
    if (r.tag === 'file') throw new Error('Uncovered portable transfer member.');
    if (r.empty) {
      if (!this.emptyPresence || r.path === null)
        throw new Error('Uncovered portable empty subtree.');
      await this.emptyPresence(r.path);
    }
  }
  async finish() {
    let row;
    while ((row = await this.next())) {
      this.options.signal?.throwIfAborted();
      await this.uncovered(row);
    }
  }
  async close() {
    await this.iterator.return(undefined);
    for (const p of this.paths.splice(0)) p.release();
  }
}

// Exact immutable spans/locations, not a native relocation permission. All inputs
// must still pass current full-projection/descendant checks before any rename.
export async function checkMovePlanMetadata(
  store: OwnedStore,
  observation: Reference,
  plans: readonly {
    partition: string;
    plan: Reference;
    tree: FrozenBaseTree;
    source: LivePartitionSource | null;
  }[],
  options: BaseObjectOptions,
) {
  if (plans.length > store.codec.options.model.partitions.length)
    throw new Error('Move metadata frontier exceeded.');
  const original = await ObservationIndex.open(store, observation, options),
    presences = new Map<string, WorkerSpool>();
  const cursors: {
    plan: (typeof plans)[number];
    iterator: AsyncIterator<LocalRow>;
    head: readonly Value[] | null;
    tree: TreeSpans;
    native: NativeSpans | null;
    source: Reference | null;
    direct: boolean;
    release: () => void;
  }[] = [];
  let failure: unknown;
  const advance = async (cursor: (typeof cursors)[number]) => {
    while (true) {
      options.signal?.throwIfAborted();
      const row = await cursor.iterator.next();
      if (row.done) {
        cursor.head = null;
        return;
      }
      const r = tuple(row.value.value);
      if (r[0] === 'move-source') {
        cursor.source = store.codec.schemas.ref('native-evidence').parse(r[1]);
        cursor.release = options.budget.holdRecord(encodeRecord(cursor.source).length);
      }
      if (r[0] === 'move-unit-open') cursor.direct = r[1] === 'maven-directory';
      if (r[0] === 'move-unit-close') cursor.direct = false;
      if (r[0] === 'move') {
        cursor.head = r;
        return;
      }
    }
  };
  try {
    for (const p of plans) {
      FrozenBaseTree.assert(p.tree, store);
      const cursor = {
        plan: p,
        iterator: store
          .rows(p.plan, 'move-plan', { ...options, partition: p.partition }, options.signal)
          [Symbol.asyncIterator](),
        head: null as readonly Value[] | null,
        tree: new TreeSpans(
          p.tree,
          options,
          p.source
            ? undefined
            : (path) => recordPresence(store, presences, p.partition, path, options),
        ),
        native: p.source ? new NativeSpans(store, p.source, options) : null,
        source: null as Reference | null,
        direct: false,
        release: () => {},
      };
      cursors.push(cursor);
      await advance(cursor);
    }
    while (true) {
      options.signal?.throwIfAborted();
      let cursor: (typeof cursors)[number] | undefined;
      for (const c of cursors)
        if (
          c.head &&
          (!cursor ||
            compareMembership(
              ['member', c.head[5] === 'file' ? 'file' : 'unit', c.head[4]],
              ['member', cursor.head![5] === 'file' ? 'file' : 'unit', cursor.head![4]],
            ) < 0)
        )
          cursor = c;
      if (!cursor) break;
      const r = cursor.head!,
        p = cursor.plan,
        path = String(r[4]),
        kind = String(r[5]);
      equal(
        r[6],
        await cursor.tree.member(path, kind, cursor.direct),
        'exact portable move member span',
      );
      if (cursor.native) {
        equal(r[2], 'owned', 'owned move namespace');
        equal(r[3], p.source!.nativeRoot + '/' + path, 'exact owned move root');
        equal(r[7], await cursor.native.member(path, kind), 'exact owned move evidence span');
      } else {
        if (r[2] !== 'live' || r[3] !== path) throw new Error('Invalid live move root.');
        const lease = kind === 'file' ? await original.file(path) : await original.directory(path);
        try {
          const n = lease.node;
          if (n[0] === 'observed-file' && (n[3] !== p.partition || n[6] === 'delete'))
            throw new Error('Invalid retained move owner/selection.');
          equal(
            r[7],
            [
              'span',
              observation[4],
              n[0] === 'observed-file' ? n[7] : n[5],
              n[0] === 'observed-file' ? n[8] : n[6],
            ],
            'exact original move evidence span',
          );
        } finally {
          lease.release();
        }
      }
      await advance(cursor);
    }
    for (const c of cursors) {
      await c.tree.finish();
      await c.native?.finish();
    }
    await checkMoveSourceBindings(
      original,
      cursors.map((c) => {
        if (!c.source) throw new Error('Missing frozen move-source context.');
        return {
          partition: c.plan.partition,
          evidence: c.source,
          tree: c.plan.tree,
          owned: c.plan.source?.evidence ?? null,
        };
      }),
      options,
    );
    await checkPresences(original, presences, options);
  } catch (e) {
    failure = e;
  }
  try {
    await settleBaseCleanup(
      [
        () => original.dispose(),
        ...[...presences.values()].map((s) => () => s.dispose()),
        ...cursors.flatMap((c) => [
          () => c.iterator.return?.(),
          () => c.tree.close(),
          () => c.native?.close(),
          () => c.release(),
        ]),
      ],
      failure,
    );
  } catch (e) {
    failure = e;
  }
  if (failure !== undefined) throw failure;
  options.signal?.throwIfAborted();
}

class NativeSpans {
  private readonly iterator;
  private head: IteratorResult<LocalRow> | undefined;
  private pending: { path: string; release: () => void } | null = null;
  constructor(
    store: OwnedStore,
    private readonly source: LivePartitionSource,
    private readonly options: BaseObjectOptions,
  ) {
    this.iterator = store.rows(
      source.evidence,
      'native-evidence',
      { ...options, partition: source.partition },
      options.signal,
    );
  }
  private async take(): Promise<LocalRow | null> {
    const next = this.head ?? (await this.iterator.next());
    this.head = undefined;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      try {
        const r = next.done ? [] : tuple(next.value.value);
        if (
          (r[0] !== 'directory' && r[0] !== 'file') ||
          !String(r[1]).startsWith(pending.path + '/')
        )
          throw new Error('Uncovered original owned empty directory.');
      } finally {
        pending.release();
      }
    }
    return next.done ? null : next.value;
  }
  async member(path: string, kind: string): Promise<Value> {
    while (true) {
      this.options.signal?.throwIfAborted();
      const item = await this.take();
      if (!item) throw new Error('Missing original owned member.');
      const r = tuple(item.value);
      if (r[0] !== kind || r[1] !== path) {
        this.uncovered(r);
        continue;
      }
      if (kind === 'file') return ['span', this.source.evidence[4], item.start, item.end];
      return this.directoryEnd(path, item.start);
    }
  }
  private async directoryEnd(path: string, start: number): Promise<Value> {
    while (true) {
      this.options.signal?.throwIfAborted();
      const next = await this.iterator.next();
      if (next.done) throw new Error('Unsealed owned evidence span.');
      const c = tuple(next.value.value);
      if ((c[0] !== 'directory' && c[0] !== 'file') || !String(c[1]).startsWith(path + '/')) {
        this.head = next;
        return ['span', this.source.evidence[4], start, next.value.start];
      }
    }
  }
  private uncovered(r: readonly Value[]) {
    if (r[0] === 'file') throw new Error('Uncovered original owned file.');
    if (r[0] === 'directory' && r[1] !== '')
      this.pending = {
        path: String(r[1]),
        release: this.options.budget.holdRecord(512 + Buffer.byteLength(String(r[1]))),
      };
  }
  async finish() {
    let row;
    while ((row = await this.take())) {
      this.options.signal?.throwIfAborted();
      this.uncovered(tuple(row.value));
    }
  }

  async close() {
    this.pending?.release();
    this.pending = null;
    this.head = undefined;
    await this.iterator.return(undefined as never);
  }
}

async function recordPresence(
  store: OwnedStore,
  spools: Map<string, WorkerSpool>,
  partition: string,
  path: string,
  options: BaseObjectOptions,
) {
  let spool = spools.get(partition);
  if (!spool) {
    spool = await WorkerSpool.create(store, options.budget);
    spools.set(partition, spool);
  }
  await spool.append(
    ['projected-empty', partition, path],
    options.signal ?? new AbortController().signal,
  );
}
// Re-derive from exact original/ref-bound post-GC decisions, in one GLOBAL empty
// frontier after the global move frontier. No per-empty subtree scan or boolean
// that can authorize omitted files/fully movable empties. Native guards come later.
async function checkPresences(
  original: ObservationIndex,
  spools: ReadonlyMap<string, WorkerSpool>,
  options: BaseObjectOptions,
) {
  if (!spools.size) return;
  const { store } = original,
    signal = options.signal ?? new AbortController().signal,
    state = store.codec.schemas.documents['local-state'].parse(await store.state());
  equal(state[6], original.reference, 'projected presence original observation');
  if (!state[10]) throw new Error('Uncovered portable empty: missing GC completion.');
  const progress = store.codec.schemas.documents['gc-progress'].parse(
    await store.readDocument(state[10], 'gc-progress'),
  );
  equal(progress[3], original.reference, 'projected presence GC observation');
  if (progress[5] !== null) throw new Error('Projected presence has active GC.');
  equal(progress[4], original.completed, 'projected presence complete GC cursor');
  const cursors: { iterator: AsyncIterator<Value>; head: IteratorResult<Value> }[] = [];
  let failure: unknown;
  try {
    for (const spool of spools.values()) {
      spool.seal(signal);
      const iterator = spool.rows(signal)[Symbol.asyncIterator]();
      cursors.push({ iterator, head: await iterator.next() });
    }
    while (true) {
      signal.throwIfAborted();
      let cursor: (typeof cursors)[number] | undefined;
      for (const c of cursors)
        if (
          !c.head.done &&
          (!cursor ||
            compareMembership(
              ['member', 'unit', tuple(c.head.value)[2]],
              ['member', 'unit', tuple(cursor.head.value!)[2]],
            ) < 0)
        )
          cursor = c;
      if (!cursor) break;
      const r = tuple(cursor.head.value!),
        p = String(r[1]),
        path = String(r[2]),
        definition = store.codec.options.model.partitions.find((d) => d[0] === p),
        bit = partitionBit(store.codec.options.model, p),
        dir = await original.directory(path);
      try {
        const s = dir.node[10],
          owners = BigInt('0x' + s[3]);
        if (
          definition?.[3] !== 'aggregate' ||
          store.codec.options.model.owner(path + '/.workspace-directory-probe')[0] !== p ||
          s[5] !== 0 ||
          (BigInt('0x' + s[1]) & bit) !== 0n ||
          (BigInt('0x' + s[2]) & bit) !== 0n ||
          (s[4] === 0 && (owners & ~bit) === 0n)
        )
          throw new Error(
            'Uncovered portable empty directory is not a protected projected presence.',
          );
      } finally {
        dir.release();
      }
      cursor.head = await cursor.iterator.next();
    }
  } catch (e) {
    failure = e;
  }
  await settleBaseCleanup([...cursors.map((c) => () => c.iterator.return?.())], failure);
  if (failure !== undefined) throw failure;
}
