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

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_CAPTURE_FILE_BYTES,
  cleanupGradleBuildResultCapture,
  createGradleBuildSummaryLines,
  installGradleBuildResultCapture,
  loadGradleBuildReport,
  toGroovySingleQuotedString,
  validateCaptureRootPath,
} from '../../../src/build-tool/gradle/build-results';

describe('Gradle build reporting', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directoryPath) => {
        await rm(directoryPath, { recursive: true, force: true });
      }),
    );
  });

  it('merges captured build results with optional build scan metadata', async () => {
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const captureRoot = path.join(runnerTemp, '.buildish-mammoth-cache');
    const buildResultsDirectory = path.join(captureRoot, 'build-results');
    const buildScansDirectory = path.join(captureRoot, 'build-scans');
    await mkdir(buildResultsDirectory, { recursive: true });
    await mkdir(buildScansDirectory, { recursive: true });

    await writeFile(
      path.join(buildResultsDirectory, '__run-2.json'),
      JSON.stringify({
        capturedAtEpochMillis: 2000,
        rootProjectName: 'demo',
        requestedTasks: 'check',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        buildFailed: true,
        configCacheHit: true,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildResultsDirectory, '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1000,
        rootProjectName: 'demo',
        requestedTasks: 'build --scan',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildScansDirectory, '__run-1.json'),
      JSON.stringify({
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
        buildScanFailed: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildScansDirectory, '__run-orphan.json'),
      JSON.stringify({
        buildScanUri: null,
        buildScanFailed: true,
      }),
      'utf8',
    );

    const report = await loadGradleBuildReport({ tempDirectory: runnerTemp });

    expect(report.builds).toEqual([
      expect.objectContaining({
        invocationKey: '__run-1',
        requestedTasks: 'build --scan',
        buildFailed: false,
        buildScanUri: 'https://scans.gradle.com/s/local-it-published',
        buildScanFailed: false,
      }),
      expect.objectContaining({
        invocationKey: '__run-2',
        requestedTasks: 'check',
        buildFailed: true,
        buildScanUri: null,
        buildScanFailed: false,
      }),
    ]);
    expect(report.warnings).toEqual([
      expect.stringContaining("Ignoring build scan metadata for invocation '__run-orphan'"),
    ]);
  });

  it('renders a compact build summary with outcomes and build scan states', () => {
    const lines = createGradleBuildSummaryLines({
      builds: [
        {
          invocationKey: '__run-1',
          capturedAtEpochMillis: 1000,
          rootProjectName: 'demo',
          requestedTasks: 'build --scan',
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: false,
          configCacheHit: false,
          buildScanUri: 'https://scans.gradle.com/s/local-it-published',
          buildScanFailed: false,
        },
        {
          invocationKey: '__run-2',
          capturedAtEpochMillis: 2000,
          rootProjectName: 'demo',
          requestedTasks: 'publishFakeBuildScanFailure',
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: false,
          configCacheHit: true,
          buildScanUri: null,
          buildScanFailed: true,
        },
      ],
      warnings: ['sample warning'],
    });

    const summaryText = lines.join('\n');
    expect(summaryText).toContain('### Performed Gradle builds');
    expect(summaryText).toContain('- Captured Gradle builds: 2');
    expect(summaryText).toContain('- Build outcomes: 2 succeeded, 0 failed');
    expect(summaryText).toContain('- Build scans: 1 published, 1 failed, 0 not attempted');
    expect(summaryText).toContain('- Build reporting warnings: 1');
    expect(summaryText).toContain('- Warning: sample warning');
    expect(summaryText).toContain('  - Outcome: succeeded');
    expect(summaryText).toContain('  - Toolchain: Gradle 8\\.14\\.3 / Java 21\\.0\\.4');
    expect(summaryText).toContain('  - Configuration cache reused: no');
    expect(summaryText).toContain('  - Build Scan: attempted but failed');
    expect(lines.some((line) => line.startsWith('- Build 1: demo'))).toBe(true);
    expect(lines.some((line) => line.includes('build') && line.includes('scan'))).toBe(true);
    // The build scan URI is rendered as an HTML link so that Markdown-special characters
    // inside the URL (e.g. '&', '(', ')') cannot break surrounding list-item formatting.
    expect(
      lines.some(
        (line) =>
          line ===
          '  - Build Scan: <a href="https://scans.gradle.com/s/local-it-published">published</a>',
      ),
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('- Build 2: demo'))).toBe(true);
  });

  it('installs generated capture scripts with embedded capture root and Gradle 7 guard', async () => {
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const gradleUserHome = path.join(runnerTemp, 'gradle-home');

    await installGradleBuildResultCapture(gradleUserHome, { tempDirectory: runnerTemp });

    const initScript = await readFile(
      path.join(
        gradleUserHome,
        'init.d',
        'buildish-mammoth-cache.build-result-capture.init.gradle',
      ),
      'utf8',
    );
    const servicePlugin = await readFile(
      path.join(
        gradleUserHome,
        'init.d',
        'buildish-mammoth-cache.build-result-capture-service.plugin.groovy',
      ),
      'utf8',
    );

    expect(initScript).toContain('Gradle build-result capture requires Gradle 7.0+');
    expect(initScript).not.toContain('captureUsingBuildFinished');
    // The path must be embedded as a single-quoted Groovy string (not a GString) so that
    // ${…} sequences in the value are never evaluated as Groovy expressions.
    const expectedCaptureRootLiteral = `'${path.join(runnerTemp, '.buildish-mammoth-cache')}'`;
    expect(initScript).toContain(`def captureRootDir = ${expectedCaptureRootLiteral}`);
    expect(servicePlugin).toContain(`def captureRootDir = ${expectedCaptureRootLiteral}`);
    expect(servicePlugin).toContain('def captureInvocationNamespace = "buildish-mammoth-cache"');
  });

  it('renders "not attempted" scan state, displayText fallbacks, and truncates overlong titles', () => {
    const longTask = 'x'.repeat(210);
    const lines = createGradleBuildSummaryLines({
      builds: [
        {
          invocationKey: '__run-1',
          capturedAtEpochMillis: 1_000,
          rootProjectName: '', // triggers displayText fallback → "(unnamed root project)"
          requestedTasks: '   ', // triggers displayText fallback → "(default tasks)"
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: false,
          configCacheHit: false,
          buildScanUri: null,
          buildScanFailed: false, // "not attempted" branch
        },
        {
          invocationKey: '__run-2',
          capturedAtEpochMillis: 2_000,
          rootProjectName: 'demo',
          requestedTasks: longTask, // title > 200 chars → truncated with …
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: false,
          configCacheHit: false,
          buildScanUri: null,
          buildScanFailed: false,
        },
      ],
      warnings: [],
    });

    const summaryText = lines.join('\n');
    // displayText fallbacks — escapeSummaryText escapes '(' and ')' as '\(' / '\)'
    expect(summaryText).toContain('\\(unnamed root project\\)');
    expect(summaryText).toContain('\\(default tasks\\)');
    // "not attempted" scan line (buildScanUri: null, buildScanFailed: false)
    expect(summaryText).toContain('  - Build Scan: not attempted');
    // title truncation: "demo — xxx..." exceeds 200 chars, ending with ellipsis
    const build2Line = lines.find((l) => l.startsWith('- Build 2:')) ?? '';
    expect(build2Line.endsWith('…')).toBe(true);
  });

  it('HTML-escapes Markdown-special characters in the build scan URI', () => {
    // '&' is valid in URLs (query parameters) and must be escaped as '&amp;' inside href.
    const lines = createGradleBuildSummaryLines({
      builds: [
        {
          invocationKey: '__run-1',
          capturedAtEpochMillis: 1_000,
          rootProjectName: 'demo',
          requestedTasks: 'build',
          gradleVersion: '8.14.3',
          javaVersion: '21.0.4',
          buildFailed: false,
          configCacheHit: false,
          buildScanUri: 'https://scans.gradle.com/s/abc?a=1&b=2',
          buildScanFailed: false,
        },
      ],
      warnings: [],
    });

    const scanLine = lines.find((l) => l.includes('Build Scan')) ?? '';
    expect(scanLine).toBe(
      '  - Build Scan: <a href="https://scans.gradle.com/s/abc?a=1&amp;b=2">published</a>',
    );
  });

  it('defaults javaVersion to "unknown" when the field is absent from the captured result file', async () => {
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const buildResultsDir = path.join(runnerTemp, '.buildish-mammoth-cache', 'build-results');
    await mkdir(buildResultsDir, { recursive: true });
    await writeFile(
      path.join(buildResultsDir, '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1_000,
        rootProjectName: 'demo',
        requestedTasks: 'build',
        gradleVersion: '8.14.3',
        // javaVersion deliberately omitted — Zod .default('unknown') should fill it in
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );

    const report = await loadGradleBuildReport({ tempDirectory: runnerTemp });

    expect(report.builds).toHaveLength(1);
    expect(report.builds[0]?.javaVersion).toBe('unknown');
  });

  it('records a warning and skips a result file that contains malformed JSON', async () => {
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const buildResultsDir = path.join(runnerTemp, '.buildish-mammoth-cache', 'build-results');
    await mkdir(buildResultsDir, { recursive: true });
    await writeFile(
      path.join(buildResultsDir, '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1_000,
        rootProjectName: 'ok',
        requestedTasks: 'build',
        gradleVersion: '8.14.3',
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );
    await writeFile(path.join(buildResultsDir, '__run-broken.json'), 'not-valid-json', 'utf8');

    const report = await loadGradleBuildReport({ tempDirectory: runnerTemp });

    expect(report.builds).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/Could not read Gradle build result file/u);
    expect(report.warnings[0]).toContain('__run-broken.json');
  });

  it('records a warning and skips a build result file that is a symbolic link', async () => {
    // F-2: a symlink in the capture directory must not be followed. A malicious Gradle plugin
    // could place a symlink pointing to a sensitive file on the runner filesystem.
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const buildResultsDir = path.join(runnerTemp, '.buildish-mammoth-cache', 'build-results');
    await mkdir(buildResultsDir, { recursive: true });

    // Create a target file outside the capture directory, then symlink it in.
    const targetFile = path.join(runnerTemp, 'sensitive-target.txt');
    await writeFile(targetFile, 'sensitive content', 'utf8');
    await symlink(targetFile, path.join(buildResultsDir, '__run-symlink.json'));

    const report = await loadGradleBuildReport({ tempDirectory: runnerTemp });

    expect(report.builds).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/symbolic link/u);
    expect(report.warnings[0]).toContain('__run-symlink.json');
  });

  it('records a warning and skips a build result file that exceeds the size limit', async () => {
    // F-3: an oversized capture file (e.g. written by a malicious Gradle plugin) must not be
    // read into memory. MAX_CAPTURE_FILE_BYTES is the per-file cap.
    const runnerTemp = await createRunnerTemp(temporaryDirectories);
    const buildResultsDir = path.join(runnerTemp, '.buildish-mammoth-cache', 'build-results');
    await mkdir(buildResultsDir, { recursive: true });

    // Write a file that is one byte over the limit.
    await writeFile(
      path.join(buildResultsDir, '__run-huge.json'),
      'x'.repeat(MAX_CAPTURE_FILE_BYTES + 1),
      'utf8',
    );

    const report = await loadGradleBuildReport({ tempDirectory: runnerTemp });

    expect(report.builds).toHaveLength(0);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/exceeds the .* read limit/u);
    expect(report.warnings[0]).toContain('__run-huge.json');
  });

  it('returns a warning when a capture init-script file cannot be removed', async () => {
    const gradleUserHome = await createRunnerTemp(temporaryDirectories);
    // Place a directory where the init-script file is expected.
    // rm() without --recursive cannot remove a directory and will produce a warning.
    const initScriptPath = path.join(
      gradleUserHome,
      'init.d',
      'buildish-mammoth-cache.build-result-capture.init.gradle',
    );
    await mkdir(initScriptPath, { recursive: true });

    const warnings = await cleanupGradleBuildResultCapture(gradleUserHome);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Could not remove Gradle build-result capture file/u);
    expect(warnings[0]).toContain('buildish-mammoth-cache.build-result-capture.init.gradle');
  });
});

