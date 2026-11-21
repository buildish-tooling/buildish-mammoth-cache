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

import { walkNative } from './native-walk';
import { verifyNativeEvidence } from './install-evidence';
import { randomUUID } from 'node:crypto';
import { FrozenMovingPublication } from './base-moving-publication';
import { MovingAdjustments } from './moving-adjustments';
import { ObservationIndex } from './observation-index';
import { checkCompleteGc } from './move-source';
import { checkGcProjection, type GcRelocationProjection } from './gc-projection';
import { RelocationProgram, type MoveRow, type MoveCursor } from './relocation-program';
import { RelocationSource } from './relocation-source';
import { RelocationTreeFile } from './relocation-tree-file';
import { RelocationRoots } from './relocation-roots';
import { RelocationEpoch } from './relocation-epoch';
import { checkMoveMember } from './relocation-member';
import { InstallParentPhase } from './install-parent-phase';
import { sameDirectoryObject } from './install-member';
import { sameNative, type NativeIdentity } from './native';
import { compareMembership, baseName } from './tree-state';
import { tuple, equal, type Value } from './encoding';
import { settleBaseCleanup } from './base-object';
import { retireOwnedDirectory } from './owned-retirement';
import type { Reference } from './owned-store';
import type { BatchTargets } from './install-batches';

