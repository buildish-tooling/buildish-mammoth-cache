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

import { lstat } from 'node:fs/promises';
import { EvidenceFile } from './evidence-file';
import { RelocationTreeFile } from './relocation-tree-file';
import { RelocationProgram, type MoveRow } from './relocation-program';
import { NativeReadPhase } from './native-read-phase';
import type { InstallParentPhase } from './install-parent-phase';
import { walkNative, type WalkEvent } from './native-walk';
import { sameNative, sameRename, nativeIdentity, type NativeIdentity } from './native';
import { nativeIdentitySchema } from './local-schema';
import { equal, tuple, add, type Value } from './encoding';
import { baseName, parentPath, normalizeMode } from './tree-state';
import { settleBaseCleanup } from './base-object';

export interface MoveMemberCheck {
  /** Caller owns the checked ancestor scope; this check grants no mutation authority. */
  readonly parentPhase?: InstallParentPhase;
  /** Immediate parent from the caller's active read-only hierarchical traversal. */
  readonly parentNative?: NativeIdentity;
  /** Native root proven by the bound adjustment/transition, not a fresh rebase. */
  readonly rootNative?: NativeIdentity;
  /** Missing syscall evidence: permit only root rename effects AND rehash its full body. */
  readonly uncertain?: boolean;
  readonly hash?: boolean;
  readonly signal?: AbortSignal;
}
interface Fact {
  path: string;
  native: NativeIdentity;
  hash: string | null;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#partition-wide-relocation-marker.
// Member consistency only. The session must ALSO admit policy, original complete
// projections, current marker ownership, endpoints and scoped mutation parents.
export async function checkMoveMember(
  program: RelocationProgram,
  move: MoveRow,
  physical: string,
  source: EvidenceFile,
  nativeSpan: Value,
  tree: RelocationTreeFile,
  options: MoveMemberCheck = {},
) {
  RelocationProgram.assert(program);
  EvidenceFile.assert(source, program.publication.store, program.partition);
  equal(source.reference, program.source, 'frozen post-GC original source');
  const compare = await Comparison.create(program, move, physical, tree, options);
  let failure: unknown;
  try {
    await source.member(
      ['evidence', source.reference, nativeSpan],
      move[4],
      move[5],
      async (value) => {
        const r = tuple(value);
        await compare.accept({
          path: String(r[1]),
          native: r[2] as NativeIdentity,
          hash: r[0] === 'file' ? String(r[3]) : null,
        });
      },
      options.signal ?? program.publication.options.signal,
    );
    return await compare.finish();
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    await settleBaseCleanup([() => compare.close()], failure);
  }
}

class Comparison {
  private readonly directories: {
    logical: string;
    physical: string;
    native: NativeIdentity;
    release: () => void;
  }[] = [];
  private root: NativeIdentity | undefined;
  private fileParent: { path: string; native: NativeIdentity } | undefined;
  private readonly portable;
  private readonly actual;
  private readonly phase: NativeReadPhase;
  private readonly signal: AbortSignal;
  readonly work = { hashBytes: 0, files: 0, directories: 0 };
  private constructor(
    private readonly program: RelocationProgram,
    private readonly move: MoveRow,
    private readonly physical: string,
    tree: RelocationTreeFile,
    private readonly options: MoveMemberCheck,
  ) {
    const { store } = program.publication;
    this.signal =
      options.signal ?? program.publication.options.signal ?? new AbortController().signal;
    this.portable = tree.records(move[6], this.signal);
    this.phase = new NativeReadPhase(
      store.root,
      move[5] === 'file' ? parentPath(physical) : physical,
      tree.hashes,
    );
    this.actual = (
      move[5] === 'directory'
        ? walkNative(store.root, physical, {
            ...program.publication.options,
            signal: this.signal,
            metadata: 'reject',
            logicalRoot: move[4],
            parentNative: options.parentNative,
          })
        : (async function* (): AsyncGenerator<WalkEvent> {
            store.root.work.stats++;
            const raw = await lstat(store.root.resolve(physical), { bigint: true }),
              n = nativeIdentity(raw);
            if (n[2] !== 'file') throw new Error('Missing/wrong move file.');
            yield {
              tag: 'file',
              path: move[4],
              nativePath: physical,
              identity: n,
              links: String(raw.nlink),
            };
          })()
    )[Symbol.asyncIterator]();
  }
  static async create(
    program: RelocationProgram,
    move: MoveRow,
    physical: string,
    tree: RelocationTreeFile,
    options: MoveMemberCheck,
  ) {
    RelocationTreeFile.assert(tree, program.publication.tree(program.partition));
    const stage =
      program.publication.store.prefix + 'objects/' + program.partition + '/payload/' + move[4];
    if (physical !== move[3] && physical !== stage)
      throw new Error('Unbound move member location.');
    options = Object.freeze({
      ...options,
      rootNative: options.rootNative
        ? (Object.freeze(nativeIdentitySchema.parse(options.rootNative)) as NativeIdentity)
        : undefined,
      parentNative: options.parentNative
        ? (Object.freeze(nativeIdentitySchema.parse(options.parentNative)) as NativeIdentity)
        : undefined,
    });
    const { store } = program.publication;
    (options.signal ?? program.publication.options.signal)?.throwIfAborted();
    if (options.parentPhase && options.parentPhase.store !== store)
      throw new Error('Foreign move parent phase.');
    if (options.parentPhase)
      options = { ...options, parentNative: await options.parentPhase.checkedParent(physical) };
    else if (!options.parentNative) {
      await store.root.parents(physical);
      store.root.work.stats++;
      options = {
        ...options,
        parentNative: nativeIdentity(
          await lstat(store.root.resolve(parentPath(physical)), { bigint: true }),
        ),
      };
    }
    const self = new Comparison(program, move, physical, tree, options);
    try {
      self.signal.throwIfAborted();
      if (move[5] === 'file') {
        const path = parentPath(physical),
          native = options.parentNative!;
        if (!native || native[2] !== 'directory') throw new Error('Unsafe move file parent.');
        await self.phase.enter(path, native);
        self.signal.throwIfAborted();
        self.fileParent = { path, native };
      }
      return self;
    } catch (e) {
      await settleBaseCleanup([() => self.close()], e);
      throw e;
    }
  }
  private async portableNext(): Promise<readonly Value[] | null> {
    while (true) {
      const row = await this.portable.next();
      if (row.done) return null;
      const r = tuple(row.value);
      if (r[0] !== 'unit-open' && r[0] !== 'unit-close') return r;
    }
  }
  private async leave() {
    this.signal.throwIfAborted();
    const frame = this.directories.pop()!;
    try {
      const actual = await this.actual.next(),
        portable = await this.portableNext();
      if (
        actual.done ||
        actual.value.tag !== 'directory-close' ||
        actual.value.path !== frame.logical ||
        !portable ||
        portable[0] !== 'dir-close' ||
        portable[1] !== frame.logical
      )
        throw new Error('Move member directory boundary mismatch.');
      await this.phase.leave(frame.physical, frame.native);
      this.signal.throwIfAborted();
    } finally {
      frame.release();
    }
  }
  async accept(fact: Fact) {
    this.signal.throwIfAborted();
    const isRoot = fact.path === this.move[4],
      isDirectory = fact.native[2] === 'directory',
      parent = isDirectory && isRoot ? null : parentPath(fact.path);
    while (
      this.directories.length &&
      this.directories[this.directories.length - 1].logical !== parent
    )
      await this.leave();
    const next = await this.actual.next(),
      portable = await this.portableNext();
    if (next.done || next.value.tag === 'protected-child' || !portable)
      throw new Error('Missing/unsupported move member.');
    const actual = next.value;
    if (actual.tag === 'file' && actual.links !== '1') throw new Error('Aliased move file.');
    if (
      actual.tag !== (isDirectory ? 'directory-open' : 'file') ||
      actual.path !== fact.path ||
      portable[0] !== (isDirectory ? 'dir-open' : 'file') ||
      (isDirectory ? portable[1] !== fact.path : portable[1] !== baseName(fact.path))
    )
      throw new Error('Move member membership mismatch.');
    const expected = isRoot && this.options.rootNative ? this.options.rootNative : fact.native,
      same =
        isRoot && this.options.uncertain
          ? sameRename(expected, actual.identity)
          : sameNative(expected, actual.identity, true);
    if (!same || actual.identity[3] !== this.program.publication.store.root.binding[3])
      throw new Error('Move source identity changed.');
    if (!this.root) this.root = actual.identity;
    if (isDirectory) {
      await this.phase.enter(actual.nativePath, actual.identity);
      this.signal.throwIfAborted();
      this.directories.push({
        logical: fact.path,
        physical: actual.nativePath,
        native: actual.identity,
        release: this.program.publication.options.budget.holdRecord(
          512 + Buffer.byteLength(fact.path),
        ),
      });
      this.work.directories++;
    } else {
      const n = actual.identity,
        model = this.program.publication.store.codec.options.model;
      if (
        actual.tag !== 'file' ||
        Number(n[5]) !== portable[2] ||
        normalizeMode(model.tuple[2], fact.path, n[6]) !== portable[3] ||
        Number(BigInt(n[8]) / 1000000n) !== portable[4]
      )
        throw new Error('Move source portable metadata changed.');
      if (fact.hash !== null && fact.hash !== portable[5])
        throw new Error('Owned source hash differs from tree.');
      const strong = this.options.hash || this.options.uncertain;
      if (
        (await this.phase.hash(
          actual.nativePath,
          n,
          strong ? null : String(portable[5]),
          this.signal,
        )) !== portable[5]
      )
        throw new Error('Move source body differs from frozen hash.');
      if (strong) this.work.hashBytes = add(this.work.hashBytes, Number(n[5]));
      this.work.files++;
    }
  }
  async finish() {
    while (this.directories.length) await this.leave();
    this.signal.throwIfAborted();
    if (!(await this.actual.next()).done || (await this.portableNext()) !== null || !this.root)
      throw new Error('Extra/incomplete move member.');
    if (this.fileParent) {
      await this.phase.leave(this.fileParent.path, this.fileParent.native);
      this.signal.throwIfAborted();
    }
    return { native: this.root, work: Object.freeze(this.work) };
  }
  async close() {
    for (const d of this.directories.splice(0)) d.release();
    await settleBaseCleanup([
      () => this.actual.return?.(undefined),
      () => this.portable.return(undefined),
    ]);
  }
}
