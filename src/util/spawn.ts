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

/**
 * POSIX environment variables required for reliable subprocess execution.
 *
 * Only variables necessary for binary loading and basic runtime behaviour are
 * included. Application secrets, CI tokens, and tool-specific configuration are
 * deliberately excluded so they are not inherited by child processes that do not
 * need them.
 */
const POSIX_EXEC_ENV_ALLOWLIST = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
]);

/**
 * Windows environment variables required for reliable subprocess execution.
 *
 * Includes variables needed for Win32 DLL loading, user-profile resolution,
 * and temp-directory access. Checked case-insensitively because Windows
 * environment variable names are case-insensitive.
 */
const WINDOWS_EXEC_ENV_ALLOWLIST_UPPERCASE = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

/**
 * Builds a minimal child-process environment by keeping only variables from an
 * explicit platform-specific allowlist, then merging caller-supplied overrides.
 *
 * Use this when spawning subprocesses that do not need access to CI secrets,
 * repository tokens, or application-specific configuration. The stripped
 * environment still contains everything needed for shared-library loading,
 * temp-file creation, and locale handling.
 *
 * On Windows, allowlist membership is checked case-insensitively because the
 * Windows environment is case-insensitive. The original key casing from
 * `sourceEnv` is preserved in the returned object.
 *
 * @param sourceEnv - The parent environment to select variables from (usually `process.env`).
 * @param overrides - Variables unconditionally merged after stripping; these win over `sourceEnv`.
 * @param platform - Target platform; defaults to `process.platform`.
 * @returns A plain object containing only the allowed variables plus `overrides`.
 */
export function buildMinimalChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  if (platform === 'win32') {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (WINDOWS_EXEC_ENV_ALLOWLIST_UPPERCASE.has(key.toUpperCase())) {
        result[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (POSIX_EXEC_ENV_ALLOWLIST.has(key)) {
        result[key] = value;
      }
    }
  }

  return { ...result, ...overrides };
}
