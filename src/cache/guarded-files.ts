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
import { open, lstat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import { isMissingPathError } from '../util/fs';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import { canonicalTimestampMs } from '../util/timestamps';

export function guardedPath(root: string, relative: string): string {
  validateNormalizedRelativePosixPath(relative, 'Managed path', 'root');
  return path.join(root, ...relative.split('/'));
}
export async function verifyParents(root: string, relative: string, create = false): Promise<void> {
  const parts = relative === '.' || relative === '' ? [] : relative.split('/');
  let directory = path.resolve(root);
  for (const part of [null, ...parts]) {
    if (part !== null) directory = path.join(directory, part);
    const st = await lstat(directory).catch((e: unknown) => {
      if (isMissingPathError(e)) return null;
      throw e;
    });
    if (!st) {
      if (create) await mkdir(directory, { recursive: part === null });
      else return;
    } else if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error(`Unsafe directory: ${directory}`);
  }
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
export async function copyGuardedFile(
  root: string,
  relative: string,
  destination: string,
  expected: { size: number; mode?: number; mtimeMs?: number; contentSha256?: string },
  native?: FileIdentity,
): Promise<string> {
  await verifyParents(root, path.posix.dirname(relative));
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
    const output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let count = 0;
    try {
      for await (const data of input.createReadStream({ autoClose: false })) {
        const chunk = Buffer.from(data);
        count += chunk.length;
        if (count > expected.size) throw new Error('Payload grew during copy.');
        hash.update(chunk);
        await output.writeFile(chunk);
      }
    } finally {
      await output.close();
    }
    if (
      count !== expected.size ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(await input.stat()), true)
    )
      throw new Error('Payload changed during copy.');
    const after = await regularStat(source);
    if (!after || !sameFileIdentity(fileIdentity(before), fileIdentity(after), true))
      throw new Error('Payload path changed during copy.');
    const digest = hash.digest('hex');
    if (expected.contentSha256 && digest !== expected.contentSha256)
      throw new Error('Payload SHA-256 verification failed.');
    return digest;
  } finally {
    await input.close();
  }
}
