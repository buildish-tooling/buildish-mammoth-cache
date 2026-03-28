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

import type { CiJobContext } from '../../ci';
import type { NormalizedGradleConfig } from '../../config/types';
import type {
  BuildReport,
  BuildToolAdapter,
  BuildToolProvisioning,
  BuiltInCachePartitionPreset,
  ProvisionOptions,
} from '../types';
import {
  cleanupGradleBuildResultCapture,
  createGradleBuildSummaryLines,
  installGradleBuildResultCapture,
  loadGradleBuildReport,
  type GradleBuildReport,
} from './build-results';
import { provisionWrapperJars, type WrapperProvisionOptions } from './wrapper/download';
import { validateTargetWrapperProperties } from './wrapper/static-validation';

/**
 * Hard-exclude globs applied unconditionally across every Gradle cache partition.
 *
 * These paths are machine-specific, process-local, or security-sensitive and must
 * never be restored on a different runner.
 */
const GRADLE_HARD_CACHE_EXCLUDE_GLOBS: readonly string[] = [
  '**/configuration-cache/**', // Configuration cache: machine- and process-specific
  'caches/*/cc-keystore', // Configuration cache encryption key — security critical
  'caches/journal-1/**', // File-system access journal: not portable across runners
  '**/*.lock', // Lock files: invalid when restored on a different PID/host
];

/**
 * Built-in Gradle cache partition presets in stable resolution order.
 *
 * This order is user-visible: active built-ins are emitted first and custom partitions are
 * appended afterward. The ordered layout also contributes to the `partitionFingerprint`.
 * All globs are relative to `GRADLE_USER_HOME`.
 */
