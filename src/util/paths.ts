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
