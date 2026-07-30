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
import type { NormalizedMavenConfig } from '../../config/types';
import type {
  BuiltInCachePartitionPreset,
  BuildReport,
  BuildToolAdapter,
  BuildToolProvisioning,
  ProvisionOptions,
} from '../types';

/**
 * Build-tool adapter for Apache Maven.
 *
 * Cache root: the Maven user home (`.m2` directory), defaulting to `~/.m2`.
 *
 * Built-in partitions:
 * - **repository** — the local Maven repository (`~/.m2/repository/**`); always enabled.
 * - **wrapper-dists** — Maven Wrapper distribution downloads (`~/.m2/wrapper/dists/**`); always
 *   enabled when the project uses `mvnw`.
 *
 * Hard excludes (applied unconditionally across every partition):
 * - `**\/*.lastUpdated` — stale remote-check markers; invalid across runners.
 * - `**\/_remote.repositories` — per-artifact remote-origin markers; can cause silent
 *   re-resolution on runners whose remote configuration differs from the build that populated
 *   the cache.
 * - `**\/*.lock` — transient resolver lock files; always runner-local.
 *
 * `provision()`, `installBuildHooks()`, and `collectBuildReport()` are intentional no-ops in v1.
 * Maven wrapper validation and Develocity / Maven Build Cache extension support are planned for a
 * future minor release.
 */
export class MavenBuildToolAdapter implements BuildToolAdapter {
  readonly #config: NormalizedMavenConfig;

  constructor(config: NormalizedMavenConfig) {
    this.#config = config;
  }

  getName(): string {
    return 'Maven';
  }

  getBuildToolId(): string {
    return 'maven';
  }

  getCacheRoot(): string {
    return this.#config.mavenLocalRepository;
  }

  getBuiltInPartitionPresets(): readonly BuiltInCachePartitionPreset[] {
    return MAVEN_BUILT_IN_PARTITION_PRESETS;
  }

  getHardCacheExcludeGlobs(): readonly string[] {
    return MAVEN_HARD_CACHE_EXCLUDE_GLOBS;
  }

  async provision(_options: ProvisionOptions): Promise<BuildToolProvisioning> {
    // Maven wrapper validation is not implemented in v1.
    // The `mvnw` script downloads its distribution on first use; the wrapper-dists partition
    // above will cache the download automatically on subsequent runs.
    return { items: [], warnings: [], additionalOutputs: {} };
  }

  async installBuildHooks(_context: CiJobContext): Promise<void> {
    // Maven does not support build-lifecycle hooks analogous to Gradle init scripts in v1.
    // Develocity / Maven Build Cache extension hook installation is planned for a later release.
  }

  async collectBuildReport(_context: CiJobContext): Promise<BuildReport> {
    // Build report collection (build scan links, per-invocation metadata) is not implemented
    // in v1 for Maven. A future release will add Develocity Maven extension support.
    return {
      anyBuildFailed: false,
      warnings: [],
      summaryLines: [],
      logLines: [],
      builds: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Static partition and exclusion configuration
// ---------------------------------------------------------------------------

const MAVEN_BUILT_IN_PARTITION_PRESETS: readonly BuiltInCachePartitionPreset[] = [
  {
    id: 'repository',
    displayName: 'Local repository',
    description:
      'Downloaded Maven dependency artifacts, plugins, and metadata stored in the local ' +
      'Maven repository.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['repository/**'],
    relativeExcludeGlobs: [],
  },
  {
    id: 'wrapper-dists',
    displayName: 'Maven Wrapper distributions',
    description:
      'Maven distributions downloaded by the Maven Wrapper (mvnw). Caching these avoids ' +
      're-downloading the Maven distribution archive on every run.',
    defaultEnabled: true,
    relativeIncludeGlobs: ['wrapper/dists/**'],
    relativeExcludeGlobs: [],
  },
];

/**
 * Glob patterns unconditionally excluded from every Maven cache partition.
 *
 * - `**\/*.lastUpdated`: written by Maven when a remote artifact check fails or succeeds.
 *   Restoring them on a different runner may suppress legitimate remote checks.
 * - `**\/resolver-status.properties`: written by Maven Resolver (Aether) at the group/artifact
 *   metadata level to track which remote repositories have been contacted and what status each
 *   returned.  Has the same per-runner semantics as `.lastUpdated` — restoring across runners
 *   causes stale remote-check suppression and produces different content across parallel worker
 *   jobs that both resolve Maven plugin metadata, making it a frequent distributed-merge conflict
 *   source.
 * - `**\/_remote.repositories`: records which remote repository each artifact was resolved from.
 *   On runners with a different repository configuration the markers can cause silent skips.
 * - `**\/*.lock`: transient file-locking artifacts used by the Maven resolver; always runner-local.
 */
const MAVEN_HARD_CACHE_EXCLUDE_GLOBS: readonly string[] = [
  '**/*.lastUpdated',
  '**/resolver-status.properties',
  '**/_remote.repositories',
  '**/*.lock',
];
