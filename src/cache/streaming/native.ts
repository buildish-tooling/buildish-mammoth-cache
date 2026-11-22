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

import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';
import type { nativeIdentitySchema } from './local-schema';
import { relativePathSchema } from './schema';
import { add } from './encoding';

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence
export type NativeIdentity = z.infer<typeof nativeIdentitySchema>;
export type Failpoint = (name: string) => Promise<void>;
export const noFailpoint: Failpoint = async () => {};
export interface NativeWork {
  stats: number;
  opens: number;
  readBytes: number;
  writeBytes: number;
  scratchReadBytes: number;
  scratchWriteBytes: number;
  renames: number;
  fileSyncs: number;
  directorySyncs: number;
  unlinks: number;
  directoryRemovals: number;
}
export const nativeWork = (): NativeWork => ({
  stats: 0,
  opens: 0,
  readBytes: 0,
  writeBytes: 0,
  scratchReadBytes: 0,
  scratchWriteBytes: 0,
  renames: 0,
  fileSyncs: 0,
  directorySyncs: 0,
  unlinks: 0,
  directoryRemovals: 0,
});
// Protocol: docs/dev/native-base-protocol.md#native-timestamp-materialization.
// Fractional seconds can round below an exact ms boundary. Choose its interior;
// callers must verify the actual fstat bucket (not a floating-point multiply-back).
export function portableMtimeSeconds(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid portable file timestamp.');
  const fractional = ms % 1000;
  return (ms - fractional) / 1000 + (fractional === 0 ? 0 : (fractional + 0.5) / 1000);
}
export function nativeIds(stat: Pick<BigIntStats, 'dev' | 'ino'>): readonly [string, string] {
  if (stat.ino === 0n) throw new Error('Unsupported native object identity/type.');
  return [String(stat.dev), String(stat.ino)];
}
export function nativeIdentity(stat: BigIntStats): NativeIdentity {
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Unsupported native object identity/type.');
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
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
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
  )
    throw new Error('Unrepresentable Windows path component.');
  return relative;
}
export class NativeRoot {
  readonly durability =
    process.platform === 'win32' ? 'file-sync-native-replace' : 'file-and-directory-sync';
  private constructor(
    readonly path: string,
    readonly binding: NativeIdentity,
    readonly work: NativeWork,
  ) {}
  static async bind(root: string, work = nativeWork()): Promise<NativeRoot> {
    const canonical = await realpath(root),
      stat = nativeIdentity(await lstat(canonical, { bigint: true }));
    work.stats++;
    if (stat[2] !== 'directory') throw new Error('Managed root is not a directory.');
    return new NativeRoot(canonical, stat, work);
  }
  resolve(relative: string): string {
    nativeRelative(relative);
    return path.join(this.path, ...relative.split('/'));
  }
  async verifyRoot(): Promise<void> {
    this.work.stats++;
    const current = nativeIdentity(await lstat(this.path, { bigint: true }));
    if (!sameObject(this.binding, current)) throw new Error('Managed root was replaced.');
  }
  /** Uncached boundary check; streaming phases use their bounded ancestor traversal. */
  async parents(relative: string): Promise<void> {
    nativeRelative(relative);
    await this.verifyRoot();
    const parts = relative.split('/').slice(0, -1);
    let current = '';
    // Payload depth is checked by stream/tree grammars; owned native paths also
    // include the invocation/object prefix outside that logical tree.
    if (parts.length > (parts[0] === '.mammoth' ? 199 : 99))
      throw new Error('Native path depth exceeded.');
    for (const part of parts) {
      if (!part) continue;
      current = current ? current + '/' + part : part;
      this.work.stats++;
      const stat = nativeIdentity(await lstat(this.resolve(current), { bigint: true }));
      if (stat[2] !== 'directory') throw new Error('Unsafe native parent.');
    }
  }
  async stat(relative: string): Promise<NativeIdentity | null> {
    try {
      await this.parents(relative);
      this.work.stats++;
      return nativeIdentity(await lstat(this.resolve(relative), { bigint: true }));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  async openRead(
    relative: string,
    expected?: NativeIdentity,
  ): Promise<{ handle: FileHandle; identity: NativeIdentity }> {
    const before = await this.stat(relative);
    if (!before || before[2] !== 'file' || (expected && !sameNative(before, expected, true)))
      throw new Error('Native source missing or changed.');
    this.work.opens++;
    const handle = await open(
      this.resolve(relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      this.work.stats++;
      const identity = nativeIdentity(await handle.stat({ bigint: true }));
      if (!sameNative(before, identity, true))
        throw new Error('Native file changed while opening.');
      return { handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async *read(relative: string, expected?: NativeIdentity): AsyncGenerator<Buffer> {
    const { handle, identity } = await this.openRead(relative, expected);
    try {
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
      })) {
        const bytes = Buffer.from(chunk);
        this.work.readBytes = add(this.work.readBytes, bytes.length);
        yield bytes;
      }
      this.work.stats++;
      const after = nativeIdentity(await handle.stat({ bigint: true }));
      if (!sameNative(identity, after, true)) throw new Error('Native file changed during read.');
      const named = await this.stat(relative);
      if (!named || !sameNative(after, named, true)) throw new Error('Native source name changed.');
    } finally {
      await handle.close();
    }
  }
  async hash(relative: string, expected?: NativeIdentity): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of this.read(relative, expected)) hash.update(chunk);
    return hash.digest('hex');
  }
  // Protocol: docs/dev/cache-lifecycle-protocol.md#durable-replacement-and-cursors
  async syncDirectory(relative: string): Promise<boolean> {
    await this.parents(relative ? relative + '/placeholder' : 'placeholder');
    if (process.platform === 'win32') return false; // Explicit documented process-crash profile.
    this.work.opens++;
    const handle = await open(this.resolve(relative), constants.O_RDONLY);
    try {
      await handle.sync();
      this.work.directorySyncs++;
      return true;
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
    if (!before || !sameNative(before, expected, true)) throw new Error('Rename source changed.');
    if (await this.stat(target)) throw new Error('Unexpected rename destination.');
    await rename(this.resolve(source), this.resolve(target));
    this.work.renames++;
    const after = await this.stat(target);
    if (!after || !sameRename(before, after))
      throw new Error('Rename identity changed.', { cause: { before, after } });
    return after;
  }
}
