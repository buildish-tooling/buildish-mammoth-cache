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

import { CACHE_METADATA_DIRECTORY, cacheMetadataDirectory } from '../metadata-paths';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, type FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';
import type { z } from 'zod';
import type { nativeIdentitySchema } from './local-schema';
import { relativePathSchema } from './schema';
import { add } from './encoding';

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence
export type NativeIdentity = z.infer<typeof nativeIdentitySchema>;

export type Failpoint = (name: string) => Promise<void>;

export const noFailpoint: Failpoint = async () => {};
export interface NativeWork {
  nativeWalks: number;
  nativeListings: number;
  metadataRowsRead: number;
  metadataRowsWritten: number;
  metadataValidations: number;
  metadataWriteCalls: number;
  indexBuilds: number;
  scratchReadCalls: number;
  scratchWriteCalls: number;
  scratchDecoderAllocations: number;
  scratchRowReuses: number;
  evidenceMemberVisits: number;
  cleanupListings: number;
  cleanupEntries: number;
  cleanupFiles: number;
  cleanupDirectories: number;
  bodyHashCalls: number;
  bodyHashBytes: number;
  bodyHashStreams: number;
  metadataBatches: number;

  directoryCreations: number;
  modeChanges: number;
  controlWriteCalls: number;
  stats: number;
  opens: number;
  readBytes: number;
  writeBytes: number;
  scratchReadBytes: number;
  scratchWriteBytes: number;
  scratchLogicalWriteBytes: number;
  renames: number;
  unlinks: number;
  directoryRemovals: number;
}

