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

import { equal, type Value } from './encoding';
import { baseName, parentPath, compareName, TreeState, type WorkingBudget } from './tree-state';
interface Frame {
  path: string;
  native: readonly Value[];
  children: Map<string, readonly Value[]>;
  last: string | null;
  directories: boolean;
  body: boolean;
  targeted: boolean;
  charge: number;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas
/** One bounded immediate-child projection per active GC evidence directory. */
export class GcTreeState {
  private readonly frames: Frame[] = [];
  private readonly tree: TreeState;
  private base: string | null = null;
  constructor(
    private readonly root: string,
    private readonly scope: string,
    private readonly budget: WorkingBudget,
    private readonly maxEntries: number,
  ) {
    this.tree = new TreeState(budget, maxEntries);
  }
  private current(): Frame {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) throw new Error('Missing GC parent projection.');
    return frame;
  }
  private relative(path: string): string {
    return path === this.base ? '' : path.slice(this.base!.length + (this.base === '' ? 0 : 1));
  }
  private close(): void {
    const frame = this.frames.pop()!;
    this.tree.close(this.relative(frame.path));
    this.budget.release(frame.charge);
  }
  private bind(path: string, native: readonly Value[], kind: string): void {
    const f = this.current();
    if (f.targeted) throw new Error('GC member after directory cleanup target.');
    const entry = f.children.get(baseName(path));
    if (!entry || entry[0] !== kind || entry[1] !== native[3] || entry[2] !== native[4])
      throw new Error('GC target differs from frozen parent projection.');
    f.body = true;
  }
  directory(path: string, native: readonly Value[]): void {
    const required = this.scope === 'file' ? parentPath(this.root) : this.root;
    if (this.base === null) {
      if (path !== required) throw new Error('Missing GC unit directory projection.');
      this.base = path;
      this.tree.open('');
    } else {
      if (this.scope !== 'subtree' || !path.startsWith(this.root + '/'))
        throw new Error('GC directory outside unit scope.');
      while (this.frames.length && this.current().path !== parentPath(path)) this.close();
      if (!this.frames.length) throw new Error('Invalid GC directory hierarchy.');
      this.bind(path, native, 'directory');
      this.tree.open(this.relative(path));
    }
    const charge = 128 + 4 * Buffer.byteLength(path);
    this.budget.retain(charge);
    this.frames.push({
      path,
      native,
      children: new Map(),
      last: null,
      directories: false,
      body: false,
      targeted: false,
      charge,
    });
  }
  child(parent: string, name: string, type: string, device: string, fileId: string): void {
    const f = this.current(),
      directory = type === 'directory';
    if (f.path !== parent || f.body || (!directory && f.directories) || f.children.has(name))
      throw new Error('Unordered/duplicate GC parent projection.');
    if (directory && !f.directories) {
      f.directories = true;
      f.last = null;
    }
    if (f.last !== null && compareName(f.last, name) >= 0) throw new Error('Unordered GC child.');
    if (f.children.size === this.maxEntries) throw new Error('GC child breadth exceeded.');
    name = Buffer.from(name).toString('utf8');
    const charge = 128 + 4 * (Buffer.byteLength(name) + device.length + fileId.length);
    this.budget.retain(charge);
    f.charge += charge;
    f.children.set(name, [
      type,
      Buffer.from(device).toString('utf8'),
      Buffer.from(fileId).toString('utf8'),
    ]);
    f.last = name;
  }
  target(path: string, native: readonly Value[]): void {
    if (native[2] === 'directory') {
      if (this.scope !== 'subtree') throw new Error('Directory target in non-subtree GC unit.');
      while (this.frames.length && this.current().path !== path) this.close();
      const f = this.current();
      if (f.path !== path || f.targeted) throw new Error('Missing/duplicate GC directory target.');
      equal(f.native, native, 'GC directory target identity');
      f.body = true;
      f.targeted = true;
    } else {
      while (this.frames.length && this.current().path !== parentPath(path)) this.close();
      this.bind(path, native, 'file');
      this.tree.file(this.relative(path));
    }
  }
  finish(): void {
    if (this.base === null) throw new Error('Missing GC parent projection.');
    while (this.frames.length) this.close();
  }
  dispose(): void {
    this.tree.dispose();
    while (this.frames.length) this.budget.release(this.frames.pop()!.charge);
  }
}