const GRADLE_BUILT_IN_CACHE_PARTITION_PRESETS: readonly BuiltInCachePartitionPreset[] = [
  {
    id: 'modules',
    displayName: 'Dependency modules',
    description:
      'Downloaded dependency artifacts, plugin jars, and shared resource stores reused across builds.',
    defaultEnabled: true,
    relativeIncludeGlobs: [
      'caches/modules-*/files-*/**',
      'caches/jars-*/**',
      'caches/resources-*/**',
    ],
    relativeExcludeGlobs: ['caches/modules-*/metadata-*/**'],
  },
  {
    id: 'transforms-metadata',
    displayName: 'Transforms and metadata',
    description:
      'Artifact transforms and related metadata that can be fast but environment-sensitive to reuse.',
    defaultEnabled: false,
    relativeIncludeGlobs: ['caches/transforms-*/**'],
    relativeExcludeGlobs: [],
  },
  {
    id: 'kotlin-dsl',
    displayName: 'Kotlin DSL caches',
    description: 'Compiled Kotlin DSL scripts and generated Gradle API jars.',
    defaultEnabled: true,
    relativeIncludeGlobs: [
      'caches/*/kotlin-dsl/**',
      'caches/*/scripts/**',
      'caches/*/generated-gradle-jars/**',
    ],
    relativeExcludeGlobs: [],
  },
  {
    id: 'build-cache',
    displayName: 'Local build cache',
    description: 'Reusable local task output cache entries maintained by Gradle.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['caches/build-cache-*/**'],
    relativeExcludeGlobs: [],
  },
  {
    id: 'wrapper-dists',
    displayName: 'Wrapper distributions',
    description:
      'Wrapper-downloaded Gradle distributions stored under the supported wrapper layout.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['wrapper/dists/**'],
    relativeExcludeGlobs: [],
  },
];

/**
 * Options for the {@link GradleBuildToolAdapter} constructor.
 *
 * All fields are optional overrides used primarily in tests to avoid real network calls
 * and GnuPG invocations.
 */
export interface GradleAdapterOptions {
  /**
   * Optional HTTP fetch implementation override passed to the wrapper downloader.
   *
   * Defaults to the runtime global `fetch`.
   */
  readonly fetchImpl?: WrapperProvisionOptions['fetchImpl'];
  /**
   * Optional detached-signature verifier override for focused wrapper tests.
   *
   * Defaults to the pinned Gradle signing-key verifier.
   */
  readonly verifyWrapperSignature?: WrapperProvisionOptions['verifyWrapperSignature'];
}

/**
 * {@link BuildToolAdapter} implementation for Gradle.
 *
 * Encapsulates Gradle-specific cache partition presets, hard excludes, wrapper JAR
 * provisioning with SHA-256 and PGP signature verification, init-script injection for
 * per-invocation build-result capture, and post-build report collection.
 */
export class GradleBuildToolAdapter implements BuildToolAdapter {
  readonly #config: NormalizedGradleConfig;
  readonly #options: GradleAdapterOptions;

  constructor(config: NormalizedGradleConfig, options: GradleAdapterOptions = {}) {
    this.#config = config;
    this.#options = options;
  }

  getName(): string {
    return 'Gradle';
  }

  getBuildToolId(): string {
    return 'gradle';
  }

  getCacheRoot(): string {
    return this.#config.gradleUserHome;
  }

  getBuiltInPartitionPresets(): readonly BuiltInCachePartitionPreset[] {
    return GRADLE_BUILT_IN_CACHE_PARTITION_PRESETS;
  }

  getHardCacheExcludeGlobs(): readonly string[] {
    return GRADLE_HARD_CACHE_EXCLUDE_GLOBS;
  }

  async provision(options: ProvisionOptions): Promise<BuildToolProvisioning> {
    const validatedWrappers = await validateTargetWrapperProperties(
      this.#config,
      options.workspace,
    );
    const provisionedWrappers = await provisionWrapperJars(validatedWrappers, {
      fetchImpl: this.#options.fetchImpl,
      httpHeadersByHost: options.httpHeadersByHost,
      logRetry: options.logRetry,
      verifyWrapperSignature: this.#options.verifyWrapperSignature,
    });

    const gradleVersions = [
      ...new Set(provisionedWrappers.map((wrapper) => wrapper.wrapperSourceVersion)),
    ].sort();
    const downloadedCount = provisionedWrappers.filter((w) => w.wasDownloaded).length;
    const reusedCount = provisionedWrappers.length - downloadedCount;

    return {
      items: provisionedWrappers.map((wrapper) => ({
        label: wrapper.relativePath,
        version: wrapper.wrapperSourceVersion,
        wasDownloaded: wrapper.wasDownloaded,
      })),
      warnings: [],
      additionalOutputs: {
        'wrapper-count': String(provisionedWrappers.length),
        'gradle-versions': gradleVersions.join(','),
        'wrapper-downloaded-count': String(downloadedCount),
        'wrapper-reused-count': String(reusedCount),
      },
    };
  }

  async installBuildHooks(context: CiJobContext): Promise<void> {
    await installGradleBuildResultCapture(this.#config.gradleUserHome, context);
  }

  async collectBuildReport(context: CiJobContext): Promise<BuildReport> {
    const [report, cleanupWarnings] = await Promise.all([
      loadGradleBuildReport(context),
      cleanupGradleBuildResultCapture(this.#config.gradleUserHome),
    ]);

    return buildReportFromGradleReport(report, cleanupWarnings);
  }
}

function buildReportFromGradleReport(
  report: GradleBuildReport,
  cleanupWarnings: readonly string[],
): BuildReport {
  const anyBuildFailed = report.builds.some((build) => build.buildFailed);
  const summaryLines = createGradleBuildSummaryLines(report);
  const logLines = createGradleBuildLogLines(report);

  return {
    anyBuildFailed,
    warnings: [...report.warnings, ...cleanupWarnings],
    summaryLines,
    logLines,
    builds: report.builds.map((build) => ({
      buildFailed: build.buildFailed,
      requestedTasks: build.requestedTasks || null,
      buildScanUri: build.buildScanUri,
      buildScanFailed: build.buildScanFailed,
    })),
  };
}

function createGradleBuildLogLines(report: GradleBuildReport): readonly string[] {
  if (report.builds.length === 0) {
    return ['No Gradle build invocations were captured.'];
  }

  return report.builds.map((build) => {
    const outcome = build.buildFailed ? 'FAILED' : 'SUCCESS';
    const configCache = build.configCacheHit ? ' (config-cache hit)' : ' (config-cache miss)';
    const scanSuffix = build.buildScanUri ? ` scan=${build.buildScanUri}` : '';
    return (
      `Gradle ${build.gradleVersion} ${outcome}${configCache}` +
      ` tasks='${build.requestedTasks}'` +
      ` project='${build.rootProjectName}'` +
      scanSuffix
    );
  });
}
