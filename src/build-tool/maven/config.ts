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

/**
 * Maven-specific action input reading, config-file resolution, and config normalization.
 *
 * Shared parsing utilities live in `../../config/config-helpers`; this module adds the
 * Maven-only logic (MAVEN_USER_HOME / maven-local-repository resolution and the
 * Maven-specific config-file key set).
 */

import { readFile, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseSerializedJson } from '../../util/serialization';
import {
  CACHE_GC_MODES,
  JOB_MODES,
  RESTORE_CLEANUP_MODES,
  type NormalizedMavenConfig,
  type RawMavenActionInputs,
} from '../../config/types';
import {
  type InputProvider,
  type NormalizeActionConfigOptions,
  type ResolveActionInputsFromConfigFileOptions,
} from '../../config/types';
import {
  parseBooleanInput,
  parseEnumInput,
  parseListInput,
  validateNamedValue,
} from '../../util/action-input';
import {
  defaultReadOnlyForEvent,
  normalizeRelativePath,
  parseCachePartitionsInput,
  validateCacheKeyPrefix,
  validateCacheKeyTemplate,
} from '../../config/shared';

export type { NormalizeActionConfigOptions, ResolveActionInputsFromConfigFileOptions };

const CACHE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads every Maven action input exactly once and returns the raw string values.
 */
export function readMavenActionInputs(inputProvider: InputProvider): RawMavenActionInputs {
  return {
    configFile: inputProvider.getInput('config-file', { trimWhitespace: true }),
    baseDirectory: inputProvider.getInput('base-directory', { trimWhitespace: true }),
    cacheEnabled: inputProvider.getInput('cache-enabled', { trimWhitespace: true }),
    readOnly: inputProvider.getInput('read-only', { trimWhitespace: true }),
    jobMode: inputProvider.getInput('job-mode', { trimWhitespace: true }),
    dependentJobs: inputProvider.getInput('dependent-jobs', { trimWhitespace: true }),
    allowDuplicateDependentDeltaPaths: inputProvider.getInput(
      'allow-duplicate-dependent-delta-paths',
      { trimWhitespace: true },
    ),
    cacheKeyPrefix: inputProvider.getInput('cache-key-prefix', { trimWhitespace: true }),
    cacheKeyTemplate: inputProvider.getInput('cache-key-template', { trimWhitespace: true }),
    cachePartitions: inputProvider.getInput('cache-partitions', { trimWhitespace: true }),
    cleanupEnabled: inputProvider.getInput('cleanup-enabled', { trimWhitespace: true }),
    restoreCleanupMode: inputProvider.getInput('restore-cleanup-mode', { trimWhitespace: true }),
    cacheGcMode: inputProvider.getInput('cache-gc-mode', { trimWhitespace: true }),
    cacheGcOlderThanDays: inputProvider.getInput('cache-gc-older-than-days', {
      trimWhitespace: true,
    }),
    mavenLocalRepository: inputProvider.getInput('maven-local-repository', {
      trimWhitespace: true,
    }),
    githubToken: inputProvider.getInput('github-token', { trimWhitespace: true }),
  };
}

/**
 * Overlays file-backed configuration onto direct Maven action inputs.
 *
 * Direct action inputs always win over file-backed values.
 */
