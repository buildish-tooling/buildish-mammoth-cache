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

import type { BigIntStats } from 'node:fs';
import { withAbort } from './abort';
import { isCacheMetadataPath } from '../metadata-paths';
import { lstat, opendir } from 'node:fs/promises';
import {
  nativeIdentity,
  nativeIds,
  sameNative,
  type NativeIdentity,
  type NativeRoot,
} from './native';
import { componentSchema, filePathSchema, pathSchema, relativePathSchema } from './schema';
import { compareName, joinPath, parentPath, baseName, type WorkingBudget } from './tree-state';

export interface NativeChild {
  readonly path: string;
  readonly parent: string;
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly device: string;
  readonly fileId: string;
  readonly pruned: boolean;
}
const childType = (s: BigIntStats): NativeChild['type'] =>
  s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other';
export interface WalkOptions {
  readonly budget: WorkingBudget;
  readonly maxDirectoryEntries?: number;
  /** Logical root when traversing an owned staging tree. Defaults to the native path. */
  readonly logicalRoot?: string;
  /** Live projections exclude reserved metadata; sealed staging must reject it. */
  readonly metadata?: 'exclude' | 'reject';
  /** Prune only when the complete subtree is outside the requested projection. */
  readonly prune?: (path: string) => boolean;
  /** Same-phase protected-child inventory. Returning prune never follows that object. */
  readonly inspectChild?: (child: NativeChild, signal: AbortSignal) => Promise<'prune' | void>;
  readonly signal?: AbortSignal;
}
export type WalkEvent =
  | (NativeChild & { readonly tag: 'protected-child'; readonly nativePath: string })
  | {
      readonly tag: 'directory-open' | 'directory-close';
      readonly path: string;
      readonly nativePath: string;
      readonly identity: NativeIdentity;
    }
  | {
      readonly tag: 'file';
      readonly links: string;
      readonly path: string;
      readonly nativePath: string;
      readonly identity: NativeIdentity;
    };
export interface WalkWork {
  listings: number;
  entries: number;
  stats: number;
  peakNames: number;
}
export const walkWork = (): WalkWork => ({ listings: 0, entries: 0, stats: 0, peakNames: 0 });
interface Child {
  name: string;
  directory: boolean;
  pruned: boolean;
}

