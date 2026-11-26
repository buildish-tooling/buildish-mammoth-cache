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

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, opendir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { pathSchema } from './schema';
import { z } from 'zod';
import { nativeIdentitySchema, ownedPathSchema } from './local-schema';
import {
  sameObject,
  sameNative,
  sameRename,
  missing,
  nativeIdentity,
  type NativeIdentity,
} from './native';
import type { OwnedStore } from './owned-store';
import type { OverlayMountDriver, OverlayMountInfo } from './overlay-mount';
import { cacheInvocationPrefix } from '../metadata-paths';
import { retireOwnedDirectory } from './owned-retirement';
import type { WalkOptions } from './native-walk';
import type { ResolvedModel } from './model';

const dirIdentity = nativeIdentitySchema.refine((n) => n[2] === 'directory');
const mountNamespace = z.string().regex(/^mnt:\[\d+\]$/u);
export function overlaySchema(invocation: string) {
  const prefix = cacheInvocationPrefix(invocation) + 'overlay/';
  return z.tuple([
    z.literal('overlay'),
    z.literal(1),
    ownedPathSchema(invocation).refine(
      (value) =>
        value.startsWith(prefix) &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.slice(prefix.length)),
    ),
    dirIdentity,
    dirIdentity,
    dirIdentity,
    dirIdentity,
    dirIdentity,
    mountNamespace,
    z.string().regex(/^\d+$/u),
    pathSchema,
    dirIdentity,
  ]);
}
export type Overlay = z.infer<ReturnType<typeof overlaySchema>>;

export interface OverlayCapture {
  useMerged(path: string): boolean;
  extraDirectories?: WalkOptions['extraDirectories'];
  listDirectory?: WalkOptions['listDirectory'];
  omitEmptyDirectory?(path: string): boolean;
  dispose?(): void;
}

export const withinOverlay = (target: string, relative: string): boolean =>
  target === '' || relative === target || relative.startsWith(target + '/');

export function publisherOverlayAllowed(
  model: ResolvedModel,
  timestampGc: boolean,
  cleanupEnabled: boolean,
): boolean {
  return !timestampGc && (!cleanupEnabled || !model.partitions.some((p) => p[7]?.length));
}

/** A coarse absence proof. Any possible managed child requires ordinary capture. */
export async function hasPotentialOverlayChanges(
  store: OwnedStore,
  physical: string,
  logical: string,
  options: Pick<WalkOptions, 'maxDirectoryEntries' | 'signal'>,
  skip?: string,
): Promise<boolean> {
  const max = options.maxDirectoryEntries ?? 100000;
  let scope = store.codec.options.model.admissionScope();
  if (logical) {
    const targetScope = scope.child(logical);
    if (!targetScope || logical.includes('/')) {
      return true;
    }
    scope = targetScope;
  }
  store.root.work.nativeListings++;
  let entries = 0;
  for await (const entry of await opendir(physical, { bufferSize: 32 })) {
    options.signal?.throwIfAborted();
    if (++entries > max) {
      return true;
    }
    const relative = logical ? logical + '/' + entry.name : entry.name;
    if (relative !== skip && scope.child(relative)) {
      return true;
    }
  }
  return false;
}

async function verifyDirectory(store: OwnedStore, relative: string, expected: NativeIdentity) {
  const actual = await store.root.stat(relative);
  if (!actual || !sameObject(expected, actual) || expected[6] !== actual[6]) {
    throw new Error('OverlayFS backing directory changed: ' + store.root.resolve(relative));
  }
  return actual;
}

async function verifyBacking(store: OwnedStore, overlay: Overlay) {
  const [, , root, owner, , lower, upper, work] = overlaySchema(
    store.codec.options.invocation,
  ).parse(overlay);
  await verifyDirectory(store, root, owner);
  const liveLower = await verifyDirectory(store, root + '/lower', lower);
  if (overlay[10] === '' && !sameObject(store.root.binding, liveLower)) {
    throw new Error('OverlayFS lower no longer holds the managed home.');
  }
  await verifyDirectory(store, root + '/upper', upper);
  await verifyDirectory(store, root + '/work', work);
}

function checkMountBacking(
  store: OwnedStore,
  root: string,
  target: string,
  mount: OverlayMountInfo | null,
) {
  if (
    !mount ||
    mount.filesystem !== 'overlay' ||
    mount.root !== '/' ||
    !['lower', 'upper', 'work'].every((p) =>
      mount.options.includes(p + 'dir=' + store.root.resolve(root + '/' + p)),
    )
  ) {
    throw new Error('Unexpected OverlayFS backing paths at ' + target);
  }
  return mount;
}

function checkMountContract(
  store: OwnedStore,
  root: string,
  target: string,
  info: OverlayMountInfo | null,
) {
  const mount = checkMountBacking(store, root, target, info);
  if (
    !['nosuid', 'nodev', 'userxattr', 'redirect_dir=nofollow', 'uuid=off'].every((option) =>
      mount.options.includes(option),
    ) ||
    mount.options.some(
      (option) =>
        /^(?:index|metacopy)=(?!off$)/u.test(option) ||
        (option.startsWith('fsync=') && option !== 'fsync=auto') ||
        option === 'volatile',
    )
  ) {
    throw new Error('Unexpected OverlayFS backing contract at ' + target);
  }
  return mount;
}

