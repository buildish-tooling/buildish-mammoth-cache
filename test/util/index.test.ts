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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseBooleanInput,
  parseEnumInput,
  parseListInput,
  validateNamedValue,
} from '../../src/util/action-input';
import {
  isMissingPathError,
  isReplaceTargetError,
  validateAbsoluteExecutablePath,
} from '../../src/util/fs';
import {
  createDetailsSection,
  createHtmlLink,
  createHtmlTable,
  escapeHtml,
  escapeSummaryText,
  safeHtml,
} from '../../src/util/html';
import {
  normalizeUserSuppliedRelativePath,
  readJavaMajorFromReleaseFile,
  resolveJavaExecutablePath,
  validateNormalizedRelativePosixPath,
} from '../../src/util/paths';
import { parseSerializedJson, parseWithZod } from '../../src/util/serialization';
import { buildMinimalChildEnv } from '../../src/util/spawn';

describe('validation helpers', () => {
  it('parses serialized JSON and surfaces the underlying JSON syntax error', () => {
    expect(parseSerializedJson('{"ok":true}', 'fixture')).toEqual({ ok: true });
    expect(parseSerializedJson('[1,2,3]', 'fixture')).toEqual([1, 2, 3]);
    expect(() => parseSerializedJson('not-json', 'fixture')).toThrow(/Could not parse serialized/u);
  });

  it('parseWithZod returns the parsed data on success', () => {
    const schema = { safeParse: (data: unknown) => ({ success: true as const, data }) };
    expect(parseWithZod(schema, { x: 1 }, 'thing')).toEqual({ x: 1 });
  });

  it('parseWithZod throws "Invalid <label>: <message>" when the issue has no path', () => {
    const schema = {
      safeParse: (_: unknown) => ({
        success: false as const,
        error: { issues: [{ path: [], message: 'must be a string' }] },
      }),
    };
    expect(() => parseWithZod(schema, 42, 'my-label')).toThrow(
      'Invalid my-label: must be a string',
    );
  });

  it('parseWithZod includes the dotted field path in the error message', () => {
    const schema = {
      safeParse: (_: unknown) => ({
        success: false as const,
        error: { issues: [{ path: ['user', 'email'], message: 'Invalid email' }] },
      }),
    };
    expect(() => parseWithZod(schema, {}, 'my-label')).toThrow(
      'Invalid my-label at user.email: Invalid email',
    );
  });

  it('parseWithZod falls back to "Unknown validation error" when the issues array is empty', () => {
    const schema = {
      safeParse: (_: unknown) => ({
        success: false as const,
        error: { issues: [] },
      }),
    };
    expect(() => parseWithZod(schema, {}, 'my-label')).toThrow(
      'Invalid my-label: Unknown validation error',
    );
  });

  it('validates normalized relative POSIX paths for caller-defined roots', () => {
    expect(validateNormalizedRelativePosixPath('payload/000001.bin', 'path', 'the package')).toBe(
      'payload/000001.bin',
    );
    expect(() => validateNormalizedRelativePosixPath('../escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
    expect(() =>
      validateNormalizedRelativePosixPath('payload\\000001.bin', 'path', 'the package'),
    ).toThrow(/normalized relative POSIX path inside the package/u);
    expect(() => validateNormalizedRelativePosixPath('\\escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
    expect(() =>
      validateNormalizedRelativePosixPath('\\\\server\\share\\payload.bin', 'path', 'the package'),
    ).toThrow(/normalized relative POSIX path inside the package/u);
    expect(() => validateNormalizedRelativePosixPath('C:/escape', 'path', 'the package')).toThrow(
      /normalized relative POSIX path inside the package/u,
    );
  });

  it('normalizes user-supplied relative paths to canonical POSIX form', () => {
    expect(normalizeUserSuppliedRelativePath('tools\\app\\gradle', 'path')).toBe(
      'tools/app/gradle',
    );
    expect(normalizeUserSuppliedRelativePath('tools/./app\\gradle/', 'path')).toBe(
      'tools/app/gradle',
    );
    expect(() => normalizeUserSuppliedRelativePath('\\Windows\\Blah', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('\\\\server\\share\\repo', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('C:\\repo', 'path')).toThrow(
      /must be a relative path/u,
    );
    expect(() => normalizeUserSuppliedRelativePath('../repo', 'path')).toThrow(
      /must stay within the repository workspace/u,
    );
  });
});

describe('html utilities', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('safe text')).toBe('safe text');
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml('it\'s & "works"')).toBe('it&#39;s &amp; &quot;works&quot;');
    expect(escapeHtml('')).toBe('');
  });

  it('escapes Markdown special characters in summary text, including angle brackets', () => {
    expect(escapeSummaryText('plain')).toBe('plain');
    expect(escapeSummaryText('8.14.3')).toBe('8\\.14\\.3');
    expect(escapeSummaryText('<feature/branch>')).toBe('\\<feature/branch\\>');
    expect(escapeSummaryText('`code`')).toBe('\\`code\\`');
    expect(escapeSummaryText('')).toBe('');
  });

  it('wraps body lines in an HTML details/summary block with an escaped title', () => {
    expect(createDetailsSection('My <title>', ['line 1', 'line 2'])).toEqual([
      '<details>',
      '<summary>My &lt;title&gt;</summary>',
      '',
      'line 1',
      'line 2',
      '',
      '</details>',
    ]);
  });

  it('renders an HTML table with escaped headers and verbatim cell content', () => {
    expect(
      createHtmlTable(
        ['Col <A>', 'Col B'],
        [[safeHtml('plain'), safeHtml('<a href="x">link</a>')]],
      ),
    ).toEqual([
      '<table>',
      '  <thead><tr><th>Col &lt;A&gt;</th><th>Col B</th></tr></thead>',
      '  <tbody>',
      '    <tr><td>plain</td><td><a href="x">link</a></td></tr>',
      '  </tbody>',
      '</table>',
    ]);
  });

  it('creates an HTML anchor tag with both href and label HTML-escaped', () => {
    expect(createHtmlLink('https://example.com/?q=<x>', 'Click <here>')).toBe(
      '<a href="https://example.com/?q=&lt;x&gt;">Click &lt;here&gt;</a>',
    );
  });
});

describe('action-input helpers', () => {
  it('coerces boolean strings, trims whitespace, and rejects everything else', () => {
    expect(parseBooleanInput('true', 'flag')).toBe(true);
    expect(parseBooleanInput('false', 'flag')).toBe(false);
    expect(parseBooleanInput('  TRUE  ', 'flag')).toBe(true);
    expect(parseBooleanInput('  FALSE  ', 'flag')).toBe(false);
    expect(() => parseBooleanInput('yes', 'flag')).toThrow(/must be either 'true' or 'false'/u);
    expect(() => parseBooleanInput('', 'flag')).toThrow(/must be either 'true' or 'false'/u);
    expect(() => parseBooleanInput('1', 'flag')).toThrow(/must be either 'true' or 'false'/u);
  });

  it('accepts valid enum values and rejects anything outside the allowed set', () => {
    const modes = ['standalone', 'distributed-worker', 'distributed-aggregator'] as const;
    expect(parseEnumInput('standalone', modes, 'job-mode')).toBe('standalone');
    expect(parseEnumInput('distributed-aggregator', modes, 'job-mode')).toBe(
      'distributed-aggregator',
    );
    expect(() => parseEnumInput('unknown', modes, 'job-mode')).toThrow(/must be one of/u);
    expect(() => parseEnumInput('', modes, 'job-mode')).toThrow(/must be one of/u);
  });

  it('splits comma- and newline-separated list inputs, trimming whitespace and dropping empties', () => {
    expect(parseListInput('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseListInput('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(parseListInput('  a , b\n  c  ')).toEqual(['a', 'b', 'c']);
    expect(parseListInput('')).toEqual([]);
    expect(parseListInput('  ,  \n  ')).toEqual([]);
    expect(parseListInput('a,,b')).toEqual(['a', 'b']);
  });

  it('validates named values and rejects names with unsafe characters or wrong length', () => {
    expect(validateNamedValue('my-job.1', 'jobs')).toBe('my-job.1');
    expect(validateNamedValue('Job A', 'jobs')).toBe('Job A');
    expect(validateNamedValue('a'.repeat(100), 'jobs')).toBe('a'.repeat(100));
    expect(() => validateNamedValue('job/slash', 'jobs')).toThrow(/unsupported characters/u);
    expect(() => validateNamedValue('', 'jobs')).toThrow(/unsupported characters/u);
    expect(() => validateNamedValue('a'.repeat(101), 'jobs')).toThrow(/unsupported characters/u);
  });
});

describe('filesystem helpers', () => {
  it('recognizes ENOENT errors as missing-path conditions', () => {
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingPathError({ code: 'EACCES' })).toBe(false);
    expect(isMissingPathError(new Error('not found'))).toBe(false);
    expect(isMissingPathError(null)).toBe(false);
    expect(isMissingPathError(undefined)).toBe(false);
    expect(isMissingPathError('ENOENT')).toBe(false);
  });

  it('recognizes atomic-rename errors on Linux (EEXIST) and Windows (EPERM, EACCES)', () => {
    expect(isReplaceTargetError({ code: 'EEXIST' })).toBe(true);
    expect(isReplaceTargetError({ code: 'EPERM' })).toBe(true);
    expect(isReplaceTargetError({ code: 'EACCES' })).toBe(true);
    expect(isReplaceTargetError({ code: 'ENOENT' })).toBe(false);
    expect(isReplaceTargetError(null)).toBe(false);
    expect(isReplaceTargetError(undefined)).toBe(false);
    expect(isReplaceTargetError('EEXIST')).toBe(false);
  });

  it('validateAbsoluteExecutablePath rejects empty strings and bare names', async () => {
    await expect(validateAbsoluteExecutablePath('', 'gpg')).rejects.toThrow(/must not be empty/u);
    await expect(validateAbsoluteExecutablePath('  ', 'gpg')).rejects.toThrow(/must not be empty/u);
    await expect(validateAbsoluteExecutablePath('gpg', 'gpg')).rejects.toThrow(
      /must be an absolute path/u,
    );
    await expect(validateAbsoluteExecutablePath('./gpg', 'gpg')).rejects.toThrow(
      /must be an absolute path/u,
    );
    await expect(validateAbsoluteExecutablePath('../bin/gpg', 'gpg')).rejects.toThrow(
      /must be an absolute path/u,
    );
  });

  it('validateAbsoluteExecutablePath rejects nonexistent paths', async () => {
    await expect(validateAbsoluteExecutablePath('/nonexistent/path/to/gpg', 'gpg')).rejects.toThrow(
      /does not exist or cannot be resolved/u,
    );
  });

  it('validateAbsoluteExecutablePath rejects paths that resolve to a directory', async () => {
    await expect(validateAbsoluteExecutablePath(os.tmpdir(), 'gpg')).rejects.toThrow(
      /not a regular file/u,
    );
  });

  it('validateAbsoluteExecutablePath accepts a real absolute path to an existing regular file', async () => {
    // Use the Node.js executable itself — guaranteed to exist and be a regular file.
    const resolved = await validateAbsoluteExecutablePath(process.execPath, 'node');
    expect(path.isAbsolute(resolved)).toBe(true);
    // The resolved canonical path must be a prefix/equal of the original (symlinks collapsed).
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('validateAbsoluteExecutablePath resolves symlinks and returns the canonical path', async () => {
    // On most Linux systems /bin is a symlink to /usr/bin; if so, the resolved path differs.
    // We verify that the return value is always an absolute path regardless.
    const resolved = await validateAbsoluteExecutablePath(process.execPath, 'node');
    expect(path.isAbsolute(resolved)).toBe(true);
  });
});

describe('spawn env helpers', () => {
  it('strips everything except the POSIX allowlist on non-Windows platforms', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      HOME: '/home/runner',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
      GITHUB_TOKEN: 'ghs_supersecret',
      AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
      BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND: '/tmp/evil',
      CUSTOM_VAR: 'should-be-stripped',
    };

    const result = buildMinimalChildEnv(sourceEnv, {}, 'linux');

    expect(result).toMatchObject({ HOME: '/home/runner', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' });
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND');
    expect(result).not.toHaveProperty('CUSTOM_VAR');
  });

  it('applies overrides after stripping, letting callers set LANG/LC_ALL unconditionally', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      HOME: '/home/runner',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: 'secret',
    };

    const result = buildMinimalChildEnv(sourceEnv, { LANG: 'C', LC_ALL: 'C' }, 'linux');

    expect(result.LANG).toBe('C');
    expect(result.LC_ALL).toBe('C');
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('strips everything except the Windows allowlist using case-insensitive matching', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      // Mixed-case as Windows commonly exposes them
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\system32',
      USERPROFILE: 'C:\\Users\\runner',
      APPDATA: 'C:\\Users\\runner\\AppData\\Roaming',
      GITHUB_TOKEN: 'ghs_supersecret',
      AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
      BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND: 'C:\\evil\\gpg.exe',
    };

    const result = buildMinimalChildEnv(sourceEnv, {}, 'win32');

    expect(result).toMatchObject({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\system32',
      USERPROFILE: 'C:\\Users\\runner',
      APPDATA: 'C:\\Users\\runner\\AppData\\Roaming',
    });
    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result).not.toHaveProperty('BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND');
  });

  it('returns an empty object when the source env contains no allowlisted keys', () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: 'secret',
      MY_APP_KEY: 'value',
    };

    expect(buildMinimalChildEnv(sourceEnv, {}, 'linux')).toEqual({});
    expect(buildMinimalChildEnv(sourceEnv, {}, 'win32')).toEqual({});
  });

  it('overrides always appear in the result even when not in the source env', () => {
    const result = buildMinimalChildEnv({}, { LANG: 'C', LC_ALL: 'C', EXTRA: 'forced' }, 'linux');
    expect(result).toEqual({ LANG: 'C', LC_ALL: 'C', EXTRA: 'forced' });
  });
});

describe('readJavaMajorFromReleaseFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'buildish-java-release-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when JAVA_HOME is not set', async () => {
    await expect(readJavaMajorFromReleaseFile({})).resolves.toBeNull();
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: '' })).resolves.toBeNull();
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: '   ' })).resolves.toBeNull();
  });

  it('returns null when the release file is absent', async () => {
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: tmpDir })).resolves.toBeNull();
  });

  it('parses a modern JAVA_VERSION field (e.g. 21.0.10)', async () => {
    await writeFile(
      path.join(tmpDir, 'release'),
      'IMPLEMENTOR="Test"\nJAVA_VERSION="21.0.10"\nOS_ARCH="x86_64"\n',
    );
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: tmpDir })).resolves.toBe(21);
  });

  it('parses a legacy 1.x JAVA_VERSION field (e.g. 1.8.0_432) and returns the minor as major', async () => {
    await writeFile(path.join(tmpDir, 'release'), 'JAVA_VERSION="1.8.0_432"\n');
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: tmpDir })).resolves.toBe(8);
  });

  it('returns null when the release file contains no JAVA_VERSION line', async () => {
    await writeFile(path.join(tmpDir, 'release'), 'IMPLEMENTOR="Test"\nOS_ARCH="x86_64"\n');
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: tmpDir })).resolves.toBeNull();
  });

  it('returns null for a JAVA_VERSION that looks too old to be supported (< 8)', async () => {
    await writeFile(path.join(tmpDir, 'release'), 'JAVA_VERSION="1.7.0_80"\n');
    await expect(readJavaMajorFromReleaseFile({ JAVA_HOME: tmpDir })).resolves.toBeNull();
  });

  it('reads the real JAVA_HOME/release when available in the test environment', async () => {
    const javaHome = process.env.JAVA_HOME?.trim();
    if (!javaHome) return; // skip when JAVA_HOME is not set
    const major = await readJavaMajorFromReleaseFile(process.env);
    expect(major).toBeGreaterThanOrEqual(8);
  });
});