// Protocol: docs/dev/cache-protocol.md#paths-and-order and #resource-accounting.
// One closed directory listing per frame, before descending. No global file index.
// The caller owns the exclusive native-cache window; consumers may read/hash bodies,
// but must finish this frozen traversal before mutating any enumerated directory.
export async function* walkNative(
  root: NativeRoot,
  relative: string,
  options: WalkOptions,
  work = walkWork(),
): AsyncGenerator<WalkEvent> {
  relativePathSchema.parse(relative);
  const logicalRoot = pathSchema.parse(options.logicalRoot ?? relative);
  const max = options.maxDirectoryEntries ?? 100000;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid directory entry allowance.');
  const signal = options.signal ?? new AbortController().signal;
  let retained = 0;
  const rawStat = async (path: string) => {
    signal.throwIfAborted();
    work.stats++;
    root.work.stats++;
    return lstat(path ? root.resolve(path) : root.path, { bigint: true });
  };
  const stat = async (path: string) => nativeIdentity(await rawStat(path));
  await root.verifyRoot();
  if (relative) await root.parents(relative);
  async function* visit(
    nativePath: string,
    path: string,
    depth: number,
    expectedKind?: 'file' | 'directory',
    pruned = false,
  ): AsyncGenerator<WalkEvent> {
    const raw = await rawStat(nativePath);
    if (expectedKind && options.inspectChild) {
      const release = options.budget.holdRecord(
        512 + Buffer.byteLength(path) + Buffer.byteLength(nativePath),
      );
      try {
        const [device, fileId] = nativeIds(raw);
        const child: NativeChild = {
          path,
          parent: parentPath(path),
          name: baseName(path),
          type: childType(raw),
          device,
          fileId,
          pruned,
        };
        const decision = await withAbort(options.inspectChild(child, signal), signal);
        if (decision === 'prune' || pruned) {
          yield { tag: 'protected-child', nativePath, ...child };
          return;
        }
      } finally {
        release();
      }
    }
    if (pruned) return;
    pathSchema.parse(path);
    const before = nativeIdentity(raw);
    if (expectedKind && before[2] !== expectedKind)
      throw new Error('Native entry kind changed during traversal.');
    if (before[2] === 'directory' && depth > 100) throw new Error('Native tree depth exceeded.');
    const releaseFrame = options.budget.holdRecord(
      512 + Buffer.byteLength(path) + Buffer.byteLength(nativePath),
    );
    try {
      if (before[2] === 'file') {
        filePathSchema.parse(path);
        yield { tag: 'file', path, nativePath, identity: before, links: String(raw.nlink) };
        if (!sameNative(before, await stat(nativePath), true))
          throw new Error('Native file changed during traversal.');
        return;
      }
      yield { tag: 'directory-open', path, nativePath, identity: before };
      const children: (Child | undefined)[] = [];
      const names = new Set<string>();
      let charge = 0,
        entries = 0;
      try {
        work.listings++;
        const directory = await opendir(nativePath ? root.resolve(nativePath) : root.path, {
          bufferSize: 32,
        });
        // for-await closes the directory on EOF, errors and early return, before recursion.
        for await (const entry of directory) {
          signal.throwIfAborted();
          work.entries++;
          if (++entries > max) throw new Error('Managed directory breadth exceeded.');
          componentSchema.parse(entry.name);
          const childPath = joinPath(path, entry.name);
          // Count every physical child; inventories additionally keep protected IDs.
          let pruned = false;
          if (isCacheMetadataPath(childPath)) {
            if ((options.metadata ?? (relative === '' ? 'exclude' : 'reject')) !== 'exclude')
              throw new Error('Reserved metadata in native staging.');
            pruned = true;
          }
          if (!pruned && options.prune?.(childPath)) pruned = true;
          if (pruned && !options.inspectChild) continue;
          if (!pruned) pathSchema.parse(childPath);
          if (names.has(entry.name)) throw new Error('Duplicate decoded native child name.');
          let isDirectory = entry.isDirectory();
          if (!entry.isFile() && !isDirectory) {
            const raw = await rawStat(joinPath(nativePath, entry.name));
            if (!options.inspectChild) nativeIdentity(raw);
            isDirectory = raw.isDirectory();
          }
          const bytes = 128 + 4 * Buffer.byteLength(entry.name);
          options.budget.retain(bytes);
          charge += bytes;
          retained += bytes;
          work.peakNames = Math.max(work.peakNames, retained);
          const name = Buffer.from(entry.name).toString('utf8');
          names.add(name);
          children.push({ name, directory: isDirectory, pruned });
        }
        if (!sameNative(before, await stat(nativePath), true))
          throw new Error('Native directory changed while listing.');
        names.clear();
        children.sort(
          (a, b) => Number(a!.directory) - Number(b!.directory) || compareName(a!.name, b!.name),
        );
        for (let i = 0; i < children.length; i++) {
          signal.throwIfAborted();
          const child = children[i]!;
          children[i] = undefined;
          // Transfer processed names to the consumer's checked frontier; retain the
          // array slot charge until this frame closes instead of double-counting it.
          const released = 112 + 4 * Buffer.byteLength(child.name);
          options.budget.release(released);
          charge -= released;
          retained -= released;
          yield* visit(
            joinPath(nativePath, child.name),
            joinPath(path, child.name),
            depth + 1,
            child.directory ? 'directory' : 'file',
            child.pruned,
          );
        }
        const after = await stat(nativePath);
        if (!sameNative(before, after, true))
          throw new Error('Native directory changed during traversal.');
        yield { tag: 'directory-close', path, nativePath, identity: after };
      } finally {
        options.budget.release(charge);
        retained -= charge;
      }
    } finally {
      releaseFrame();
    }
  }
  yield* visit(relative, logicalRoot, logicalRoot ? logicalRoot.split('/').length + 1 : 1);
  await root.verifyRoot();
}
