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
import { lstat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { isAbsolutePosixOrWindowsPath } from './paths';

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
 * Validates that `value` is an absolute path that resolves — via all symlinks — to an existing
 * regular file, then returns the canonical resolved path.
 *
 * The check is intentionally strict:
 * - The raw value must be an absolute POSIX or Windows path (no relative paths, no bare names).
 * - All symlinks are resolved with `realpath` before the file-type check, so a symlink chain
 *   that ultimately points to a regular file is accepted and the symlink-free canonical path
 *   is returned. Using the canonical path for subsequent `spawn()` calls eliminates the
 *   time-of-check / time-of-use window that would exist if the original symlink path were used.
 * - The resolved path must be a regular file; directories and device nodes are rejected.
 *
 * @param value - The path string supplied by the caller (e.g. from an environment variable).
 * @param label - Human-readable label used in error messages.
 * @returns The canonical, symlink-resolved absolute path to the file.
 */
export async function validateAbsoluteExecutablePath(
  value: string,
  label: string,
): Promise<string> {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }

  if (!isAbsolutePosixOrWindowsPath(trimmed)) {
    throw new Error(
      `${label} must be an absolute path, but '${trimmed}' is not. ` +
        `Bare executable names and relative paths are not accepted.`,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(trimmed);
  } catch {
    throw new Error(
      `${label} '${trimmed}' does not exist or cannot be resolved. ` +
        `Ensure the path points to an existing GnuPG executable.`,
    );
  }

  const stats = await lstat(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`${label} '${trimmed}' resolves to a path that is not a regular file.`);
  }

  return resolvedPath;
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
