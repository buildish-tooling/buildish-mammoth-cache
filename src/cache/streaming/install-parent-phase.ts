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

import { lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { nativeIdentity, sameNative, missing, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import { shaSchema } from './schema';
import { nativeIdentitySchema } from './local-schema';
import { encodeRecord, decodeRecord, add } from './encoding';
import type { OwnedStore } from './owned-store';
import { parentPath, type WorkingBudget } from './tree-state';

// Process-local mutable directory facts. Only popped dirty frames are spooled;
// these are same-process mutation bookkeeping, never restart authority.
export class InstallParentPhase {
  private hasSaved = true;
  private readonly frames: {
    path: string;
    native: NativeIdentity;
    dirty: boolean;
    projection: string | null;
    release: () => void;
  }[] = [];
  constructor(
    readonly store: OwnedStore,
    readonly anchor: string,
    readonly ledger: string,
    readonly budget: WorkingBudget,
    readonly expected: (physical: string) => Promise<NativeIdentity | null>,
    readonly signal?: AbortSignal,
    private readonly baseline?: {
      native(path: string): Promise<NativeIdentity | null>;
      projection(path: string): Promise<string | null>;
    },
  ) {
    // A supplied baseline belongs to a newly created moving-window ledger.
    // Other callers can reopen an epoch ledger and must probe existing records.
    if (baseline) this.hasSaved = false;
  }
  private key(path: string) {
    return this.ledger + createHash('sha256').update(path).digest('hex');
  }
  async stat(path: string): Promise<NativeIdentity | null> {
    this.store.root.work.stats++;
    try {
      return nativeIdentity(await lstat(this.store.root.resolve(path), { bigint: true }));
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }
  private async check(frame: (typeof this.frames)[number]) {
    const actual = await this.stat(frame.path);
    if (!actual || !sameNative(frame.native, actual, true))
      throw new Error('Active install parent changed.');
  }
  private async savedFull(
    path: string,
  ): Promise<{ native: NativeIdentity; projection: string | null } | null> {
    if (!this.hasSaved) return null;
    try {
      const file = this.key(path),
        stat = await this.store.root.stat(file);
      if (!stat) return null;
      if (BigInt(stat[5]) > 65536n) throw new Error('Oversized parent phase record.');
      const chunks: Buffer[] = [];
      for await (const bytes of this.store.root.read(file, stat)) chunks.push(bytes);
      const value = decodeRecord(Buffer.concat(chunks));
      if (!Array.isArray(value) || value[0] !== path)
        throw new Error('Parent phase ledger collision.');
      return {
        native: nativeIdentitySchema.parse(value[1]),
        projection: value[2] ? shaSchema.parse(value[2]) : null,
      };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async saved(path: string) {
    return (await this.savedFull(path))?.native ?? null;
  }
  async projection(path: string): Promise<string | null> {
    return (
      this.frames.find((f) => f.path === path)?.projection ??
      (await this.savedFull(path))?.projection ??
      (await this.baseline?.projection(path)) ??
      null
    );
  }
  async known(path: string, actual?: NativeIdentity): Promise<NativeIdentity | null> {
    // An unchanged admitted context needs no lookup of a mutation checkpoint.
    const baseline = actual ? await this.baseline?.native(path) : null;
    if (baseline && sameNative(baseline, actual!, true)) return baseline;
    return (
      this.frames.find((f) => f.path === path)?.native ??
      (await this.saved(path)) ??
      (await this.baseline?.native(path)) ??
      null
    );
  }
  async effective(path: string): Promise<NativeIdentity | null> {
    const frame = this.frames.find((f) => f.path === path);
    return frame ? frame.native : ((await this.saved(path)) ?? this.expected(path));
  }
  async created(path: string, native: NativeIdentity, projection: string | null = null) {
    const bytes = encodeRecord([path, native, projection]);
    this.hasSaved = true;
    await writeFile(this.store.root.resolve(this.key(path)), bytes, {
      mode: 0o600,
    });
    this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, bytes.length);
  }
  private async pop() {
    this.signal?.throwIfAborted();
    const f = this.frames.pop()!;
    try {
      await this.check(f);
      this.signal?.throwIfAborted();
      if (f.dirty) {
        this.signal?.throwIfAborted();
        await this.created(f.path, f.native, f.projection);
      }
    } finally {
      f.release();
    }
  }
  async parents(leaf: string) {
    this.signal?.throwIfAborted();
    const parent = parentPath(leaf);
    if (parent !== this.anchor && !parent.startsWith(this.anchor ? this.anchor + '/' : ''))
      throw new Error('Mutation escapes parent phase.');
    while (
      this.frames.length > 1 &&
      this.frames[this.frames.length - 1].path !== parent &&
      !parent.startsWith(this.frames[this.frames.length - 1].path + '/')
    )
      await this.pop();
    const suffix = this.anchor ? parent.slice(this.anchor.length).replace(/^\//, '') : parent;
    const paths = [this.anchor];
    let path = this.anchor;
    for (const name of suffix.split('/').filter(Boolean)) {
      path = path ? path + '/' + name : name;
      paths.push(path);
    }
    if (!this.frames.length)
      await this.store.root.parents(this.anchor ? this.anchor + '/pending' : 'pending');
    for (const path of paths.slice(this.frames.length)) {
      const saved = await this.savedFull(path),
        native = saved?.native ?? (await this.expected(path));
      if (!native || native[2] !== 'directory' || native[3] !== this.store.root.binding[3])
        throw new Error('Missing/unsafe expected mutation parent.');
      const frame = {
        path,
        native,
        dirty: false,
        projection: saved?.projection ?? (await this.baseline?.projection(path)) ?? null,
        release: this.budget.holdRecord(512 + Buffer.byteLength(path)),
      };
      this.frames.push(frame);
      await this.check(frame);
    }
    await this.check(this.frames[this.frames.length - 1]);
  }
  async changed(leaf: string) {
    const frame = this.frames[this.frames.length - 1];
    if (!frame || frame.path !== parentPath(leaf)) throw new Error('Unscoped parent mutation.');
    const after = await this.stat(frame.path);
    if (!after || !sameDirectoryObject(frame.native, after))
      throw new Error('Mutation parent was replaced.');
    frame.native = after;
    frame.dirty = true;
  }
  /** Immediate parent within this phase's checked, mutation-aware ancestor stack. */
  async checkedParent(leaf: string): Promise<NativeIdentity> {
    await this.parents(leaf);
    return this.frames[this.frames.length - 1].native;
  }
  async barrier() {
    while (this.frames.length) await this.pop();
  }
  release() {
    for (const f of this.frames.splice(0)) f.release();
  }
}
