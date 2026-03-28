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
 * Gradle-specific action input reading, config-file resolution, and config normalization.
 *
 * Shared input loading and normalization live in `../../config/inputs` and
 * `../../config/normalize`; this module retains wrapper selection, GRADLE_USER_HOME resolution,
 * and setup-java gating.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import {
  type NormalizedGradleConfig,
  type RawGradleActionInputs,
  type WrapperSelectionMode,
} from '../../config/types';
import {
  type InputProvider,
  type NormalizeActionConfigOptions,
  type ResolveActionInputsFromConfigFileOptions,
} from '../../config/types';
import { parseBooleanInput, parseListInput } from '../../util/action-input';
import { normalizeRelativePath } from '../../config/shared';
import { readActionInputs, resolveActionInputsFromConfigFile } from '../../config/inputs';
import { normalizeSharedActionConfig } from '../../config/normalize';

export type {
  InputProvider,
  NormalizeActionConfigOptions,
  ResolveActionInputsFromConfigFileOptions,
};

const EXPLICIT_PATH_GLOB_PATTERN = /[*?[\]{}!]/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads every Gradle action input exactly once and returns the raw string values.
 */
export function readGradleActionInputs(inputProvider: InputProvider): RawGradleActionInputs {
  return readActionInputs('gradle', inputProvider);
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
  return resolveActionInputsFromConfigFile('gradle', directInputs, options);
}

/**
 * Validates and normalizes raw Gradle action inputs into the internal runtime config.
 */
export function normalizeGradleActionConfig(
  rawInputs: RawGradleActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedGradleConfig {
  const sharedConfig = normalizeSharedActionConfig(rawInputs, options);
  const processAllWrapperFiles = parseBooleanInput(
    rawInputs.processAllWrapperFiles || 'false',
    'process-all-wrapper-files',
  );
  const explicitWrapperPropertiesFiles = parseListInput(rawInputs.wrapperPropertiesFiles).map(
    (filePath) => resolveWrapperPropertiesPath(sharedConfig.baseDirectory, filePath),
  );
  const wrapperSelectionMode = determineWrapperSelectionMode(
    processAllWrapperFiles,
    explicitWrapperPropertiesFiles.length,
  );
  const wrapperPropertiesGlob = resolveGlobPattern(
    sharedConfig.baseDirectory,
    rawInputs.wrapperPropertiesGlob || '**/gradle/wrapper/gradle-wrapper.properties',
  );
  const gradleUserHome = normalizeGradleUserHome(rawInputs.gradleUserHome, options.env);
  const setupJava = parseBooleanInput(rawInputs.setupJava || 'false', 'setup-java');

  if (setupJava) {
    throw new Error(
      'setup-java=true is not supported in v1. Run actions/setup-java before this action instead.',
    );
  }

  return {
    ...sharedConfig,
    wrapperSelectionMode,
    wrapperPropertiesGlob,
    defaultWrapperPropertiesFile: joinWithinBaseDirectory(
      sharedConfig.baseDirectory,
      'gradle/wrapper/gradle-wrapper.properties',
    ),
    wrapperPropertiesFiles: explicitWrapperPropertiesFiles,
    gradleUserHome,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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