export interface MovingPartition {
  readonly program: RelocationProgram;
  readonly source: RelocationSource;
  readonly tree: RelocationTreeFile;
  readonly shape: RelocationRoots;
  readonly ownedRoot: string | null;
  current: MovingAdjustments;
}
const windows = new WeakSet<object>();
// Protocol: docs/dev/cache-lifecycle-protocol.md#moving-source-publication-handoff.
// One stable-phase original index/parent ledger, shared across every partition.
// No source bytes, whole-cache inventory, or metadata prefix is reread per upload.
export class MovingWindow {
  private closed = false;
  private busy = false;
  private failed = false;
  private checked = false;
  private borrowed: { p: string; epoch: RelocationEpoch | null } | null = null;
  get verified() {
    return this.checked && !this.failed && !this.closed;
  }
  private constructor(
    readonly publication: FrozenMovingPublication,
    readonly original: ObservationIndex,
    readonly livePhase: InstallParentPhase,
    private readonly parts: Map<string, MovingPartition>,
    private readonly container: string,
    private readonly owner: NativeIdentity,
  ) {
    windows.add(this);
  }
  static assert(window: MovingWindow, pub = window.publication) {
    if (!windows.has(window) || window.closed || window.failed || window.publication !== pub)
      throw new Error('Unavailable moving source window.');
    FrozenMovingPublication.assert(pub);
  }
  static async open(pub: FrozenMovingPublication, limits: BatchTargets = {}) {
    FrozenMovingPublication.assert(pub);
    if (
      pub.store.codec.options.access !== 'writable' ||
      pub.store.codec.options.role === 'distributed-worker'
    )
      throw new Error('Moving window requires writable base role.');
    const state = await pub.state(),
      original = await ObservationIndex.open(pub.store, state[6]!, pub.options),
      parts = new Map<string, MovingPartition>(),
      container = pub.store.prefix + 'planning/' + randomUUID();
    let window: MovingWindow | undefined;
    try {
      await checkCompleteGc(original);
      await pub.store.makeParents(container + '/live/pending');
      const owner = (await pub.store.root.stat(container))!,
        phase = new InstallParentPhase(
          pub.store,
          '',
          container + '/live/',
          pub.options.budget,
          async (path) => {
            const d = await original.directory(path);
            try {
              return structuredClone(d.node[2]);
            } finally {
              d.release();
            }
          },
          pub.options.signal,
        );
      window = new MovingWindow(pub, original, phase, parts, container, owner);
      const cells = await pub.cells();
      try {
        for (const choice of pub.choices)
          if (choice[0] === 'new') {
            const p = choice[1],
              program = await RelocationProgram.create(pub, p, [], limits);
            let source: RelocationSource | undefined,
              tree: RelocationTreeFile | undefined,
              shape: RelocationRoots | undefined,
              current: MovingAdjustments | undefined,
              ownedRoot: string | null = null;
            try {
              source = await RelocationSource.open(program);
              tree = await RelocationTreeFile.open(pub.tree(p), pub.options);
              const s = source;
              shape = await RelocationRoots.create(
                pub.store,
                pub.options.budget,
                (async function* () {
                  for await (const range of program.ranges())
                    for await (const move of program.moves(range)) {
                      if (move[2] === 'owned') ownedRoot = move[3].slice(0, -move[4].length - 1);
                      const fact = await s.member(move);
                      yield [move[4], ['shape', move, fact.span]] as const;
                    }
                })(),
                pub.options.signal,
              );
              let q = cells.rows.find((c) => c[1] === p)![3];
              const raw = await pub.store.readFixed(pub.store.prefix + 'relocation/' + p + '.json');
              if (raw) {
                const marker = pub.store.codec.schemas.documents.relocation.parse(raw);
                if (
                  marker[7] === 'sources-returned' &&
                  JSON.stringify(q) === JSON.stringify(marker[13])
                )
                  q = marker[6];
              }
              current = await MovingAdjustments.open(program, source, q);
              parts.set(p, { program, source, tree, shape, current, ownedRoot });
            } catch (error) {
              await settleBaseCleanup(
                [
                  () => program.close(),
                  () => source?.close(),
                  () => tree?.close(),
                  () => shape?.close(),
                  () => current?.close(),
                ],
                error,
              );
              throw error;
            }
          }
      } finally {
        cells.release();
      }
      return window;
    } catch (error) {
      await settleBaseCleanup(window ? [() => window!.close()] : [() => original.dispose()], error);
      throw error;
    }
  }
  acquire(p: string) {
    MovingWindow.assert(this);
    if (this.busy || this.borrowed) throw new Error('Moving window already borrowed/active.');
    this.currentPart(p);
    const owner = { p, epoch: null as RelocationEpoch | null };
    this.borrowed = owner;
    return () => {
      if (this.borrowed === owner) this.borrowed = null;
    };
  }
  register(epoch: RelocationEpoch) {
    RelocationEpoch.assert(epoch, this.publication);
    if (!this.borrowed || this.borrowed.p !== epoch.partition || this.borrowed.epoch)
      throw new Error('Missing exclusive moving borrow.');
    this.borrowed.epoch = epoch;
  }
  assertEpoch(epoch: RelocationEpoch) {
    MovingWindow.assert(this);
    if (this.busy || this.borrowed?.epoch !== epoch)
      throw new Error('Moving window operation/borrow mismatch.');
  }
  assertEpochClose(epoch: RelocationEpoch) {
    if (this.busy || this.borrowed?.epoch !== epoch)
      throw new Error('Moving window is using the borrowed epoch.');
  }
  private async operation<T>(p: string, work: () => Promise<T>): Promise<T> {
    MovingWindow.assert(this);
    if (
      this.busy ||
      (this.borrowed &&
        (this.borrowed.p !== p || !this.borrowed.epoch || this.borrowed.epoch.isActive))
    )
      throw new Error('Moving window operation/borrow active.');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  private currentPart(p: string): MovingPartition {
    MovingWindow.assert(this);
    const part = this.parts.get(p);
    if (!part) throw new Error('No changed moving partition.');
    return part;
  }
  part(p: string): Readonly<Omit<MovingPartition, 'current'>> {
    const part = this.currentPart(p);
    return Object.freeze({
      program: part.program,
      source: part.source,
      tree: part.tree,
      shape: part.shape,
      ownedRoot: part.ownedRoot,
    });
  }
  current(p: string) {
    const value = this.currentPart(p).current;
    return Object.freeze({ reference: value.reference, highestEpoch: value.highestEpoch });
  }
  private async native(p: string, move: MoveRow) {
    const part = this.currentPart(p),
      adjust = await part.current.root(move);
    return adjust ? (adjust[3] as NativeIdentity) : (await part.source.member(move)).native;
  }
  nativeFor(epoch: RelocationEpoch, move: MoveRow) {
    this.assertEpoch(epoch);
    return this.native(epoch.partition, move);
  }
  contextFor(
    epoch: RelocationEpoch,
    path: string,
    actual: NativeIdentity,
    changed: boolean,
    known: NativeIdentity | null,
  ) {
    this.assertEpoch(epoch);
    return this.contextNative(epoch.partition, path, actual, changed, known);
  }
  contextsFor(epoch: RelocationEpoch) {
    this.assertEpoch(epoch);
    return this.checkLiveContexts(epoch.partition);
  }
  projectionFor(epoch: RelocationEpoch, path: string) {
    this.assertEpoch(epoch);
    return this.parentProjection(path);
  }
  adopt(p: string, reference: Reference) {
    return this.operation(p, () => this.adoptCurrent(p, reference));
  }
  private async adoptCurrent(p: string, reference: Reference) {
    const catalog = await this.publication.cells();
    try {
      equal(
        catalog.rows.find((c) => c[1] === p)?.[3] ?? null,
        reference,
        'committed current adjustment pointer',
      );
    } finally {
      catalog.release();
    }
    const part = this.currentPart(p),
      next = await MovingAdjustments.open(part.program, part.source, reference),
      old = part.current;
    part.current = next;
    await old.close();
  }
  private async ownedEffect(
    p: string,
    path: string,
    actual: NativeIdentity,
    proof?: MovingAdjustments,
  ) {
    const part = this.currentPart(p),
      effect = await (proof ?? part.current).effect(path);
    if (!effect) return false;
    equal([effect[2], effect[3]], [actual[3], actual[4]], 'owned adjustment ancestor identity');
    equal(effect[4], await part.source.projection(path), 'owned full ancestor projection');
    return true;
  }
  private async contextNative(
    p: string,
    path: string,
    actual: NativeIdentity,
    activeChanged = false,
    known?: NativeIdentity | null,
    proof?: MovingAdjustments,
  ) {
    const part = this.currentPart(p),
      frozen = await part.source.directory(path);
    if (!frozen) throw new Error('Missing frozen source context.');
    const effect = await this.ownedEffect(p, path, actual, proof);
    if (known) {
      if (!sameNative(known, actual, true)) throw new Error('Known source context changed.');
      return;
    }
    const affected = activeChanged || effect;
    if (!(affected ? sameDirectoryObject(frozen, actual) : sameNative(frozen, actual, true)))
      throw new Error('Source context changed.');
  }
  private async checkLiveContexts(p: string) {
    const part = this.currentPart(p);
    if (part.ownedRoot) throw new Error('Not a live source.');
    let skip = '';
    for await (const item of this.publication.store.rows(
      part.program.source,
      'native-evidence',
      { ...this.publication.options, partition: p },
      this.publication.options.signal,
    )) {
      const row = tuple(item.value);
      if (row[0] !== 'directory' && row[0] !== 'file') continue;
      const path = String(row[1]);
      if (skip && path.startsWith(skip + '/')) continue;
      skip = '';
      const claim = await part.shape.claim(path);
      try {
        if (claim && tuple(claim.value)[0] === 'shape') {
          if (row[0] === 'directory') skip = path;
          continue;
        }
        if (row[0] !== 'directory') throw new Error('Unproven live context file.');
        const expected = await this.livePhase.known(path),
          actual = await this.publication.store.root.stat(path);
        if (!expected || !actual || !sameNative(expected, actual, true))
          throw new Error('Live source context changed.');
      } finally {
        claim?.release();
      }
    }
  }
  verifyPart(p: string) {
    return this.operation(p, () => this.verifyPartition(p));
  }
  private async verifyPartition(p: string) {
    const part = this.currentPart(p);
    if (part.ownedRoot) return this.verifyOwned(p);
    await this.checkLiveContexts(p);
    for await (const range of part.program.ranges())
      for await (const move of part.program.moves(range)) {
        const fact = await part.source.member(move);
        await checkMoveMember(
          part.program,
          move,
          move[3],
          part.source.evidence,
          fact.span,
          part.tree,
          { rootNative: await this.native(p, move), parentPhase: this.livePhase },
        );
      }
  }
  private async verifyOwned(p: string, proof?: MovingAdjustments) {
    const parents: { native: NativeIdentity; release: () => void }[] = [];
    const part = this.currentPart(p),
      anchor = part.ownedRoot!,
      pub = this.publication,
      actual = walkNative(pub.store.root, anchor, {
        ...pub.options,
        logicalRoot: '',
        metadata: 'reject',
        inspectChild: async (child) => {
          const claim = await part.shape.claim(child.path);
          try {
            if (claim && tuple(claim.value)[0] === 'shape') return 'prune';
          } finally {
            claim?.release();
          }
        },
      }),
      next = async () => {
        let item = await actual.next();
        while (!item.done && item.value.tag === 'directory-close') {
          parents.pop()!.release();
          item = await actual.next();
        }
        if (!item.done && item.value.tag === 'directory-open')
          parents.push({ native: item.value.identity, release: pub.options.budget.holdRecord(32) });
        return item;
      };
    let skip = '';
    try {
      for await (const item of pub.store.rows(
        part.program.source,
        'native-evidence',
        { ...pub.options, partition: p },
        pub.options.signal,
      )) {
        const row = tuple(item.value);
        if (row[0] !== 'directory' && row[0] !== 'file') continue;
        const path = String(row[1]);
        if (skip && path.startsWith(skip + '/')) continue;
        skip = '';
        const claim = await part.shape.claim(path);
        try {
          const r = claim ? tuple(claim.value) : [],
            observed = await next();
          if (r[0] === 'shape') {
            const move = r[1] as MoveRow,
              adjustment = await (proof ?? part.current).root(move),
              native = adjustment
                ? (adjustment[3] as NativeIdentity)
                : (await part.source.member(move)).native,
              fact = await part.source.member(move);
            if (
              observed.done ||
              observed.value.tag !== 'protected-child' ||
              observed.value.path !== path ||
              observed.value.device !== native[3] ||
              observed.value.fileId !== native[4]
            )
              throw new Error('Owned source root projection changed.');
            await checkMoveMember(
              part.program,
              move,
              move[3],
              part.source.evidence,
              fact.span,
              part.tree,
              { rootNative: native, parentNative: parents[parents.length - 1].native },
            );
            if (row[0] === 'directory') skip = path;
          } else {
            if (
              row[0] !== 'directory' ||
              observed.done ||
              observed.value.tag !== 'directory-open' ||
              observed.value.path !== path
            )
              throw new Error('Owned source context membership changed.');
            await this.contextNative(p, path, observed.value.identity, false, undefined, proof);
          }
        } finally {
          claim?.release();
        }
      }
      if (!(await next()).done) throw new Error('Unexpected owned source member.');
    } finally {
      for (const frame of parents) frame.release();
      await actual.return(undefined);
    }
  }
  private async retainedSources() {
    const pub = this.publication,
      state = await pub.state();
    for await (const item of pub.store.rows(
      state[7]!,
      'post-sources',
      { ...pub.options, partition: null },
      pub.options.signal,
    )) {
      const row = tuple(item.value);
      if (row[0] !== 'snapshot-source') continue;
      const source = pub.store.codec.schemas.source.parse(row[1]);
      if (this.parts.has(source[0])) continue;
      await verifyNativeEvidence(pub.store, source[3], source[4], source[0], pub.options);
    }
  }
  async *mergeRows(p: string, delta: AsyncIterable<Value>): AsyncGenerator<Value> {
    const part = this.currentPart(p),
      pub = this.publication,
      old = part.current.reference;
    const previous = (async function* () {
      if (old)
        for await (const item of pub.store.rows(
          old,
          'adjustments',
          { ...pub.options, partition: p },
          pub.options.signal,
        )) {
          const row = tuple(item.value);
          if (row[0] !== 'local-stream' && row[0] !== 'local-end') yield row;
        }
    })();
    const incoming = delta[Symbol.asyncIterator]();
    let a = await previous.next(),
      b = await incoming.next();
    const member = (row: readonly Value[]) =>
      [
        'member',
        row[0] === 'ancestor-effect' || (row[3] as NativeIdentity)[2] === 'directory'
          ? 'unit'
          : 'file',
        String(row[1]),
      ] as const;
    try {
      while (!a.done || !b.done) {
        pub.options.signal?.throwIfAborted();
        if (a.done) {
          yield b.value!;
          b = await incoming.next();
          continue;
        }
        if (b.done) {
          yield a.value;
          a = await previous.next();
          continue;
        }
        const row = tuple(b.value),
          order = compareMembership(member(a.value), member(row));
        if (order < 0) {
          yield a.value;
          a = await previous.next();
        } else {
          yield row;
          b = await incoming.next();
          if (order === 0) a = await previous.next();
        }
      }
    } finally {
      await settleBaseCleanup([() => previous.return(undefined), () => incoming.return?.()]);
    }
  }
  checkCandidate(epoch: RelocationEpoch, reference: Reference) {
    return this.operation(epoch.partition, () => this.admitCandidate(epoch, reference));
  }
  private async admitCandidate(epoch: RelocationEpoch, reference: Reference) {
    RelocationEpoch.assert(epoch, this.publication);
    const part = this.currentPart(epoch.partition),
      marker = epoch.current;
    if (!marker || marker[7] !== 'sources-returned')
      throw new Error('Candidate requires returned ownership.');
    equal(marker[13], reference, 'exact returned candidate');
    equal(marker[6], part.current.reference, 'old current adjustment baseline');
    const candidate = await MovingAdjustments.open(part.program, part.source, reference),
      high = await part.program.index(marker[8] as MoveCursor);
    try {
      for await (const range of part.program.ranges())
        for await (const move of part.program.moves(range)) {
          const current = await candidate.root(move);
          if (move[1] <= high) {
            const claim = await epoch.nativeClaim(move[4]);
            try {
              const r = claim ? tuple(claim.value) : [];
              if (
                r[0] !== 'root' ||
                r[4] !== 'original' ||
                !current ||
                current[2] !== marker[4] ||
                !sameNative(current[3] as NativeIdentity, r[3] as NativeIdentity, true)
              )
                throw new Error('Returned candidate native root changed.');
            } finally {
              claim?.release();
            }
          } else equal(current, await part.current.root(move), 'untouched candidate adjustment');
          if (!part.ownedRoot) {
            const fact = await part.source.member(move);
            await checkMoveMember(
              part.program,
              move,
              move[3],
              part.source.evidence,
              fact.span,
              part.tree,
              {
                rootNative: current ? (current[3] as NativeIdentity) : fact.native,
                parentPhase: this.livePhase,
              },
            );
          }
        }
      if (!part.ownedRoot) await this.checkLiveContexts(epoch.partition);
      else await this.verifyOwned(epoch.partition, candidate);
      for await (const item of this.publication.store.rows(
        reference,
        'adjustments',
        { ...this.publication.options, partition: epoch.partition },
        this.publication.options.signal,
      )) {
        const row = tuple(item.value);
        if (row[0] !== 'ancestor-effect') continue;
        const path = String(row[1]),
          physical = part.ownedRoot ? part.ownedRoot + (path ? '/' + path : '') : path,
          actual = await this.publication.store.root.stat(physical);
        if (!actual || actual[2] !== 'directory')
          throw new Error('Returned candidate ancestor missing.');
        equal(row.slice(2, 4), [actual[3], actual[4]], 'returned candidate ancestor identity');
        const sha = part.ownedRoot
          ? await part.source.projection(path)
          : await this.parentProjection(path);
        equal(row[4], sha, 'returned candidate ancestor projection');
      }
      // A candidate is fully parsed/root-bound before it can replace current.
      return candidate;
    } catch (error) {
      await candidate.close();
      throw error;
    }
  }
  async verify(active?: RelocationEpoch) {
    MovingWindow.assert(this);
    if (
      this.busy ||
      (this.borrowed && (!active || this.borrowed.epoch !== active || active.isActive))
    )
      throw new Error('Moving source verification active/borrowed.');
    this.busy = true;
    if (active) RelocationEpoch.assert(active, this.publication);
    const pub = this.publication,
      signal = pub.options.signal ?? new AbortController().signal,
      heads: {
        p: string;
        part: MovingPartition;
        iterator: AsyncGenerator<MoveRow>;
        head: IteratorResult<MoveRow>;
      }[] = [],
      frames: {
        path: string;
        native: NativeIdentity;
        effects: readonly Value[][];
        missing: [string, string][];
        release: () => void;
        charge: number;
      }[] = [];
    let failure: unknown;
    try {
      await pub.store.assertNoIntents(active?.current ?? undefined);
      const catalog = await pub.cells();
      try {
        for (const cell of catalog.rows) {
          const part = this.parts.get(cell[1]);
          if (!part) continue;
          const marker = active?.partition === cell[1] ? active.current : null;
          if (marker && JSON.stringify(cell[3]) === JSON.stringify(marker[13]))
            equal(part.current.reference, marker[6], 'old candidate source baseline');
          else equal(cell[3], part.current.reference, 'current window source baseline');
          if (
            cell[6] !== null &&
            (!marker || cell[6] !== pub.store.prefix + 'relocation/' + cell[1] + '.json')
          )
            throw new Error('Unowned relocation catalog hint.');
        }
      } finally {
        catalog.release();
      }
      for (const [p, part] of this.parts)
        if (!part.ownedRoot) {
          const iterator = (async function* () {
            for await (const range of part.program.ranges()) yield* part.program.moves(range);
          })();
          heads.push({ p, part, iterator, head: await iterator.next() });
        }
      const least = () => {
        let chosen: (typeof heads)[number] | undefined;
        for (const h of heads)
          if (
            !h.head.done &&
            (!chosen ||
              compareMembership(
                ['member', h.head.value[5] === 'file' ? 'file' : 'unit', h.head.value[4]],
                [
                  'member',
                  chosen.head.value![5] === 'file' ? 'file' : 'unit',
                  chosen.head.value![4],
                ],
              ) < 0)
          )
            chosen = h;
        return chosen;
      };
      const join: GcRelocationProjection = {
        member: async (path, present) => {
          const chosen = least();
          if (!chosen || chosen.head.value![4] !== path) return false;
          const move = chosen.head.value!;
          if (active?.partition === chosen.p) {
            const claim = await active.nativeClaim(path);
            try {
              const r = claim ? tuple(claim.value) : [];
              if (r[0] !== 'root' || present !== (r[4] === 'original'))
                throw new Error('Active root location changed.');
              if (!present) {
                const f = frames[frames.length - 1],
                  n = 128 + 4 * Buffer.byteLength(baseName(path));
                pub.options.budget.retain(n);
                f.charge += n;
                f.missing.push([baseName(path), move[5]]);
              }
            } finally {
              claim?.release();
            }
          } else {
            if (!present) throw new Error('Returned source missing.');
            const fact = await chosen.part.source.member(move);
            await checkMoveMember(
              chosen.part.program,
              move,
              move[3],
              chosen.part.source.evidence,
              fact.span,
              chosen.part.tree,
              {
                rootNative: await this.native(chosen.p, move),
                parentNative: frames[frames.length - 1].native,
              },
            );
          }
          chosen.head = await chosen.iterator.next();
          return true;
        },
        directory: async (d, n, gcChanged) => {
          const frame = frames[frames.length - 1];
          if (frame.path !== d[1]) throw new Error('Moving projection stack mismatch.');
          const known = await this.livePhase.known(d[1]);
          let frozen: NativeIdentity | null = null;
          for (const h of heads) {
            const candidate = await h.part.source.directory(d[1]);
            if (candidate) {
              if (frozen && !sameNative(frozen, candidate, true))
                throw new Error('Post-GC context baselines disagree.');
              frozen = candidate;
            }
          }
          let changed = false;
          if (active) {
            const part = this.currentPart(active.partition);
            if (!part.ownedRoot) {
              const claim = await active.nativeClaim(d[1]);
              try {
                const r = claim ? tuple(claim.value) : [];
                changed = r[0] === 'context' && r[1] === 1;
              } finally {
                claim?.release();
              }
            }
          }
          if (frame.effects.length) {
            const digest = d[10][7];
            for (const effect of frame.effects) {
              equal(effect.slice(2, 4), [n[3], n[4]], 'live ancestor stable identity');
              equal(effect[4], digest, 'complete live ancestor projection');
            }
            changed = true;
          }
          if (known) {
            if (!sameNative(known, n, true)) throw new Error('Known live context changed.');
            return;
          }
          const expected = frozen ?? d[2];
          if (
            !(changed || (!frozen && gcChanged)
              ? sameDirectoryObject(expected, n)
              : sameNative(expected, n, true))
          )
            throw new Error('Unexplained live context change.');
        },
      };
      await checkGcProjection(
        this.original,
        this.original.completed[4],
        this.original.completed[4],
        undefined,
        undefined,
        {
          open: async (d, n) => {
            const effects: Value[][] = [];
            let charge = 0;
            try {
              for (const h of heads) {
                const effect = await h.part.current.effect(d[1]);
                if (effect) {
                  const owned = structuredClone([...effect]),
                    size = 512 + 4 * Buffer.byteLength(d[1]);
                  pub.options.budget.retain(size);
                  charge += size;
                  effects.push(owned);
                }
              }
              frames.push({
                path: d[1],
                native: n,
                effects,
                missing: [],
                release: pub.options.budget.holdRecord(512 + Buffer.byteLength(d[1])),
                charge,
              });
            } catch (error) {
              pub.options.budget.release(charge);
              throw error;
            }
          },
          file: async () => {},
          protected: async () => {},
          close: async (d, n) => {
            const frame = frames.pop()!;
            try {
              await this.livePhase.created(d[1], n, d[10][7]);
            } finally {
              frame.release();
              pub.options.budget.release(frame.charge);
            }
          },
        },
        join,
      );
      if (heads.some((h) => !h.head.done)) throw new Error('Unvisited live move roots.');
      for (const [p, part] of this.parts)
        if (part.ownedRoot && active?.partition !== p) await this.verifyOwned(p);
      await this.retainedSources();
      signal.throwIfAborted();
      this.checked = true;
    } catch (error) {
      failure = error;
      this.failed = true;
      throw error;
    } finally {
      for (const frame of frames) {
        frame.release();
        pub.options.budget.release(frame.charge);
      }
      try {
        await settleBaseCleanup(
          heads.map((h) => () => h.iterator.return(undefined)),
          failure,
        );
      } finally {
        this.busy = false;
      }
    }
  }
  private async parentProjection(path: string) {
    const sha = await this.livePhase.projection(path);
    if (!sha) throw new Error('Missing checked post-GC parent projection.');
    return sha;
  }
  async close() {
    if (this.busy || this.borrowed) throw new Error('Moving window operation/borrow active.');
    if (this.closed) return;
    this.livePhase.release();
    const pub = this.publication;
    await settleBaseCleanup(
      [...this.parts.values()]
        .flatMap((p) => [
          () => p.current.close(),
          () => p.shape.close(),
          () => p.source.close(),
          () => p.tree.close(),
          () => p.program.close(),
        ])
        .concat([
          () => this.original.dispose(),
          () => retireOwnedDirectory(pub.store, this.container, this.owner, pub.options.budget),
        ]),
    );
    this.closed = true;
  }
}