export async function verifyOverlay(
  store: OwnedStore,
  overlay: Overlay,
  driver: OverlayMountDriver,
) {
  await verifyBacking(store, overlay);
  const target = path.join(store.root.path, overlay[10]);
  const mount = checkMountContract(
    store,
    overlay[2],
    target,
    await driver.inspect(target, store.root.resolve(overlay[2])),
  );
  if (mount.namespace !== overlay[8] || mount.id !== overlay[9]) {
    throw new Error('OverlayFS mount identity changed at ' + target);
  }
  if (overlay[10] === '') {
    const mounted = store.root.mountedBinding;
    if (
      !mounted ||
      !overlay[11] ||
      !sameObject(mounted, overlay[11]) ||
      mounted[6] !== overlay[11][6]
    ) {
      throw new Error('OverlayFS mounted home binding changed.');
    }
    await store.root.verifyRoot();
  } else {
    store.root.work.stats++;
    const mounted = nativeIdentity(await lstat(target, { bigint: true }));
    if (!sameObject(mounted, overlay[11]) || mounted[6] !== overlay[11][6]) {
      throw new Error('OverlayFS mounted directory binding changed.');
    }
  }
}

async function retireBacking(
  store: OwnedStore,
  root: string,
  owner: NativeIdentity,
  driver: OverlayMountDriver,
) {
  // OverlayFS creates its private work subdirectory without owner access.
  const privateWork = store.root.resolve(root + '/work/work');
  try {
    const owned = await lstat(privateWork, { bigint: true });
    if (!owned.isDirectory() || String(owned.dev) !== store.root.binding[3]) {
      throw new Error('Unsafe OverlayFS private work directory.');
    }
    try {
      // rmdir only needs write access to the owned parent, even for a root-owned private dir.
      await rmdir(privateWork);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        throw error;
      }
      const uid = process.getuid?.();
      if (Number(owned.uid) !== uid) {
        if (uid === undefined || owned.uid !== 0n || !driver.claimPrivateWork) {
          throw error;
        }
        await driver.claimPrivateWork(privateWork, uid);
        const claimed = await lstat(privateWork, { bigint: true });
        if (
          !claimed.isDirectory() ||
          claimed.ino !== owned.ino ||
          claimed.dev !== owned.dev ||
          Number(claimed.uid) !== uid
        ) {
          throw new Error('OverlayFS private work directory changed during retirement.', {
            cause: error,
          });
        }
      }
      await chmod(privateWork, 0o700);
    }
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  await retireOwnedDirectory(store, root, owner);
}

/** Called only after quiescence, or while prepare still has exclusive access. */
export async function retireOverlay(
  store: OwnedStore,
  overlay: Overlay,
  driver: OverlayMountDriver,
) {
  await verifyOverlay(store, overlay, driver);
  const target = path.join(store.root.path, overlay[10]);
  await driver.unmount(target);
  if (await driver.inspect(target, store.root.resolve(overlay[2]))) {
    throw new Error('OverlayFS mount still present at ' + target);
  }
  await restoreLower(store, overlay[10], overlay[2], overlay[3], overlay[4], overlay[5], driver);
}

/** Only the mount transition may temporarily leave the managed home path absent. */
async function moveHome(
  store: OwnedStore,
  source: string,
  target: string,
  expected: NativeIdentity,
) {
  const before = nativeIdentity(await lstat(source, { bigint: true }));
  store.root.work.stats++;
  if (!sameNative(before, expected, true)) {
    throw new Error('OverlayFS home move source changed.');
  }
  try {
    store.root.work.stats++;
    await lstat(target);
    throw new Error('Unexpected OverlayFS home move destination.');
  } catch (error) {
    if (!missing(error)) {
      throw error;
    }
  }
  await rename(source, target);
  store.root.work.renames++;
  store.root.work.stats++;
  const after = nativeIdentity(await lstat(target, { bigint: true }));
  if (!sameRename(before, after)) {
    throw new Error('OverlayFS home move identity changed.');
  }
  return after;
}

async function restoreLower(
  store: OwnedStore,
  relative: string,
  root: string,
  owner: NativeIdentity,
  placeholder: NativeIdentity,
  lower: NativeIdentity,
  driver: OverlayMountDriver,
) {
  if (relative === '') {
    store.root.mountedBinding = placeholder;
  }
  await verifyDirectory(store, root, owner);
  await verifyDirectory(store, relative, placeholder);
  const actual = await verifyDirectory(store, root + '/lower', lower);
  const target = store.root.resolve(relative);
  await rmdir(target);
  if (relative === '') {
    await moveHome(store, store.root.resolve(root + '/lower'), target, actual);
    store.root.mountedBinding = undefined;
  } else {
    await store.root.renameAbsent(root + '/lower', relative, actual);
  }
  await retireBacking(store, root, owner, driver);
}

