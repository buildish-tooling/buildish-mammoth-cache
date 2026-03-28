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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  calculateCanonicalCacheManifestDigest,
  deserializeCacheManifest,
  serializeCacheManifest,
  type CacheManifest,
} from '../../cache/manifest';
import { z } from 'zod';

import { isAbsolutePosixOrWindowsPath } from '../../util/paths';
import { parseSerializedJson, parseWithZod } from '../../util/serialization';

/** CI state key holding the complete validated prepare/finalize cache lifecycle record. */
export const CACHE_LIFECYCLE_RECORD_STATE = 'buildish-mammoth-cache-lifecycle-record';
/** Schema for the CI-state lifecycle envelope, independent of the cache compatibility schema. */
export const CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION = 1;
const BASE_CACHE_RESTORE_STATUSES = [
  'feature-unavailable',
  'miss',
  'current-lineage-hit',
  'fallback-lineage-hit',
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

const baseCacheRestoreResultSchema = z
  .object({
    operation: z.literal('restore'),
    status: z.enum(BASE_CACHE_RESTORE_STATUSES),
    cacheFamilyKey: z.string().min(1),
    currentRefLineagePrefix: z.string().min(1),
    matchedKey: z.string().min(1).nullable(),
    matchedLineagePrefix: z.string().min(1).nullable(),
    restoreCandidates: z.array(
      z.object({
        lineage: z.enum(['current-ref', 'default-branch']),
        keyPrefix: z.string().min(1),
      }),
    ),
    paths: z.array(z.string().min(1)),
    message: z.string().min(1),
  })
  .superRefine((value, context) => {
    const hit = value.status === 'current-lineage-hit' || value.status === 'fallback-lineage-hit';
    if (hit !== (value.matchedKey !== null && value.matchedLineagePrefix !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Restore hit status and matched generation fields must agree.',
      });
      return;
    }
    if (!value.matchedKey || !value.matchedLineagePrefix) {
      return;
    }

    const matchedCandidate = value.restoreCandidates.find(
      (candidate) => candidate.keyPrefix === value.matchedLineagePrefix,
    );
    if (
      !matchedCandidate ||
      !value.matchedKey.startsWith(value.matchedLineagePrefix) ||
      value.matchedKey.length === value.matchedLineagePrefix.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Matched generation must belong to a requested restore lineage.',
      });
    } else if (
      (value.status === 'current-lineage-hit') !==
      (matchedCandidate.lineage === 'current-ref')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Restore hit status must identify the matched lineage origin.',
      });
    }
  });

const dependentDeltaStateSchema = z
  .object({
    requestedJobs: z.array(z.string().min(1)),
    artifactNames: z.array(z.string().min(1)),
    addedCount: z.number().int().nonnegative(),
    modifiedCount: z.number().int().nonnegative(),
    deletedCount: z.number().int().nonnegative(),
    totalChangedCount: z.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.totalChangedCount !== value.addedCount + value.modifiedCount + value.deletedCount) {
      context.addIssue({
        code: 'custom',
        message: 'Dependent delta totalChangedCount must equal its per-change counts.',
      });
    }
  });

const cacheLifecycleRecordSchema = z
  .object({
    lifecycleSchemaVersion: z.literal(CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION),
    cacheSchemaVersion: z.number().int().positive(),
    buildToolId: z.string().min(1),
    cacheFamilyKey: z.string().min(1),
    currentRefLineagePrefix: z.string().min(1),
    fallbackRefLineagePrefixes: z.array(z.string().min(1)).max(1),
    plannedGenerationId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u),
    restoreResult: baseCacheRestoreResultSchema,
    preBuildManifestPath: z
      .string()
      .min(1)
      .refine(isAbsolutePosixOrWindowsPath, 'Pre-build manifest path must be absolute.'),
    preBuildManifestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u, 'Must be a lowercase hex SHA-256 digest'),
    executionIdentity: persistedExecutionIdentitySchema,
    sourceRevision: z.string().min(1).nullable(),
    dependentDelta: dependentDeltaStateSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.restoreResult.cacheFamilyKey !== value.cacheFamilyKey) {
      context.addIssue({
        code: 'custom',
        message: 'Restore result cache family must match the lifecycle cache family.',
      });
    }
    if (value.restoreResult.currentRefLineagePrefix !== value.currentRefLineagePrefix) {
      context.addIssue({
        code: 'custom',
        message: 'Restore result current lineage must match the lifecycle current lineage.',
      });
    }

    const expectedCandidates = [
      { lineage: 'current-ref', keyPrefix: value.currentRefLineagePrefix },
      ...value.fallbackRefLineagePrefixes.map((keyPrefix) => ({
        lineage: 'default-branch',
        keyPrefix,
      })),
    ];
    if (
      JSON.stringify(value.restoreResult.restoreCandidates) !== JSON.stringify(expectedCandidates)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Restore candidates must match the lifecycle lineage order.',
      });
    }
  });

