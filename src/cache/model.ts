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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { CiJobContext } from '../ci';
import type { BuildToolAdapter, BuiltInCachePartitionPreset } from '../build-tool/types';
import type { ConfiguredCachePartitionInput, NormalizedActionConfig } from '../config/types';
import { readJavaMajorFromReleaseFile, resolveJavaExecutablePath } from '../util/paths';
import { buildMinimalChildEnv } from '../util/spawn';

/**
 * Default cache key template used when the `cache-key-template` input is not set.
 *
 * Placeholders are resolved at runtime: `${cacheKeyPrefix}` (user-configurable prefix),
 * `${schemaVersion}` (schema bump counter), `${javaMajor}` (detected Java major version),
 * `${runnerOs}` / `${runnerArch}` (normalized runner platform), `${partitionFingerprint}`
 * (16-char SHA-256 of the active partition layout), and `${refName}` (cache-safe branch slug).
 */
export const DEFAULT_CACHE_KEY_TEMPLATE =
  '${cacheKeyPrefix}${schemaVersion}-${javaMajor}-${runnerOs}-${runnerArch}-${partitionFingerprint}-${refName}';
const CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;

/**
 * Fully derived cache identity and partition metadata for a single job execution.
 *
 * This object is the handoff point between bootstrap-time environment discovery and later
 * cache restore/save or delta-manifest logic.
 */
export interface CacheModel {
  /**
   * Fully resolved primary cache key for this job.
   *
   * Must satisfy the cache key constraints enforced by `CACHE_KEY_PATTERN`: only `[A-Za-z0-9._:-]`
   * characters and a maximum length of 512 characters.
   */
  readonly cacheKey: string;
  /**
   * The detected Java major version, derived from `$JAVA_HOME/release` or `java -version`.
   *
   * `null` when Java cannot be located at all; the cache key template renders this as `'0'`
   * so that jobs where Java is unavailable do not collide with jobs running a real version.
   */
  readonly javaMajor: number | null;
  /**
   * Normalized runner operating system, lower-cased by the CI adapter.
   *
   * Typical values include `linux`, `windows`, and `macos`.
   */
  readonly runnerOs: string;
  /**
   * Normalized runner architecture, lower-cased by the CI adapter.
   *
   * Typical values include `x64`, `arm64`, and `x86`.
   */
  readonly runnerArch: string;
  /**
   * Ref name sanitized for safe cache-key usage.
   *
   * This is derived by the CI adapter and excludes path separators or other cache-unsafe
   * characters.
   */
  readonly safeRefName: string;
  /**
   * Stable digest of the resolved active cache partition layout.
   *
   * The fingerprint changes when at least one of the active order of partitions, or the includes or excludes change and is
   * part of the base cache key, so different cache layouts do not collide.
   */
  readonly partitionFingerprint: string;
  /**
   * Stable machine-readable build tool identifier from the active {@link BuildToolAdapter}.
   *
   * Embedded in every cache manifest so that a manifest produced by one build tool (e.g. `'gradle'`)
   * is rejected with a clear error when read by a different build tool (e.g. `'maven'`).
   */
  readonly buildToolId: string;
  /**
   * Absolute path to the build tool's user home / cache root directory.
   *
   * Provided by the active {@link BuildToolAdapter}. Used as the base for all relative globs in
   * the partition definitions and as the root for manifest capture and delta application.
   */
  readonly cacheRoot: string;
  /**
   * Ordered logical cache partitions that make up the build tool cache model.
   *
   * Contains the active built-in partitions plus any custom partitions after overrides and opt-outs
   * have been resolved.
   */
  readonly partitions: readonly CachePartitionDefinition[];
  /**
   * Absolute include-globs aggregated from all partitions.
   *
   * These are passed to cache and filesystem operations in the listed order.
   */
  readonly includePaths: readonly string[];
  /**
   * Absolute exclude-globs aggregated and deduplicated from all partitions.
   *
   * Always includes the shared exclusions for configuration-cache content and `*.lock` files.
   */
  readonly excludePaths: readonly string[];
}

/**
 * Describes one logical slice of build tool cache content that should participate in cache
 * restore/save and later delta computation.
 *
 * Relative globs are stable identifiers for manifests and tests, while absolute globs are ready
 * to pass to filesystem or cache APIs for the current {@link CacheModel.cacheRoot}.
 */
export interface CachePartitionDefinition {
  /**
   * Stable machine-readable partition identifier.
   */
  readonly id: string;
  /** Short human-readable partition label for logs and summaries. */
  readonly displayName: string;
  /** Longer human-readable explanation of what the partition stores. */
  readonly description: string;
  /**
   * Partition include-globs relative to the build tool's cache root.
   *
   * These remain stable across machines and are preferred for manifests and tests.
   */
  readonly relativeIncludeGlobs: readonly string[];
  /**
   * Partition exclude-globs relative to the build tool's cache root.
   *
   * The effective list always contains the non-overridable hard safety excludes plus any
   * partition-specific excludes from the built-in preset or user override.
   */
  readonly relativeExcludeGlobs: readonly string[];
  /**
   * Absolute include-globs rooted under the effective cache root.
   *
   * These are the concrete paths used by cache restore/save operations for the current runner.
   */
  readonly absoluteIncludeGlobs: readonly string[];
  /**
   * Absolute exclude-globs rooted under the effective cache root.
   *
   * These mirror `relativeExcludeGlobs` after joining against the cache root.
   */
  readonly absoluteExcludeGlobs: readonly string[];
}

