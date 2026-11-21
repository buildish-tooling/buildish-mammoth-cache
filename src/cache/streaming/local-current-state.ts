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

import { z } from 'zod';
import type { Value } from './encoding';
import { nativeIdentitySchema, type LocalSchemas } from './local-schema';
import { filePathSchema, pathSchema } from './schema';
import { sameNative, type NativeIdentity } from './native';
import { TreeState, type WorkingBudget } from './tree-state';

const directory = z
  .tuple([z.enum(['dir-open', 'dir-close']), pathSchema, nativeIdentitySchema])
  .refine((r) => r[2][2] === 'directory');
const file = z
  .tuple([z.literal('file'), filePathSchema, nativeIdentitySchema])
  .refine((r) => r[2][2] === 'file');
// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Current facts are complete no-follow physical projections, not desired ownership/hash evidence.
export class LocalCurrentState {
  private readonly tree: TreeState;
  private readonly frames: { identity: NativeIdentity; release: () => void }[] = [];
  constructor(
    private readonly schemas: LocalSchemas,
    private readonly budget: WorkingBudget,
    maxEntries?: number,
  ) {
    this.tree = new TreeState(budget, maxEntries);
  }
  accept(value: Value): void {
    if (!Array.isArray(value)) throw new Error('Invalid install current row.');
    if (value[0] === 'parent-child') {
      const row = this.schemas.rows.parentChild.parse(value);
      if (row[1] !== this.tree.path) throw new Error('Protected child outside current parent.');
      this.tree.protectedChild(row[2], row[3] === 'directory');
    } else if (value[0] === 'file') {
      const row = file.parse(value);
      this.tree.file(row[1]);
    } else {
      const row = directory.parse(value);
      if (row[0] === 'dir-open') {
        const release = this.budget.holdRecord(512 + Buffer.byteLength(row[1]));
        try {
          this.tree.open(row[1]);
          this.frames.push({ identity: row[2], release });
        } catch (error) {
          release();
          throw error;
        }
      } else {
        const frame = this.frames[this.frames.length - 1];
        if (!frame || !sameNative(frame.identity, row[2], true))
          throw new Error('Current directory identity changed.');
        this.tree.close(row[1]);
        this.frames.pop()!.release();
      }
    }
  }
  finish(): void {
    if (!this.tree.complete || this.frames.length)
      throw new Error('Incomplete install current inventory.');
  }
  dispose(): void {
    for (const frame of this.frames.splice(0)) frame.release();
    this.tree.dispose();
  }
}
