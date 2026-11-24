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

import { lstat, opendir } from 'node:fs/promises';
import { missing, nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';
import { baseName, joinPath, nativeAliasKey, parentPath, type WorkingBudget } from './tree-state';

type Child = { name: string; sources: bigint; directories: bigint; alias: boolean };
type SharedView = {
  names: ReadonlyMap<string, Child>;
  directories: ReadonlyMap<number, NativeIdentity>;
};
type Frame = {
  path: string;
  sources: bigint;
  stagedParents?: ReadonlyMap<number, NativeIdentity>;
  live: NativeIdentity | null | undefined;
  charge: number;
};

/** Optional checked views shared across serial source walks. Absence here only guides representation. */
export class BaseMoveBoundaries {
  private readonly views = new Map<string, SharedView>();
  private readonly parents: Frame[] = [];
  private enabled = true;
  private charged = 0;
  private readonly unregister: () => void;
  constructor(
    private readonly store: OwnedStore,
    private readonly budget: WorkingBudget,
    private readonly sources: readonly { readonly partition: string; readonly root: string }[],
    private readonly maxEntries: number,
    private readonly signal?: AbortSignal,
  ) {
    this.unregister = budget.onNamePressure(() => this.close());
  }

  close(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.views.clear();
    this.parents.length = 0;
    this.budget.release(this.charged);
    this.charged = 0;
    this.unregister();
  }

  private retain(bytes: number): boolean {
    if (!this.budget.tryRetainNames(bytes)) {
      this.close();
      return false;
    }
    this.charged += bytes;
    return true;
  }

  async begin(partition: string): Promise<(path: string) => Promise<boolean>> {
    for (const frame of this.parents.splice(0)) {
      this.budget.release(frame.charge);
      this.charged -= frame.charge;
    }
    if (!this.enabled) return async () => false;
    const bit = 1n << BigInt(this.sources.findIndex((source) => source.partition === partition));
    const live = await this.directory('');
    if (!live || !sameObject(live, this.store.root.binding))
      throw new Error('Managed root was replaced.');
    this.parents.push({
      path: '',
      sources: (1n << BigInt(this.sources.length)) - 1n,
      live,
      charge: 0,
    });
    return (path) => this.intact(path, bit);
  }

  private async view(parent: Frame): Promise<SharedView | undefined> {
    const saved = this.views.get(parent.path);
    if (saved) return saved;
    if (!this.retain(192 + 4 * Buffer.byteLength(parent.path))) return undefined;
    const names = new Map<string, Child>(),
      directories = new Map<number, NativeIdentity>();
    for (const [index, source] of this.sources.entries()) {
      const bit = 1n << BigInt(index);
      if (!(parent.sources & bit)) continue;
      this.signal?.throwIfAborted();
      const payload = source.root + '/payload';
      const path = parent.path ? joinPath(payload, parent.path) : payload;
      const expectedParent = parent.stagedParents?.get(index);
      if (
        parent.path &&
        (!expectedParent || !(await this.matches(parentPath(path), expectedParent)))
      ) {
        this.close();
        return undefined;
      }
      const before = parent.path ? await this.directory(path) : await this.store.root.stat(path);
      if (
        !before ||
        before[2] !== 'directory' ||
        before[3] !== this.store.root.binding[3] ||
        !this.retain(512)
      ) {
        this.close();
        return undefined;
      }
      this.store.root.work.nativeListings++;
      let entries = 0;
      for await (const entry of await opendir(this.store.root.resolve(path), { bufferSize: 32 })) {
        this.signal?.throwIfAborted();
        if (++entries > this.maxEntries) {
          this.close();
          return undefined;
        }
        const key = nativeAliasKey(entry.name);
        let child = names.get(key);
        if (!child) {
          if (!this.retain(192 + 4 * (Buffer.byteLength(key) + Buffer.byteLength(entry.name))))
            return undefined;
          child = { name: entry.name, sources: 0n, directories: 0n, alias: false };
          names.set(key, child);
        }
        child.alias ||= child.name !== entry.name;
        child.sources |= bit;
        if (entry.isDirectory()) child.directories |= bit;
      }
      if (
        !(await this.matches(path, before)) ||
        (expectedParent && !(await this.matches(parentPath(path), expectedParent)))
      )
        throw new Error('Staged restore boundary changed while listing.');
      directories.set(index, before);
    }
    const view = { names, directories };
    this.views.set(parent.path, view);
    return view;
  }

  // Null means absent under an observed directory. Undefined means an incompatible endpoint.
  private async directory(path: string): Promise<NativeIdentity | null | undefined> {
    this.signal?.throwIfAborted();
    try {
      this.store.root.work.stats++;
      const native = await lstat(path ? this.store.root.resolve(path) : this.store.root.path, {
        bigint: true,
      });
      return native.isDirectory() && String(native.dev) === this.store.root.binding[3]
        ? nativeIdentity(native)
        : undefined;
    } catch (error) {
      if (missing(error)) return null;
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  private async matches(path: string, expected: NativeIdentity): Promise<boolean> {
    const actual = await this.directory(path);
    return !!actual && sameNative(actual, expected, true);
  }

  private async live(path: string, parent: Frame): Promise<Frame['live']> {
    if (!parent.live) return parent.live;
    if (!(await this.matches(parent.path, parent.live))) return undefined;
    const child = await this.directory(path);
    return (await this.matches(parent.path, parent.live)) ? child : undefined;
  }

  private async intact(path: string, bit: bigint): Promise<boolean> {
    if (!path || !this.enabled) return false;
    const parentName = parentPath(path);
    while (this.parents[this.parents.length - 1].path !== parentName) {
      const removed = this.parents.pop()!;
      this.budget.release(removed.charge);
      this.charged -= removed.charge;
    }
    const parent = this.parents[this.parents.length - 1];
    let sources = parent.sources,
      stagedParents: Frame['stagedParents'];
    if (sources && sources !== bit) {
      const view = await this.view(parent);
      if (!view) return false;
      stagedParents = view.directories;
      const child = view.names.get(nativeAliasKey(baseName(path)));
      sources =
        child && !child.alias && child.sources === child.directories && child.sources & bit
          ? child.sources
          : 0n;
    }
    const live = sources ? await this.live(path, parent) : undefined;
    if (sources === bit && live === null) return true;
    const charge = 384 + 4 * Buffer.byteLength(path);
    if (this.retain(charge)) this.parents.push({ path, sources, stagedParents, live, charge });
    return false;
  }
}
