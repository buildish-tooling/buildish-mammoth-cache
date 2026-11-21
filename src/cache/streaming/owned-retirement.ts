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

import { lstat, opendir, unlink, rmdir } from 'node:fs/promises';
import { nativeIdentity, sameNative, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import type { OwnedStore } from './owned-store';
import { relativePathSchema } from './schema';
import { WorkingBudget, parentPath } from './tree-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#owned-metadata-retirement.
/** Reserved disposable containers only; never a live managed payload/backup root. */
export async function retireOwnedDirectory(
  store: OwnedStore,
  relative: string,
  expected: NativeIdentity,
  budget = new WorkingBudget(),
  event = 'disposable-member-retired',
) {
  relativePathSchema.parse(relative);
  if (!relative.startsWith(store.prefix)) throw new Error('Foreign disposable namespace.');
  const suffix = relative.slice(store.prefix.length),
    parts = suffix.split('/');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const disposable =
    parts.length === 2 &&
    ['planning', 'admission', 'mutation', 'worker'].includes(parts[0]) &&
    uuid.test(parts[1]);
  const parentLedger =
    parts.length === 3 && parts[0] === 'parents' && uuid.test(parts[1]) && parts[2] === 'ledger';
  const retired =
    parts.length === 2 &&
    parts[0] === 'retired' &&
    /^[a-f0-9]{64}$/.test(parts[1]) &&
    parts[1] !== store.codec.options.invocation;
  if (!disposable && !parentLedger && !retired)
    throw new Error('Not a reserved disposable container.');
  await store.root.parents(relative);
  async function stat(path: string) {
    store.root.work.stats++;
    const raw = await lstat(store.root.resolve(path), { bigint: true });
    if (!raw.isFile() && !raw.isDirectory())
      throw new Error('Unsupported disposable member; never following links.');
    const native = nativeIdentity(raw);
    if (native[3] !== store.root.binding[3]) throw new Error('Cross-filesystem disposable member.');
    return native;
  }
  async function visit(path: string, identity: NativeIdentity, depth: number) {
    if (depth > 199) throw new Error('Owned retirement depth exceeded.');
    const release = budget.holdRecord(512 + Buffer.byteLength(path));
    try {
      let current = await stat(path);
      if (!sameDirectoryObject(identity, current))
        throw new Error('Disposable directory was replaced.');
      const directory = await opendir(store.root.resolve(path), { bufferSize: 1 });
      try {
        while (true) {
          const entry = await directory.read();
          if (!entry) break;
          const before = await stat(path);
          if (!sameNative(current, before, true)) throw new Error('Disposable parent changed.');
          const child = path + '/' + entry.name,
            native = await stat(child);
          if (native[2] === 'directory') await visit(child, native, depth + 1);
          else {
            const now = await stat(child);
            if (!sameNative(native, now, true)) throw new Error('Disposable file changed.');
            await unlink(store.root.resolve(child));
            store.root.work.unlinks++;
            await store.fail(event);
          }
          const after = await stat(path);
          if (!sameDirectoryObject(before, after))
            throw new Error('Disposable parent replaced during retirement.');
          current = after;
        }
      } finally {
        await directory.close();
      }
      const after = await stat(path);
      if (!sameNative(current, after, true))
        throw new Error('Disposable directory changed before retirement.');
      await store.root.syncDirectory(path);
      await rmdir(store.root.resolve(path));
      store.root.work.directoryRemovals++;
      await store.fail(event);
    } finally {
      release();
    }
  }
  await visit(relative, expected, 0);
  await store.root.syncDirectory(parentPath(relative));
}
