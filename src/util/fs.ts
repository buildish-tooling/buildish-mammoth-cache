/*
 * Copyright 2026 The Apache Software Foundation
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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Returns `true` when the given error represents a missing-path (`ENOENT`) condition.
 *
 * Use this predicate to distinguish "file does not exist" from other I/O errors when calling
 * filesystem APIs that do not provide a separate "does it exist?" check.
 */
export function isMissingPathError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/**
 * Returns `true` when the given error arises from trying to replace an existing path during
 * an atomic rename on platforms that do not permit silent overwrites.
 *
 * Covers `EEXIST` (Linux / most POSIX), `EPERM`, and `EACCES` (Windows) error codes.
 */
export function isReplaceTargetError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

/**
 * Computes the SHA-256 digest of a file's contents and returns the lowercase hex string.
 *
 * Streams the file to avoid reading the entire content into memory. Rejects when the file
 * cannot be opened or read.
 */
export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
