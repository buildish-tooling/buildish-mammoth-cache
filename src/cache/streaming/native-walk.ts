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

import type { BigIntStats, Dirent } from 'node:fs';
import { isCacheMetadataPath } from '../metadata-paths';
import { lstat, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeIdentity,
  nativeIds,
  sameNative,
  sameObject,
  missing,
  type NativeIdentity,
  type NativeRoot,
} from './native';
import { componentSchema, filePathSchema, pathSchema, relativePathSchema } from './schema';
import {
  directoryBreadthError,
  compareName,
  joinPath,
  parentPath,
  baseName,
  type WorkingBudget,
} from './tree-state';

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
/** Capture-only pre-freeze policy; the trusted caller already owns the exclusive window. */
export interface NativePurge {
  claim(path: string): readonly string[];
  assertCurrent(): void;
  outcome(partition: string, outcome: 'deleted' | 'missing' | 'unsupported', path: string): void;
  checkpoint(phase: 'before-unlink' | 'unlinked' | 'refreshed'): Promise<void>;
}

interface AdditionalDirectories {
  readonly names: ReadonlySet<string>;
  readonly only?: boolean;
}

export interface WalkOptions {
  readonly budget: WorkingBudget;
  readonly purge?: NativePurge;
  readonly maxDirectoryEntries?: number;
  /** Logical root when traversing an owned staging tree. Defaults to the native path. */
  readonly logicalRoot?: string;
  /** Live projections exclude reserved metadata; sealed staging must reject it. */
  readonly metadata?: 'exclude' | 'reject';
  /** Trusted base sources may retain an intact directory without visiting its children. */
  readonly intactDirectory?: (path: string) => 'intact' | 'workspace' | undefined;
  /** Within trusted intact roots, only the summary uses these file observations. */
  readonly summaryOnlyFile?: (path: string) => boolean;
  /** Prune only when the complete subtree is outside the requested projection. */
  readonly prune?: (path: string) => boolean;
  /** Synchronous protected-child inventory. Returning prune never follows that object. */
  readonly inspectChild?: (child: NativeChild) => 'prune' | void;
  readonly ignoreEntry?: (path: string, raw: BigIntStats) => Promise<boolean>;
  /** Complete units can require directories present only in the merged view. */
  readonly extraDirectories?: (path: string) => AdditionalDirectories | undefined;
  readonly signal?: AbortSignal;
  /** Immediate parent held by a caller's checked ancestor scope. Rechecked at both boundaries. */
  readonly parentNative?: NativeIdentity;
}