export async function activateOverlay(
  store: OwnedStore,
  relative: string,
  expected: NativeIdentity,
  driver: OverlayMountDriver,
): Promise<Overlay | undefined> {
  pathSchema.parse(relative);
  const live = await store.root.stat(relative);
  const target = store.root.resolve(relative);
  if (
    !live ||
    live[3] !== store.root.binding[3] ||
    !sameObject(live, expected) ||
    live[6] !== expected[6]
  ) {
    return undefined;
  }
  store.root.work.stats++;
  const raw = await lstat(target, { bigint: true });
  if (Number(raw.uid) !== process.getuid?.() || Number(raw.gid) !== process.getgid?.()) {
    return undefined;
  }
  try {
    if (await driver.inspect(target)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const root = store.prefix + 'overlay/' + randomUUID();
  await store.makeParents(root + '/upper/pending');
  await store.makeParents(root + '/work/pending');
  await chmod(store.root.resolve(root + '/upper'), live[6]);
  const owner = (await store.root.stat(root))!,
    upper = (await store.root.stat(root + '/upper'))!,
    work = (await store.root.stat(root + '/work'))!;
  const lowerPath = store.root.resolve(root + '/lower');
  const lower =
    relative === ''
      ? await moveHome(store, target, lowerPath, live)
      : await store.root.renameAbsent(relative, root + '/lower', live);
  let placeholder: NativeIdentity;
  try {
    await mkdir(target);
    if (relative === '') {
      store.root.work.stats++;
      placeholder = nativeIdentity(await lstat(target, { bigint: true }));
      store.root.mountedBinding = placeholder;
    } else {
      placeholder = (await store.root.stat(relative))!;
    }
  } catch (error) {
    if (relative === '') {
      await moveHome(store, lowerPath, target, lower);
      store.root.mountedBinding = undefined;
    } else {
      await store.root.renameAbsent(root + '/lower', relative, lower);
    }
    await retireBacking(store, root, owner, driver);
    throw error;
  }
  const backing = store.root.resolve(root);
  try {
    if (await driver.inspect(target, backing)) {
      throw new Error('Unexpected mount at ' + target);
    }
    await driver.mount({
      target,
      lower: store.root.resolve(root + '/lower'),
      upper: store.root.resolve(root + '/upper'),
      work: store.root.resolve(root + '/work'),
    });
    const info = checkMountContract(store, root, target, await driver.inspect(target, backing));
    store.root.work.stats++;
    const mountedIdentity = nativeIdentity(await lstat(target, { bigint: true }));
    if (relative === '') {
      store.root.mountedBinding = mountedIdentity;
    }
    const mounted = overlaySchema(store.codec.options.invocation).parse([
      'overlay',
      1,
      root,
      owner,
      placeholder,
      lower,
      upper,
      work,
      info.namespace,
      info.id,
      relative,
      mountedIdentity,
    ]);
    const directory = await opendir(target);
    try {
      await directory.read();
    } finally {
      await directory.close();
    }
    const name = '.mammoth.overlay-probe-' + randomUUID();
    await writeFile(path.join(target, name), '', { flag: 'wx', mode: 0o600 });
    if (!(await store.root.stat(root + '/upper/' + name))) {
      throw new Error('OverlayFS write did not reach its upper layer.');
    }
    await unlink(path.join(target, name));
    await verifyOverlay(store, mounted, driver);
    return mounted;
  } catch (error) {
    try {
      const active = await driver.inspect(target, backing);
      if (active) {
        // The unique private paths identify our mount even if the kernel reported unqualified options.
        checkMountBacking(store, root, target, active);
        await driver.unmount(target);
        if (await driver.inspect(target, backing)) {
          throw new Error('OverlayFS mount still present at ' + target, { cause: error });
        }
      }
      await restoreLower(store, relative, root, owner, placeholder, lower, driver);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'OverlayFS state retained at ' + store.root.resolve(root),
        { cause: cleanup },
      );
    }
    return undefined;
  }
}

/** Project only upper content into the existing logical worker observation and replay. */
export function projectOverlay(
  store: OwnedStore,
  overlay: Overlay,
  useMerged?: (path: string) => boolean,
): () => void {
  return store.root.project(overlay[10], overlay[2] + '/upper', useMerged, overlay[11][3]);
}

export async function isOverlayWhiteout(
  store: OwnedStore,
  relative: string,
  raw: BigIntStats,
): Promise<boolean> {
  if (!(raw.isFile() && raw.size === 0n) && !(raw.isCharacterDevice() && raw.rdev === 0n)) {
    return false;
  }
  try {
    store.root.work.stats++;
    await lstat(path.join(store.root.path, relative));
  } catch (error) {
    if (missing(error)) {
      return true;
    }
    throw error;
  }
  if (!raw.isFile()) {
    throw new Error('OverlayFS whiteout is visible through the mount: ' + relative);
  }
  return false;
}
