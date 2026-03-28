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
import path from 'node:path';

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
  const stream = createReadStream(filePath);

  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('close', () => resolve(hash.digest('hex')));
  });
}

/**
 * Resolves a pre-validated, normalized POSIX-style relative path beneath a root directory and
 * throws a caller-supplied error message when the resolved path would escape the root.
 *
 * This is the shared implementation backing all safe child-path resolution in the codebase.
 * Callers are responsible for validating and normalizing `normalizedRelativePath` before passing
 * it here (e.g., via `validateNormalizedRelativePosixPath` from `../validation`).
 *
 * @param rootDirectory - Absolute or resolvable root directory path.
 * @param normalizedRelativePath - A normalized POSIX relative path (no `..` segments, no leading slash).
 * @param escapeErrorMessage - Error message thrown when the resolved path escapes the root.
 * @returns The absolute resolved path within the root.
 * @throws When the resolved path escapes the root directory.
 */
export function resolveNormalizedPathWithinRoot(
  rootDirectory: string,
  normalizedRelativePath: string,
  escapeErrorMessage: string,
): string {
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath.split('/').join(path.sep));
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(rootWithSeparator)) {
    throw new Error(escapeErrorMessage);
  }

  return resolvedPath;
}