export async function resolveMavenActionInputsFromConfigFile(
  directInputs: RawMavenActionInputs,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<RawMavenActionInputs> {
  const configFile = directInputs.configFile.trim();
  if (configFile.length === 0) return directInputs;

  const normalizedConfigFile = normalizeRelativePath(configFile, 'config-file');
  if (normalizedConfigFile === '.') {
    throw new Error(
      'config-file must point to a .json, .yml, or .yaml file inside the repository workspace.',
    );
  }

  const configFilePath = await resolveMavenConfigFilePath(
    options.workspace,
    normalizedConfigFile,
    options,
  );
  const contents = await readMavenConfigFileContents(configFilePath, normalizedConfigFile, options);
  const fileInputs = serializeMavenConfigFileInputs(
    parseMavenConfigFileContents(contents, normalizedConfigFile),
    normalizedConfigFile,
  );
  return overlayMavenConfiguredInputs(fileInputs, directInputs);
}

/**
 * Validates and normalizes raw Maven action inputs into the internal runtime config.
 */
export function normalizeMavenActionConfig(
  rawInputs: RawMavenActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedMavenConfig {
  const baseDirectory = normalizeRelativePath(rawInputs.baseDirectory || '.', 'base-directory');
  const cacheEnabled = parseBooleanInput(rawInputs.cacheEnabled || 'true', 'cache-enabled');
  const jobMode = parseEnumInput(rawInputs.jobMode || 'standalone', JOB_MODES, 'job-mode');
  const dependentJobs = parseListInput(rawInputs.dependentJobs).map((jobName) =>
    validateNamedValue(jobName, 'dependent-jobs'),
  );
  const allowDuplicateDependentDeltaPaths = parseBooleanInput(
    rawInputs.allowDuplicateDependentDeltaPaths || 'false',
    'allow-duplicate-dependent-delta-paths',
  );
  const cacheKeyPrefix = validateCacheKeyPrefix(
    rawInputs.cacheKeyPrefix || 'buildish-mammoth-maven-cache-',
  );
  const cacheKeyTemplate = validateCacheKeyTemplate(rawInputs.cacheKeyTemplate);
  const cachePartitions = parseCachePartitionsInput(rawInputs.cachePartitions);
  const cleanupEnabled = parseBooleanInput(rawInputs.cleanupEnabled || 'true', 'cleanup-enabled');
  const restoreCleanupMode = parseEnumInput(
    rawInputs.restoreCleanupMode || 'none',
    RESTORE_CLEANUP_MODES,
    'restore-cleanup-mode',
  );
  const cacheGcMode = parseEnumInput(
    rawInputs.cacheGcMode || 'timestamp',
    CACHE_GC_MODES,
    'cache-gc-mode',
  );
  const cacheGcOlderThanDays = parseCacheGcOlderThanDays(rawInputs.cacheGcOlderThanDays || '14');
  const readOnly =
    rawInputs.readOnly.length > 0
      ? parseBooleanInput(rawInputs.readOnly, 'read-only')
      : defaultReadOnlyForEvent(options.ciContext.eventName);
  const mavenLocalRepository = normalizeMavenLocalRepository(
    rawInputs.mavenLocalRepository,
    options.env,
  );

  if (dependentJobs.length > 0 && jobMode === 'standalone') {
    throw new Error('dependent-jobs can only be used with distributed job modes.');
  }

  return {
    phase: options.phase,
    baseDirectory,
    cacheEnabled,
    readOnly,
    jobMode,
    dependentJobs,
    allowDuplicateDependentDeltaPaths,
    cacheKeyPrefix,
    cacheKeyTemplate,
    cachePartitions,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    cleanupEnabled,
    restoreCleanupMode,
    cacheGcMode,
    cacheGcOlderThanDays,
    mavenLocalRepository,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the Maven local repository path from input and environment, defaulting to `~/.m2`.
 */
function normalizeMavenLocalRepository(input: string, env: NodeJS.ProcessEnv | undefined): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return env?.MAVEN_USER_HOME ?? path.join(os.homedir(), '.m2');
  }
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) {
    throw new Error('maven-local-repository must resolve to an absolute path.');
  }
  return resolved;
}

async function resolveMavenConfigFilePath(
  workspace: string,
  normalizedConfigFile: string,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<string> {
  const realpathImpl = options.realpathImpl ?? realpath;
  const workspaceRealPath = await resolveMavenRealPath(realpathImpl, workspace, 'workspace');
  const candidatePath = path.resolve(workspaceRealPath, normalizedConfigFile);
  const configFileRealPath = await resolveMavenRealPath(
    realpathImpl,
    candidatePath,
    `config-file '${normalizedConfigFile}'`,
  );
  if (!isMavenPathInside(workspaceRealPath, configFileRealPath)) {
    throw new Error(
      `config-file '${normalizedConfigFile}' must stay within the repository workspace after symlink resolution.`,
    );
  }
  return configFileRealPath;
}

async function resolveMavenRealPath(
  realpathImpl: typeof realpath,
  targetPath: string,
  label: string,
): Promise<string> {
  try {
    return await realpathImpl(targetPath);
  } catch (error: unknown) {
    throw new Error(
      `Could not resolve ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readMavenConfigFileContents(
  configFilePath: string,
  normalizedConfigFile: string,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<string> {
  const readFileImpl = options.readFileImpl ?? readFile;
  try {
    const contents = await readFileImpl(configFilePath, 'utf8');
    return contents.replace(/^\uFEFF/u, '');
  } catch (error: unknown) {
    throw new Error(
      `Could not read config-file '${normalizedConfigFile}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseMavenConfigFileContents(
  contents: string,
  normalizedConfigFile: string,
): Record<string, unknown> {
  const extension = path.posix.extname(normalizedConfigFile).toLowerCase();
  let parsed: unknown;
  switch (extension) {
    case '.json':
      parsed = parseSerializedJson(contents, `config-file '${normalizedConfigFile}'`);
      break;
    case '.yaml':
    case '.yml':
      try {
        parsed = parseYaml(contents, {
          strict: true,
          stringKeys: true,
          uniqueKeys: true,
          merge: false,
          maxAliasCount: 0,
          prettyErrors: true,
        });
      } catch (error: unknown) {
        throw new Error(
          `Could not parse config-file '${normalizedConfigFile}': ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      break;
    default:
      throw new Error(
        `config-file '${normalizedConfigFile}' must use a .json, .yml, or .yaml extension.`,
      );
  }
  return validateMavenRecord(parsed, `config-file '${normalizedConfigFile}'`);
}

function serializeMavenConfigFileInputs(
  values: Record<string, unknown>,
  normalizedConfigFile: string,
): RawMavenActionInputs {
  const inputs: Record<keyof RawMavenActionInputs, string> = createEmptyRawMavenActionInputs();
  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case 'config-file':
        throw new Error(
          `config-file '${normalizedConfigFile}' must not contain nested config-file entries.`,
        );
      case 'base-directory':
        inputs.baseDirectory = serializeMavenStringValue(value, key);
        break;
      case 'cache-enabled':
        inputs.cacheEnabled = serializeMavenBooleanLikeValue(value, key);
        break;
      case 'read-only':
        inputs.readOnly = serializeMavenBooleanLikeValue(value, key);
        break;
      case 'job-mode':
        inputs.jobMode = serializeMavenStringValue(value, key);
        break;
      case 'dependent-jobs':
        inputs.dependentJobs = serializeMavenListLikeValue(value, key);
        break;
      case 'allow-duplicate-dependent-delta-paths':
        inputs.allowDuplicateDependentDeltaPaths = serializeMavenBooleanLikeValue(value, key);
        break;
      case 'cache-key-prefix':
        inputs.cacheKeyPrefix = serializeMavenStringValue(value, key);
        break;
      case 'cache-key-template':
        inputs.cacheKeyTemplate = serializeMavenStringValue(value, key);
        break;
      case 'cache-partitions':
        inputs.cachePartitions = serializeMavenStructuredValue(value, key);
        break;
      case 'cleanup-enabled':
        inputs.cleanupEnabled = serializeMavenBooleanLikeValue(value, key);
        break;
      case 'restore-cleanup-mode':
        inputs.restoreCleanupMode = serializeMavenStringValue(value, key);
        break;
      case 'cache-gc-mode':
        inputs.cacheGcMode = serializeMavenStringValue(value, key);
        break;
      case 'cache-gc-older-than-days':
        inputs.cacheGcOlderThanDays = serializeMavenNumberLikeValue(value, key);
        break;
      case 'maven-local-repository':
        inputs.mavenLocalRepository = serializeMavenStringValue(value, key);
        break;
      case 'github-token':
        throw new Error(
          `config-file '${normalizedConfigFile}' must not contain github-token. Pass it directly as an action input or environment secret instead.`,
        );
      default:
        throw new Error(
          `config-file '${normalizedConfigFile}' contains unsupported key '${key}'. Use the same kebab-case names as action inputs.`,
        );
    }
  }
  return inputs;
}

function overlayMavenConfiguredInputs(
  fileInputs: RawMavenActionInputs,
  directInputs: RawMavenActionInputs,
): RawMavenActionInputs {
  return {
    configFile: directInputs.configFile,
    baseDirectory: directInputs.baseDirectory || fileInputs.baseDirectory,
    cacheEnabled: directInputs.cacheEnabled || fileInputs.cacheEnabled,
    readOnly: directInputs.readOnly || fileInputs.readOnly,
    jobMode: directInputs.jobMode || fileInputs.jobMode,
    dependentJobs: directInputs.dependentJobs || fileInputs.dependentJobs,
    allowDuplicateDependentDeltaPaths:
      directInputs.allowDuplicateDependentDeltaPaths ||
      fileInputs.allowDuplicateDependentDeltaPaths,
    cacheKeyPrefix: directInputs.cacheKeyPrefix || fileInputs.cacheKeyPrefix,
    cacheKeyTemplate: directInputs.cacheKeyTemplate || fileInputs.cacheKeyTemplate,
    cachePartitions: directInputs.cachePartitions || fileInputs.cachePartitions,
    cleanupEnabled: directInputs.cleanupEnabled || fileInputs.cleanupEnabled,
    restoreCleanupMode: directInputs.restoreCleanupMode || fileInputs.restoreCleanupMode,
    cacheGcMode: directInputs.cacheGcMode || fileInputs.cacheGcMode,
    cacheGcOlderThanDays: directInputs.cacheGcOlderThanDays || fileInputs.cacheGcOlderThanDays,
    mavenLocalRepository: directInputs.mavenLocalRepository || fileInputs.mavenLocalRepository,
    githubToken: directInputs.githubToken,
  };
}

function createEmptyRawMavenActionInputs(): Record<keyof RawMavenActionInputs, string> {
  return {
    configFile: '',
    baseDirectory: '',
    cacheEnabled: '',
    readOnly: '',
    jobMode: '',
    dependentJobs: '',
    allowDuplicateDependentDeltaPaths: '',
    cacheKeyPrefix: '',
    cacheKeyTemplate: '',
    cachePartitions: '',
    cleanupEnabled: '',
    restoreCleanupMode: '',
    cacheGcMode: '',
    cacheGcOlderThanDays: '',
    mavenLocalRepository: '',
    githubToken: '',
  };
}

function isMavenPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function serializeMavenStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value.trim();
}

function serializeMavenBooleanLikeValue(value: unknown, label: string): string {
  if (typeof value === 'boolean') return String(value);
  return serializeMavenStringValue(value, label);
}

function serializeMavenNumberLikeValue(value: unknown, label: string): string {
  if (typeof value === 'number') return String(value);
  return serializeMavenStringValue(value, label);
}

function parseCacheGcOlderThanDays(input: string): number {
  const value = Number(input.trim());
  if (!Number.isFinite(value) || value < 2) {
    throw new Error('cache-gc-older-than-days must be a number greater than or equal to 2.');
  }
  return value;
}

function serializeMavenListLikeValue(value: unknown, label: string): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value
    .map((entry, index) => {
      if (typeof entry !== 'string') throw new Error(`${label} entry ${index} must be a string.`);
      return entry.trim();
    })
    .filter((entry) => entry.length > 0)
    .join('\n');
}

function serializeMavenStructuredValue(value: unknown, label: string): string {
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error(
      `Could not serialize ${label} from config-file: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validateMavenRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
