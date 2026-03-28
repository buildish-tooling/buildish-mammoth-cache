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
 * Canonical raw action-input reading and repository config-file loading.
 *
 * Build-tool adapters retain only their public wrapper functions and tool-specific normalization.
 * This module owns file containment, parsing, value serialization, direct-input precedence, and
 * read-only provenance for every action variant.
 */

import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseSerializedJson } from '../util/serialization';
import { recordReadOnlyInputSource } from './input-provenance';
import {
  getConfigFileInput,
  getPublicActionInputs,
  type ActionBuildTool,
  type ConfigFileValueKind,
} from './public-contract';
import { normalizeRelativePath } from './shared';
import type {
  InputProvider,
  RawGradleActionInputs,
  RawMavenActionInputs,
  RawSharedActionInputs,
  ResolveActionInputsFromConfigFileOptions,
} from './types';

interface RawActionInputsByBuildTool {
  readonly gradle: RawGradleActionInputs;
  readonly maven: RawMavenActionInputs;
}

/** Reads every raw build-tool input declared by the canonical public contract exactly once. */
export function readActionInputs<TBuildTool extends ActionBuildTool>(
  buildTool: TBuildTool,
  inputProvider: InputProvider,
): RawActionInputsByBuildTool[TBuildTool] {
  const entries = getPublicActionInputs(buildTool).flatMap((input) =>
    input.property === null
      ? []
      : [[input.property, inputProvider.getInput(input.name, { trimWhitespace: true })] as const],
  );
  return Object.fromEntries(entries) as unknown as RawActionInputsByBuildTool[TBuildTool];
}

/**
 * Loads and overlays a repository config file through the canonical build-tool input contract.
 *
 * Direct inputs always win. The selected file must remain inside the real workspace after symlink
 * resolution, and direct-only inputs are rejected before values reach a build-tool normalizer.
 */
export async function resolveActionInputsFromConfigFile<TBuildTool extends ActionBuildTool>(
  buildTool: TBuildTool,
  directInputs: RawActionInputsByBuildTool[TBuildTool],
  options: ResolveActionInputsFromConfigFileOptions,
): Promise<RawActionInputsByBuildTool[TBuildTool]> {
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
  const values = parseConfigFileContents(contents, normalizedConfigFile);
  const fileInputs = serializeConfigFileInputs(
    buildTool,
    directInputs,
    values,
    normalizedConfigFile,
  );
  const resolvedInputs = overlayConfiguredInputs(fileInputs, directInputs);
  recordReadOnlyInputSource(
    resolvedInputs,
    directInputs.readOnly.length > 0
      ? 'direct'
      : fileInputs.readOnly.length > 0
        ? 'config-file'
        : 'unset',
  );
  return resolvedInputs;
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

function serializeConfigFileInputs<TInputs extends RawSharedActionInputs>(
  buildTool: ActionBuildTool,
  inputShape: TInputs,
  values: Record<string, unknown>,
  normalizedConfigFile: string,
): TInputs {
  const inputs = createEmptyRawInputs(inputShape);
  const writableInputs = inputs as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    const input = getConfigFileInput(buildTool, key);
    if (input.configFile === 'nested-forbidden') {
      throw new Error(
        `config-file '${normalizedConfigFile}' must not contain nested config-file entries.`,
      );
    }
    if (!Object.hasOwn(writableInputs, input.property)) {
      throw new Error(
        `Internal ${buildTool} input contract error: config-file property '${input.property}' is not present in the raw input shape.`,
      );
    }
    writableInputs[input.property] = serializeConfigValue(value, key, input.configFileValueKind);
  }
  return inputs;
}

function createEmptyRawInputs<TInputs extends RawSharedActionInputs>(inputShape: TInputs): TInputs {
  return Object.fromEntries(
    Object.keys(inputShape).map((property) => [property, '']),
  ) as unknown as TInputs;
}

function overlayConfiguredInputs<TInputs extends RawSharedActionInputs>(
  fileInputs: TInputs,
  directInputs: TInputs,
): TInputs {
  const fileValues = fileInputs as unknown as Record<string, string>;
  return Object.fromEntries(
    Object.entries(directInputs).map(([property, directValue]) => [
      property,
      directValue || fileValues[property],
    ]),
  ) as unknown as TInputs;
}

function serializeConfigValue(value: unknown, label: string, kind: ConfigFileValueKind): string {
  switch (kind) {
    case 'string':
      return validateString(value, label).trim();
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : validateString(value, label).trim();
    case 'number':
      return typeof value === 'number' ? String(value) : validateString(value, label).trim();
    case 'list':
      if (typeof value === 'string') return value.trim();
      return validateArray(value, label)
        .map((entry, index) => validateString(entry, `${label} entry ${index}`).trim())
        .filter((entry) => entry.length > 0)
        .join('\n');
    case 'structured':
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
}

function validateString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function validateArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function validateRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
