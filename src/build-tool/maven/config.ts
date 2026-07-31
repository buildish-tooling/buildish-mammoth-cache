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
 * Maven-specific action input reading, config-file resolution, and config normalization.
 *
 * Shared input loading and normalization live in `../../config/inputs` and
 * `../../config/normalize`; this module retains MAVEN_USER_HOME / maven-user-home resolution.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { type NormalizedMavenConfig, type RawMavenActionInputs } from '../../config/types';
import {
  type InputProvider,
  type NormalizeActionConfigOptions,
  type ResolveActionInputsFromConfigFileOptions,
} from '../../config/types';
import { readActionInputs, resolveActionInputsFromConfigFile } from '../../config/inputs';
import { normalizeSharedActionConfig } from '../../config/normalize';

export type { NormalizeActionConfigOptions, ResolveActionInputsFromConfigFileOptions };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads every Maven action input exactly once and returns the raw string values.
 */
export function readMavenActionInputs(inputProvider: InputProvider): RawMavenActionInputs {
  return readActionInputs('maven', inputProvider);
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
  return resolveActionInputsFromConfigFile('maven', directInputs, options);
}

/**
 * Validates and normalizes raw Maven action inputs into the internal runtime config.
 */
export function normalizeMavenActionConfig(
  rawInputs: RawMavenActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedMavenConfig {
  const sharedConfig = normalizeSharedActionConfig(rawInputs, options);
  const mavenUserHome = normalizeMavenUserHome(rawInputs.mavenUserHome, options.env);

  return {
    ...sharedConfig,
    mavenUserHome,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the Maven user home from input and environment, defaulting to `~/.m2`.
 */
function normalizeMavenUserHome(input: string, env: NodeJS.ProcessEnv | undefined): string {
  const configuredPath =
    input.trim() || env?.MAVEN_USER_HOME?.trim() || path.join(os.homedir(), '.m2');
  return path.resolve(configuredPath);
}