export type WalkEvent =
  | (NativeChild & { readonly tag: 'protected-child'; readonly nativePath: string })
  | {
      readonly tag: 'directory-open' | 'directory-close';
      readonly activityTimes?: readonly [string, string];
      readonly directJars?: true;
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
  regular: boolean;
  removed?: boolean;
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
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new Error('Invalid directory entry allowance.');
  }
  const signal = options.signal ?? new AbortController().signal;
  let retained = 0;
  const rawStat = async (path: string) => {
    signal.throwIfAborted();
    work.stats++;
    root.work.stats++;
    return lstat(root.resolve(path), { bigint: true });
  };
  const stat = async (path: string) => nativeIdentity(await rawStat(path));
  signal.throwIfAborted();
  root.work.nativeWalks++;
  await root.verifyRoot();
  const checkParent = async () => {
    const expected = options.parentNative!;
    if (
      !relative ||
      expected[2] !== 'directory' ||
      expected[3] !== root.binding[3] ||
      !sameNative(await stat(parentPath(relative)), expected, true)
    ) {
      throw new Error('Scoped traversal parent changed.');
    }
  };
  if (options.parentNative) {
    await checkParent();
  } else if (relative) {
    await root.parents(relative);
  }
  async function* projectedListing(
    physical: string,
    extra: AdditionalDirectories,
  ): AsyncGenerator<Pick<Dirent, 'name' | 'isDirectory' | 'isFile'>> {
    if (!extra.only) {
      for await (const entry of await opendir(physical, { bufferSize: 32 })) {
        signal.throwIfAborted();
        work.entries++;
        if (!extra.names.has(entry.name)) {
          yield entry;
        }
      }
    }
    for (const name of extra.names) {
      yield { name, isDirectory: () => true, isFile: () => false };
    }
  }
  async function* visit(
    nativePath: string,
    path: string,
    depth: number,
    expectedKind?: 'file' | 'directory',
    pruned = false,
  ): AsyncGenerator<WalkEvent> {
    const raw = await rawStat(nativePath);
    if (expectedKind && options.ignoreEntry && (await options.ignoreEntry(path, raw))) {
      return;
    }
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
        signal.throwIfAborted();
        let decision: 'prune' | void;
        try {
          decision = options.inspectChild(child);
        } finally {
          // A callback can cancel the walk and throw at the same time.
          signal.throwIfAborted();
        }
        if (decision === 'prune' || pruned) {
          yield { tag: 'protected-child', nativePath, ...child };
          return;
        }
      } finally {
        release();
      }
    }
    if (pruned) {
      return;
    }
    pathSchema.parse(path);
    let before = nativeIdentity(raw);
    if (expectedKind && before[2] !== expectedKind) {
      throw new Error('Native entry kind changed during traversal.');
    }
    if (before[2] === 'directory' && depth > 100) {
      throw new Error('Native tree depth exceeded.');
    }
    const releaseFrame = options.budget.holdRecord(
      512 + Buffer.byteLength(path) + Buffer.byteLength(nativePath),
    );
    try {
      if (before[2] === 'file') {
        filePathSchema.parse(path);
        yield { tag: 'file', path, nativePath, identity: before, links: String(raw.nlink) };
        if (!options.summaryOnlyFile?.(path) && !sameNative(before, await stat(nativePath), true)) {
          throw new Error('Native file changed during traversal.');
        }
        return;
      }
      const activityTimes = options.purge ? ([before[8], before[9]] as const) : undefined;
      if (!options.purge) {
        yield { tag: 'directory-open', path, nativePath, identity: before };
      }
      const intact = options.intactDirectory?.(path);
      if (intact) {
        let directJars: true | undefined;
        if (intact === 'workspace') {
          work.listings++;
          root.work.nativeListings++;
          let entries = 0;
          for await (const entry of await opendir(root.resolve(nativePath), { bufferSize: 32 })) {
            signal.throwIfAborted();
            work.entries++;
            if (++entries > max) {
              throw directoryBreadthError(path, max, 'native walk');
            }
            if ((entry.name === 'classes.jar' || entry.name === 'sources.jar') && entry.isFile()) {
              directJars = true;
            }
          }
        }
        const after = await stat(nativePath);
        if (!sameNative(before, after, true)) {
          throw new Error('Native directory changed during traversal.');
        }
        yield { tag: 'directory-close', path, nativePath, identity: after, directJars };
        return;
      }
      const children: (Child | undefined)[] = [];
      const names = new Set<string>();
      let charge = 0,
        entries = 0;
      try {
        const physical = root.resolve(nativePath);
        const extra = options.extraDirectories?.(path);
        if (!extra?.only) {
          work.listings++;
          root.work.nativeListings++;
        }
        const listing = extra
          ? projectedListing(physical, extra)
          : await opendir(physical, {
              bufferSize: 32,
            });
        // Close the physical directory before descending.
        for await (const entry of listing) {
          signal.throwIfAborted();
          if (!extra) {
            work.entries++;
          }
          const entryName = entry.name;
          if (++entries > max) {
            throw directoryBreadthError(path, max, 'native walk');
          }
          componentSchema.parse(entryName);
          const childPath = joinPath(path, entryName);
          // Count every physical child; inventories additionally keep protected IDs.
          let pruned = false;
          if (isCacheMetadataPath(childPath)) {
            if ((options.metadata ?? (relative === '' ? 'exclude' : 'reject')) !== 'exclude') {
              throw new Error('Reserved metadata in native staging.');
            }
            pruned = true;
          }
          if (!pruned && options.prune?.(childPath)) {
            pruned = true;
          }
          if (pruned && !options.inspectChild) {
            continue;
          }
          if (!pruned) {
            pathSchema.parse(childPath);
          }
          if (names.has(entryName)) {
            throw new Error('Duplicate decoded native child name.');
          }
          let isDirectory = entry.isDirectory();
          const regular = entry.isFile();
          if (
            options.ignoreEntry &&
            !isDirectory &&
            join(physical, entryName) !== root.resolve(joinPath(nativePath, entryName))
          ) {
            // A whiteout can occupy an upper name whose complete-unit view is merged.
            work.stats++;
            root.work.stats++;
            if (
              await options.ignoreEntry(
                childPath,
                await lstat(join(physical, entryName), { bigint: true }),
              )
            ) {
              continue;
            }
          }
          if (!regular && !isDirectory) {
            const raw = await rawStat(joinPath(nativePath, entryName));
            if (!options.inspectChild) {
              nativeIdentity(raw);
            }
            isDirectory = raw.isDirectory();
          }
          const bytes = 128 + 4 * Buffer.byteLength(entryName);
          options.budget.retain(bytes);
          charge += bytes;
          retained += bytes;
          work.peakNames = Math.max(work.peakNames, retained);
          const name = Buffer.from(entryName).toString('utf8');
          names.add(name);
          children.push({ name, directory: isDirectory, regular, pruned });
        }
        if (!sameNative(before, await stat(nativePath), true)) {
          throw new Error('Native directory changed while listing.');
        }
        names.clear();
        children.sort(
          (a, b) => Number(a!.directory) - Number(b!.directory) || compareName(a!.name, b!.name),
        );
        // Protocol: docs/dev/cache-lifecycle-protocol.md#pre-freeze-purge-configuration.
        // No observer facts escape until these known mutations finish. Nonmatches
        // reuse the listing and incur no additional filesystem/lifetime checks.
        if (options.purge) {
          const policy = options.purge;
          for (const child of children) {
            if (!child || child.directory || child.pruned) {
              continue;
            }
            const file = joinPath(nativePath, child.name),
              claims = policy.claim(joinPath(path, child.name));
            if (!claims.length) {
              continue;
            }
            const partition = claims[0];
            if (!child.regular) {
              policy.outcome(partition, 'unsupported', file);
              continue;
            }
            let candidate: BigIntStats;
            try {
              candidate = await rawStat(file);
            } catch (error) {
              if (!missing(error)) {
                throw error;
              }
              if (!sameNative(before, await stat(nativePath), true)) {
                throw new Error('Missing purge candidate changed its parent.', { cause: error });
              }
              child.removed = true;
              policy.outcome(partition, 'missing', file);
              continue;
            }
            if (!candidate.isFile() || candidate.nlink !== 1n) {
              policy.outcome(partition, 'unsupported', file);
              continue;
            }
            const expected = nativeIdentity(candidate);
            if (expected[3] !== root.binding[3]) {
              throw new Error('Cross-device purge candidate.');
            }
            await policy.checkpoint('before-unlink');
            policy.assertCurrent();
            signal.throwIfAborted();
            if (!sameNative(before, await stat(nativePath), true)) {
              throw new Error('Purge parent changed.');
            }
            const fresh = await rawStat(file);
            if (
              !fresh.isFile() ||
              fresh.nlink !== 1n ||
              !sameNative(expected, nativeIdentity(fresh), true)
            ) {
              throw new Error('Purge candidate changed.');
            }
            policy.assertCurrent();
            signal.throwIfAborted();
            await unlink(root.resolve(file));
            root.work.unlinks++;
            child.removed = true;
            policy.outcome(partition, 'deleted', file);
            const after = await stat(nativePath);
            if (!sameObject(before, after) || before[6] !== after[6]) {
              throw new Error('Purge parent was replaced.');
            }
            before = after;
            await policy.checkpoint('unlinked');
            await policy.checkpoint('refreshed');
          }
          yield { tag: 'directory-open', path, nativePath, identity: before, activityTimes };
        }
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
          if (child.removed) {
            continue;
          }
          yield* visit(
            joinPath(nativePath, child.name),
            joinPath(path, child.name),
            depth + 1,
            child.directory ? 'directory' : 'file',
            child.pruned,
          );
        }
        const after = await stat(nativePath);
        if (!sameNative(before, after, true)) {
          throw new Error('Native directory changed during traversal.');
        }
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
  if (options.parentNative) {
    await checkParent();
  }
  await root.verifyRoot();
}
