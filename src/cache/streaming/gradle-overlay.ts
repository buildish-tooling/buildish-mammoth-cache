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
import { chmod, lstat, mkdir, opendir, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { z } from 'zod';
import { nativeIdentitySchema, ownedPathSchema } from './local-schema';
import { sameObject, missing, type NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';
import type { OverlayMountDriver, OverlayMountInfo } from './overlay-mount';
import type { MetadataBaseRestore } from './metadata-base-restore';
import { gradleDependencySources, GRADLE_ARTIFACTS } from './gradle-layer';
import { ownsLocalSnapshot } from './model';
import { cacheInvocationPrefix } from '../metadata-paths';
import { retireOwnedDirectory } from './owned-retirement';

const dirIdentity = nativeIdentitySchema.refine((n) => n[2] === 'directory');
const mountNamespace = z.string().regex(/^mnt:\[\d+\]$/u);
export function overlaySchema(invocation: string) {
  const prefix = cacheInvocationPrefix(invocation) + 'overlay/';
  return z.tuple([
    z.literal('gradle-overlay'),
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
  ]);
}
export type GradleOverlay = z.infer<ReturnType<typeof overlaySchema>>;

export function isOverlayArtifact(relative: string): boolean {
  return relative === GRADLE_ARTIFACTS || relative.startsWith(GRADLE_ARTIFACTS + '/');
}

export function gradleOverlayCandidate(store: OwnedStore): boolean {
  const options = store.codec.options;
  return (
    options.model.tuple[2] === 'gradle' &&
    options.model.dependencyCacheLayer &&
    options.role === 'distributed-worker' &&
    options.access === 'writable' &&
    options.model.partitions.some((p) => p[6] === 1 && ownsLocalSnapshot(p, options))
  );
}

/** Prove that the ordinary installer can move the exact admitted artifact tree intact. */
export async function overlaySource(
  store: OwnedStore,
  restored: MetadataBaseRestore,
  driver: OverlayMountDriver,
): Promise<NativeIdentity | undefined> {
  if (await store.root.stat(GRADLE_ARTIFACTS)) {
    return undefined;
  }
  const target = path.join(store.root.path, GRADLE_ARTIFACTS);
  try {
    if (await driver.inspect(target)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return (await gradleDependencySources(store, restored))?.[1].native;
}

function targetPath(store: OwnedStore): string {
  return path.join(store.root.path, GRADLE_ARTIFACTS);
}

async function verifyDirectory(store: OwnedStore, relative: string, expected: NativeIdentity) {
  const actual = await store.root.stat(relative);
  if (!actual || !sameObject(expected, actual) || expected[6] !== actual[6]) {
    throw new Error('OverlayFS backing directory changed: ' + store.root.resolve(relative));
  }
  return actual;
}

async function verifyBacking(store: OwnedStore, overlay: GradleOverlay) {
  const [, , root, owner, , lower, upper, work] = overlaySchema(
    store.codec.options.invocation,
  ).parse(overlay);
  await verifyDirectory(store, root, owner);
  await verifyDirectory(store, root + '/lower', lower);
  await verifyDirectory(store, root + '/upper', upper);
  await verifyDirectory(store, root + '/work', work);
}

function checkMountBacking(store: OwnedStore, root: string, mount: OverlayMountInfo | null) {
  if (
    !mount ||
    mount.filesystem !== 'overlay' ||
    mount.root !== '/' ||
    !['lower', 'upper', 'work'].every((p) =>
      mount.options.includes(p + 'dir=' + store.root.resolve(root + '/' + p)),
    )
  ) {
    throw new Error('Unexpected OverlayFS backing paths at ' + targetPath(store));
  }
  return mount;
}

function checkMountContract(store: OwnedStore, root: string, info: OverlayMountInfo | null) {
  const mount = checkMountBacking(store, root, info);
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
    throw new Error('Unexpected OverlayFS backing contract at ' + targetPath(store));
  }
  return mount;
}

export async function verifyGradleOverlay(
  store: OwnedStore,
  overlay: GradleOverlay,
  driver: OverlayMountDriver,
) {
  await verifyBacking(store, overlay);
  const mount = checkMountContract(
    store,
    overlay[2],
    await driver.inspect(targetPath(store), store.root.resolve(overlay[2])),
  );
  if (mount.namespace !== overlay[8] || mount.id !== overlay[9]) {
    throw new Error('OverlayFS mount identity changed at ' + targetPath(store));
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
export async function retireGradleOverlay(
  store: OwnedStore,
  overlay: GradleOverlay,
  driver: OverlayMountDriver,
) {
  await verifyGradleOverlay(store, overlay, driver);
  const target = targetPath(store);
  await driver.unmount(target);
  if (await driver.inspect(target, store.root.resolve(overlay[2]))) {
    throw new Error('OverlayFS mount still present at ' + target);
  }
  await restoreLower(store, overlay[2], overlay[3], overlay[4], overlay[5], driver);
}

async function restoreLower(
  store: OwnedStore,
  root: string,
  owner: NativeIdentity,
  placeholder: NativeIdentity,
  lower: NativeIdentity,
  driver: OverlayMountDriver,
) {
  await verifyDirectory(store, root, owner);
  await verifyDirectory(store, GRADLE_ARTIFACTS, placeholder);
  const actual = await verifyDirectory(store, root + '/lower', lower);
  await rmdir(targetPath(store));
  await store.root.renameAbsent(root + '/lower', GRADLE_ARTIFACTS, actual);
  await retireBacking(store, root, owner, driver);
}

export async function activateGradleOverlay(
  store: OwnedStore,
  expected: NativeIdentity,
  driver: OverlayMountDriver,
): Promise<GradleOverlay | undefined> {
  const live = await store.root.stat(GRADLE_ARTIFACTS);
  const target = targetPath(store);
  if (!live || !sameObject(live, expected) || live[6] !== expected[6]) {
    // Installation merged a destination instead of moving the admitted source.
    return undefined;
  }
  const root = store.prefix + 'overlay/' + randomUUID();
  await store.makeParents(root + '/upper/pending');
  await store.makeParents(root + '/work/pending');
  const owner = (await store.root.stat(root))!,
    upper = (await store.root.stat(root + '/upper'))!,
    work = (await store.root.stat(root + '/work'))!;
  const lower = await store.root.renameAbsent(GRADLE_ARTIFACTS, root + '/lower', live);
  let placeholder: NativeIdentity;
  try {
    await mkdir(target);
    placeholder = (await store.root.stat(GRADLE_ARTIFACTS))!;
  } catch (error) {
    await store.root.renameAbsent(root + '/lower', GRADLE_ARTIFACTS, lower);
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
    const info = checkMountContract(store, root, await driver.inspect(target, backing));
    const mounted = overlaySchema(store.codec.options.invocation).parse([
      'gradle-overlay',
      1,
      root,
      owner,
      placeholder,
      lower,
      upper,
      work,
      info.namespace,
      info.id,
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
    await verifyGradleOverlay(store, mounted, driver);
    return mounted;
  } catch (error) {
    try {
      const active = await driver.inspect(target, backing);
      if (active) {
        // The unique private paths identify our mount even if the kernel reported unqualified options.
        checkMountBacking(store, root, active);
        await driver.unmount(target);
        if (await driver.inspect(target, backing)) {
          throw new Error('OverlayFS mount still present at ' + target, { cause: error });
        }
      }
      await restoreLower(store, root, owner, placeholder, lower, driver);
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
export function projectGradleOverlay(store: OwnedStore, overlay: GradleOverlay): () => void {
  return store.root.project(GRADLE_ARTIFACTS, overlay[2] + '/upper');
}

export async function isOverlayWhiteout(
  store: OwnedStore,
  relative: string,
  raw: BigIntStats,
): Promise<boolean> {
  if (!isOverlayArtifact(relative) || raw.isDirectory() || (raw.isFile() && raw.size !== 0n)) {
    return false;
  }
  if (!raw.isFile() && !(raw.isCharacterDevice() && raw.rdev === 0n)) {
    throw new Error('Unsupported OverlayFS upper entry: ' + relative);
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
