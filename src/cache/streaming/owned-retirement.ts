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

import type { NativeOperationOptions } from './native-operation';
import { lstat, opendir, unlink, rmdir } from 'node:fs/promises';
import { checkPostRootBinding } from './post-admission';
import { nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import type { OwnedStore } from './owned-store';
import { relativePathSchema } from './schema';
import { WorkingBudget } from './tree-state';

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
  if (!relative.startsWith(store.prefix)) {
    throw new Error('Foreign disposable namespace.');
  }
  const suffix = relative.slice(store.prefix.length),
    parts = suffix.split('/');
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const disposable =
    parts.length === 2 &&
    [
      'planning',
      'admission',
      'mutation',
      'worker',
      'base',
      'snapshots',
      'seed',
      'overlay',
    ].includes(parts[0]) &&
    uuid.test(parts[1]);
  const parentLedger =
    parts.length === 3 && parts[0] === 'parents' && uuid.test(parts[1]) && parts[2] === 'ledger';
  const retired =
    parts.length === 2 &&
    parts[0] === 'retired' &&
    /^[a-f0-9]{64}$/.test(parts[1]) &&
    parts[1] !== store.codec.options.invocation;
  if (!disposable && !parentLedger && !retired) {
    throw new Error('Not a reserved disposable container.');
  }
  return retireTree(
    store,
    relative,
    expected,
    budget,
    event,
    undefined,
    disposable && parts[0] === 'overlay' ? relative : undefined,
  );
}
async function retireTree(
  store: OwnedStore,
  relative: string,
  expected: NativeIdentity,
  budget: WorkingBudget,
  event: string,
  check: () => void = () => {},
  overlayRoot?: string,
) {
  check();
  await store.root.parents(relative);
  async function rawStat(path: string) {
    check();
    store.root.work.stats++;
    const raw = await lstat(store.root.resolve(path), { bigint: true });
    if (String(raw.dev) !== store.root.binding[3]) {
      throw new Error('Cross-filesystem disposable member.');
    }
    return raw;
  }
  function identityOf(raw: Awaited<ReturnType<typeof rawStat>>) {
    if (!raw.isFile() && !raw.isDirectory()) {
      throw new Error('Unsupported disposable member; never following links.');
    }
    return nativeIdentity(raw);
  }
  const stat = async (path: string) => identityOf(await rawStat(path));
  async function visit(path: string, identity: NativeIdentity, depth: number) {
    if (depth > 199) {
      throw new Error('Owned retirement depth exceeded.');
    }
    const release = budget.holdRecord(512 + Buffer.byteLength(path));
    try {
      let current = await stat(path);
      if (!sameDirectoryObject(identity, current)) {
        throw new Error('Disposable directory was replaced.');
      }
      check();
      store.root.work.cleanupListings++;
      const directory = await opendir(store.root.resolve(path), { bufferSize: 1 });
      try {
        while (true) {
          check();
          const entry = await directory.read();
          if (!entry) {
            break;
          }
          store.root.work.cleanupEntries++;
          const before = await stat(path);
          if (!sameNative(current, before, true)) {
            throw new Error('Disposable parent changed.');
          }
          const child = path + '/' + entry.name;
          const raw = await rawStat(child);
          if (raw.isDirectory()) {
            await visit(child, identityOf(raw), depth + 1);
          } else {
            const now = await rawStat(child);
            const same =
              overlayRoot &&
              (child.startsWith(overlayRoot + '/upper/') ||
                child.startsWith(overlayRoot + '/work/work/')) &&
              !raw.isFile() &&
              !raw.isDirectory()
                ? // These are private overlay entries after unmount. Unlink by
                  // name without opening whiteouts, links or unmanaged sockets.
                  now.mode === raw.mode &&
                  now.rdev === raw.rdev &&
                  now.ino === raw.ino &&
                  now.ctimeNs === raw.ctimeNs
                : sameNative(identityOf(raw), identityOf(now), true);
            if (!same) {
              throw new Error('Disposable file changed.');
            }
            check();
            await unlink(store.root.resolve(child));
            store.root.work.unlinks++;
            store.root.work.cleanupFiles++;
            await store.fail(event);
          }
          const after = await stat(path);
          if (!sameDirectoryObject(before, after)) {
            throw new Error('Disposable parent replaced during retirement.');
          }
          current = after;
        }
      } finally {
        await directory.close();
      }
      const after = await stat(path);
      if (!sameNative(current, after, true)) {
        throw new Error('Disposable directory changed before retirement.');
      }
      check();
      await rmdir(store.root.resolve(path));
      store.root.work.directoryRemovals++;
      store.root.work.cleanupDirectories++;
      await store.fail(event);
    } finally {
      release();
    }
  }
  await visit(relative, expected, 0);
  check();
}

/** Exact invocation-owned install container, never a live cache/backup tree. */
export async function retireInstallStaging(
  store: OwnedStore,
  installOwner: NativeIdentity,
  options: NativeOperationOptions,
  assertCurrent: () => undefined,
) {
  const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(state[5], 'bindings'),
    );
  const check = () => {
    options.signal?.throwIfAborted();
    if (assertCurrent() !== undefined) {
      throw new Error('Install staging lifetime must be synchronous.');
    }
  };
  const checkRoot = async () => {
    check();
    store.root.work.stats++;
    checkPostRootBinding(
      store,
      bindings,
      nativeIdentity(await lstat(store.root.path, { bigint: true })),
    );
    check();
  };
  await checkRoot();
  await store.assertNoIntents();
  const parent = store.prefix + 'install',
    expected = installOwner;
  const checkParent = async () => {
    check();
    const current = await store.root.stat(parent);
    if (
      !current ||
      !sameObject(current, expected) ||
      current[6] !== expected[6] ||
      current[3] !== store.root.binding[3]
    ) {
      throw new Error('Frozen install container replaced or changed mode/device.');
    }
    check();
  };
  await checkParent();
  const allowed = new Set(store.codec.options.model.partitions.map((p) => p[0]));
  for await (const entry of await opendir(store.root.resolve(parent))) {
    check();
    if (!allowed.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Unknown install staging child; preserved.');
    }
    await checkParent();
    const child = parent + '/' + entry.name,
      native = await store.root.stat(child);
    if (!native || native[2] !== 'directory' || native[3] !== store.root.binding[3]) {
      throw new Error('Install staging child replaced.');
    }
    await retireTree(store, child, native, options.budget, 'prepare-install-member-retired', check);
  }
  await checkParent();
  const directory = await opendir(store.root.resolve(parent));
  try {
    if (await directory.read()) {
      throw new Error('Install staging disposal incomplete.');
    }
  } finally {
    await directory.close();
  }
  await checkRoot();
  check();
}
