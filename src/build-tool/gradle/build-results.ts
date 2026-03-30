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

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { CiJobContext } from '../../ci';
import { parseSerializedJson, parseWithZod } from '../../util/serialization';

const CAPTURE_DIRECTORY_NAME = '.buildish-mammoth-cache';
const BUILD_RESULTS_SUBDIRECTORY = 'build-results';
const BUILD_SCANS_SUBDIRECTORY = 'build-scans';
const INIT_SCRIPT_FILE_NAME = 'buildish-mammoth-cache.build-result-capture.init.gradle';
const SERVICE_PLUGIN_FILE_NAME =
  'buildish-mammoth-cache.build-result-capture-service.plugin.groovy';
const SKIP_CAPTURE_ENVIRONMENT_VARIABLE = 'BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE';
const DEFAULT_CAPTURE_INVOCATION_NAMESPACE = 'buildish-mammoth-cache';

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
    ? `  - Build Scan: published (${build.buildScanUri})`
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
  return tempDirectory ? path.join(tempDirectory, CAPTURE_DIRECTORY_NAME) : null;
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

function escapeSummaryText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!<>|-]/g, '\\$&');
}

function isMissingPathError(error: unknown): boolean {
  return !!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function createInitScriptContents(captureRoot: string | null): string {
  const captureRootLiteral = captureRoot ? JSON.stringify(captureRoot) : 'null';

  return `/*
 * Apache Buildish Mammoth Cache for Gradle — per-invocation build result capture
 *
 * Installed as a Gradle init script. Records metadata for each top-level build and writes it
 * to structured JSON files that the action finalize phase collects for the job summary.
 */
import org.gradle.util.GradleVersion
import org.slf4j.LoggerFactory

// Plugin / extension identifiers for the supported build-scan ecosystems
def DEVELOCITY_EXT    = "develocity"
def DEVELOCITY_PLUGIN = "com.gradle.develocity"
def GE_EXT            = "gradleEnterprise"
def GE_PLUGIN         = "com.gradle.enterprise"
def SCAN_EXT          = "buildScan"
def SCAN_PLUGIN       = "com.gradle.build-scan"

// Opt-out: skip capture when the environment flag is set
def skipEnvKey = "${SKIP_CAPTURE_ENVIRONMENT_VARIABLE}"
if (System.properties[skipEnvKey] ?: System.getenv(skipEnvKey)) {
    logger.lifecycle("buildish/mammoth-cache/gradle: Not capturing build results")
    return
}

// Only the outermost Gradle invocation participates in capture
if (gradle.getParent() != null) {
    return
}

// Require Gradle 7.0 or newer for BuildService support
if (GradleVersion.current().baseVersion < GradleVersion.version("7.0")) {
    logger.warn("buildish/mammoth-cache/gradle: Gradle build-result capture requires Gradle 7.0+; current version is ${'$'}{GradleVersion.current().version}. Skipping capture.")
    return
}

def invocId = "-" + java.util.UUID.randomUUID().toString()

// Store the invocation identifier before applying the service plugin so it can read it
gradle.ext.invocationId = invocId
apply from: '${SERVICE_PLUGIN_FILE_NAME}'

// Attach scan-published / scan-error callbacks for settings-level plugins (Develocity / GE)
settingsEvaluated { settings ->
    def onScanReady = {
        if (settings.extensions.findByName(DEVELOCITY_EXT)) {
            hookScanCallbacks(settings.extensions[DEVELOCITY_EXT].buildScan, invocId)
        } else if (settings.extensions.findByName(GE_EXT)) {
            hookScanCallbacks(settings.extensions[GE_EXT].buildScan, invocId)
        }
    }
    settings.pluginManager.withPlugin(GE_PLUGIN, onScanReady)
    settings.pluginManager.withPlugin(DEVELOCITY_PLUGIN) {
        if (settings.pluginManager.hasPlugin(GE_PLUGIN)) return
        onScanReady()
    }
}

// Attach scan-published / scan-error callbacks for project-level plugins (build-scan / Develocity)
projectsEvaluated { g ->
    def onScanReady = {
        if (g.rootProject.extensions.findByName(DEVELOCITY_EXT)) {
            hookScanCallbacks(g.rootProject.extensions[DEVELOCITY_EXT].buildScan, invocId)
        } else if (g.rootProject.extensions.findByName(SCAN_EXT)) {
            hookScanCallbacks(g.rootProject.extensions[SCAN_EXT], invocId)
        }
    }
    g.rootProject.pluginManager.withPlugin(SCAN_PLUGIN, onScanReady)
    g.rootProject.pluginManager.withPlugin(DEVELOCITY_PLUGIN) {
        if (g.rootProject.pluginManager.hasPlugin(SCAN_PLUGIN)) return
        onScanReady()
    }
}

// Register buildScanPublished / onError hooks on the given scan extension
void hookScanCallbacks(scanExt, String invocId) {
    def writer = new ScanResultsWriter()
    scanExt.with {
        buildScanPublished { scan ->
            writer.record("${BUILD_SCANS_SUBDIRECTORY}", invocId, [
                buildScanUri   : scan.buildScanUri.toASCIIString(),
                buildScanFailed: false,
            ])
        }
        onError { err ->
            writer.record("${BUILD_SCANS_SUBDIRECTORY}", invocId, [
                buildScanUri   : null,
                buildScanFailed: true,
            ])
        }
    }
}

class ScanResultsWriter {
    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")

    void record(String subDir, String invocId, def payload) {
        def captureRootDir = ${captureRootLiteral}
        def captureInvocationNamespace = "${DEFAULT_CAPTURE_INVOCATION_NAMESPACE}"

        if (!captureRootDir) return

        try {
            def outDir  = new File(captureRootDir, subDir)
            outDir.mkdirs()
            def outFile = new File(outDir, captureInvocationNamespace + invocId + ".json")
            if (!outFile.exists()) {
                logger.lifecycle("buildish/mammoth-cache/gradle: Writing build results to ${'$'}{outFile}")
                outFile << groovy.json.JsonOutput.toJson(payload)
            }
        } catch (Exception ex) {
            println "buildish/mammoth-cache/gradle failed to write build-results file. Will continue. > ${'$'}{ex.getLocalizedMessage()}"
        }
    }
}
`;
}

function createServicePluginContents(captureRoot: string | null): string {
  const captureRootLiteral = captureRoot ? JSON.stringify(captureRoot) : 'null';

  return `import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.internal.build.event.BuildEventListenerRegistryInternal
import org.gradle.internal.operations.*
import org.gradle.initialization.*
import org.gradle.execution.*
import org.gradle.tooling.events.*
import org.gradle.util.GradleVersion
import org.slf4j.LoggerFactory

settingsEvaluated { settings ->
    def svc = gradle.sharedServices.registerIfAbsent(
        "buildish-mammoth-cache-buildResultsRecorder",
        BuildResultsRecorder) { spec ->
        spec.getParameters().getRootProjectName().set(settings.rootProject.name)
        spec.getParameters().getRequestedTasks().set(gradle.startParameter.taskNames.join(" "))
        spec.getParameters().getInvocationId().set(gradle.ext.invocationId)
    }
    gradle.services.get(BuildEventListenerRegistryInternal).onOperationCompletion(svc)
}

abstract class BuildResultsRecorder
        implements BuildService<BuildResultsRecorder.Params>, BuildOperationListener, AutoCloseable {

    interface Params extends BuildServiceParameters {
        Property<String> getRootProjectName()
        Property<String> getRequestedTasks()
        Property<String> getInvocationId()
    }

    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")
    private boolean configCacheHit = true
    private boolean buildFailed    = false

    @Override
    void started(BuildOperationDescriptor descriptor, OperationStartEvent start) {}

    @Override
    void progress(OperationIdentifier id, OperationProgressEvent progress) {}

    @Override
    void finished(BuildOperationDescriptor descriptor, OperationFinishEvent finish) {
        if (descriptor.details in EvaluateSettingsBuildOperationType.Details) {
            configCacheHit = false
        }
        if (descriptor.metadata == BuildOperationCategory.RUN_WORK ||
            descriptor.metadata == BuildOperationCategory.CONFIGURE_PROJECT) {
            if (finish.failure != null) {
                buildFailed = true
            }
        }
    }

    @Override
    void close() {
        def captureRootDir = ${captureRootLiteral}
        def captureInvocationNamespace = "${DEFAULT_CAPTURE_INVOCATION_NAMESPACE}"
        def snapshot = [
            capturedAtEpochMillis: System.currentTimeMillis(),
            rootProjectName      : getParameters().getRootProjectName().get(),
            requestedTasks       : getParameters().getRequestedTasks().get(),
            gradleVersion        : GradleVersion.current().version,
            javaVersion          : System.getProperty("java.version") ?: "unknown",
            buildFailed          : buildFailed,
            configCacheHit       : configCacheHit,
        ]

        if (!captureRootDir) return

        try {
            def resultsDir  = new File(captureRootDir, "${BUILD_RESULTS_SUBDIRECTORY}")
            resultsDir.mkdirs()
            def resultsFile = new File(resultsDir, captureInvocationNamespace + getParameters().getInvocationId().get() + ".json")
            if (!resultsFile.exists()) {
                logger.lifecycle("buildish/mammoth-cache/gradle: Writing build results to ${'$'}{resultsFile}")
                resultsFile << groovy.json.JsonOutput.toJson(snapshot)
            }
        } catch (Exception ex) {
            println "buildish/mammoth-cache/gradle failed to write build-results file. Will continue. > ${'$'}{ex.getLocalizedMessage()}"
        }
    }
}
`;
}