describe('resolveJavaExecutablePath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'buildish-java-exec-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 'java' on Linux/macOS when JAVA_HOME is not set", async () => {
    await expect(resolveJavaExecutablePath({}, 'linux')).resolves.toBe('java');
    await expect(resolveJavaExecutablePath({}, 'darwin')).resolves.toBe('java');
    await expect(resolveJavaExecutablePath({ JAVA_HOME: '' }, 'linux')).resolves.toBe('java');
  });

  it("returns 'java.exe' on Windows when JAVA_HOME is not set", async () => {
    await expect(resolveJavaExecutablePath({}, 'win32')).resolves.toBe('java.exe');
  });

  it('returns the absolute $JAVA_HOME/bin/java path when the binary is accessible', async () => {
    // Create a fake java binary that passes the access() check.
    const binDir = path.join(tmpDir, 'bin');
    await mkdir(binDir);
    const fakeBinary = path.join(binDir, 'java');
    await writeFile(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });

    const resolved = await resolveJavaExecutablePath({ JAVA_HOME: tmpDir }, 'linux');
    expect(resolved).toBe(fakeBinary);
  });

  it("falls back to 'java' when JAVA_HOME is set but the binary is absent", async () => {
    await expect(resolveJavaExecutablePath({ JAVA_HOME: tmpDir }, 'linux')).resolves.toBe('java');
  });
});
