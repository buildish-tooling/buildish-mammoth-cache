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

import { access, constants, readFile } from 'node:fs/promises';
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

/**
 * Pattern for the `JAVA_VERSION` field in a `$JAVA_HOME/release` file.
 *
 * Handles both modern (`"21.0.10"`) and legacy 1.x (`"1.8.0_432"`) version strings.
 * Applied line-by-line so that regex backtracking is bounded to a single short line.
 */
const JAVA_RELEASE_VERSION_LINE_PATTERN = /^JAVA_VERSION="((?:1\.)?[0-9]+)(?:[._][^"]*)?"$/u;

/**
 * Maximum number of lines to scan in a `$JAVA_HOME/release` file.
 *
 * The file is small in practice (typically under 20 lines). The cap prevents
 * unexpected behaviour if a malformed or oversized file is encountered.
 */
const MAX_JAVA_RELEASE_FILE_LINES = 64;

/**
 * Reads the Java major version from the `$JAVA_HOME/release` file without spawning a subprocess.
 *
 * Every standard JDK and JRE distribution includes a `release` file in the Java home directory.
 * It contains a `JAVA_VERSION="…"` line whose value can be parsed directly. Preferring this
 * file over `java -version` eliminates a process spawn and any PATH dependency.
 *
 * The file is read line-by-line with a hard cap on the number of lines inspected, so a
 * pathologically large file cannot cause unbounded memory or CPU use.
 *
 * @param env - Environment to read `JAVA_HOME` from; defaults to `process.env`.
 * @returns The Java major version (integer ≥ 8), or `null` when `JAVA_HOME` is unset,
 *          the release file is absent, or the version line cannot be parsed.
 */
export async function readJavaMajorFromReleaseFile(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  const javaHome = env.JAVA_HOME?.trim();
  if (!javaHome) {
    return null;
  }

  const releaseFilePath = path.join(javaHome, 'release');
  let content: string;
  try {
    content = await readFile(releaseFilePath, { encoding: 'utf8' });
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/u);
  for (let i = 0; i < Math.min(lines.length, MAX_JAVA_RELEASE_FILE_LINES); i++) {
    const match = JAVA_RELEASE_VERSION_LINE_PATTERN.exec(lines[i]!.trim());
    if (!match) {
      continue;
    }
    const versionToken = match[1]!;
    const major = versionToken.startsWith('1.')
      ? Number.parseInt(versionToken.slice(2), 10)
      : Number.parseInt(versionToken, 10);
    return Number.isInteger(major) && major >= 8 ? major : null;
  }

  return null;
}

/**
 * Resolves the `java` executable path, preferring an absolute path derived from `JAVA_HOME`
 * over PATH-based resolution.
 *
 * Lookup order (mirrors the logic used by `gradlew` / `gradlew.bat`):
 * 1. If `JAVA_HOME` is set and `$JAVA_HOME/bin/java[.exe]` is accessible, return that
 *    absolute path. This avoids any PATH dependency.
 * 2. Otherwise return the platform-appropriate bare name (`java` / `java.exe`) for
 *    PATH-based resolution at `spawn()` time.
 *
 * @param env - Environment to read `JAVA_HOME` from; defaults to `process.env`.
 * @param platform - Platform for choosing the executable name; defaults to `process.platform`.
 * @returns An absolute path when JAVA_HOME-based resolution succeeds, otherwise a bare name.
 */
export async function resolveJavaExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const javaBinaryName = platform === 'win32' ? 'java.exe' : 'java';
  const javaHome = env.JAVA_HOME?.trim();

  if (javaHome) {
    const candidate = path.join(javaHome, 'bin', javaBinaryName);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // $JAVA_HOME/bin/java is absent or not executable; fall through to PATH.
    }
  }

  return javaBinaryName;
}
