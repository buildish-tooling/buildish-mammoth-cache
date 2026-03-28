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

import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { CiJobContext } from '../../ci';
import { isMissingPathError } from '../../util/fs';
import { createHtmlLink, escapeSummaryText } from '../../util/html';
import { parseSerializedJson, parseWithZod } from '../../util/serialization';
import {
  BUILD_RESULTS_SUBDIRECTORY,
  BUILD_SCANS_SUBDIRECTORY,
  INIT_SCRIPT_FILE_NAME,
  SERVICE_PLUGIN_FILE_NAME,
  createInitScriptContents,
  createServicePluginContents,
  validateCaptureRootPath,
} from './build-result-capture-scripts';

export {
  toGroovySingleQuotedString,
  validateCaptureRootPath,
} from './build-result-capture-scripts';

const CAPTURE_DIRECTORY_NAME = '.buildish-mammoth-cache';

/**
 * Maximum byte size of a single Gradle build-result or build-scan capture file.
 *
 * Legitimate capture files are small JSON blobs (a few hundred bytes). The cap prevents a
 * malicious Gradle plugin that writes oversized `.json` files into the capture directory from
 * exhausting runner memory. Exported so tests can assert the boundary without hard-coding the
 * value.
 */
export const MAX_CAPTURE_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB

type BuildCaptureContext = Pick<CiJobContext, 'tempDirectory'>;

/**
 * Merged metadata for a single Gradle invocation captured by the build-result init script.
 *
 * Combines the core build-result file with the optional Develocity build scan file written
 * by the Gradle Enterprise / Develocity plugin.
 */
export interface CapturedGradleBuild {
  /** Stable key derived from the result file name; used to correlate build and scan files. */
  readonly invocationKey: string;
  readonly capturedAtEpochMillis: number;
  readonly rootProjectName: string;
  readonly requestedTasks: string;
  readonly gradleVersion: string;
  readonly javaVersion: string;
  readonly buildFailed: boolean;
  readonly configCacheHit: boolean;
  /** URI of the published build scan, or `null` if none was published. */
  readonly buildScanUri: string | null;
  /** `true` when the Develocity plugin attempted to publish a scan but failed. */
  readonly buildScanFailed: boolean;
}

/** Aggregated report covering all Gradle invocations captured during the current job. */
export interface GradleBuildReport {
  readonly builds: readonly CapturedGradleBuild[];
  /** Non-fatal warnings encountered while loading or parsing the capture files. */
  readonly warnings: readonly string[];
}

const buildScanUriSchema = z.string().transform((val, ctx) => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(val);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Must be a valid URL' });
    return z.NEVER;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    ctx.addIssue({
      code: 'custom',
      message: `Must use http or https, but was '${parsedUrl.protocol}'`,
    });
    return z.NEVER;
  }
  return parsedUrl.toString();
});

const capturedBuildResultFileSchema = z.object({
  capturedAtEpochMillis: z.number().finite().nonnegative(),
  rootProjectName: z.string(),
  requestedTasks: z.string(),
  gradleVersion: z.string(),
  javaVersion: z.string().optional().default('unknown'),
  buildFailed: z.boolean(),
  configCacheHit: z.boolean(),
});

const capturedBuildScanFileSchema = z.object({
  buildScanUri: z.union([buildScanUriSchema, z.null()]),
  buildScanFailed: z.boolean(),
});

type CapturedBuildResultFile = z.infer<typeof capturedBuildResultFileSchema>;
type CapturedBuildScanFile = z.infer<typeof capturedBuildScanFileSchema>;

/**
 * Installs the Gradle build-result capture init script and Groovy service plugin into the
 * `init.d` directory of the given Gradle user home.
 *
 * The init script is picked up automatically by every subsequent Gradle invocation that uses
 * this Gradle user home. It writes per-invocation JSON result files to the CI temp directory,
 * which are later collected by {@link loadGradleBuildReport} in the finalize phase.
 *
 * Requires Gradle 7.0 or newer; emits a warning and exits gracefully on older versions.
 */
