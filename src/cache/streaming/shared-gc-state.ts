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

import { TreeState, parentPath, type WorkingBudget } from './tree-state';
import type { NativeIdentity } from './native';

// Protocol: docs/dev/cache-lifecycle-protocol.md#shared-gc-parent-projections.
// Syntax/order only. The consumer must bind each exact span to the complete
// observation before any intent/mutation; no child projection is copied per unit.
export class SharedGcTreeState {
  private readonly tree: TreeState;
  private readonly frames: { path: string; targeted: boolean; release: () => void }[] = [];
  private base: string | null = null;
  constructor(
    private readonly root: string,
    private readonly scope: string,
    private readonly budget: WorkingBudget,
    max: number,
  ) {
    this.tree = new TreeState(budget, max);
  }
  private relative(path: string): string {
    return path === this.base ? '' : path.slice(this.base!.length + (this.base ? 1 : 0));
  }
  private close(): void {
    const f = this.frames.pop()!;
    try {
      this.tree.close(this.relative(f.path));
    } finally {
      f.release();
    }
  }
  parent(path: string): void {
    if (this.base === null) {
      if (path !== (this.scope === 'file' ? parentPath(this.root) : this.root))
        throw new Error('Wrong shared GC parent.');
      this.base = path;
      this.tree.open('');
    } else {
      if (this.scope !== 'subtree' || !path.startsWith(this.root + '/'))
        throw new Error('Shared GC directory outside subtree.');
      while (this.frames.length && this.frames[this.frames.length - 1].path !== parentPath(path))
        this.close();
      if (!this.frames.length || this.frames[this.frames.length - 1].targeted)
        throw new Error('Invalid shared GC directory hierarchy.');
      this.tree.open(this.relative(path));
    }
    this.frames.push({
      path,
      targeted: false,
      release: this.budget.holdRecord(128 + Buffer.byteLength(path)),
    });
  }
  target(path: string, native: NativeIdentity): void {
    if (this.base === null) throw new Error('Missing shared GC parent.');
    if (native[2] === 'directory') {
      if (this.scope !== 'subtree') throw new Error('Directory target outside GC subtree.');
      while (this.frames.length && this.frames[this.frames.length - 1].path !== path) this.close();
      const frame = this.frames[this.frames.length - 1];
      if (!frame || frame.targeted)
        throw new Error('Missing/duplicate shared GC directory target.');
      frame.targeted = true;
    } else {
      while (this.frames.length && this.frames[this.frames.length - 1].path !== parentPath(path))
        this.close();
      if (!this.frames.length || this.frames[this.frames.length - 1].targeted)
        throw new Error('Shared GC file lacks parent.');
      this.tree.file(this.relative(path));
    }
  }
  finish(): void {
    if (this.base === null) throw new Error('Missing shared GC projection.');
    while (this.frames.length) this.close();
  }
  dispose(): void {
    this.tree.dispose();
    for (const f of this.frames) f.release();
    this.frames.length = 0;
  }
}
