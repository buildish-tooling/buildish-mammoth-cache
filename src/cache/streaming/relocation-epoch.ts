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

import { StageDirectoryEvidence } from './stage-directory-evidence';
import { InstallScratch } from './install-scratch';
import { MovingWindow } from './moving-window';
import { walkNative } from './native-walk';
import { mkdir, opendir, rename, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RelocationProgram, type MoveRow, type MoveCursor } from './relocation-program';
import { RelocationSource } from './relocation-source';
import { RelocationRoots } from './relocation-roots';
import { RelocationTreeFile } from './relocation-tree-file';
import { checkMoveMember } from './relocation-member';
import { relocationLog, TransitionCursor } from './relocation-log';
import { FrozenMovingPublication } from './base-moving-publication';
import { ObservationIndex } from './observation-index';
import { checkCompleteGc } from './move-source';
import { checkGcProjection } from './gc-projection';
import { InstallParentPhase } from './install-parent-phase';
import { sameDirectoryObject } from './install-member';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { tuple, equal, type Value, Digest } from './encoding';
import { parentPath } from './tree-state';
import { decodeRecords } from './encoding';
import { ValidatedBaseObject, settleBaseCleanup } from './base-object';
import { movingObjectRef } from './base-moving-publication';
import { retireOwnedDirectory } from './owned-retirement';
import type { OwnedStore, OwnedAppend, Reference } from './owned-store';
import type { BatchTargets } from './install-batches';

type Marker = ReturnType<OwnedStore['codec']['schemas']['documents']['relocation']['parse']>;
type RootClaim = readonly [
  'root',
  MoveRow,
  Value,
  NativeIdentity,
  'original' | 'staged',
  number,
  number,
];
const epochs = new WeakSet<object>();
const signalOf = (pub: FrozenMovingPublication) =>
  pub.options.signal ?? new AbortController().signal;