/**
 * Optional injection points for cache-model creation.
 *
 * Tests can replace command execution to avoid spawning `java`, and callers may supply a custom
 * environment when detection must not read from `process.env`.
 */
export interface CacheModelOptions {
  /**
   * Optional command runner override used for Java detection.
   *
   * Defaults to the internal child-process implementation when omitted.
   */
  readonly captureCommandOutput?: CommandOutputCapture;
  /**
   * Optional environment override used during Java detection.
   *
   * Defaults to `process.env` when omitted.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Minimal abstraction for commands whose combined stdout/stderr should be captured as text.
 *
 * The cache model currently uses this for Java version detection, but keeping it typed makes the
 * bootstrap path deterministic in tests and avoids coupling callers to `child_process` directly.
 *
 * @param command Executable name or absolute path. Defaults to `java` in the built-in caller.
 * @param args Command arguments, typically `['-version']` for Java detection.
 * @param env Optional environment to run with; if omitted, the current process environment is used.
 * @returns Combined stdout/stderr text from the completed command.
 */
export type CommandOutputCapture = (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

/**
 * Derives the cache key coordinates and partition definitions for the current job.
 */
export async function createCacheModel(
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  adapter: BuildToolAdapter,
  options: CacheModelOptions = {},
): Promise<CacheModel> {
  const javaMajor = await detectJavaMajor(
    options.captureCommandOutput ?? captureCombinedOutput,
    options.env,
  );
  const cacheRoot = adapter.getCacheRoot();
  const partitions = createCachePartitions(
    cacheRoot,
    config.cachePartitions,
    adapter.getBuiltInPartitionPresets(),
    adapter.getHardCacheExcludeGlobs(),
  );
  const partitionFingerprint = createPartitionFingerprint(
    partitions,
    adapter.getHardCacheExcludeGlobs(),
  );
  const cacheKey = renderCacheKey(config, ciContext, javaMajor, partitionFingerprint);

  return {
    cacheKey,
    buildToolId: adapter.getBuildToolId(),
    cacheRoot,
    javaMajor,
    runnerOs: ciContext.runnerOs,
    runnerArch: ciContext.runnerArch,
    safeRefName: ciContext.safeRefName,
    partitionFingerprint,
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: deduplicatePaths(
      partitions.flatMap((partition) => partition.absoluteExcludeGlobs),
    ),
  };
}

/**
 * Renders the effective cache key from either the restricted user template or the default.
 */
export function renderCacheKey(
  config: NormalizedActionConfig,
  ciContext: CiJobContext,
  javaMajor: number | null,
  partitionFingerprint: string,
): string {
  if (javaMajor !== null) {
    validateJavaMajor(javaMajor);
  }
  const template = config.cacheKeyTemplate ?? DEFAULT_CACHE_KEY_TEMPLATE;
  const placeholderValues: Record<string, string> = {
    cacheKeyPrefix: config.cacheKeyPrefix,
    schemaVersion: String(config.cacheSchemaVersion),
    partitionFingerprint,
    javaMajor: javaMajor !== null ? String(javaMajor) : '0',
    runnerOs: ciContext.runnerOs,
    runnerArch: ciContext.runnerArch,
    refName: ciContext.safeRefName,
  };
  const cacheKey = template.replaceAll(
    /\$\{([A-Za-z0-9]+)\}/g,
    (match, placeholderName: string) => {
      return placeholderValues[placeholderName] ?? match;
    },
  );

  if (!CACHE_KEY_PATTERN.test(cacheKey)) {
    throw new Error(
      'Resolved cache key contains unsupported characters or exceeds the 512 character limit.',
    );
  }

  return cacheKey;
}

/**
 * Parses `java -version` output into a supported Java major version.
 */
export function parseJavaMajor(versionOutput: string): number {
  const match = /version "((?:1\.)?[0-9]+)(?:[._][^"]*)?"/u.exec(versionOutput);

  if (!match) {
    throw new Error(`Unable to determine Java version from output:\n${versionOutput}`);
  }

  const versionToken = match[1];
  const javaMajor = versionToken.startsWith('1.')
    ? Number.parseInt(versionToken.slice(2), 10)
    : Number.parseInt(versionToken, 10);

  validateJavaMajor(javaMajor);
  return javaMajor;
}

/**
 * Computes the build tool cache partitions used by cache restore/save and delta tracking.
 *
 * Rules:
 * - built-ins are considered in stable preset order
 * - built-in overrides replace the preset include/exclude lists entirely
 * - built-ins with empty effective includes are disabled
 * - custom partitions are appended in declaration order and must keep at least one include glob
 */