describe('Groovy embedding helpers', () => {
  describe('toGroovySingleQuotedString', () => {
    it('wraps a plain path in single quotes', () => {
      expect(toGroovySingleQuotedString('/home/runner/work/_temp')).toBe(
        "'/home/runner/work/_temp'",
      );
    });

    it('escapes backslashes so Windows paths survive round-trip through Groovy', () => {
      // Input: D:\a\_temp  →  Groovy literal: 'D:\\a\\_temp'  →  Groovy value: D:\a\_temp
      expect(toGroovySingleQuotedString('D:\\a\\_temp')).toBe("'D:\\\\a\\\\_temp'");
    });

    it('escapes embedded single quotes', () => {
      expect(toGroovySingleQuotedString("/tmp/it's-fine")).toBe("'/tmp/it\\'s-fine'");
    });

    it('leaves ${…} sequences inert — they are never interpolated in single-quoted strings', () => {
      const result = toGroovySingleQuotedString('/tmp/${System.exit(1)}');
      // The output is a single-quoted literal — Groovy will NOT evaluate ${…} inside it.
      expect(result).toBe("'/tmp/${System.exit(1)}'");
      // Confirm no double-quote wrapper that would make it a GString.
      expect(result.startsWith("'")).toBe(true);
      expect(result.endsWith("'")).toBe(true);
    });
  });

  describe('validateCaptureRootPath', () => {
    it('accepts normal POSIX temp paths', () => {
      expect(() =>
        validateCaptureRootPath('/home/runner/work/_temp/.buildish-mammoth-cache'),
      ).not.toThrow();
      expect(() => validateCaptureRootPath('/tmp/.buildish-mammoth-cache')).not.toThrow();
    });

    it('accepts normal Windows temp paths', () => {
      expect(() => validateCaptureRootPath('D:\\a\\_temp\\.buildish-mammoth-cache')).not.toThrow();
      expect(() =>
        validateCaptureRootPath(
          'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\.buildish-mammoth-cache',
        ),
      ).not.toThrow();
    });

    it('rejects a path containing a $ character', () => {
      expect(() =>
        validateCaptureRootPath('/tmp/${System.exit(1)}/.buildish-mammoth-cache'),
      ).toThrow(/suspicious|not permitted/iu);
    });

    it('rejects a path containing a backtick', () => {
      expect(() => validateCaptureRootPath('/tmp/`id`/.buildish-mammoth-cache')).toThrow(
        /suspicious|not permitted/iu,
      );
    });

    it('rejects a path containing a newline', () => {
      expect(() => validateCaptureRootPath('/tmp/evil\n/path/.buildish-mammoth-cache')).toThrow(
        /suspicious|not permitted/iu,
      );
    });

    it('rejects a path containing a NUL byte', () => {
      expect(() => validateCaptureRootPath('/tmp/evil\0/path/.buildish-mammoth-cache')).toThrow(
        /suspicious|not permitted/iu,
      );
    });
  });

  describe('installGradleBuildResultCapture rejects a tampered RUNNER_TEMP', () => {
    it('throws when the temp directory contains a $ character', async () => {
      const tmpDirs: string[] = [];
      const fakeGradleHome = await createRunnerTemp(tmpDirs);
      try {
        await expect(
          installGradleBuildResultCapture(fakeGradleHome, {
            tempDirectory: '/tmp/${System.exit(1)}',
          }),
        ).rejects.toThrow(/not permitted/iu);
      } finally {
        for (const d of tmpDirs) {
          await rm(d, { recursive: true, force: true });
        }
      }
    });
  });
});

async function createRunnerTemp(temporaryDirectories: string[]): Promise<string> {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), 'buildish-gradle-build-report-'));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}
