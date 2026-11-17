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
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isMissingPathError } from '../util/fs';
import { validateNormalizedRelativePosixPath } from '../util/paths';
import { isCacheMetadataPath } from './metadata-paths';

/** Metadata never follows links and never shares a namespace with transported artifacts. */
export async function metadataPath(
  root: string,
  relative: string,
  create = false,
): Promise<string> {
  validateNormalizedRelativePosixPath(relative, 'Metadata path', 'cache root');
  if (!isCacheMetadataPath(relative))
    throw new Error('Metadata path is outside reserved namespace.');
  let directory = path.resolve(root);
  const parts = relative.split('/');
  for (const segment of [null, ...parts.slice(0, -1)]) {
    if (segment !== null) directory = path.join(directory, segment);
    if (create)
      await mkdir(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    const st = await lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error(`Metadata directory is not a regular directory: ${directory}`);
  }
  return path.join(directory, parts.at(-1)!);
}

export async function readMetadata(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<string | null> {
  const file = await metadataPath(root, relative).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (file === null) return null;
  const before = await lstat(file).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('Metadata is not a regular file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    },
  );
  if (handle === null) return null;
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size > maxBytes)
      throw new Error('Metadata is not a bounded regular file.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error('Metadata exceeds byte limit.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeMetadata(
  root: string,
  relative: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Metadata exceeds byte limit.');
  const file = await metadataPath(root, relative, true);
  const existing = await lstat(file).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('Metadata target is not a regular file.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