export function createCachePartitions(
  cacheRoot: string,
  configuredPartitions: readonly ConfiguredCachePartitionInput[] = [],
  builtInPresets: readonly BuiltInCachePartitionPreset[] = [],
  hardCacheExcludeGlobs: readonly string[] = [],
): readonly CachePartitionDefinition[] {
  const builtInPresetIds = new Set(builtInPresets.map((preset) => preset.id));
  const configuredById = new Map(
    configuredPartitions.map((partition) => [partition.id, partition]),
  );
  const builtIns = builtInPresets.flatMap((preset) => {
    const override = configuredById.get(preset.id);
    if (!override && !preset.defaultEnabled) {
      return [];
    }

    const includeGlobs = deduplicatePaths(override?.includes ?? preset.relativeIncludeGlobs);
    if (includeGlobs.length === 0) {
      return [];
    }

    return [
      createPartition(
        preset.id,
        preset.displayName,
        preset.description,
        cacheRoot,
        includeGlobs,
        deduplicatePaths(override?.excludes ?? preset.relativeExcludeGlobs),
        hardCacheExcludeGlobs,
      ),
    ];
  });

  const customPartitions = configuredPartitions.flatMap((partition) => {
    if (builtInPresetIds.has(partition.id)) {
      return [];
    }
    if (partition.includes.length === 0) {
      throw new Error(
        `Custom cache partition '${partition.id}' must declare at least one include glob. Empty includes only disable built-in partitions.`,
      );
    }

    return [
      createPartition(
        partition.id,
        `Custom partition '${partition.id}'`,
        `User-defined build tool cache partition '${partition.id}'.`,
        cacheRoot,
        deduplicatePaths(partition.includes),
        deduplicatePaths(partition.excludes),
        hardCacheExcludeGlobs,
      ),
    ];
  });

  return [...builtIns, ...customPartitions];
}

async function detectJavaMajor(
  captureCommandOutput: CommandOutputCapture,
  env: NodeJS.ProcessEnv | undefined,
): Promise<number | null> {
  // Prefer reading the $JAVA_HOME/release file: no process spawn, no PATH dependency.
  const fromRelease = await readJavaMajorFromReleaseFile(env ?? process.env);
  if (fromRelease !== null) {
    return fromRelease;
  }

  // Fall back to running java -version. Resolve via JAVA_HOME first, then PATH.
  const javaCommand = await resolveJavaExecutablePath(env ?? process.env);
  let javaVersionOutput: string;
  try {
    javaVersionOutput = await captureCommandOutput(javaCommand, ['-version'], env);
  } catch {
    // Java is not available at all; return null so callers can degrade gracefully.
    return null;
  }

  try {
    return parseJavaMajor(javaVersionOutput);
  } catch {
    return null;
  }
}

async function captureCombinedOutput(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: buildMinimalChildEnv(env ?? process.env) });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`Unable to execute '${command} ${args.join(' ')}': ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`'${command} ${args.join(' ')}' terminated by signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(`'${command} ${args.join(' ')}' failed with exit code ${code}.\n${output}`),
        );
        return;
      }

      resolve(output);
    });
  });
}

function createPartition(
  id: CachePartitionDefinition['id'],
  displayName: string,
  description: string,
  cacheRoot: string,
  relativeIncludeGlobs: readonly string[],
  partitionRelativeExcludeGlobs: readonly string[],
  hardCacheExcludeGlobs: readonly string[],
): CachePartitionDefinition {
  const deduplicatedIncludeGlobs = deduplicatePaths(relativeIncludeGlobs);
  const relativeExcludeGlobs = deduplicatePaths([
    ...hardCacheExcludeGlobs,
    ...partitionRelativeExcludeGlobs,
  ]);

  return {
    id,
    displayName,
    description,
    relativeIncludeGlobs: deduplicatedIncludeGlobs,
    relativeExcludeGlobs,
    absoluteIncludeGlobs: deduplicatedIncludeGlobs.map((glob) => path.join(cacheRoot, glob)),
    absoluteExcludeGlobs: relativeExcludeGlobs.map((glob) => path.join(cacheRoot, glob)),
  };
}

function createPartitionFingerprint(
  partitions: readonly CachePartitionDefinition[],
  hardCacheExcludeGlobs: readonly string[],
): string {
  // Include the hard excludes and fully resolved ordered partition layout so cache keys diverge
  // whenever the managed cache surface changes.
  const serializedLayout = JSON.stringify({
    hardExcludes: hardCacheExcludeGlobs,
    partitions: partitions.map((partition) => ({
      id: partition.id,
      includes: partition.relativeIncludeGlobs,
      excludes: partition.relativeExcludeGlobs,
    })),
  });

  return createHash('sha256').update(serializedLayout).digest('hex').slice(0, 16);
}

function deduplicatePaths(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validateJavaMajor(javaMajor: number): void {
  if (!Number.isInteger(javaMajor) || javaMajor < 8) {
    throw new Error(`Unsupported Java major version '${javaMajor}'. Expected Java 8 or newer.`);
  }
}
