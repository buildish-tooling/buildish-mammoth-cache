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
/** Capture-root directory containing per-invocation build start JSON files. */
export const BUILD_STARTS_SUBDIRECTORY = 'build-starts';
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

/** Internal lifecycle target; summary eligibility never controls registration. */
export interface GradleOperationalCapture {
  readonly invocation: string;
  readonly directory: string;
  readonly layered?: boolean;
}

function operationalRegistration(options?: GradleOperationalCapture): string {
  if (!options) {
    return '';
  }
  if (!/^[a-f0-9]{64}$/.test(options.invocation)) {
    throw new Error('Invalid operational invocation.');
  }
  validateCaptureRootPath(options.directory);
  const directory = toGroovySingleQuotedString(options.directory),
    id = toGroovySingleQuotedString(options.invocation);
  // Protocol: docs/dev/cache-lifecycle-protocol.md#gradle-installation-registration.
  return `// Operational registration runs before every summary/service eligibility filter.
// Never probe the record before writing it: the configuration cache fingerprints file checks
// made here, so a record created by the first build would invalidate the second build's entry.
def operationalDirectory = new File(${directory}).toPath()
def operationalFailure = operationalDirectory.resolveSibling("registrations.failed.json")
try {
    def row = ["gradle-installation", 1, ${id},
        gradle.gradleHomeDir.canonicalPath, GradleVersion.current().version,
        gradle.gradleUserHomeDir.canonicalPath, new File(System.getProperty("java.home")).canonicalPath]

    // Fixed tuple canonical encoding uses only core APIs available before the
    // summary BuildService version gate. All controls use lower-case u00xx.
    def quote = { String value ->
        def out = new StringBuilder().append((char) 34)
        for (int n = 0; n < value.length(); n++) {
            int c = (int) value.charAt(n)
            if (Character.isHighSurrogate((char) c)) {
                if (n + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(n + 1))) {
                    throw new IOException("Unpaired operational path surrogate")
                }
                out.append((char) c).append(value.charAt(++n))
            } else if (Character.isLowSurrogate((char) c)) {
                throw new IOException("Unpaired operational path surrogate")
            } else if (c < 32) {
                out.append((char) 92).append('u')
                for (int shift = 12; shift >= 0; shift -= 4) {
                    out.append('0123456789abcdef'.charAt((c >> shift) & 15))
                }
            } else {
                if (c == 34 || c == 92) {
                    out.append((char) 92)
                }
                out.append((char) c)
            }
        }
        out.append((char) 34).toString()
    }
    byte[] json = ('[' + row.collect { v -> v instanceof Number ? v.toString() : quote(v.toString()) }.join(',') + ']').getBytes("UTF-8")
    if (json.length + 1 > 65536) {
        throw new IOException("Operational registration exceeds record bound")
    }

    // The record name is its framed SHA-256 digest, so equal tuples share one name.
    def digest = java.security.MessageDigest.getInstance("SHA-256")
    digest.update("mammoth:gradle-installation:1".getBytes("UTF-8"))
    digest.update((byte) 0)
    digest.update(java.nio.ByteBuffer.allocate(8).putLong(json.length).array())
    digest.update(json)
    def name = digest.digest().encodeHex().toString() + ".json"

    java.nio.file.Files.createDirectories(operationalDirectory)
    if (operationalDirectory.toRealPath() != operationalDirectory.toAbsolutePath().normalize()) {
        throw new IOException("Operational registration traverses a link")
    }

    // Canonical records end with a single LF.
    byte[] bytes = java.util.Arrays.copyOf(json, json.length + 1)
    bytes[json.length] = (byte) 10

    // Publish through an atomic rename, so a record under its name is always complete.
    // Repeated or concurrent builds of the same installation replace it with identical bytes;
    // the consumer validates every record's name, schema and digest.
    def temp = java.nio.file.Files.createTempFile(operationalDirectory, ".registration-", ".candidate")
    try {
        def channel = java.nio.channels.FileChannel.open(temp, java.nio.file.StandardOpenOption.WRITE)
        try {
            def buffer = java.nio.ByteBuffer.wrap(bytes)
            while (buffer.hasRemaining()) {
                channel.write(buffer)
            }
        } finally {
            channel.close()
        }
        java.nio.file.Files.move(temp, operationalDirectory.resolve(name), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
    } finally {
        java.nio.file.Files.deleteIfExists(temp)
    }
} catch (Exception failure) {
    // A single sticky failure witness prevents another successful build from hiding this failure.
    boolean recorded = false
    try {
        byte[] json = ('["gradle-capture-failed",1,"' + ${id} + '"]').getBytes("UTF-8")
        byte[] bytes = java.util.Arrays.copyOf(json, json.length + 1)
        bytes[json.length] = (byte) 10

        // CREATE_NEW keeps the first witness; an existing one already records the failure.
        def channel = java.nio.channels.FileChannel.open(operationalFailure,
            java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE)
        try {
            def buffer = java.nio.ByteBuffer.wrap(bytes)
            while (buffer.hasRemaining()) {
                channel.write(buffer)
            }
        } finally {
            channel.close()
        }
        recorded = true
    } catch (java.nio.file.FileAlreadyExistsException known) {
        recorded = true
    } catch (Exception ignored) {
        // Unrecorded failure evidence fails the initialization below.
    }

    if (!recorded) {
        throw new org.gradle.api.GradleException("Mammoth operational registration failed without completed failure evidence", failure)
    }
    ${options.layered ? `throw new org.gradle.api.GradleException("Mammoth dependency layer registration failed", failure)` : ''}
    logger.warn("Mammoth operational registration failed; relocating cache save will be skipped", failure)
}
`;
}

