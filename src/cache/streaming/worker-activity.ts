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

import type { OwnedStore } from './owned-store';
import { WorkerSpool } from './worker-spool';
import { baseName, parentPath, TreeState, type WorkingBudget } from './tree-state';
import type { Unit } from './schema';
interface Frame {
  path: string;
  open: boolean;
  release: () => void;
}
// Protocol: docs/dev/cache-protocol.md#usage-validation.
// Sequential provisional membership only. No Q or live authority until every input
// and the final activity union pass succeeds.
export class ActivityProjection {
  readonly spool: WorkerSpool;
  private readonly frames: Frame[] = [];
  private readonly tree: TreeState;
  private unit: Unit | null = null;
  private constructor(
    spool: WorkerSpool,
    private readonly budget: WorkingBudget,
    max: number,
    readonly kind: 'upsert' | 'used',
  ) {
    this.spool = spool;
    this.tree = new TreeState(budget, max);
  }
  static async create(
    store: OwnedStore,
    budget: WorkingBudget,
    max = 100000,
    kind: 'upsert' | 'used' = 'upsert',
  ): Promise<ActivityProjection> {
    if (!Number.isSafeInteger(max) || max < 1)
      throw new Error('Invalid activity directory allowance.');
    return new ActivityProjection(await WorkerSpool.create(store, budget), budget, max, kind);
  }
  async enter(path: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const parent = this.frames[this.frames.length - 1];
    if (parent ? parentPath(path) !== parent.path : path !== '')
      throw new Error('Activity hierarchy mismatch.');
    this.frames.push({
      path,
      open: false,
      release: this.budget.holdRecord(256 + Buffer.byteLength(path)),
    });
    if (this.unit?.[2] === 'subtree') await this.ensure(signal);
  }
  async ensure(signal: AbortSignal): Promise<void> {
    for (const f of this.frames)
      if (!f.open) {
        this.tree.open(f.path);
        await this.spool.append(['dir-open', f.path], signal);
        f.open = true;
      }
  }
  async member(
    activity: 'upsert' | 'used',
    path: string,
    partition: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (parentPath(path) !== this.frames[this.frames.length - 1]?.path)
      throw new Error('Activity file outside frame.');
    await this.ensure(signal);
    this.tree.file(path);
    await this.spool.append([activity, baseName(path), partition], signal);
  }
  async unitOpen(unit: Unit, activity: 'upsert' | 'used', signal: AbortSignal): Promise<void> {
    if (this.unit || unit[1] !== this.frames[this.frames.length - 1]?.path)
      throw new Error('Activity unit mismatch.');
    await this.ensure(signal);
    await this.spool.append(['unit-open', ...unit, activity], signal);
    this.unit = unit;
  }
  async unitClose(signal: AbortSignal): Promise<void> {
    if (!this.unit) throw new Error('Missing activity unit.');
    await this.spool.append(['unit-close', this.unit[0], this.unit[1]], signal);
    if (this.unit[2] === 'direct') this.tree.endFiles();
    this.unit = null;
  }
  async leave(path: string, signal: AbortSignal): Promise<void> {
    const f = this.frames[this.frames.length - 1];
    if (!f || f.path !== path) throw new Error('Unbalanced activity close.');
    if (path === '') await this.ensure(signal);
    if (f.open) {
      await this.spool.append(['dir-close', path], signal);
      this.tree.close(path);
    }
    this.frames.pop()!.release();
  }
  seal(signal: AbortSignal): void {
    if (this.frames.length || this.unit) throw new Error('Unfinished activity projection.');
    this.spool.seal(signal);
  }
  async dispose(): Promise<void> {
    this.tree.dispose();
    while (this.frames.length) this.frames.pop()!.release();
    await this.spool.dispose();
  }
}
