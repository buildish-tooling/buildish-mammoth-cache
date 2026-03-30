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

import path from 'node:path';

const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

/**
 * Treats POSIX-absolute and Windows-rooted inputs as non-relative paths.
 *
 * Windows drive prefixes are rejected even without a separator (for example, `C:tmp`) because
 * they are not safe portable relative paths.
 */
export function isAbsolutePosixOrWindowsPath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(value) ||
    value.startsWith('\\')
  );
}

/**
 * Normalizes a user-supplied repository-relative path to its canonical POSIX path.
 *
 * Windows separator characters are accepted for usability, but Windows drive-prefixed,
 * UNC, and rooted paths are rejected before normalization.
 */
export function normalizeUserSuppliedRelativePath(value: string, label: string): string {
  if (isAbsolutePosixOrWindowsPath(value)) {
    throw new Error(`${label} must be a relative path.`);
  }

  const normalizedPath = path.posix.normalize(value.replaceAll('\\', '/'));

  if (
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`${label} must stay within the repository workspace.`);
  }

  return normalizedPath === '' ? '.' : normalizedPath.replace(/\/$/, '') || '.';
}

/**
 * Requires a normalized relative POSIX path rooted beneath a caller-defined location.
 */
export function validateNormalizedRelativePosixPath(
  value: unknown,
  label: string,
  locationDescription: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  const relativePath = value;
  const normalizedPath = path.posix.normalize(relativePath);

  if (
    relativePath.length === 0 ||
    relativePath === '.' ||
    relativePath.includes('\\') ||
    isAbsolutePosixOrWindowsPath(relativePath) ||
    normalizedPath !== relativePath ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../')
  ) {
    throw new Error(
      `${label} must be a normalized relative POSIX path inside ${locationDescription}.`,
    );
  }

  return relativePath;
}

/**
 * Resolves a pre-validated, normalized POSIX-style relative path beneath a root directory and
 * throws a caller-supplied error message when the resolved path would escape the root.
 *
 * This is the shared implementation backing all safe child-path resolution in the codebase.
 * Callers are responsible for validating and normalizing `normalizedRelativePath` before passing
 * it here (e.g., via `validateNormalizedRelativePosixPath`).
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
