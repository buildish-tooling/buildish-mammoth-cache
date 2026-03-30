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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deserializeCacheManifest,
  serializeCacheManifest,
  type CacheManifest,
} from '../cache/manifest';
import type { BaseCacheRestoreResult } from '../cache/service';
import type { CiJobContext } from '../ci';
import { z } from 'zod';

import { parseSerializedJson, parseWithZod } from '../util/serialization';

/** CI state key holding the absolute path to the persisted pre-build cache manifest file. */
export const PRE_BUILD_CACHE_MANIFEST_PATH_STATE =
  'buildish-mammoth-cache-gradle-pre-build-manifest-path';
/** CI state key holding a JSON array of consumed delta artifact names to delete in the finalize phase. */
export const CONSUMED_DELTA_ARTIFACT_NAMES_STATE =
  'buildish-mammoth-cache-gradle-consumed-delta-artifact-names';
/** CI state key holding the serialized {@link PersistedDeltaArtifactExecutionIdentity} JSON. */
export const DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE =
  'buildish-mammoth-cache-gradle-delta-artifact-execution-identity';
/** CI state key holding the serialized {@link BaseCacheRestoreResult} JSON. */
export const BASE_CACHE_RESTORE_RESULT_STATE =
  'buildish-mammoth-cache-gradle-base-cache-restore-result';
const BASE_CACHE_RESTORE_STATUSES = [
  'feature-unavailable',
  'miss',
  'exact-hit',
  'partial-hit',
] as const;
const PRE_BUILD_CACHE_MANIFEST_FILE = 'pre-build-cache-manifest.json';

// ---------------------------------------------------------------------------
// Zod schemas for persisted CI state shapes
// ---------------------------------------------------------------------------

const persistedExecutionIdentitySchema = z.object({
  jobName: z.string().min(1),
  runId: z.number().int().nonnegative().nullable(),
  runAttempt: z.number().int().nonnegative().nullable(),
});

const baseCacheRestoreResultSchema = z.object({
  operation: z.literal('restore'),
  status: z.enum(BASE_CACHE_RESTORE_STATUSES),
  cacheKey: z.string().min(1),
  matchedKey: z.string().min(1).nullable(),
  restoreKeys: z.array(z.string().min(1)),
  paths: z.array(z.string().min(1)),
  message: z.string().min(1),
});

const consumedArtifactNamesSchema = z.array(z.string().min(1));

// ---------------------------------------------------------------------------

/**
 * Minimal CI execution identity persisted by the prepare phase so the finalize phase can locate
 * and verify the delta artifact uploaded by the same invocation.
 */
export type PersistedDeltaArtifactExecutionIdentity = z.infer<
  typeof persistedExecutionIdentitySchema
>;

/** Path metadata returned after writing the pre-build cache manifest to the runner temp directory. */
export interface PersistedPreBuildCacheManifestState {
  /** Absolute path of the written manifest file. */
  readonly manifestPath: string;
}

/** Options for {@link persistPreBuildCacheManifest}. */
export interface PersistPreBuildCacheManifestOptions {
  /** Environment variable map; used to read `RUNNER_TEMP` when `tempDirectory` is not set. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit parent directory override; takes precedence over `tempDirectory` and `RUNNER_TEMP`. */
  readonly parentDirectory?: string;
  /** Absolute path to the CI temp directory; falls back to `os.tmpdir()` when `null`. */
  readonly tempDirectory?: string | null;
}

/** Options for {@link loadPersistedPreBuildCacheManifest}. */
export interface LoadPersistedPreBuildCacheManifestOptions {
  /** Override for `fs.readFile`; useful for injecting test doubles. */
  readonly readFileImpl?: typeof readFile;
}

/**
 * Serialises `manifest` to a temp-directory file and persists the file path in CI state.
 *
 * The file is written to a UUID-suffixed subdirectory inside the resolved parent directory to
 * avoid collisions when multiple action steps share the same temp root.
 *
 * @returns The path of the written manifest file for logging.
 */
export async function persistPreBuildCacheManifest(
  manifest: CacheManifest,
  saveState: (name: string, value: string) => void,
  options: PersistPreBuildCacheManifestOptions = {},
): Promise<PersistedPreBuildCacheManifestState> {
  const parentDirectory = resolveStateParentDirectory(options);
  await mkdir(parentDirectory, { recursive: true });
  const stateDirectory = await mkdtemp(
    path.join(parentDirectory, 'buildish-mammoth-cache-gradle-post-state-'),
  );
  const manifestPath = path.join(stateDirectory, PRE_BUILD_CACHE_MANIFEST_FILE);

  await writeFile(manifestPath, serializeCacheManifest(manifest), 'utf8');
  saveState(PRE_BUILD_CACHE_MANIFEST_PATH_STATE, manifestPath);

  return { manifestPath };
}

/**
 * Reads the persisted manifest path from CI state and deserialises the manifest file.
 *
 * @returns The deserialised {@link CacheManifest}, or `null` when no path was persisted.
 */