export const nativeWork = (): NativeWork => ({
  nativeWalks: 0,
  nativeListings: 0,
  metadataRowsRead: 0,
  metadataRowsWritten: 0,
  metadataValidations: 0,
  metadataWriteCalls: 0,
  indexBuilds: 0,
  scratchReadCalls: 0,
  scratchWriteCalls: 0,
  scratchDecoderAllocations: 0,
  scratchRowReuses: 0,
  evidenceMemberVisits: 0,
  cleanupListings: 0,
  cleanupEntries: 0,
  cleanupFiles: 0,
  cleanupDirectories: 0,
  bodyHashCalls: 0,
  bodyHashBytes: 0,
  bodyHashStreams: 0,
  metadataBatches: 0,

  directoryCreations: 0,
  modeChanges: 0,
  controlWriteCalls: 0,
  stats: 0,
  opens: 0,
  readBytes: 0,
  writeBytes: 0,
  scratchReadBytes: 0,
  scratchWriteBytes: 0,
  scratchLogicalWriteBytes: 0,
  renames: 0,
  unlinks: 0,
  directoryRemovals: 0,
});
// Protocol: docs/dev/native-base-protocol.md#native-timestamp-materialization.
// Fractional seconds can round below an exact ms boundary. Choose its interior;
// callers must verify the actual fstat bucket (not a floating-point multiply-back).
export function portableMtimeSeconds(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error('Invalid portable file timestamp.');
  }
  const fractional = ms % 1000;
  return (ms - fractional) / 1000 + (fractional === 0 ? 0 : (fractional + 0.5) / 1000);
}
export function nativeIds(stat: Pick<BigIntStats, 'dev' | 'ino'>): readonly [string, string] {
  if (stat.ino === 0n) {
    throw new Error('Unsupported native object identity/type.');
  }
  return [String(stat.dev), String(stat.ino)];
}
export function nativeIdentity(stat: BigIntStats): NativeIdentity {
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error('Unsupported native object identity/type.');
  }
  const [device, fileId] = nativeIds(stat);
  // Node may substitute ctime for birthtime on Unix. Use birth identity only on
  // Windows, where libuv supplies the native creation timestamp.
  return [
    'native',
    1,
    stat.isFile() ? 'file' : 'directory',
    device,
    fileId,
    String(stat.size),
    Number(stat.mode),
    String(stat.atimeNs),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    process.platform === 'win32' ? String(stat.birthtimeNs) : null,
  ];
}
export function sameNative(a: NativeIdentity, b: NativeIdentity, ownRead = false): boolean {
  return a.every((v, i) => (i === 7 && ownRead) || v === b[i]);
}
/** Only the observed root rename may explain these platform-specific time changes. */
export function sameRename(a: NativeIdentity, b: NativeIdentity): boolean {
  return a.every(
    (value, index) =>
      index === 7 ||
      index === 9 ||
      (index === 10 && process.platform === 'win32') ||
      value === b[index],
  );
}
export function sameObject(a: NativeIdentity, b: NativeIdentity): boolean {
  return a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[10] === b[10];
}
export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}
function nativeRelative(relative: string): string {
  relativePathSchema.parse(relative);
  if (
    process.platform === 'win32' &&
    relative
      .split('/')
      .some(
        (p) =>
          /[<>:"|?*]/.test(p) ||
          hasControl(p) ||
          /[ .]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  ) {
    throw new Error('Unrepresentable Windows path component.');
  }
  return relative;
}
export class NativeRoot {
  private metadataIdentity: NativeIdentity | null = null;
  private projection:
    { logical: string; physical: string; useMerged?: (path: string) => boolean } | undefined;
  mountedBinding: NativeIdentity | undefined;

  private constructor(
    readonly path: string,
    readonly binding: NativeIdentity,
    readonly work: NativeWork,
    private readonly metadataDirectory: string,
  ) {}

  static async bind(
    root: string,
    work = nativeWork(),
    overlay?: { readonly original: NativeIdentity; readonly mounted: NativeIdentity },
  ): Promise<NativeRoot> {
    const canonical = await realpath(root),
      stat = nativeIdentity(await lstat(canonical, { bigint: true }));
    work.stats++;
    if (stat[2] !== 'directory') {
      throw new Error('Managed root is not a directory.');
    }
    if (nodePath.dirname(canonical) === canonical) {
      throw new Error('Mammoth requires a managed home below the filesystem root.');
    }
    const original = overlay?.original ?? stat;
    const native = new NativeRoot(canonical, original, work, cacheMetadataDirectory(canonical));
    if (sameObject(original, stat)) {
      if (original[6] !== stat[6]) {
        throw new Error('Managed home mode changed.');
      }
    } else {
      if (!overlay || !sameObject(overlay.mounted, stat) || overlay.mounted[6] !== stat[6]) {
        throw new Error('Mounted home binding changed.');
      }
      native.mountedBinding = overlay.mounted;
    }
    native.metadataIdentity = await native.readMetadataIdentity();
    return native;
  }

  get externalMetadataBinding(): [string, NativeIdentity] | null {
    return this.metadataIdentity ? [this.metadataDirectory, this.metadataIdentity] : null;
  }

  private async readMetadataIdentity(): Promise<NativeIdentity | null> {
    let raw: BigIntStats;
    try {
      this.work.stats++;
      raw = await lstat(this.metadataDirectory, { bigint: true });
    } catch (error) {
      if (missing(error)) {
        return null;
      }
      throw error;
    }
    const identity = nativeIdentity(raw);
    const uid = process.getuid?.();
    if (
      identity[2] !== 'directory' ||
      (uid !== undefined && (Number(raw.uid) !== uid || (raw.mode & 0o022n) !== 0n))
    ) {
      throw new Error('Unsafe external Mammoth control directory.');
    }
    this.checkMetadataDevice(identity);
    return identity;
  }

  private checkMetadataDevice(identity: NativeIdentity): void {
    if (identity[3] !== this.binding[3]) {
      throw new Error('Cross-filesystem Mammoth control or staging.');
    }
  }

  async createMetadataDirectory(): Promise<void> {
    if (this.metadataIdentity) {
      throw new Error('External Mammoth control directory is already bound.');
    }
    await mkdir(this.metadataDirectory, { mode: 0o700 });
    this.metadataIdentity = await this.readMetadataIdentity();
    if (!this.metadataIdentity) {
      throw new Error('External Mammoth control directory disappeared.');
    }
  }

  private checkMetadataPath(relative: string, identity: NativeIdentity): void {
    if (relative === CACHE_METADATA_DIRECTORY) {
      if (!this.metadataIdentity || !sameObject(this.metadataIdentity, identity)) {
        throw new Error('External Mammoth control directory changed.');
      }
    } else if (relative.startsWith(CACHE_METADATA_DIRECTORY + '/')) {
      this.checkMetadataDevice(identity);
    }
  }

  resolve(relative: string): string {
    nativeRelative(relative);
    const parts = relative.split('/');
    if (parts[0] === CACHE_METADATA_DIRECTORY) {
      return nodePath.join(this.metadataDirectory, ...parts.slice(1));
    }
    const projection = this.projection;
    if (projection && !projection.useMerged?.(relative)) {
      if (relative === projection.logical) {
        return projection.physical;
      }
      if (projection.logical === '') {
        return nodePath.join(projection.physical, relative);
      }
      if (relative.startsWith(projection.logical + '/')) {
        return nodePath.join(projection.physical, relative.slice(projection.logical.length + 1));
      }
    }
    return nodePath.join(this.path, ...parts);
  }

  expectedDevice(relative: string): string {
    if (
      relative !== CACHE_METADATA_DIRECTORY &&
      !relative.startsWith(CACHE_METADATA_DIRECTORY + '/') &&
      this.mountedBinding &&
      (!this.projection || this.projection.useMerged?.(relative))
    ) {
      return this.mountedBinding[3];
    }
    return this.binding[3];
  }

  /** Redirect one logical subtree for the original, quiescent capture and replay. */
  project(logical: string, ownedSource: string, useMerged?: (path: string) => boolean): () => void {
    if (this.projection || !ownedSource.startsWith(CACHE_METADATA_DIRECTORY + '/')) {
      throw new Error('Invalid projected observation source.');
    }
    nativeRelative(logical);
    this.projection = { logical, physical: this.resolve(ownedSource), useMerged };
    return () => {
      this.projection = undefined;
    };
  }

  async verifyRoot(checkMode = false): Promise<void> {
    this.work.stats++;
    const current = nativeIdentity(await lstat(this.path, { bigint: true }));
    const expected = this.mountedBinding ?? this.binding;
    if (
      !sameObject(expected, current) ||
      ((checkMode || this.mountedBinding) && expected[6] !== current[6])
    ) {
      throw new Error(checkMode ? 'Managed root binding changed.' : 'Managed root was replaced.');
    }
  }

  /** Uncached boundary check; streaming phases use their bounded ancestor traversal. */
  async parents(relative: string): Promise<void> {
    nativeRelative(relative);
    await this.verifyRoot();
    const parts = relative.split('/').slice(0, -1);
    let current = '';
    // Payload depth is checked by stream/tree grammars; owned native paths also
    // include the invocation/object prefix outside that logical tree.
    if (parts.length > (parts[0] === CACHE_METADATA_DIRECTORY ? 199 : 99)) {
      throw new Error('Native path depth exceeded.');
    }
    for (const part of parts) {
      if (!part) {
        continue;
      }
      current = current ? current + '/' + part : part;
      this.work.stats++;
      const stat = nativeIdentity(await lstat(this.resolve(current), { bigint: true }));
      this.checkMetadataPath(current, stat);
      if (stat[2] !== 'directory') {
        throw new Error('Unsafe native parent.');
      }
    }
  }

  async stat(relative: string): Promise<NativeIdentity | null> {
    try {
      await this.parents(relative);
      this.work.stats++;
      const identity = nativeIdentity(await lstat(this.resolve(relative), { bigint: true }));
      this.checkMetadataPath(relative, identity);
      return identity;
    } catch (error) {
      if (missing(error)) {
        return null;
      }
      throw error;
    }
  }

  async openRead(
    relative: string,
    expected?: NativeIdentity,
  ): Promise<{ handle: FileHandle; identity: NativeIdentity }> {
    const before = await this.stat(relative);
    if (!before || before[2] !== 'file' || (expected && !sameNative(before, expected, true))) {
      throw new Error('Native source missing or changed.');
    }
    this.work.opens++;
    const handle = await open(
      this.resolve(relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      this.work.stats++;
      const identity = nativeIdentity(await handle.stat({ bigint: true }));
      if (!sameNative(before, identity, true)) {
        throw new Error('Native file changed while opening.');
      }
      return { handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async *read(
    relative: string,
    expected?: NativeIdentity,
    accepted?: (native: NativeIdentity) => void,
  ): AsyncGenerator<Buffer> {
    const { handle, identity } = await this.openRead(relative, expected);
    try {
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
      })) {
        if (!Buffer.isBuffer(chunk)) {
          throw new Error('Native read returned a non-Buffer chunk.');
        }
        this.work.readBytes = add(this.work.readBytes, chunk.length);
        yield chunk;
      }
      this.work.stats++;
      const after = nativeIdentity(await handle.stat({ bigint: true }));
      if (!sameNative(identity, after, true)) {
        throw new Error('Native file changed during read.');
      }
      const named = await this.stat(relative);
      if (!named || !sameNative(after, named, true)) {
        throw new Error('Native source name changed.');
      }
      accepted?.(after);
    } finally {
      await handle.close();
    }
  }

  async renameAbsent(
    source: string,
    target: string,
    expected: NativeIdentity,
  ): Promise<NativeIdentity> {
    const before = await this.stat(source);
    if (!before || !sameNative(before, expected, true)) {
      throw new Error('Rename source changed.');
    }
    if (await this.stat(target)) {
      throw new Error('Unexpected rename destination.');
    }
    await rename(this.resolve(source), this.resolve(target));
    this.work.renames++;
    const after = await this.stat(target);
    if (!after || !sameRename(before, after)) {
      throw new Error('Rename identity changed.', { cause: { before, after } });
    }
    return after;
  }
}

/** A missing managed home must not hide an earlier external owner. */
export async function assertNoDetachedMetadata(root: string): Promise<void> {
  const absolute = nodePath.resolve(root);
  let parent: string;
  try {
    parent = await realpath(nodePath.dirname(absolute));
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  const managedRoot = nodePath.join(parent, nodePath.basename(absolute));
  try {
    await lstat(cacheMetadataDirectory(managedRoot));
  } catch (error) {
    if (missing(error)) {
      return;
    }
    throw error;
  }
  throw new Error('External Mammoth control directory exists for a missing managed home.');
}
