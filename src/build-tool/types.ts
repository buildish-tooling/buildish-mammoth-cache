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

import type { CiJobContext, HttpHeadersByHost } from '../ci';

/**
 * One entry in the built-in cache partition preset list supplied by a {@link BuildToolAdapter}.
 *
 * Presets are resolved in declaration order. A preset is disabled when either its
 * `defaultEnabled` flag is `false` and no user override exists, or when the effective
 * include list is empty after applying an override.
 */
export interface BuiltInCachePartitionPreset {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Whether this partition is included by default when the user supplies no override. */
  readonly defaultEnabled: boolean;
  /** Include globs relative to the build tool's cache root directory. */
  readonly relativeIncludeGlobs: readonly string[];
  /** Exclude globs relative to the build tool's cache root directory. */
  readonly relativeExcludeGlobs: readonly string[];
}

/**
 * One provisioned build-tool item (e.g. a verified wrapper JAR or downloaded distribution).
 *
 * Used in {@link BuildToolProvisioning} to summarize what the provisioning step did.
 */
export interface BuildToolProvisionItem {
  /** Human-readable description of the provisioned item (e.g. a relative path). */
  readonly label: string;
  /** Resolved tool version string (e.g. `"8.14"` for Gradle). */
  readonly version: string;
  /** Whether the item was freshly downloaded (`true`) or reused from a prior run (`false`). */
  readonly wasDownloaded: boolean;
}

/**
 * Result of the build-tool provisioning step executed during the bootstrap phase.
 */
export interface BuildToolProvisioning {
  /** Ordered list of items provisioned by the adapter. Empty when nothing was provisioned. */
  readonly items: readonly BuildToolProvisionItem[];
  /** Non-fatal warnings encountered during provisioning. */
  readonly warnings: readonly string[];
  /** Additional CI output key-value pairs contributed by the adapter (tool-specific outputs). */
  readonly additionalOutputs: Record<string, string>;
}

/**
 * Options supplied by bootstrap to {@link BuildToolAdapter.provision}.
 */
export interface ProvisionOptions {
  /** Absolute path to the repository workspace root. */
  readonly workspace: string;
  /**
   * Per-host HTTP headers for authenticated downloads (e.g. private artifact registries).
   *
   * This is the exact type supplied by {@link CiPlatformAdapter.httpHeadersByHost}.
   */
  readonly httpHeadersByHost: HttpHeadersByHost;
  /** Callback for retry-related log messages during download operations. */
  readonly logRetry: (message: string) => void;
}

/**
 * A generic descriptor for a single captured build invocation.
 *
 * Adapters populate this for each captured build so that integration scripts and reporting
 * logic can introspect individual build outcomes without depending on the concrete adapter type.
 */
export interface CapturedBuildItem {
  /** Whether this build invocation was reported as failed. */
  readonly buildFailed: boolean;
  /** The tasks or targets that were requested for this invocation, if known. */
  readonly requestedTasks: string | null;
  /** A URL pointing to a published build scan or equivalent telemetry artifact, if available. */
  readonly buildScanUri: string | null;
  /** Whether a build scan was attempted but failed to publish. */
  readonly buildScanFailed: boolean;
}

/**
 * Build report produced by {@link BuildToolAdapter.collectBuildReport}.
 *
 * The adapter is responsible for generating its own tool-specific Markdown and log lines;
 * the finalize phase inserts them verbatim into the job summary and log group.
 */
export interface BuildReport {
  /** Whether at least one build invocation in this report failed. */
  readonly anyBuildFailed: boolean;
  /** Non-fatal warnings to surface in the finalize summary. */
  readonly warnings: readonly string[];
  /** Markdown lines for the tool-specific section of the finalize job summary. */
  readonly summaryLines: readonly string[];
  /** Plain-text lines for the tool-specific section of the finalize log group. */
  readonly logLines: readonly string[];
  /**
   * Per-invocation metadata for each captured build.
   *
   * Populated by the adapter; allows callers to introspect individual build outcomes,
   * Build Scan publication status, and requested tasks without depending on the concrete
   * adapter type.
   */
  readonly builds: readonly CapturedBuildItem[];
}

/**
 * Abstraction over a specific JVM build tool (Gradle, Maven, …).
 *
 * Each build-tool adapter encapsulates:
 * - the location of its user/home directory (the cache root),
 * - the built-in cache partition presets and hard exclusion globs,
 * - tool-specific provisioning (wrapper JAR verification, distribution download),
 * - build hook installation / cleanup (init scripts, lifecycle extensions), and
 * - post-build result collection (build reports, scan links).
 *
 * The shared phase logic calls the adapter methods at well-defined points in the
 * prepare/finalize lifecycle without importing any tool-specific modules directly.
 */
export interface BuildToolAdapter {
  /** Human-readable tool name used in log output and job summaries (e.g. `"Gradle"`). */
  getName(): string;

  /**
   * Stable machine-readable build tool identifier embedded in every cache manifest.
   *
   * The value must be a lowercase ASCII string (e.g. `'gradle'`, `'maven'`). It is baked into
   * the adapter implementation — never supplied by user configuration — so a mismatched manifest
   * from a different build tool is detected with a clear error rather than producing silent
   * cache corruption.
   */
  getBuildToolId(): string;

  /** Absolute path to the build tool's user home / cache root directory. */
  getCacheRoot(): string;

  /**
   * Built-in cache partition presets in their stable resolution order.
   *
   * Custom partitions configured by the user are appended after these.
   */
  getBuiltInPartitionPresets(): readonly BuiltInCachePartitionPreset[];

  /**
   * Glob patterns unconditionally excluded from every cache partition.
   *
   * These cannot be overridden by user configuration and protect against
   * caching files that are unsafe to restore on a different runner.
   */
  getHardCacheExcludeGlobs(): readonly string[];

  /**
   * Validates and provisions the build tool before the build starts.
   *
   * Called during the prepare-phase bootstrap, after the base cache has been restored.
   * Implementations should verify wrapper/distribution integrity and download any
   * missing artifacts.
   *
   * @returns A {@link BuildToolProvisioning} summary of what was validated and downloaded.
   */
  provision(options: ProvisionOptions): Promise<BuildToolProvisioning>;

  /**
   * Installs any build hook needed to capture per-invocation build metadata.
   *
   * Called during the prepare phase, after bootstrap completes.
   * For Gradle this installs the build-result-capture init script.
   * Failures are expected to be caught and logged as non-fatal by the caller.
   */
  installBuildHooks(context: CiJobContext): Promise<void>;

  /**
   * Collects the build report and cleans up any installed build hooks.
   *
   * Called at the start of the finalize phase, before the post-build manifest is captured.
   * Returns a {@link BuildReport} whose summary and log lines the finalize phase embeds
   * directly into the job summary and log group.
   */
  collectBuildReport(context: CiJobContext): Promise<BuildReport>;
}
