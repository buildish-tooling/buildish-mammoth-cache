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

import { InstallScratch } from './install-scratch';
import { IndexDirectories, type IndexedNode } from './install-index';
import { baseName, parentPath, compareName } from './tree-state';
import { encodeRecord, type Value } from './encoding';
import { settleBaseCleanup } from './base-object';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';

// Operation-local sparse hierarchical lookup of already admitted, nonoverlapping
// roots. Payload membership and restart authority stay in the immutable plans/Qs.
// The common directory pager treats node[3] as opaque; only this class reads claims.
export class RelocationRoots {
  private busy = false;
  private closed = false;
  private constructor(
    private readonly scratch: InstallScratch,
    private readonly pages: IndexDirectories,
  ) {}
  static async create(
    store: OwnedStore,
    budget: WorkingBudget,
    source: AsyncIterable<readonly [string, Value]>,
    signal = new AbortController().signal,
  ) {
    const scratch = await InstallScratch.create(store, budget),
      frames: {
        path: string;
        tail: number | null;
        affected: boolean;
        returned: boolean;
        currentRoots: boolean;
        effect: Value | null;
        effectRelease: () => void;
        release: () => void;
      }[] = [];
    let root: number | undefined;
    const attach = async (path: string, offset: number, kind: 'file' | 'directory') => {
      const parent = frames[frames.length - 1];
      if (!parent) {
        if (root !== undefined) throw new Error('Duplicate root lookup root.');
        root = offset;
      } else
        parent.tail = await scratch.append([
          'root-link',
          parent.tail,
          baseName(path),
          kind,
          offset,
        ]);
    };
    const close = async () => {
      const f = frames.pop()!,
        entries: { name: string; kind: 'file' | 'directory'; offset: number }[] = [];
      let charge = 0;
      try {
        for (let at = f.tail; at !== null;) {
          signal.throwIfAborted();
          const row = await scratch.record(at);
          try {
            const r = row.value as readonly Value[],
              name = String(r[2]),
              n = 128 + 4 * Buffer.byteLength(name);
            budget.retain(n);
            charge += n;
            entries.push({ name, kind: r[3] as 'file' | 'directory', offset: Number(r[4]) });
            at = r[1] as number | null;
          } finally {
            row.release();
          }
        }
        entries.sort((a, b) => compareName(a.name, b.name));
        if (f.currentRoots !== (f.effect !== null))
          throw new Error('Adjustment parent effect/root coverage mismatch.');
        const start = scratch.position;
        for (const e of entries) {
          signal.throwIfAborted();
          await scratch.append(['edge', e.name, e.kind, e.offset]);
        }
        const end = scratch.position,
          node: IndexedNode = [
            'node',
            'directory',
            f.path,
            ['context', f.affected ? 1 : 0, f.effect, f.returned ? 1 : 0],
            null,
            '0',
            0,
            start,
            end,
            0,
            0,
          ];
        await attach(f.path, await scratch.append(node), 'directory');
      } finally {
        budget.release(charge);
        f.effectRelease();
        f.release();
      }
    };
    const push = (path: string) =>
      frames.push({
        path,
        tail: null,
        affected: false,
        returned: false,
        currentRoots: false,
        effect: null,
        effectRelease: () => {},
        release: budget.holdRecord(512 + Buffer.byteLength(path)),
      });
    try {
      push('');
      for await (const [path, claim] of source) {
        signal.throwIfAborted();
        const effect = Array.isArray(claim) && claim[0] === 'ancestor-effect';
        if (!path && !effect) throw new Error('Cannot claim managed lookup root.');
        const parent = effect ? path : parentPath(path);
        while (
          frames.length > 1 &&
          frames[frames.length - 1].path !== parent &&
          !parent.startsWith(frames[frames.length - 1].path + '/')
        )
          await close();
        const anchor = frames[frames.length - 1].path,
          suffix = anchor ? parent.slice(anchor.length + 1) : parent;
        let current = anchor;
        for (const name of suffix.split('/').filter(Boolean)) {
          current = current ? current + '/' + name : name;
          push(current);
        }
        if (effect) {
          const frame = frames[frames.length - 1];
          if (frame.effect !== null) throw new Error('Duplicate adjustment parent effect.');
          frame.effectRelease = budget.holdRecord(encodeRecord(claim).length);
          frame.effect = structuredClone(claim);
          continue;
        }
        const hold = budget.holdRecord(encodeRecord(claim).length);
        try {
          const node: IndexedNode = ['node', 'file', path, claim, null, '0', 0, 0, 0, 0, 0];
          await attach(path, await scratch.append(node), 'file');
          if (Array.isArray(claim) && claim[0] === 'adjustment')
            frames[frames.length - 1].currentRoots = true;
          if (Array.isArray(claim) && claim[0] === 'root' && claim[6] === 1)
            frames[frames.length - 1].affected = true;
          if (
            Array.isArray(claim) &&
            claim[0] === 'root' &&
            claim[6] === 1 &&
            claim[4] === 'original'
          )
            frames[frames.length - 1].returned = true;
        } finally {
          hold();
        }
      }
      while (frames.length) await close();
      signal.throwIfAborted();
      return new RelocationRoots(scratch, new IndexDirectories(scratch, root!));
    } catch (error) {
      for (const f of frames) {
        f.effectRelease();
        f.release();
      }
      await settleBaseCleanup([() => scratch.close()], error);
      throw error;
    }
  }
  async claim(path: string): Promise<{ value: Value; release(): void } | null> {
    if (this.busy || this.closed) throw new Error('Root lookup unavailable/active.');
    this.busy = true;
    try {
      const lease = await this.pages.member(path);
      if (!lease) return null;
      try {
        if (lease.node[3] === null) return null;
        const release = this.scratch.budget.holdRecord(encodeRecord(lease.node[3]).length);
        try {
          return { value: structuredClone(lease.node[3]), release };
        } catch (error) {
          release();
          throw error;
        }
      } finally {
        lease.release();
      }
    } finally {
      this.busy = false;
    }
  }
  async close() {
    if (this.busy) throw new Error('Root lookup active.');
    this.closed = true;
    this.pages.close();
    await this.scratch.close();
  }
}
