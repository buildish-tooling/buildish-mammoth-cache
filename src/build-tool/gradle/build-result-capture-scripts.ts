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
 * Generates the Gradle init script and service plugin used for per-invocation build reporting.
 *
 * Environment-derived paths are validated and encoded as non-interpolating Groovy string literals
 * before they enter executable source. Keep those controls in this module with the generated code.
 */

/** Capture-root directory containing per-invocation build result JSON files. */
export const BUILD_RESULTS_SUBDIRECTORY = 'build-results';
/** Capture-root directory containing per-invocation build scan JSON files. */
export const BUILD_SCANS_SUBDIRECTORY = 'build-scans';
/** File name installed into Gradle's `init.d` directory for capture orchestration. */
export const INIT_SCRIPT_FILE_NAME = 'buildish-mammoth-cache.build-result-capture.init.gradle';
/** File name installed beside the init script for the capture build service. */
export const SERVICE_PLUGIN_FILE_NAME =
  'buildish-mammoth-cache.build-result-capture-service.plugin.groovy';

const SKIP_CAPTURE_ENVIRONMENT_VARIABLE = 'BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE';
const DEFAULT_CAPTURE_INVOCATION_NAMESPACE = 'buildish-mammoth-cache';

/**
 * Characters that must never appear in a `captureRoot` path before it is embedded into
 * generated Groovy source. Their presence is a strong indicator of environment tampering.
 *
 * - `$`  — GString interpolation marker; harmless in single-quoted strings but suspicious.
 * - `` ` `` — Groovy slashy / multiline string marker; harmless here but suspicious.
 * - `\n`, `\r` — Newlines are invalid in filesystem paths on all supported platforms.
 * - `\0` — NUL bytes are invalid in filesystem paths everywhere.
 */
const SUSPICIOUS_CAPTURE_ROOT_CHARS = /[$`\n\r\0]/u;

/**
 * Throws if `captureRoot` contains characters that cannot legitimately appear in a
 * CI temp-directory path. This is a defence-in-depth check; the primary injection
 * protection comes from {@link toGroovySingleQuotedString}.
 *
 * Exported so that it can be exercised directly in unit tests.
 */
export function validateCaptureRootPath(captureRoot: string): void {
  if (SUSPICIOUS_CAPTURE_ROOT_CHARS.test(captureRoot)) {
    throw new Error(
      `The build capture root path '${captureRoot}' contains characters that are not ` +
        `permitted in a CI temp-directory path. ` +
        `Check that RUNNER_TEMP does not include shell-expansion markers or control characters.`,
    );
  }
}

/**
 * Encodes a filesystem path as a **single-quoted** Groovy string literal.
 *
 * Single-quoted strings in Groovy are plain {@code java.lang.String} values — they do NOT
 * support `${…}` GString interpolation. This makes them safe to construct from values that
 * originate in the environment (such as `RUNNER_TEMP`), where an attacker might attempt to
 * inject Groovy expressions via `${…}` sequences.
 *
 * The only characters with special meaning inside a Groovy single-quoted string are the
 * backslash escape (`\\`) and the closing delimiter (`\'`); both are escaped here.
 *
 * Exported so that it can be exercised directly in unit tests.
 */
export function toGroovySingleQuotedString(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  return `'${escaped}'`;
}

/** Generates the Gradle init script after validating and safely encoding its capture root. */
export function createInitScriptContents(captureRoot: string | null): string {
  // Use a single-quoted Groovy string (not a GString) so that ${…} sequences in the path
  // cannot be interpreted as Groovy expression interpolation.
  if (captureRoot) {
    validateCaptureRootPath(captureRoot);
  }
  const captureRootLiteral = captureRoot ? toGroovySingleQuotedString(captureRoot) : 'null';

  return `/*
 * Buildish Mammoth Cache for Gradle — per-invocation build result capture
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

/** Generates the Gradle service plugin after validating and safely encoding its capture root. */
export function createServicePluginContents(captureRoot: string | null): string {
  // Use a single-quoted Groovy string (not a GString) so that ${…} sequences in the path
  // cannot be interpreted as Groovy expression interpolation.
  if (captureRoot) {
    validateCaptureRootPath(captureRoot);
  }
  const captureRootLiteral = captureRoot ? toGroovySingleQuotedString(captureRoot) : 'null';

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