export async function loadPersistedPreBuildCacheManifest(
  getState: (name: string) => string,
  options: LoadPersistedPreBuildCacheManifestOptions = {},
): Promise<CacheManifest | null> {
  const manifestPath = getPersistedPreBuildCacheManifestPath(getState);
  if (!manifestPath) {
    return null;
  }

  const readFileImpl = options.readFileImpl ?? readFile;
  return deserializeCacheManifest(await readFileImpl(manifestPath, 'utf8'));
}

/**
 * Reads the pre-build manifest path from CI state and resolves it to an absolute path.
 *
 * @returns The resolved absolute path, or `null` when no path was persisted.
 */
export function getPersistedPreBuildCacheManifestPath(
  getState: (name: string) => string,
): string | null {
  const manifestPath = getState(PRE_BUILD_CACHE_MANIFEST_PATH_STATE).trim();
  return manifestPath.length > 0 ? path.resolve(manifestPath) : null;
}

/**
 * Serialises `artifactNames` as a JSON array and writes it to CI state so the finalize phase
 * can delete the consumed delta artifacts after the aggregator has applied them.
 */
export function persistConsumedDeltaArtifactNames(
  artifactNames: readonly string[],
  saveState: (name: string, value: string) => void,
): void {
  saveState(CONSUMED_DELTA_ARTIFACT_NAMES_STATE, `${JSON.stringify([...artifactNames])}\n`);
}

/**
 * Extracts the relevant CI execution identity fields from `ciContext` and persists them as JSON
 * so the finalize phase can look up the correct delta artifact even if the job metadata drifts
 * between the prepare and finalize steps.
 */
export function persistDeltaArtifactExecutionIdentity(
  ciContext: CiJobContext,
  saveState: (name: string, value: string) => void,
): void {
  const identity: PersistedDeltaArtifactExecutionIdentity = {
    jobName: ciContext.jobName,
    runId: ciContext.runId,
    runAttempt: ciContext.runAttempt,
  };
  saveState(DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE, `${JSON.stringify(identity)}\n`);
}

/**
 * Serialises the base cache restore result to CI state so the finalize phase can include the
 * restore outcome in its log summary without re-running the restore.
 */
export function persistBaseCacheRestoreResult(
  result: BaseCacheRestoreResult,
  saveState: (name: string, value: string) => void,
): void {
  saveState(BASE_CACHE_RESTORE_RESULT_STATE, `${JSON.stringify(result)}\n`);
}

/**
 * Reads and validates the persisted delta artifact execution identity from CI state.
 *
 * @returns The parsed identity, or `null` when no identity was persisted.
 * @throws When the persisted state is present but malformed.
 */
export function getPersistedDeltaArtifactExecutionIdentity(
  getState: (name: string) => string,
): PersistedDeltaArtifactExecutionIdentity | null {
  const serializedIdentity = getState(DELTA_ARTIFACT_EXECUTION_IDENTITY_STATE).trim();
  if (serializedIdentity.length === 0) {
    return null;
  }

  return parseWithZod(
    persistedExecutionIdentitySchema,
    parseSerializedJson(serializedIdentity, 'delta artifact execution identity state'),
    'delta artifact execution identity state',
  );
}

/**
 * Reads and validates the persisted base cache restore result from CI state.
 *
 * @returns The parsed {@link BaseCacheRestoreResult}, or `null` when no result was persisted.
 * @throws When the persisted state is present but malformed or contains an unsupported status.
 */
export function getPersistedBaseCacheRestoreResult(
  getState: (name: string) => string,
): BaseCacheRestoreResult | null {
  const serializedResult = getState(BASE_CACHE_RESTORE_RESULT_STATE).trim();
  if (serializedResult.length === 0) {
    return null;
  }

  return parseWithZod(
    baseCacheRestoreResultSchema,
    parseSerializedJson(serializedResult, 'base cache restore result state'),
    'base cache restore result state',
  );
}

/**
 * Reads and validates the persisted list of consumed delta artifact names from CI state.
 *
 * @returns An ordered, deduplicated array of artifact names, or an empty array when none were persisted.
 * @throws When the persisted state is present but not a valid JSON array of strings.
 */
export function getPersistedConsumedDeltaArtifactNames(
  getState: (name: string) => string,
): readonly string[] {
  const serializedArtifactNames = getState(CONSUMED_DELTA_ARTIFACT_NAMES_STATE).trim();
  if (serializedArtifactNames.length === 0) {
    return [];
  }

  const names = parseWithZod(
    consumedArtifactNamesSchema,
    parseSerializedJson(serializedArtifactNames, 'consumed delta artifact names'),
    'consumed delta artifact names',
  );

  return [...new Set(names)];
}

function resolveStateParentDirectory(options: PersistPreBuildCacheManifestOptions): string {
  const parentDirectory = options.parentDirectory?.trim();
  if (parentDirectory) {
    return path.resolve(parentDirectory);
  }

  const tempDirectory = options.tempDirectory?.trim();
  if (tempDirectory) {
    return path.resolve(tempDirectory);
  }

  const runnerTemp = options.env?.RUNNER_TEMP?.trim();
  return runnerTemp ? path.resolve(runnerTemp) : os.tmpdir();
}
