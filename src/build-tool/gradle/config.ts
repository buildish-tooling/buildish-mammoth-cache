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
 * Gradle-specific action input reading, config-file resolution, and config normalization.
 *
 * Shared parsing utilities live in `../../config/config-helpers`; this module adds the
 * Gradle-only logic (wrapper selection, GRADLE_USER_HOME resolution, setup-java gating,
 * and the Gradle-specific config-file key set).
 */

import { readFile, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseSerializedJson } from '../../util/serialization';
import {
  JOB_MODES,
  RESTORE_CLEANUP_MODES,
  type NormalizedGradleConfig,
  type RawGradleActionInputs,
  type WrapperSelectionMode,
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

export type {
  InputProvider,
  NormalizeActionConfigOptions,
  ResolveActionInputsFromConfigFileOptions,
};

const EXPLICIT_PATH_GLOB_PATTERN = /[*?[\]{}!]/;
const CACHE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads every Gradle action input exactly once and returns the raw string values.
 */
export function readGradleActionInputs(inputProvider: InputProvider): RawGradleActionInputs {
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
    processAllWrapperFiles: inputProvider.getInput('process-all-wrapper-files', {
      trimWhitespace: true,
    }),
    wrapperPropertiesGlob: inputProvider.getInput('wrapper-properties-glob', {
      trimWhitespace: true,
    }),
    wrapperPropertiesFiles: inputProvider.getInput('wrapper-properties-files', {
      trimWhitespace: true,
    }),
    cleanupEnabled: inputProvider.getInput('cleanup-enabled', { trimWhitespace: true }),
    restoreCleanupMode: inputProvider.getInput('restore-cleanup-mode', { trimWhitespace: true }),
    gradleUserHome: inputProvider.getInput('gradle-user-home', { trimWhitespace: true }),
    setupJava: inputProvider.getInput('setup-java', { trimWhitespace: true }),
    githubToken: inputProvider.getInput('github-token', { trimWhitespace: true }),
  };
}

/**
 * Overlays file-backed configuration onto direct action inputs.
 *
 * Direct action inputs always win over file-backed values, so workflows can keep local defaults
 * in a committed config file while retaining per-job overrides in workflow YAML.
 */
