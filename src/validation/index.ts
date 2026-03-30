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

type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: {
        // PropertyKey includes symbol; Zod v4 uses PropertyKey[] for issue paths.
        readonly issues: ReadonlyArray<{
          readonly path: ReadonlyArray<PropertyKey>;
          readonly message: string;
        }>;
      };
    };

/**
 * Parses serialized JSON and preserves the original error as the `cause`.
 */
export function parseSerializedJson(serializedValue: string, label: string): unknown {
  try {
    return JSON.parse(serializedValue);
  } catch (error: unknown) {
    throw new Error(
      `Could not parse serialized ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Wraps a Zod-compatible `safeParse` result, throwing a readable `Error` on the first issue.
 *
 * The schema parameter is typed structurally so this helper has no hard import dependency on Zod.
 */
export function parseWithZod<T>(
  schema: { safeParse(data: unknown): ParseResult<T> },
  data: unknown,
  label: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const pathStr = issue && issue.path.length > 0 ? ` at ${issue.path.map(String).join('.')}` : '';
  throw new Error(`Invalid ${label}${pathStr}: ${issue?.message ?? 'Unknown validation error'}`);
}

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