export async function installGradleBuildResultCapture(
  gradleUserHome: string,
  context: BuildCaptureContext = { tempDirectory: null },
): Promise<void> {
  const initDirectory = path.join(gradleUserHome, 'init.d');
  const captureRoot = resolveCaptureRoot(context);
  await mkdir(initDirectory, { recursive: true });
  await writeFile(
    path.join(initDirectory, INIT_SCRIPT_FILE_NAME),
    createInitScriptContents(captureRoot),
    {
      encoding: 'utf8',
    },
  );
  await writeFile(
    path.join(initDirectory, SERVICE_PLUGIN_FILE_NAME),
    createServicePluginContents(captureRoot),
    {
      encoding: 'utf8',
    },
  );
}

/**
 * Removes the capture init script and service plugin from the `init.d` directory.
 *
 * Called during the finalize phase so the installed files are not included in the cache snapshot.
 * Removal failures are collected as non-fatal warnings rather than hard errors.
 *
 * @returns Any warnings encountered while removing the capture files.
 */
export async function cleanupGradleBuildResultCapture(
  gradleUserHome: string,
): Promise<readonly string[]> {
  const warnings: string[] = [];

  await Promise.all(
    [INIT_SCRIPT_FILE_NAME, SERVICE_PLUGIN_FILE_NAME].map(async (fileName) => {
      const absolutePath = path.join(gradleUserHome, 'init.d', fileName);
      try {
        await rm(absolutePath, { force: true });
      } catch (error: unknown) {
        warnings.push(
          `Could not remove Gradle build-result capture file '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );

  return warnings;
}

/**
 * Reads all Gradle build-result and build-scan capture files written during the job and
 * merges them into a single {@link GradleBuildReport}.
 *
 * Returns an empty report with a warning when the CI temp directory is unavailable.
 * Parse errors for individual capture files are collected as warnings rather than hard errors
 * so a single malformed file does not suppress all other captured build metadata.
 */
export async function loadGradleBuildReport(
  context: BuildCaptureContext = { tempDirectory: null },
): Promise<GradleBuildReport> {
  const warnings: string[] = [];
  const resultsRoot = resolveCaptureRoot(context);
  if (!resultsRoot) {
    return {
      builds: [],
      warnings: ['Gradle build reporting is unavailable because the CI temp directory is not set.'],
    };
  }

  const buildResults = await loadFilesByInvocationKey<CapturedBuildResultFile>(
    path.join(resultsRoot, BUILD_RESULTS_SUBDIRECTORY),
    'build result',
    warnings,
    validateCapturedBuildResultFile,
  );
  const buildScans = await loadFilesByInvocationKey<CapturedBuildScanFile>(
    path.join(resultsRoot, BUILD_SCANS_SUBDIRECTORY),
    'build scan',
    warnings,
    validateCapturedBuildScanFile,
  );

  for (const invocationKey of buildScans.keys()) {
    if (!buildResults.has(invocationKey)) {
      warnings.push(
        `Ignoring build scan metadata for invocation '${invocationKey}' because the corresponding build result was not captured.`,
      );
    }
  }

  const builds = [...buildResults.entries()]
    .map(([invocationKey, buildResult]) => {
      const buildScan = buildScans.get(invocationKey);
      return {
        invocationKey,
        capturedAtEpochMillis: buildResult.capturedAtEpochMillis,
        rootProjectName: buildResult.rootProjectName,
        requestedTasks: buildResult.requestedTasks,
        gradleVersion: buildResult.gradleVersion,
        javaVersion: buildResult.javaVersion,
        buildFailed: buildResult.buildFailed,
        configCacheHit: buildResult.configCacheHit,
        buildScanUri: buildScan?.buildScanUri ?? null,
        buildScanFailed: buildScan?.buildScanFailed ?? false,
      } satisfies CapturedGradleBuild;
    })
    .sort(
      (left, right) =>
        left.capturedAtEpochMillis - right.capturedAtEpochMillis ||
        left.invocationKey.localeCompare(right.invocationKey),
    );

  return { builds, warnings };
}

/**
 * Renders Markdown summary lines for the Gradle build section of the job summary.
 *
 * Produces a table of captured Gradle invocations with outcome, configuration-cache state,
 * and build scan links when available. Returns an empty array when no builds were captured.
 */
export function createGradleBuildSummaryLines(report: GradleBuildReport): readonly string[] {
  const successfulBuildCount = report.builds.filter((build) => !build.buildFailed).length;
  const failedBuildCount = report.builds.length - successfulBuildCount;
  const buildScanCounts = report.builds.reduce(
    (counts, build) => {
      if (build.buildScanUri) {
        counts.published += 1;
      } else if (build.buildScanFailed) {
        counts.failed += 1;
      } else {
        counts.notAttempted += 1;
      }

      return counts;
    },
    { failed: 0, notAttempted: 0, published: 0 },
  );

  return [
    '### Performed Gradle builds',
    `- Captured Gradle builds: ${report.builds.length}`,
    `- Build outcomes: ${successfulBuildCount} succeeded, ${failedBuildCount} failed`,
    `- Build scans: ${buildScanCounts.published} published, ${buildScanCounts.failed} failed, ${buildScanCounts.notAttempted} not attempted`,
    `- Build reporting warnings: ${report.warnings.length}`,
    ...report.warnings.map((warning) => `- Warning: ${escapeSummaryText(warning)}`),
    ...report.builds.flatMap((build, index) => createBuildSummaryLines(build, index)),
  ];
}

function createBuildSummaryLines(build: CapturedGradleBuild, index: number): readonly string[] {
  const title = `${displayText(build.rootProjectName, '(unnamed root project)')} — ${displayText(build.requestedTasks, '(default tasks)')}`;
  const buildScanSummaryLine = build.buildScanUri
    ? `  - Build Scan: ${createHtmlLink(build.buildScanUri, 'published')}`
    : build.buildScanFailed
      ? '  - Build Scan: attempted but failed'
      : '  - Build Scan: not attempted';

  return [
    `- Build ${index + 1}: ${escapeSummaryText(truncateSummaryText(title, 200))}`,
    `  - Outcome: ${build.buildFailed ? 'failed' : 'succeeded'}`,
    `  - Toolchain: Gradle ${escapeSummaryText(build.gradleVersion)} / Java ${escapeSummaryText(build.javaVersion)}`,
    `  - Configuration cache reused: ${build.configCacheHit ? 'yes' : 'no'}`,
    buildScanSummaryLine,
  ];
}

async function loadFilesByInvocationKey<T>(
  directoryPath: string,
  label: string,
  warnings: string[],
  validate: (contents: string, filePath: string) => T,
): Promise<Map<string, T>> {
  let entries: readonly string[];
  try {
    entries = await readdir(directoryPath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return new Map();
    }

    warnings.push(
      `Could not enumerate Gradle ${label} files in '${directoryPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort();
  const results = new Map<string, T>();
  for (const fileName of files) {
    const absolutePath = path.join(directoryPath, fileName);
    try {
      // F-2: reject symlinks before following them, consistent with the rest of the codebase.
      // A malicious Gradle plugin that creates a symlink in the capture directory could
      // otherwise cause the action to read an arbitrary file on the runner filesystem.
      // F-3: reject files above MAX_CAPTURE_FILE_BYTES before reading to prevent a runaway
      // Gradle plugin from exhausting runner memory with an oversized capture file.
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        warnings.push(`Gradle ${label} file '${absolutePath}' is a symbolic link and was skipped.`);
        continue;
      }
      if (fileStat.size > MAX_CAPTURE_FILE_BYTES) {
        warnings.push(
          `Gradle ${label} file '${absolutePath}' exceeds the ${MAX_CAPTURE_FILE_BYTES}-byte read limit and was skipped.`,
        );
        continue;
      }
      const contents = await readFile(absolutePath, 'utf8');
      results.set(fileName.slice(0, -'.json'.length), validate(contents, absolutePath));
    } catch (error: unknown) {
      warnings.push(
        `Could not read Gradle ${label} file '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return results;
}

function validateCapturedBuildResultFile(
  contents: string,
  filePath: string,
): CapturedBuildResultFile {
  return parseWithZod(
    capturedBuildResultFileSchema,
    parseSerializedJson(contents, `Gradle build result file '${filePath}'`),
    `Gradle build result file '${filePath}'`,
  );
}

function validateCapturedBuildScanFile(contents: string, filePath: string): CapturedBuildScanFile {
  return parseWithZod(
    capturedBuildScanFileSchema,
    parseSerializedJson(contents, `Gradle build scan file '${filePath}'`),
    `Gradle build scan file '${filePath}'`,
  );
}

function resolveCaptureRoot(context: BuildCaptureContext): string | null {
  const tempDirectory = context.tempDirectory?.trim();
  if (!tempDirectory) {
    return null;
  }
  const captureRoot = path.join(tempDirectory, CAPTURE_DIRECTORY_NAME);
  validateCaptureRootPath(captureRoot);
  return captureRoot;
}

function displayText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function truncateSummaryText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