// ---------------------------------------------------------------------------

/**
 * Minimal CI execution identity persisted by the prepare phase so the finalize phase can locate
 * and verify the delta artifact uploaded by the same invocation.
 */
export type PersistedDeltaArtifactExecutionIdentity = z.infer<
  typeof persistedExecutionIdentitySchema
>;

/** Complete validated state shared by cache-enabled prepare and finalize phases. */
export type PersistedCacheLifecycleRecord = z.infer<typeof cacheLifecycleRecordSchema>;

/** Path metadata returned after writing the pre-build cache manifest to the runner temp directory. */
export interface PersistedPreBuildCacheManifestState {
  /** Absolute path of the written manifest file. */
  readonly manifestPath: string;
  /** Canonical material-state digest of the persisted manifest. */
  readonly manifestDigest: string;
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
 * Serialises `manifest` to a temp-directory file and returns its path and canonical digest.
 *
 * The file is written to a UUID-suffixed subdirectory inside the resolved parent directory to
 * avoid collisions when multiple action steps share the same temp root.
 *
 * @returns The path of the written manifest file for logging.
 */
export async function persistPreBuildCacheManifest(
  manifest: CacheManifest,
  options: PersistPreBuildCacheManifestOptions = {},
): Promise<PersistedPreBuildCacheManifestState> {
  const parentDirectory = resolveStateParentDirectory(options);
  await mkdir(parentDirectory, { recursive: true });
  const stateDirectory = await mkdtemp(
    path.join(parentDirectory, 'buildish-mammoth-cache-post-state-'),
  );
  const manifestPath = path.join(stateDirectory, PRE_BUILD_CACHE_MANIFEST_FILE);

  await writeFile(manifestPath, serializeCacheManifest(manifest), 'utf8');

  return {
    manifestPath,
    manifestDigest: calculateCanonicalCacheManifestDigest(manifest),
  };
}

/**
 * Reads and deserialises the manifest at the validated lifecycle-record path.
 *
 * @returns The deserialised {@link CacheManifest}.
 */
export async function loadPersistedPreBuildCacheManifest(
  manifestPath: string,
  options: LoadPersistedPreBuildCacheManifestOptions = {},
): Promise<CacheManifest> {
  const readFileImpl = options.readFileImpl ?? readFile;
  return deserializeCacheManifest(await readFileImpl(path.resolve(manifestPath), 'utf8'));
}

/**
 * Validates and persists the complete cache lifecycle record for the finalize phase.
 */
export function persistCacheLifecycleRecord(
  record: PersistedCacheLifecycleRecord,
  saveState: (name: string, value: string) => void,
): void {
  const validatedRecord = parseWithZod(
    cacheLifecycleRecordSchema,
    record,
    'cache lifecycle record',
  );
  saveState(CACHE_LIFECYCLE_RECORD_STATE, `${JSON.stringify(validatedRecord)}\n`);
}

/**
 * Reads and validates the complete cache lifecycle record from CI state.
 *
 * @returns The parsed record, or `null` when prepare did not persist cache lifecycle state.
 * @throws When the persisted state is present but malformed.
 */
export function getPersistedCacheLifecycleRecord(
  getState: (name: string) => string,
): PersistedCacheLifecycleRecord | null {
  const serializedRecord = getState(CACHE_LIFECYCLE_RECORD_STATE).trim();
  if (serializedRecord.length === 0) {
    return null;
  }

  return parseWithZod(
    cacheLifecycleRecordSchema,
    parseSerializedJson(serializedRecord, 'cache lifecycle record state'),
    'cache lifecycle record state',
  );
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