/** Generates the Gradle init script after validating and safely encoding its capture root. */
export function createInitScriptContents(
  captureRoot: string | null,
  operational?: GradleOperationalCapture,
): string {
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

${operationalRegistration(operational)}
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

// Require Gradle 7.0 or newer for BuildService support
if (GradleVersion.current().baseVersion < GradleVersion.version("7.0")) {
    logger.warn("buildish/mammoth-cache/gradle: Gradle build-result capture requires Gradle 7.0+; current version is ${'$'}{GradleVersion.current().version}. Skipping capture.")
    return
}

// Test fixtures may deliberately fail. Their enclosing test task owns the outcome.
// Configure included-build projects too, even though their own results are not captured.
if (GradleVersion.current().baseVersion >= GradleVersion.version("8.8")) {
    gradle.lifecycle.beforeProject { project ->
        TestBuildResultCapture.suppress(project)
    }
} else {
    gradle.beforeProject { project ->
        TestBuildResultCapture.suppress(project)
    }
}

// Only the outermost Gradle invocation participates in capture
if (gradle.getParent() != null) {
    return
}

// The configuring build's invocation identifier. A configuration-cache hit restores it, so the
// recorder service replaces it with its own identifier for such builds.
def invocId = "-" + java.util.UUID.randomUUID().toString()

// Store the invocation identifier before applying the service plugin so it can read it.
// Its settingsEvaluated hook, which runs before the ones below, publishes the recorder service
// as gradle.ext.buildResultsRecorder.
gradle.ext.invocationId = invocId

// Record the start before settings evaluation. A build that fails before the recorder service
// is registered, or is interrupted, leaves a start without a matching result. A
// configuration-cache hit does not run init scripts, so it records a result without a start.
def startsRootDir = ${captureRootLiteral}
if (startsRootDir) {
    try {
        def startsDir = new File(startsRootDir, "${BUILD_STARTS_SUBDIRECTORY}").toPath()
        java.nio.file.Files.createDirectories(startsDir)
        def start = groovy.json.JsonOutput.toJson([requestedTasks: gradle.startParameter.taskNames.join(" ")])
        java.nio.file.Files.write(startsDir.resolve("${DEFAULT_CAPTURE_INVOCATION_NAMESPACE}" + invocId + ".json"),
            start.getBytes("UTF-8"), java.nio.file.StandardOpenOption.CREATE_NEW)
    } catch (Exception ex) {
        logger.warn("buildish/mammoth-cache/gradle: Could not record the build start. Will continue. > ${'$'}{ex.getLocalizedMessage()}")
    }
}

apply from: '${SERVICE_PLUGIN_FILE_NAME}'

// Attach scan-published / scan-error callbacks for settings-level plugins (Develocity / GE)
settingsEvaluated { settings ->
    def recorder = gradle.ext.buildResultsRecorder
    def onScanReady = {
        if (settings.extensions.findByName(DEVELOCITY_EXT)) {
            hookScanCallbacks(settings.extensions[DEVELOCITY_EXT].buildScan, recorder, invocId)
        } else if (settings.extensions.findByName(GE_EXT)) {
            hookScanCallbacks(settings.extensions[GE_EXT].buildScan, recorder, invocId)
        }
    }
    settings.pluginManager.withPlugin(GE_PLUGIN, onScanReady)
    settings.pluginManager.withPlugin(DEVELOCITY_PLUGIN) {
        if (settings.pluginManager.hasPlugin(GE_PLUGIN)) {
            return
        }
        onScanReady()
    }
}

// Attach scan-published / scan-error callbacks for project-level plugins (build-scan / Develocity)
projectsEvaluated { g ->
    def recorder = g.ext.buildResultsRecorder
    def onScanReady = {
        if (g.rootProject.extensions.findByName(DEVELOCITY_EXT)) {
            hookScanCallbacks(g.rootProject.extensions[DEVELOCITY_EXT].buildScan, recorder, invocId)
        } else if (g.rootProject.extensions.findByName(SCAN_EXT)) {
            hookScanCallbacks(g.rootProject.extensions[SCAN_EXT], recorder, invocId)
        }
    }
    g.rootProject.pluginManager.withPlugin(SCAN_PLUGIN, onScanReady)
    g.rootProject.pluginManager.withPlugin(DEVELOCITY_PLUGIN) {
        if (g.rootProject.pluginManager.hasPlugin(SCAN_PLUGIN)) {
            return
        }
        onScanReady()
    }
}

class TestBuildResultCapture {
    static void suppress(org.gradle.api.Project project) {
        project.tasks.withType(org.gradle.api.tasks.testing.Test).configureEach { task ->
            task.environment("${SKIP_CAPTURE_ENVIRONMENT_VARIABLE}", "true")
        }
    }
}

// Register buildScanPublished / onError hooks on the given scan extension. They run at execution
// time, so they ask the recorder for the identifier of the build that is actually running.
void hookScanCallbacks(scanExt, recorder, String invocId) {
    def writer = new ScanResultsWriter()
    scanExt.with {
        buildScanPublished { scan ->
            writer.record("${BUILD_SCANS_SUBDIRECTORY}", recorder, invocId, [
                buildScanUri   : scan.buildScanUri.toASCIIString(),
                buildScanFailed: false,
            ])
        }
        onError { err ->
            writer.record("${BUILD_SCANS_SUBDIRECTORY}", recorder, invocId, [
                buildScanUri   : null,
                buildScanFailed: true,
            ])
        }
    }
}

class ScanResultsWriter {
    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")

    void record(String subDir, recorder, String configuredInvocId, def payload) {
        def captureRootDir = ${captureRootLiteral}
        def captureInvocationNamespace = "${DEFAULT_CAPTURE_INVOCATION_NAMESPACE}"

        if (!captureRootDir) {
            return
        }

        try {
            def invocId = configuredInvocId
            try {
                invocId = recorder.get().invocationId()
            } catch (Exception ex) {
                logger.warn("buildish/mammoth-cache/gradle: Build result recorder unavailable; using the configured invocation identifier", ex)
            }

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
    gradle.ext.buildResultsRecorder = svc
}

abstract class BuildResultsRecorder
        implements BuildService<BuildResultsRecorder.Params>, BuildOperationListener, AutoCloseable {

    interface Params extends BuildServiceParameters {
        Property<String> getRootProjectName()
        Property<String> getRequestedTasks()
        Property<String> getInvocationId()
    }

    private final logger = LoggerFactory.getLogger("buildish/mammoth-cache/gradle")

    // Each build creates its own instance, also when it reuses a configuration cache entry.
    private final String executionInvocationId = "-" + java.util.UUID.randomUUID().toString()
    private volatile boolean observed    = false
    private volatile boolean configured  = false
    private volatile boolean buildFailed = false

    /**
     * A configuration-cache hit restores the configuring build's parameters, including its
     * invocation identifier, so such a build uses this instance's own identifier instead.
     * An instance that has not observed any operation cannot tell and keeps the configured one.
     */
    String invocationId() {
        observed && !configured ? executionInvocationId : getParameters().getInvocationId().get()
    }

    @Override
    void started(BuildOperationDescriptor descriptor, OperationStartEvent start) {}

    @Override
    void progress(OperationIdentifier id, OperationProgressEvent progress) {}

    @Override
    void finished(BuildOperationDescriptor descriptor, OperationFinishEvent finish) {
        observed = true
        if (descriptor.details in EvaluateSettingsBuildOperationType.Details) {
            configured = true
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
            configCacheHit       : !configured,
        ]

        if (!captureRootDir) {
            return
        }

        try {
            def resultsDir  = new File(captureRootDir, "${BUILD_RESULTS_SUBDIRECTORY}")
            resultsDir.mkdirs()
            def resultsFile = new File(resultsDir, captureInvocationNamespace + invocationId() + ".json")
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
