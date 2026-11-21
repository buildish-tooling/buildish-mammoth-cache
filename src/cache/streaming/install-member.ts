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
import type { Value } from './encoding';
import { nativeIdentity, sameNative, sameRename, sameObject, type NativeIdentity } from './native';
import { NativeReadPhase } from './native-read-phase';
import { walkNative } from './native-walk';
import { compareMembership, parentPath } from './tree-state';
import type { InstallReaders } from './install-program';

/** Exact complete member, or a surviving subset during committed backup retirement. */
export async function checkInstallMember(
  readers: InstallReaders,
  binding: Value,
  logical: string,
  physical: string,
  options: {
    renamed: boolean;
    hash: boolean;
    partial?: boolean;
    rootNative?: NativeIdentity;
    observed?: (row: Value, physical: string, native: NativeIdentity) => Promise<void>;
    stat?: (path: string) => Promise<NativeIdentity | null>;
  },
  signal: AbortSignal,
): Promise<NativeIdentity> {
  const store = readers.store,
    reader = await readers.reader(binding, signal);
  const stat = options.stat ?? ((p: string) => store.root.stat(p));
  const actualRoot = await stat(physical);
  if (!actualRoot) throw new Error('Missing install member.');
  if (options.rootNative && !sameNative(options.rootNative, actualRoot, true))
    throw new Error('Observed backup root changed.');
  const phase = new NativeReadPhase(
    store.root,
    actualRoot[2] === 'file' ? parentPath(physical) : physical,
  );
  if (actualRoot[2] === 'file') {
    store.root.work.stats++;
    const raw = await lstat(store.root.resolve(physical), { bigint: true });
    if (raw.nlink !== 1n || !sameNative(actualRoot, nativeIdentity(raw), true))
      throw new Error('Aliased/changed install root file.');
  }
  let fileParent: { path: string; native: NativeIdentity } | undefined;
  if (actualRoot[2] === 'file' && options.hash) {
    const parent = parentPath(physical);
    store.root.work.stats++;
    fileParent = {
      path: parent,
      native: nativeIdentity(await lstat(store.root.resolve(parent), { bigint: true })),
    };
    await phase.enter(parent, fileParent.native);
  }
  const actual =
    actualRoot[2] === 'directory'
      ? walkNative(store.root, physical, {
          budget: readers.budget,
          logicalRoot: logical,
          metadata: 'reject',
          signal,
          maxDirectoryEntries: readers.maxDirectoryEntries,
        })
      : (async function* () {
          yield {
            tag: 'file' as const,
            path: logical,
            nativePath: physical,
            identity: actualRoot,
            links: '1',
          };
        })();
  async function next() {
    while (true) {
      const n = await actual.next();
      if (n.done) return n;
      const e = n.value;
      if (e.tag === 'protected-child') throw new Error('Unsupported install member.');
      if (e.tag === 'directory-close') {
        await phase.leave(e.nativePath, e.identity);
        continue;
      }
      if (e.tag === 'directory-open') await phase.enter(e.nativePath, e.identity);
      return n;
    }
  }
  let head = await next();
  try {
    await reader.member(
      binding,
      logical,
      actualRoot[2],
      async (value) => {
        signal.throwIfAborted();
        const row = value as readonly Value[],
          kind = row[0] === 'file' ? 'file' : 'directory',
          path = String(row[1]);
        if (head.done) {
          if (options.partial) return;
          throw new Error('Missing member descendant.');
        }
        const e = head.value;
        if (e.tag === 'protected-child' || e.tag === 'directory-close')
          throw new Error('Invalid member event.');
        const actualKind = e.tag === 'file' ? 'file' : 'directory';
        const order = compareMembership(['member', actualKind, e.path], ['member', kind, path]);
        if (order < 0) throw new Error('Unknown install descendant.');
        if (order > 0) {
          if (options.partial) return;
          throw new Error('Missing member descendant.');
        }
        const expected = row[2] as NativeIdentity,
          observed = e.identity;
        const matches =
          options.partial && kind === 'directory'
            ? observed[2] === expected[2] &&
              observed[3] === expected[3] &&
              observed[4] === expected[4] &&
              observed[6] === expected[6] &&
              ((path === logical && process.platform === 'win32') || observed[10] === expected[10])
            : path === logical && options.renamed
              ? sameRename(expected, observed)
              : sameNative(expected, observed, true);
        if (
          !matches ||
          observed[3] !== store.root.binding[3] ||
          (e.tag === 'file' && e.links !== '1')
        )
          throw new Error('Install member native identity changed.');
        if (
          e.tag === 'file' &&
          options.hash &&
          (await phase.hash(e.nativePath, observed, null, signal)) !== row[3]
        )
          throw new Error('Install member hash changed.');
        if (options.observed) await options.observed(value, e.nativePath, observed);
        head = await next();
      },
      signal,
    );
    if (!head.done) throw new Error('Unknown trailing install descendant.');
    // Root stat prevents replacing an empty member between the join and return.
    const after = await stat(physical);
    if (!after || !sameNative(actualRoot, after, true))
      throw new Error('Install member changed during validation.');
    if (fileParent) await phase.leave(fileParent.path, fileParent.native);
    return after;
  } finally {
    await actual.return(undefined as never);
  }
}

export function sameDirectoryObject(a: NativeIdentity, b: NativeIdentity): boolean {
  return sameObject(a, b) && a[2] === 'directory' && a[6] === b[6];
}
