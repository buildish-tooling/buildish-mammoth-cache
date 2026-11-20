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
import { constants, type Stats } from 'node:fs';
import { open, lstat, mkdir, rename, rm, rmdir, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readMetadata, writeMetadata, metadataPath } from './metadata-io';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import { hashStableFileSha256, isMissingPathError } from '../util/fs';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import { canonicalTimestampMs } from '../util/timestamps';

export function guardedPath(root: string, relative: string): string {
  validateNormalizedRelativePosixPath(relative, 'Managed path', 'root');
  return path.join(root, ...relative.split('/'));
}
/** Positive directory evidence belongs to one stable phase, never to a retry. */
export class DirectoryValidationBatch {
  private readonly validated = new Set<string>();
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  invalidate(relative = ''): void {
    const name = relative === '.' ? '' : relative;
    if (name) guardedPath(this.root, name);
    for (const entry of this.validated)
      if (!name || entry === name || entry.startsWith(name + '/')) this.validated.delete(entry);
  }
  async verify(relative: string, create = false): Promise<void> {
    if (relative !== '.' && relative !== '') guardedPath(this.root, relative);
    const parts = relative === '.' || relative === '' ? [] : relative.split('/');
    let name = '';
    for (const part of [null, ...parts]) {
      if (part !== null) name = name ? name + '/' + part : part;
      if (this.validated.has(name)) continue;
      const directory = name ? guardedPath(this.root, name) : this.root;
      let stat = await lstat(directory).catch((error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      });
      if (!stat) {
        if (!create) return;
        await mkdir(directory, { recursive: part === null }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
        stat = await lstat(directory);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unsafe directory: ${directory}`);
      this.validated.add(name);
    }
  }
}
export async function verifyParents(
  root: string,
  relative: string,
  create = false,
  batch?: DirectoryValidationBatch,
): Promise<void> {
  if (batch && batch.root !== path.resolve(root))
    throw new Error('Directory validation root mismatch.');
  await (batch ?? new DirectoryValidationBatch(root)).verify(relative, create);
}
export async function regularStat(file: string): Promise<Stats | null> {
  const st = await lstat(file).catch((e: unknown) => {
    if (isMissingPathError(e)) return null;
    throw e;
  });
  if (st && (!st.isFile() || st.isSymbolicLink()))
    throw new Error(`Expected regular non-symlink file: ${file}`);
  return st;
}
/** Read a selected source once, hashing the same bytes written to the exclusive staging file. */
async function copyFileContents(
  root: string,
  relative: string,
  destination: string,
  expected: { size: number; mode?: number; mtimeMs?: number; contentSha256?: string },
  native: FileIdentity | undefined,
  integrity: PayloadIntegrity,
  directories?: DirectoryValidationBatch,
  destinationHandle?: FileHandle,
): Promise<string | undefined> {
  await verifyParents(root, path.posix.dirname(relative), false, directories);
  const source = guardedPath(root, relative),
    before = await regularStat(source);
  if (!before) throw new Error(`Payload source missing: ${relative}`);
  if (native && !sameFileIdentity(native, fileIdentity(before), true))
    throw new Error(`Frozen source changed: ${relative}`);
  if (
    before.size !== expected.size ||
    (expected.mode !== undefined && (before.mode & 0o777) !== expected.mode) ||
    (expected.mtimeMs !== undefined &&
      canonicalTimestampMs(before.mtimeMs) !== canonicalTimestampMs(expected.mtimeMs))
  )
    throw new Error(`Payload metadata changed: ${relative}`);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(await input.stat()), true))
      throw new Error('Payload source replaced during open.');
    const output = destinationHandle ?? (await open(destination, 'wx', 0o600));
    const hash = integrity === 'verified' ? createHash('sha256') : undefined;
    let count = 0;
    try {
      for await (const data of input.createReadStream({ autoClose: false })) {
        const chunk = Buffer.from(data);
        count += chunk.length;
        if (count > expected.size) throw new Error('Payload grew during copy.');
        hash?.update(chunk);
        await output.writeFile(chunk);
      }
    } finally {
      if (!destinationHandle) await output.close();
    }
    if (
      count !== expected.size ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(await input.stat()), true)
    )
      throw new Error('Payload changed during copy.');
    const after = await regularStat(source);
    if (!after || !sameFileIdentity(fileIdentity(before), fileIdentity(after), true))
      throw new Error('Payload path changed during copy.');
    const digest = hash?.digest('hex');
    if (integrity === 'verified' && expected.contentSha256 && digest !== expected.contentSha256)
      throw new Error('Payload SHA-256 verification failed.');
    return digest;
  } finally {
    await input.close();
  }
}

/** Base restore trusts producer bytes; every other caller verifies content by default. */
export type PayloadIntegrity = 'verified' | 'trusted-base';
export async function copyGuardedFile(
  root: string,
  relative: string,
  destination: string,
  expected: { size: number; mode?: number; mtimeMs?: number; contentSha256?: string },
  native?: FileIdentity,
  directories?: DirectoryValidationBatch,
  destinationHandle?: FileHandle,
): Promise<string> {
  return (await copyFileContents(
    root,
    relative,
    destination,
    expected,
    native,
    'verified',
    directories,
    destinationHandle,
  ))!;
}
export async function copyTrustedBaseFile(
  root: string,
  relative: string,
  destination: string,
  expected: { size: number },
  native?: FileIdentity,
  directories?: DirectoryValidationBatch,
  destinationHandle?: FileHandle,
): Promise<void> {
  await copyFileContents(
    root,
    relative,
    destination,
    expected,
    native,
    'trusted-base',
    directories,
    destinationHandle,
  );
}

/** Hash without materializing another file, bound to the selected native source identity. */
export async function hashGuardedFile(
  root: string,
  relative: string,
  expected: { size: number; contentSha256?: string },
  native?: FileIdentity,
  directories?: DirectoryValidationBatch,
): Promise<string> {
  await verifyParents(root, path.posix.dirname(relative), false, directories);
  const source = guardedPath(root, relative),
    before = await regularStat(source);
  if (
    !before ||
    before.size !== expected.size ||
    (native && !sameFileIdentity(native, fileIdentity(before), true))
  )
    throw new Error(`Payload size/SHA-256 or frozen source changed: ${relative}`);
  const digest = await hashStableFileSha256(source, before),
    after = await regularStat(source);
  if (
    !digest ||
    !after ||
    !sameFileIdentity(fileIdentity(before), fileIdentity(after), true) ||
    (expected.contentSha256 && digest !== expected.contentSha256)
  )
    throw new Error(`Payload size/SHA-256 or source identity changed: ${relative}`);
  return digest;
}
export interface PreparedGuardedMove {
  readonly identity: FileIdentity;
  readonly digest?: string;
}
const preparedMoves = new WeakMap<PreparedGuardedMove, string>();
function moveBinding(
  root: string,
  relative: string,
  expected: { size: number; contentSha256?: string },
  integrity: PayloadIntegrity,
): string {
  return JSON.stringify([
    path.resolve(root),
    relative,
    expected.size,
    expected.contentSha256,
    integrity,
  ]);
}
/** Freeze application-time content verification before the destination mutation batch. */
export async function prepareGuardedMove(
  root: string,
  relative: string,
  expected: { size: number; contentSha256?: string },
  integrity: PayloadIntegrity = 'verified',
  directories?: DirectoryValidationBatch,
): Promise<PreparedGuardedMove> {
  const source = guardedPath(root, relative),
    before = await regularStat(source);
  await verifyParents(root, path.posix.dirname(relative), false, directories);
  if (!before || before.size !== expected.size) throw new Error('Restore source size changed.');
  if (integrity === 'trusted-base') {
    const current = await regularStat(source);
    if (!current || !sameFileIdentity(fileIdentity(before), fileIdentity(current), true))
      throw new Error('Restore source identity changed.');
  }
  const digest =
    integrity === 'verified'
      ? await hashGuardedFile(root, relative, expected, fileIdentity(before), directories)
      : undefined;
  const prepared = Object.freeze({ identity: Object.freeze(fileIdentity(before)), digest });
  preparedMoves.set(prepared, moveBinding(root, relative, expected, integrity));
  return prepared;
}
/** Consume disposable verified restore inputs. Rename normally; copy only across filesystems. */
export async function moveGuardedFile(
  root: string,
  relative: string,
  destination: string,
  expected: { size: number; contentSha256?: string },
  recoveryRoot = path.dirname(destination),
  integrity: PayloadIntegrity = 'verified',
  directories?: DirectoryValidationBatch,
  prepared?: PreparedGuardedMove,
): Promise<{ copied: boolean; identity: FileIdentity }> {
  const selected =
    prepared ?? (await prepareGuardedMove(root, relative, expected, integrity, directories));
  if (preparedMoves.get(selected) !== moveBinding(root, relative, expected, integrity))
    throw new Error('Invalid prepared source binding.');
  await verifyParents(root, path.posix.dirname(relative), false, directories);
  const source = guardedPath(root, relative);
  const before = await regularStat(source);
  if (!before || !sameFileIdentity(selected.identity, fileIdentity(before), true))
    throw new Error('Move source changed after verification.');
  const digest = selected.digest;
  let copied = false;
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copied = true;
    const relativeDestination = path.relative(recoveryRoot, destination).split(path.sep).join('/');
    validateNormalizedRelativePosixPath(relativeDestination, 'Restore destination', 'cache root');
    const parent = path.posix.dirname(relativeDestination);
    const metadataDirectory = (parent === '.' ? '' : parent + '/') + '.mammoth';
    await verifyParents(recoveryRoot, parent);
    const existing = await lstat(guardedPath(recoveryRoot, metadataDirectory)).catch(
      (e: unknown) => {
        if (isMissingPathError(e)) return null;
        throw e;
      },
    );
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error('Unsafe restore fallback metadata directory.', { cause: error });
    const temporaryRelative = metadataDirectory + '/restore-move-' + randomUUID();
    await recoverInterruptedMoves(recoveryRoot);
    await writeMetadata(
      recoveryRoot,
      MOVE_INTENT,
      { temporaryRelative, cleanupDirectory: parent !== '.' && !existing },
      16 * 1024,
    );
    try {
      const temporary = await metadataPath(recoveryRoot, temporaryRelative, true);
      const output = await open(temporary, 'wx', 0o600);
      let written: FileIdentity;
      try {
        await copyFileContents(
          root,
          relative,
          temporary,
          { size: expected.size, contentSha256: digest },
          fileIdentity(before),
          integrity,
          undefined,
          output,
        );
        written = fileIdentity(await output.stat());
      } finally {
        await output.close();
      }
      await verifyParents(recoveryRoot, metadataDirectory);
      const current = await regularStat(temporary);
      if (!current || !sameFileIdentity(written, fileIdentity(current), true))
        throw new Error('Move fallback staging changed.', { cause: error });
      await verifyParents(root, path.posix.dirname(relative));
      const sourceNow = await regularStat(source);
      if (!sourceNow || !sameFileIdentity(selected.identity, fileIdentity(sourceNow), true))
        throw new Error('Move fallback source changed.', { cause: error });
      await rename(temporary, destination);
      await rm(source);
    } finally {
      await recoverInterruptedMoves(recoveryRoot);
    }
  }
  const installed = await regularStat(destination);
  if (!installed) throw new Error('Move destination disappeared.');
  return { copied, identity: fileIdentity(installed) };
}

const MOVE_INTENT = '.mammoth/restore-move-v1.json';
const moveIntentSchema = z
  .object({ temporaryRelative: z.string(), cleanupDirectory: z.boolean() })
  .strict();
/** Discard only recorded reserved fallback scratch before any build/cache observation. */
export async function recoverInterruptedMoves(root: string): Promise<void> {
  const raw = await readMetadata(root, MOVE_INTENT, 16 * 1024);
  if (raw === null) return;
  const intent = moveIntentSchema.parse(JSON.parse(raw));
  validateNormalizedRelativePosixPath(intent.temporaryRelative, 'Restore scratch', 'cache root');
  if (
    !/(?:^|\/)\.mammoth\/restore-move-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
      intent.temporaryRelative,
    )
  )
    throw new Error('Invalid restore move recovery intent.');
  const parent = path.posix.dirname(intent.temporaryRelative);
  if (intent.cleanupDirectory && parent === '.mammoth')
    throw new Error('Cannot remove cache-root metadata.');
  await verifyParents(root, parent);
  await regularStat(guardedPath(root, intent.temporaryRelative));
  await rm(guardedPath(root, intent.temporaryRelative), { force: true });
  if (intent.cleanupDirectory)
    await rmdir(guardedPath(root, parent)).catch((e: unknown) => {
      if (!isMissingPathError(e)) throw e;
    });
  await rm(await metadataPath(root, MOVE_INTENT), { force: true });
}