// Protocol: docs/dev/cache-lifecycle-protocol.md#partition-wide-relocation-marker.
// One partition-wide owner. This primitive stops at a sealed return candidate;
// catalog/receipt eligibility belongs to the moving publisher, never the SDK result.
export class RelocationEpoch {
  private closed = false;
  private busy = false;
  private marker: Marker | null = null;
  private roots!: RelocationRoots;
  private readonly phases: InstallParentPhase[] = [];
  private sourcePhase!: InstallParentPhase;
  private stagePhase!: InstallParentPhase;
  private outbound: OwnedAppend | undefined;
  private returned: OwnedAppend | undefined;
  private stageBaseline: StageDirectoryEvidence | undefined;
  private constructor(
    readonly program: RelocationProgram,
    readonly source: RelocationSource,
    private readonly tree: RelocationTreeFile,
    private readonly original: ObservationIndex,
    private readonly container: string,
    private readonly owner: NativeIdentity,
    private readonly window?: MovingWindow,
    private readonly releaseWindow: () => void = () => {},
  ) {
    epochs.add(this);
    window?.register(this);
  }
  static assert(epoch: RelocationEpoch, pub = epoch.publication) {
    if (!epochs.has(epoch) || epoch.closed || epoch.publication !== pub)
      throw new Error('Unavailable relocation epoch.');
    FrozenMovingPublication.assert(pub);
  }
  nativeClaim(path: string) {
    RelocationEpoch.assert(this);
    return this.roots.claim(path);
  }
  get isActive() {
    return this.busy;
  }
  get publication() {
    return this.program.publication;
  }
  get store() {
    return this.publication.store;
  }
  get partition() {
    return this.program.partition;
  }
  get payload() {
    return this.publication.tree(this.partition).root + '/payload';
  }
  get current(): Marker | null {
    return this.marker ? structuredClone(this.marker) : null;
  }
  static async open(
    pub: FrozenMovingPublication,
    partition: string,
    limits: BatchTargets = {},
    window?: MovingWindow,
  ) {
    FrozenMovingPublication.assert(pub);
    const release = window?.acquire(partition);
    try {
      if (
        pub.store.codec.options.access !== 'writable' ||
        pub.store.codec.options.role === 'distributed-worker'
      )
        throw new Error('Relocation requires writable base ownership.');
      const raw = await pub.store.readFixed(pub.store.prefix + 'relocation/' + partition + '.json'),
        marker = raw ? pub.store.codec.schemas.documents.relocation.parse(raw) : null;
      await pub.store.assertNoIntents(marker ?? undefined);
      const checkpoints = marker
          ? [marker[8], marker[9], ...(marker[10] ? [marker[10][1], marker[10][2]] : [])]
          : [],
        program = window
          ? window.part(partition).program
          : await RelocationProgram.create(pub, partition, checkpoints, limits);
      if (window) {
        MovingWindow.assert(window, pub);
        for (const c of checkpoints) await program.index(c as MoveCursor);
      }
      let source: RelocationSource | undefined,
        tree: RelocationTreeFile | undefined,
        original: ObservationIndex | undefined,
        epoch: RelocationEpoch | undefined;
      try {
        if (marker) equal(marker[5], program.plan, 'exact relocation plan');
        const cells = await pub.cells();
        try {
          const cell = cells.rows.find((c) => c[1] === partition)!;
          if (cell[5]) throw new Error('Confirmed object cannot start a relocation.');
          // The catalog publisher consumes returned candidates before a retry.
          if (!window && cell[3])
            throw new Error('Effective retry requires moving publisher admission.');
          if (
            marker &&
            JSON.stringify(cell[3]) !== JSON.stringify(marker[6]) &&
            JSON.stringify(cell[3]) !== JSON.stringify(marker[13])
          )
            throw new Error('Unexpected relocation adjustment owner.');
        } finally {
          cells.release();
        }
        if (marker && window && marker[4] <= window.current(partition).highestEpoch)
          throw new Error('Relocation epoch does not advance current native history.');
        source = window ? window.part(partition).source : await RelocationSource.open(program);
        tree = window
          ? window.part(partition).tree
          : await RelocationTreeFile.open(pub.tree(partition), pub.options);
        const state = await pub.state();
        original = window
          ? window.original
          : await ObservationIndex.open(pub.store, state[6]!, pub.options);
        await checkCompleteGc(original);
        const container = pub.store.prefix + 'planning/' + randomUUID();
        await pub.store.makeParents(container + '/source/pending');
        await pub.store.makeParents(container + '/stage/pending');
        const owner = (await pub.store.root.stat(container))!;
        epoch = new RelocationEpoch(
          program,
          source,
          tree,
          original,
          container,
          owner,
          window,
          release,
        );
        epoch.marker = marker;
        await epoch.admit();
        return epoch;
      } catch (error) {
        await settleBaseCleanup(
          epoch
            ? [() => epoch!.close()]
            : window
              ? []
              : [
                  () => program.close(),
                  () => source?.close(),
                  () => tree?.close(),
                  () => original?.dispose(),
                ],
          error,
        );
        throw error;
      }
    } catch (error) {
      release?.();
      throw error;
    }
  }
  private async replace(next: Marker) {
    const valid = this.store.codec.schemas.documents.relocation.parse(next);
    if (this.marker) await this.store.replaceRelocation(this.marker, valid);
    else await this.store.publishIntent(valid);
    this.marker = valid;
  }
  private async state(phase: 'relocating' | 'staged' | 'returning') {
    const state = await this.publication.state();
    state[3]++;
    state[4] = phase;
    await this.store.updateState(state);
  }
  // Endpoints remain freshly checked. Ancestor authority belongs to the guarded
  // phases, which callers invalidate after the syscall (including failpoints).
  private async renameMember(
    source: string,
    target: string,
    expected: NativeIdentity,
    from: InstallParentPhase,
    to: InstallParentPhase,
  ) {
    await from.parents(source);
    await to.parents(target);
    const before = await from.stat(source);
    if (!before || !sameNative(before, expected, true) || (await to.stat(target)))
      throw new Error('Changed relocation endpoints.');
    signalOf(this.publication).throwIfAborted();
    await rename(this.store.root.resolve(source), this.store.root.resolve(target));
    this.store.root.work.renames++;
    const after = await to.stat(target);
    if (!after || !sameRename(before, after)) throw new Error('Changed relocated member.');
    return after;
  }
  private async admit(recovering = !!this.marker) {
    const marker = this.marker,
      warmSource = recovering ? undefined : this.sourcePhase,
      warmStage = !recovering && marker?.[11] ? this.stagePhase : undefined,
      signal = signalOf(this.publication),
      out = await relocationLog(
        this.store,
        marker?.[11] ?? null,
        this.partition,
        this.publication.options,
      );
    let ret: Awaited<ReturnType<typeof relocationLog>> | undefined;
    const outbound = new TransitionCursor(out);
    let returned: TransitionCursor | undefined;
    try {
      ret = await relocationLog(
        this.store,
        marker?.[12] ?? null,
        this.partition,
        this.publication.options,
      );
      returned = new TransitionCursor(ret);
      const high = marker
          ? await this.program.index(
              (marker[10]?.[0] === 'outbound' ? marker[10][2] : marker[8]) as MoveCursor,
            )
          : 0,
        returnHigh = marker
          ? await this.program.index(
              (marker[10]?.[0] === 'return' ? marker[10][2] : marker[9]) as MoveCursor,
            )
          : 0,
        self = this;
      this.roots = await RelocationRoots.create(
        this.store,
        this.publication.options.budget,
        (async function* () {
          for await (const range of self.program.ranges())
            for await (const move of self.program.moves(range)) {
              const fact = await self.source.member(move),
                o = await outbound.take(move[1]),
                r = await returned!.take(move[1]);
              if ((o && move[1] > high) || (r && move[1] > returnHigh))
                throw new Error('Transition outside relocation ownership.');
              for (const [row, direction] of [
                [o, 'outbound'],
                [r, 'return'],
              ] as const)
                if (row) {
                  if (row[2] !== marker?.[4] || row[3] !== direction)
                    throw new Error('Foreign relocation transition.');
                  equal(row[6], move[6], 'transition portable member span');
                  if (!sameRename(fact.native, row[4] as NativeIdentity))
                    throw new Error('Transition rewrote frozen root evidence.');
                  if (!sameRename(row[4] as NativeIdentity, row[5] as NativeIdentity))
                    throw new Error('Invalid rename transition.');
                }
              const stage = self.payload + '/' + move[4];
              if (warmStage) await warmStage.parents(stage);
              if (warmSource) await warmSource.parents(move[3]);
              const staged = await (warmStage
                  ? warmStage.stat(stage)
                  : self.store.root.stat(stage)),
                original = await (warmSource
                  ? warmSource.stat(move[3])
                  : self.store.root.stat(move[3])),
                authorized = move[1] <= high;
              if (!!staged === !!original || (!authorized && staged))
                throw new Error('Ambiguous/unowned move endpoints.');
              const where = staged ? 'staged' : 'original',
                expected = (where === 'staged' ? o?.[5] : r?.[5]) as NativeIdentity | undefined,
                uncertain = authorized && !expected;
              const baseline = self.window ? await self.window.nativeFor(self, move) : fact.native;
              const effective = expected ?? baseline;
              await checkMoveMember(
                self.program,
                move,
                where === 'staged' ? self.payload + '/' + move[4] : move[3],
                self.source.evidence,
                fact.span,
                self.tree,
                {
                  rootNative: effective,
                  uncertain,
                  hash: recovering && authorized,
                  signal,
                  parentPhase: where === 'staged' ? warmStage : warmSource,
                },
              );
              yield [
                move[4],
                [
                  'root',
                  move,
                  fact.span,
                  where === 'staged' ? staged! : original!,
                  where,
                  uncertain ? 1 : 0,
                  authorized ? 1 : 0,
                ],
              ] as const;
            }
        })(),
        signal,
      );
      await outbound.finish();
      await returned.finish();
      await warmSource?.barrier();
      await warmStage?.barrier();
    } finally {
      await settleBaseCleanup([
        () => outbound.close(),
        () => returned?.close(),
        () => out.close(),
        () => ret?.close(),
      ]);
    }
    const first = await this.firstMove(),
      anchor = first?.[2] === 'owned' ? first[3].slice(0, -first[4].length - 1) : '';
    this.sourcePhase = new InstallParentPhase(
      this.store,
      anchor,
      this.container + '/source/',
      this.publication.options.budget,
      async (physical) =>
        anchor
          ? this.source.directory(physical === anchor ? '' : physical.slice(anchor.length + 1))
          : await this.originalDirectory(physical),
      signal,
    );
    if (this.window && !anchor) this.sourcePhase = this.window.livePhase;
    this.stagePhase = new InstallParentPhase(
      this.store,
      this.payload,
      this.container + '/stage/',
      this.publication.options.budget,
      async () => null,
      signal,
    );
    this.phases.push(this.sourcePhase, this.stagePhase);
    if (this.window) {
      if (!this.window.verified) await this.window.verify(this);
      else if (!anchor) await this.window.contextsFor(this);
    } else {
      await checkGcProjection(
        this.original,
        this.original.completed[4],
        this.original.completed[4],
        undefined,
        undefined,
        {
          open: async (d, n) => {
            if (!anchor) await this.sourcePhase.created(d[1], n);
          },
          file: async () => {},
          protected: async () => {},
          close: async () => {},
        },
        {
          member: async (path, present) => {
            if (anchor) return false;
            const claim = await this.roots.claim(path);
            if (!claim) return false;
            try {
              const row = tuple(claim.value);
              if (row[0] !== 'root') return false;
              if (present !== (row[4] === 'original'))
                throw new Error('Move endpoint changed during admission.');
              return true;
            } finally {
              claim.release();
            }
          },
          directory: async (d, n, gcChanged) => {
            if (anchor) {
              if (!gcChanged && !sameNative(d[2], n, true))
                throw new Error('Original source directory changed.');
              return;
            }
            const frozen = await this.source.directory(d[1]),
              claim = await this.roots.claim(d[1]);
            try {
              const affected =
                claim && tuple(claim.value)[0] === 'context' && tuple(claim.value)[1] === 1;
              if (frozen) {
                if (!(affected ? sameDirectoryObject(frozen, n) : sameNative(frozen, n, true)))
                  throw new Error('Post-GC source directory changed.');
              } else if (!gcChanged && !sameNative(d[2], n, true))
                throw new Error('Unexplained original directory change.');
            } finally {
              claim?.release();
            }
          },
        },
      );
    }
    if (anchor) await this.checkOwnedContext(anchor);
    if (marker?.[14] && !this.stageBaseline)
      this.stageBaseline = await StageDirectoryEvidence.open(
        this.store,
        marker[14],
        this.partition,
        this.publication.options,
      );
    if (marker) await this.admitStageContext();
  }
  private async originalDirectory(path: string) {
    const lease = await this.original.directory(path);
    try {
      return structuredClone(lease.node[2]);
    } finally {
      lease.release();
    }
  }
  private async firstMove(): Promise<MoveRow | null> {
    for await (const range of this.program.ranges())
      for await (const move of this.program.moves(range)) return move;
    return null;
  }
  private async checkOwnedContext(anchor: string) {
    const actual = walkNative(this.store.root, anchor, {
      ...this.publication.options,
      logicalRoot: '',
      metadata: 'reject',
      inspectChild: async (child) => {
        const claim = await this.roots.claim(child.path);
        try {
          if (claim && tuple(claim.value)[0] === 'root') return 'prune';
        } finally {
          claim?.release();
        }
      },
    });
    const next = async () => {
      let row = await actual.next();
      while (!row.done && row.value.tag === 'directory-close') row = await actual.next();
      return row;
    };
    let skip = '';
    try {
      for await (const item of this.store.rows(
        this.program.source,
        'native-evidence',
        { ...this.publication.options, partition: this.partition },
        signalOf(this.publication),
      )) {
        const row = tuple(item.value);
        if (row[0] !== 'directory' && row[0] !== 'file') continue;
        const path = String(row[1]);
        if (skip && path.startsWith(skip + '/')) continue;
        skip = '';
        const claim = await this.roots.claim(path);
        try {
          const r = claim ? tuple(claim.value) : null;
          if (r?.[0] === 'root') {
            if (r[4] === 'original') {
              const a = await next();
              if (
                a.done ||
                a.value.tag !== 'protected-child' ||
                a.value.path !== path ||
                a.value.device !== (r[3] as NativeIdentity)[3] ||
                a.value.fileId !== (r[3] as NativeIdentity)[4]
              )
                throw new Error('Owned root projection changed.');
            }
            if (row[0] === 'directory') skip = path;
            continue;
          }
          const a = await next();
          if (
            row[0] !== 'directory' ||
            a.done ||
            a.value.tag !== 'directory-open' ||
            a.value.path !== path
          )
            throw new Error('Owned context membership changed.');
          const affected = r?.[0] === 'context' && r[1] === 1;
          if (this.window)
            await this.window.contextFor(
              this,
              path,
              a.value.identity,
              affected,
              await this.sourcePhase.known(a.value.nativePath),
            );
          else if (
            !(affected
              ? sameDirectoryObject(row[2] as NativeIdentity, a.value.identity)
              : sameNative(row[2] as NativeIdentity, a.value.identity, true))
          )
            throw new Error('Owned context identity changed.');
          await this.sourcePhase.created(a.value.nativePath, a.value.identity);
        } finally {
          claim?.release();
        }
      }
      if (!(await next()).done) throw new Error('Unexpected owned context member.');
    } finally {
      await actual.return(undefined);
    }
  }
  private async admitStageContext() {
    if (!(await this.store.root.stat(this.payload))) return;
    const actual = walkNative(this.store.root, this.payload, {
      ...this.publication.options,
      logicalRoot: '',
      metadata: 'reject',
      inspectChild: async (child) => {
        const claim = await this.roots.claim(child.path);
        try {
          if (claim && tuple(claim.value)[0] === 'root') return 'prune';
        } finally {
          claim?.release();
        }
      },
    });
    try {
      for await (const event of actual) {
        if (event.tag === 'protected-child') {
          const claim = await this.roots.claim(event.path);
          try {
            const r = claim ? tuple(claim.value) : [];
            if (
              r[0] !== 'root' ||
              r[4] !== 'staged' ||
              event.device !== (r[3] as NativeIdentity)[3] ||
              event.fileId !== (r[3] as NativeIdentity)[4]
            )
              throw new Error('Unknown staged root.');
          } finally {
            claim?.release();
          }
        } else if (event.tag === 'directory-open') {
          if (!(await this.source.directory(event.path)))
            throw new Error('Unknown synthetic stage directory.');
          if (this.stageBaseline) {
            const expected = await this.stageBaseline.directory(event.path),
              claim = await this.roots.claim(event.path);
            let returned = false;
            try {
              const r = claim ? tuple(claim.value) : [];
              returned = r[0] === 'context' && r[3] === 1;
            } finally {
              claim?.release();
            }
            const cleaning =
              this.marker?.[7] === 'sources-returned' &&
              (await this.stageBaseline.missingSyntheticChild(
                event.path,
                event.nativePath,
                this.roots,
              ));
            if (
              !expected ||
              !(returned || cleaning
                ? sameDirectoryObject(expected, event.identity)
                : sameNative(expected, event.identity, true))
            )
              throw new Error('Sealed synthetic stage identity changed.');
          }
          await this.stagePhase.created(event.nativePath, event.identity);
        } else if (event.tag === 'file') throw new Error('Unknown staged file.');
      }
    } finally {
      await actual.return(undefined);
    }
  }
  private async start() {
    if (this.marker) return;
    if (await this.store.root.stat(this.payload))
      throw new Error('Unowned payload stage already exists.');
    await this.store.assertNoIntents();
    const current = this.window?.current(this.partition);
    await this.replace([
      'relocation',
      1,
      this.store.codec.options.invocation,
      this.partition,
      (current?.highestEpoch ?? 0) + 1,
      this.store.codec.schemas.ref('move-plan').parse(this.program.plan),
      current?.reference
        ? this.store.codec.schemas.ref('adjustments').parse(current.reference)
        : null,
      'outbound',
      this.program.initial,
      this.program.initial,
      null,
      null,
      null,
      null,
      null,
    ]);
    await this.store.fail('relocation-marker');
    await this.state('relocating');
  }
  private async stageDirectories() {
    let skip = '';
    for await (const item of decodeRecords(
      this.store.read(this.publication.tree(this.partition).tree, 'native-tree'),
    )) {
      signalOf(this.publication).throwIfAborted();
      const row = tuple(item.value);
      if (row[0] !== 'dir-open') continue;
      const logical = String(row[1]);
      if (skip && logical.startsWith(skip + '/')) continue;
      skip = '';
      const claim = await this.roots.claim(logical);
      try {
        if (claim && tuple(claim.value)[0] === 'root') {
          skip = logical;
          continue;
        }
      } finally {
        claim?.release();
      }
      const path = this.payload + (logical ? '/' + logical : '');
      if (await this.store.root.stat(path))
        throw new Error('Unexpected preexisting stage directory.');
      if (logical) await this.stagePhase.parents(path);
      signalOf(this.publication).throwIfAborted();
      await mkdir(this.store.root.resolve(path));
      if (logical) await this.stagePhase.changed(path);
      await this.stagePhase.created(path, (await this.store.root.stat(path))!);
    }
    await this.stagePhase.barrier();
    await this.store.root.syncDirectory(parentPath(this.payload));
  }
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.busy) throw new Error('Relocation epoch unavailable/active.');
    this.window?.assertEpoch(this);
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  async reserve() {
    return this.operation(async () => {
      await this.start();
      return this.current!;
    });
  }
  async evacuate(): Promise<ValidatedBaseObject> {
    return this.operation(async () => {
      signalOf(this.publication).throwIfAborted();
      await this.start();
      if (this.marker![7] !== 'outbound' || this.marker![8][4] !== 0 || this.marker![10])
        throw new Error('Interrupted evacuation must return before retry.');
      await this.stageDirectories();
      this.outbound = await this.store.append(
        'outbound-evidence',
        this.partition,
        this.publication.options.budget,
      );
      let next = structuredClone(this.marker!);
      next[11] = this.store.codec.schemas
        .appendPrefix('outbound-evidence')
        .parse(await this.outbound.checkpoint());
      await this.replace(next);
      for await (const range of this.program.ranges()) {
        next = structuredClone(this.marker!);
        next[10] = ['outbound', range.start, range.end];
        await this.replace(next);
        await this.store.fail('relocation-outbound-intent');
        for await (const move of this.program.moves(range)) {
          signalOf(this.publication).throwIfAborted();
          const fact = await this.source.member(move),
            from = move[3],
            to = this.payload + '/' + move[4];
          await this.sourcePhase.parents(from);
          await this.stagePhase.parents(to);
          const checked = await checkMoveMember(
            this.program,
            move,
            from,
            this.source.evidence,
            fact.span,
            this.tree,
            {
              rootNative: this.window ? await this.window.nativeFor(this, move) : undefined,
              parentPhase: this.sourcePhase,
            },
          );
          signalOf(this.publication).throwIfAborted();
          const moved = await this.renameMember(
            from,
            to,
            checked.native,
            this.sourcePhase,
            this.stagePhase,
          );
          await this.store.fail('relocation-outbound-rename');
          await this.sourcePhase.changed(from);
          await this.stagePhase.changed(to);
          await this.outbound.append([
            'transition',
            move[1],
            this.marker![4],
            'outbound',
            checked.native,
            moved,
            move[6],
          ]);
        }
        await this.sourcePhase.barrier();
        await this.stagePhase.barrier();
        next = structuredClone(this.marker!);
        next[11] = this.store.codec.schemas
          .appendPrefix('outbound-evidence')
          .parse(await this.outbound.checkpoint());
        await this.store.fail('relocation-outbound-evidence');
        next[8] = range.end;
        next[10] = null;
        await this.replace(next);
        await this.store.fail('relocation-outbound-cursor');
      }
      const log = await relocationLog(
          this.store,
          this.marker![11],
          this.partition,
          this.publication.options,
        ),
        transitions = new TransitionCursor(log);
      try {
        for await (const range of this.program.ranges())
          for await (const move of this.program.moves(range)) {
            const r = await transitions.take(move[1]),
              fact = await this.source.member(move);
            if (!r) throw new Error('Missing completed outbound evidence.');
            await checkMoveMember(
              this.program,
              move,
              this.payload + '/' + move[4],
              this.source.evidence,
              fact.span,
              this.tree,
              { rootNative: r[5] as NativeIdentity, parentPhase: this.stagePhase },
            );
          }
        await transitions.finish();
      } finally {
        await settleBaseCleanup([() => transitions.close(), () => log.close()]);
      }
      const choice = this.publication.choices.find((c) => c[1] === this.partition)!;
      if (choice[0] !== 'new') throw new Error('Missing changed stage choice.');
      await this.store.fail('relocation-stage-admission');
      const object = await ValidatedBaseObject.verify(
        this.store,
        this.publication.tree(this.partition).root,
        movingObjectRef(choice),
        this.publication.options,
        false,
        'moving',
        this.stageFacts(),
      );
      const stage = await this.store.writeStream(
        'stage-evidence',
        { ...this.publication.options, partition: this.partition },
        this.evidenceRows(object.evidence),
        signalOf(this.publication),
      );
      await object.verifyStable(this.publication.options);
      next = structuredClone(this.marker!);
      next[7] = 'staged';
      next[14] = this.store.codec.schemas.ref('stage-evidence').parse(stage);
      if (!this.program.rootCount) next[8] = this.program.final;
      await this.replace(next);
      await this.state('staged');
      return object;
    });
  }
  private async *stageFacts(): AsyncGenerator<Value> {
    const log = await relocationLog(
        this.store,
        this.marker![11],
        this.partition,
        this.publication.options,
      ),
      transitions = new TransitionCursor(log);
    let subtree = '';
    try {
      for await (const item of this.store.rows(
        this.program.source,
        'native-evidence',
        { ...this.publication.options, partition: this.partition },
        signalOf(this.publication),
      )) {
        const row = tuple(item.value);
        if (row[0] !== 'directory' && row[0] !== 'file') continue;
        const path = String(row[1]);
        if (subtree && path.startsWith(subtree + '/')) {
          yield row;
          continue;
        }
        subtree = '';
        const claim = await this.roots.claim(path);
        try {
          const r = claim ? tuple(claim.value) : [];
          if (r[0] === 'root') {
            const move = r[1] as MoveRow,
              transition = await transitions.take(move[1]);
            if (!transition) throw new Error('Missing staged root transition.');
            if (row[0] === 'directory') subtree = path;
            yield row[0] === 'file'
              ? ['file', path, transition[5], row[3]]
              : ['directory', path, transition[5]];
          } else {
            if (row[0] !== 'directory') throw new Error('Unproven staged file.');
            const expected = await this.stagePhase.effective(
              this.payload + (path ? '/' + path : ''),
            );
            if (!expected) throw new Error('Synthetic stage directory has no creation evidence.');
            yield ['directory', path, expected];
          }
        } finally {
          claim?.release();
        }
      }
      await transitions.finish();
    } finally {
      await settleBaseCleanup([() => transitions.close(), () => log.close()]);
    }
  }
  private async *evidenceRows(reference: Reference) {
    for await (const item of this.store.rows(
      reference,
      'native-evidence',
      { ...this.publication.options, partition: this.partition },
      signalOf(this.publication),
    )) {
      const row = tuple(item.value);
      if (row[0] !== 'local-stream' && row[0] !== 'local-end') yield row;
    }
  }
  // Recovery/cleanup callers must reopen the publication with their live cleanup
  // signal. An aborted foreground publication cannot mint a new outbound operation.
  async returnSources(): Promise<Reference> {
    return this.operation(async () => {
      if (!this.marker) throw new Error('No relocation owner to return.');
      if (this.marker[7] === 'sources-returned')
        return this.store.codec.schemas.ref('adjustments').parse(this.marker[13]);
      signalOf(this.publication).throwIfAborted();
      let next = structuredClone(this.marker);
      if (next[10]?.[0] === 'outbound') next[8] = next[10][2];
      next[7] = 'returning';
      await this.replace(next);
      await this.state('returning');
      const oldReturn = this.marker![12],
        out = await relocationLog(
          this.store,
          this.marker![11],
          this.partition,
          this.publication.options,
        ),
        outgoing = new TransitionCursor(out);
      let ret: Awaited<ReturnType<typeof relocationLog>> | undefined,
        incoming: TransitionCursor | undefined;
      try {
        ret = await relocationLog(this.store, oldReturn, this.partition, this.publication.options);
        incoming = new TransitionCursor(ret);
        this.returned = oldReturn
          ? await this.store.resumePrefix(
              oldReturn,
              'return-evidence',
              this.partition,
              this.publication.options.budget,
              this.marker!,
            )
          : await this.store.append(
              'return-evidence',
              this.partition,
              this.publication.options.budget,
            );
        next = structuredClone(this.marker!);
        next[12] = this.store.codec.schemas
          .appendPrefix('return-evidence')
          .parse(await this.returned.checkpoint());
        await this.replace(next);
        for await (const range of this.program.ranges(
          this.program.initial,
          this.marker![9] as MoveCursor,
        ))
          for await (const move of this.program.moves(range)) {
            await outgoing.take(move[1]);
            await incoming.take(move[1]);
          }
        for await (const range of this.program.ranges(
          this.marker![9] as MoveCursor,
          this.marker![8] as MoveCursor,
        )) {
          next = structuredClone(this.marker!);
          next[10] = ['return', range.start, range.end];
          await this.replace(next);
          await this.store.fail('relocation-return-intent');
          for await (const move of this.program.moves(range)) {
            signalOf(this.publication).throwIfAborted();
            const o = await outgoing.take(move[1]),
              r = await incoming.take(move[1]),
              fact = await this.source.member(move),
              from = this.payload + '/' + move[4];
            await this.stagePhase.parents(from);
            await this.sourcePhase.parents(move[3]);
            const staged = await this.stagePhase.stat(from),
              original = await this.sourcePhase.stat(move[3]);
            if (!!staged === !!original) throw new Error('Ambiguous return endpoints.');
            if (staged) {
              await this.stagePhase.parents(from);
              await this.sourcePhase.parents(move[3]);
              const checked = await checkMoveMember(
                this.program,
                move,
                from,
                this.source.evidence,
                fact.span,
                this.tree,
                {
                  rootNative: o?.[5] as NativeIdentity | undefined,
                  uncertain: !o,
                  parentPhase: this.stagePhase,
                },
              );
              signalOf(this.publication).throwIfAborted();
              const restored = await this.renameMember(
                from,
                move[3],
                checked.native,
                this.stagePhase,
                this.sourcePhase,
              );
              await this.store.fail('relocation-return-rename');
              await this.stagePhase.changed(from);
              await this.sourcePhase.changed(move[3]);
              await this.returned.append([
                'transition',
                move[1],
                this.marker![4],
                'return',
                checked.native,
                restored,
                move[6],
              ]);
            } else {
              await checkMoveMember(
                this.program,
                move,
                move[3],
                this.source.evidence,
                fact.span,
                this.tree,
                {
                  rootNative:
                    (r?.[5] as NativeIdentity | undefined) ??
                    (this.window ? await this.window.nativeFor(this, move) : fact.native),
                  uncertain: !r,
                  parentPhase: this.sourcePhase,
                },
              );
              // An already-applied return may have crashed before its namespace barrier.
              await this.sourcePhase.parents(move[3]);
              await this.sourcePhase.changed(move[3]);
              if (await this.store.root.stat(parentPath(from))) {
                await this.stagePhase.parents(from);
                await this.stagePhase.changed(from);
              }
            }
          }
          await this.sourcePhase.barrier();
          await this.stagePhase.barrier();
          next = structuredClone(this.marker!);
          next[12] = this.store.codec.schemas
            .appendPrefix('return-evidence')
            .parse(await this.returned.checkpoint());
          await this.store.fail('relocation-return-evidence');
          next[9] = range.end;
          next[10] = null;
          await this.replace(next);
          await this.store.fail('relocation-return-cursor');
        }
        if (!this.program.rootCount) {
          next = structuredClone(this.marker!);
          next[9] = next[8];
          next[10] = null;
          await this.replace(next);
        }
      } finally {
        await settleBaseCleanup([
          () => outgoing.close(),
          () => incoming?.close(),
          () => out.close(),
          () => ret?.close(),
        ]);
      }
      // Reconstruct current root facts from committed return evidence; no ctime-only
      // adoption. Complete original/owned projections precede the replacement Q.
      await this.roots.close();
      await this.admit(false);
      const candidate = await this.store.writeStream(
        'adjustments',
        { ...this.publication.options, partition: this.partition },
        this.window
          ? this.window.mergeRows(this.partition, this.adjustmentRows())
          : this.adjustmentRows(),
        signalOf(this.publication),
      );
      await this.store.fail('relocation-adjustment-candidate');
      next = structuredClone(this.marker!);
      next[13] = this.store.codec.schemas.ref('adjustments').parse(candidate);
      next[7] = 'sources-returned';
      await this.replace(next);
      await this.store.fail('relocation-sources-returned');
      return candidate;
    });
  }
  private async projectionSha(path: string) {
    const entries: { name: string; kind: string }[] = [];
    let charge = 0;
    try {
      const dir = await opendir(this.store.root.resolve(path), { bufferSize: 1 });
      try {
        while (true) {
          signalOf(this.publication).throwIfAborted();
          const e = await dir.read();
          if (!e) break;
          if (entries.length >= (this.publication.options.maxDirectoryEntries ?? 100000))
            throw new Error('Adjustment directory allowance exceeded.');
          const n = 128 + 4 * Buffer.byteLength(e.name);
          this.publication.options.budget.retain(n);
          charge += n;
          entries.push({
            name: e.name,
            kind: e.isFile()
              ? 'file'
              : e.isDirectory()
                ? 'directory'
                : e.isSymbolicLink()
                  ? 'symlink'
                  : 'other',
          });
        }
      } finally {
        await dir.close();
      }
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const digest = new Digest('ancestor-children');
      for (const e of entries) digest.update([e.name, e.kind]);
      return digest.digest();
    } finally {
      this.publication.options.budget.release(charge);
    }
  }
  private async *adjustmentRows(): AsyncGenerator<Value> {
    const first = await this.firstMove(),
      owned = first?.[2] === 'owned',
      anchor = owned ? first![3].slice(0, -first![4].length - 1) : '';
    const rows = owned
      ? this.store.rows(
          this.program.source,
          'native-evidence',
          { ...this.publication.options, partition: this.partition },
          signalOf(this.publication),
        )
      : null;
    let skip = '';
    const directory = (claim: Value) => {
      const r = tuple(claim);
      return r[0] === 'context' || (r[3] as NativeIdentity)[2] === 'directory';
    };
    const nativeRows = async function* (
      self: RelocationEpoch,
    ): AsyncGenerator<readonly [string, boolean, Value]> {
      if (rows) {
        for await (const item of rows) {
          const r = tuple(item.value);
          if (r[0] !== 'directory' && r[0] !== 'file') continue;
          const path = String(r[1]);
          if (skip && path.startsWith(skip + '/')) continue;
          skip = '';
          const claim = await self.roots.claim(path);
          try {
            if (claim) yield [path, r[0] === 'directory', claim.value];
          } finally {
            claim?.release();
          }
        }
      } else {
        // Admission already bound these sparse roots/contexts. Do not enumerate
        // unrelated original observations or descendants of opaque moved roots.
        for await (const [path, claim] of self.roots.entries(directory, signalOf(self.publication)))
          yield [path, directory(claim), claim];
      }
    };
    for await (const [path, isDir, value] of nativeRows(this)) {
      skip = '';
      const r = tuple(value);
      if (r[0] === 'root') {
        const root = r as unknown as RootClaim;
        if (root[6] !== 1) continue;
        if (root[4] !== 'original') throw new Error('Adjustment source still staged.');
        yield ['adjust', path, this.marker![4], root[3], root[1][7], root[1][6]];
        if (isDir) skip = path;
      } else if (r[0] === 'context' && r[1] === 1) {
        const physical = anchor ? anchor + (path ? '/' + path : '') : path,
          n = await this.store.root.stat(physical);
        if (!n) throw new Error('Missing adjustment ancestor.');
        yield [
          'ancestor-effect',
          path,
          n[3],
          n[4],
          this.window && !owned
            ? await this.window.projectionFor(this, path)
            : await this.projectionSha(physical),
        ];
      }
    }
  }
  async cleanupStage() {
    return this.operation(async () => {
      if (this.marker?.[7] !== 'sources-returned')
        throw new Error('Stage cleanup requires returned sources.');
      const scratch = await InstallScratch.create(this.store, this.publication.options.budget);
      try {
        if (!(await this.store.root.stat(this.payload))) return;
        await this.admitStageContext();
        const walker = walkNative(this.store.root, this.payload, {
          ...this.publication.options,
          logicalRoot: '',
          metadata: 'reject',
        });
        try {
          for await (const event of walker) {
            if (event.tag === 'directory-close') await scratch.append([event.nativePath]);
            else if (event.tag !== 'directory-open')
              throw new Error('Returned stage contains unexpected payload.');
          }
        } finally {
          await walker.return(undefined);
        }
        for await (const value of scratch.rows(0, scratch.position)) {
          signalOf(this.publication).throwIfAborted();
          const path = String(tuple(value)[0]);
          if (path === this.payload) await this.stagePhase.barrier();
          const expected = await this.stagePhase.effective(path),
            actual = await this.store.root.stat(path);
          if (!expected || !actual || !sameNative(expected, actual, true))
            throw new Error('Stage cleanup directory changed.');
          if (path !== this.payload) await this.stagePhase.parents(path);
          else await this.store.root.parents(path);
          signalOf(this.publication).throwIfAborted();
          await rmdir(this.store.root.resolve(path));
          this.store.root.work.directoryRemovals++;
          await this.store.fail('relocation-stage-directory-removed');
          if (path !== this.payload) await this.stagePhase.changed(path);
          else await this.store.root.syncDirectory(parentPath(path));
        }
        await this.stagePhase.barrier();
      } finally {
        await scratch.close();
      }
    });
  }
  async close() {
    if (this.busy) throw new Error('Relocation operation active.');
    if (this.closed) return;
    this.window?.assertEpochClose(this);
    for (const phase of this.phases) phase.release();
    await settleBaseCleanup([
      () => this.outbound?.close(),
      () => this.returned?.close(),
      () => this.stageBaseline?.close(),
      () => this.roots?.close(),
      ...(!this.window
        ? [
            () => this.source.close(),
            () => this.tree.close(),
            () => this.original.dispose(),
            () => this.program.close(),
          ]
        : []),
      () =>
        retireOwnedDirectory(
          this.store,
          this.container,
          this.owner,
          this.publication.options.budget,
        ),
    ]);
    this.closed = true;
    this.releaseWindow();
  }
}