export async function resolveGradleActionInputsFromConfigFile(
  directInputs: RawGradleActionInputs,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<RawGradleActionInputs> {
  const configFile = directInputs.configFile.trim();
  if (configFile.length === 0) return directInputs;

  const normalizedConfigFile = normalizeRelativePath(configFile, 'config-file');
  if (normalizedConfigFile === '.') {
    throw new Error(
      'config-file must point to a .json, .yml, or .yaml file inside the repository workspace.',
    );
  }

  const configFilePath = await resolveConfigFilePath(
    options.workspace,
    normalizedConfigFile,
    options,
  );
  const contents = await readConfigFileContents(configFilePath, normalizedConfigFile, options);
  const fileInputs = serializeConfigFileInputs(
    parseConfigFileContents(contents, normalizedConfigFile),
    normalizedConfigFile,
  );
  return overlayConfiguredInputs(fileInputs, directInputs);
}

/**
 * Validates and normalizes raw Gradle action inputs into the internal runtime config.
 */
export function normalizeGradleActionConfig(
  rawInputs: RawGradleActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedGradleConfig {
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
    rawInputs.cacheKeyPrefix || 'buildish-mammoth-gradle-cache-',
  );
  const cacheKeyTemplate = validateCacheKeyTemplate(rawInputs.cacheKeyTemplate);
  const cachePartitions = parseCachePartitionsInput(rawInputs.cachePartitions);
  const processAllWrapperFiles = parseBooleanInput(
    rawInputs.processAllWrapperFiles || 'false',
    'process-all-wrapper-files',
  );
  const explicitWrapperPropertiesFiles = parseListInput(rawInputs.wrapperPropertiesFiles).map(
    (filePath) => resolveWrapperPropertiesPath(baseDirectory, filePath),
  );
  const wrapperSelectionMode = determineWrapperSelectionMode(
    processAllWrapperFiles,
    explicitWrapperPropertiesFiles.length,
  );
  const wrapperPropertiesGlob = resolveGlobPattern(
    baseDirectory,
    rawInputs.wrapperPropertiesGlob || '**/gradle/wrapper/gradle-wrapper.properties',
  );
  const cleanupEnabled = parseBooleanInput(rawInputs.cleanupEnabled || 'true', 'cleanup-enabled');
  const restoreCleanupMode = parseEnumInput(
    rawInputs.restoreCleanupMode || 'none',
    RESTORE_CLEANUP_MODES,
    'restore-cleanup-mode',
  );
  const readOnly =
    rawInputs.readOnly.length > 0
      ? parseBooleanInput(rawInputs.readOnly, 'read-only')
      : defaultReadOnlyForEvent(options.ciContext.eventName);
  const gradleUserHome = normalizeGradleUserHome(rawInputs.gradleUserHome, options.env);
  const setupJava = parseBooleanInput(rawInputs.setupJava || 'false', 'setup-java');

  if (dependentJobs.length > 0 && jobMode === 'standalone') {
    throw new Error('dependent-jobs can only be used with distributed job modes.');
  }
  if (setupJava) {
    throw new Error(
      'setup-java=true is not supported in v1. Run actions/setup-java before this action instead.',
    );
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
    wrapperSelectionMode,
    wrapperPropertiesGlob,
    defaultWrapperPropertiesFile: joinWithinBaseDirectory(
      baseDirectory,
      'gradle/wrapper/gradle-wrapper.properties',
    ),
    wrapperPropertiesFiles: explicitWrapperPropertiesFiles,
    cleanupEnabled,
    restoreCleanupMode,
    gradleUserHome,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function createEmptyRawGradleActionInputs(): RawGradleActionInputs {
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
    processAllWrapperFiles: '',
    wrapperPropertiesGlob: '',
    wrapperPropertiesFiles: '',
    cleanupEnabled: '',
    restoreCleanupMode: '',
    gradleUserHome: '',
    setupJava: '',
    githubToken: '',
  };
}

async function resolveConfigFilePath(
  workspace: string,
  normalizedConfigFile: string,
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<string> {
  const realpathImpl = options.realpathImpl ?? realpath;
  const workspaceRealPath = await resolveRealPath(realpathImpl, workspace, 'workspace');
  const candidatePath = path.resolve(workspaceRealPath, normalizedConfigFile);
  const configFileRealPath = await resolveRealPath(
    realpathImpl,
    candidatePath,
    `config-file '${normalizedConfigFile}'`,
  );
  if (!isPathInside(workspaceRealPath, configFileRealPath)) {
    throw new Error(
      `config-file '${normalizedConfigFile}' must stay within the repository workspace after symlink resolution.`,
    );
  }
  return configFileRealPath;
}

async function resolveRealPath(
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

async function readConfigFileContents(
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

function parseConfigFileContents(
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
  return validateRecord(parsed, `config-file '${normalizedConfigFile}'`);
}

function validateRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function validateArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function serializeConfigFileInputs(
  values: Record<string, unknown>,
  normalizedConfigFile: string,
): RawGradleActionInputs {
  const inputs: Record<keyof RawGradleActionInputs, string> = createEmptyRawGradleActionInputs();
  for (const [key, value] of Object.entries(values)) {
    switch (key) {
      case 'config-file':
        throw new Error(
          `config-file '${normalizedConfigFile}' must not contain nested config-file entries.`,
        );
      case 'base-directory':
        inputs.baseDirectory = serializeStringConfigValue(value, key);
        break;
      case 'cache-enabled':
        inputs.cacheEnabled = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'read-only':
        inputs.readOnly = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'job-mode':
        inputs.jobMode = serializeStringConfigValue(value, key);
        break;
      case 'dependent-jobs':
        inputs.dependentJobs = serializeListLikeConfigValue(value, key);
        break;
      case 'allow-duplicate-dependent-delta-paths':
        inputs.allowDuplicateDependentDeltaPaths = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'cache-key-prefix':
        inputs.cacheKeyPrefix = serializeStringConfigValue(value, key);
        break;
      case 'cache-key-template':
        inputs.cacheKeyTemplate = serializeStringConfigValue(value, key);
        break;
      case 'cache-partitions':
        inputs.cachePartitions = serializeStructuredConfigValue(value, key);
        break;
      case 'process-all-wrapper-files':
        inputs.processAllWrapperFiles = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'wrapper-properties-glob':
        inputs.wrapperPropertiesGlob = serializeStringConfigValue(value, key);
        break;
      case 'wrapper-properties-files':
        inputs.wrapperPropertiesFiles = serializeListLikeConfigValue(value, key);
        break;
      case 'cleanup-enabled':
        inputs.cleanupEnabled = serializeBooleanLikeConfigValue(value, key);
        break;
      case 'restore-cleanup-mode':
        inputs.restoreCleanupMode = serializeStringConfigValue(value, key);
        break;
      case 'gradle-user-home':
        inputs.gradleUserHome = serializeStringConfigValue(value, key);
        break;
      case 'setup-java':
        inputs.setupJava = serializeBooleanLikeConfigValue(value, key);
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

function serializeStringConfigValue(value: unknown, label: string): string {
  return validateString(value, label).trim();
}

function serializeBooleanLikeConfigValue(value: unknown, label: string): string {
  return typeof value === 'boolean' ? String(value) : serializeStringConfigValue(value, label);
}

function serializeListLikeConfigValue(value: unknown, label: string): string {
  if (typeof value === 'string') return value.trim();
  return validateArray(value, label)
    .map((entry, index) => validateString(entry, `${label} entry ${index}`).trim())
    .filter((entry) => entry.length > 0)
    .join('\n');
}

function serializeStructuredConfigValue(value: unknown, label: string): string {
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

function overlayConfiguredInputs(
  fileInputs: RawGradleActionInputs,
  directInputs: RawGradleActionInputs,
): RawGradleActionInputs {
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
    processAllWrapperFiles:
      directInputs.processAllWrapperFiles || fileInputs.processAllWrapperFiles,
    wrapperPropertiesGlob: directInputs.wrapperPropertiesGlob || fileInputs.wrapperPropertiesGlob,
    wrapperPropertiesFiles:
      directInputs.wrapperPropertiesFiles || fileInputs.wrapperPropertiesFiles,
    cleanupEnabled: directInputs.cleanupEnabled || fileInputs.cleanupEnabled,
    restoreCleanupMode: directInputs.restoreCleanupMode || fileInputs.restoreCleanupMode,
    gradleUserHome: directInputs.gradleUserHome || fileInputs.gradleUserHome,
    setupJava: directInputs.setupJava || fileInputs.setupJava,
    githubToken: directInputs.githubToken,
  };
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function determineWrapperSelectionMode(
  processAllWrapperFiles: boolean,
  explicitWrapperPropertiesFileCount: number,
): WrapperSelectionMode {
  if (processAllWrapperFiles && explicitWrapperPropertiesFileCount > 0) {
    throw new Error('process-all-wrapper-files cannot be combined with wrapper-properties-files.');
  }
  if (explicitWrapperPropertiesFileCount > 0) return 'explicit';
  if (processAllWrapperFiles) return 'all';
  return 'default';
}

function resolveWrapperPropertiesPath(baseDirectory: string, input: string): string {
  const normalizedRelativePath = normalizeRelativePath(input, 'wrapper-properties-files');
  if (EXPLICIT_PATH_GLOB_PATTERN.test(normalizedRelativePath)) {
    throw new Error(
      'wrapper-properties-files entries must be explicit file paths, not glob patterns.',
    );
  }
  if (path.posix.basename(normalizedRelativePath) !== 'gradle-wrapper.properties') {
    throw new Error(
      'wrapper-properties-files entries must point to gradle-wrapper.properties files.',
    );
  }
  return joinWithinBaseDirectory(baseDirectory, normalizedRelativePath);
}

function resolveGlobPattern(baseDirectory: string, input: string): string {
  return joinWithinBaseDirectory(
    baseDirectory,
    normalizeRelativePath(input, 'wrapper-properties-glob'),
  );
}

function joinWithinBaseDirectory(baseDirectory: string, relativePath: string): string {
  return baseDirectory === '.' ? relativePath : path.posix.join(baseDirectory, relativePath);
}

function normalizeGradleUserHome(input: string, env: NodeJS.ProcessEnv | undefined): string {
  const supportedDefault = env?.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
  const trimmed = input.trim();
  if (trimmed.length === 0) return supportedDefault;
  if (path.resolve(trimmed) !== path.resolve(supportedDefault)) {
    throw new Error(
      'Non-default gradle-user-home values are not supported in v1. Use the default GRADLE_USER_HOME location.',
    );
  }
  return supportedDefault;
}
