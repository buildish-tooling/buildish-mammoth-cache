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

import { captureCacheMetadataSnapshot } from './manifest';
import { MAVEN_TRANSIENT_CACHE_EXCLUDE_GLOBS } from './maven-repository';
import { restoreDistributionLauncherPermissions } from './file-permissions';
import { restorePartitionedGeneration, type RestoredGeneration } from './partition-restore';
import { generationRecordPaths, storageDigest } from './partition-format';
import type { NormalizedActionConfig } from '../config/types';
import type { BaseCacheBackend } from './backend';
import type { CacheGeneration, CacheModel } from './model';

/**
 * Injectable dependencies for the base cache service.
 */
export interface BaseCacheServiceDependencies {
  /** Provider-neutral cache backend used for restore and save operations. */
  readonly cacheBackend: BaseCacheBackend;
  readonly onRestorePartitions?: (restored: RestoredGeneration) => Promise<void>;
  readonly publishGeneration?: (generation: CacheGeneration) => Promise<number | null>;
}

/** Ordered semantic lookup candidate for one immutable cache lineage. */
export interface CacheRestoreCandidate {
  /** Relationship between this lineage and the current execution. */
  readonly lineage: 'current-ref' | 'default-branch';
  /** Prefix whose newest immutable generation should be restored. */
  readonly keyPrefix: string;
}

/**
 * Result of restoring the base cache before the workflow's Gradle work begins.
 *
 * `status` identifies which semantic lineage supplied the restored immutable generation.
 */
export interface BaseCacheRestoreResult {
  /** Discriminator for bootstrap consumers; always `restore` for this result shape. */
  readonly operation: 'restore';
  /**
   * Restore outcome classification.
   *
   * Valid values:
   * - `feature-unavailable`: cache backend unavailable in this environment
   * - `miss`: no cache matched
   * - `current-lineage-hit`: newest current-ref generation restored
   * - `fallback-lineage-hit`: newest default-branch generation restored
   */
  readonly status:
    | 'feature-unavailable'
    | 'miss'
    | 'current-lineage-hit'
    | 'fallback-lineage-hit'
    | 'current-lineage-partial-hit'
    | 'fallback-lineage-partial-hit';
  readonly selectedRecordKey?: string | null;
  readonly baselineDigest?: string;
  readonly partitionResults?: {
    partitionId: string;
    status: 'restored' | 'empty' | 'missing';
  }[];
  /** Compatibility family used by every lookup candidate. */
  readonly cacheFamilyKey: string;
  /** Current-ref lineage prefix supplied as the primary lookup candidate. */
  readonly currentRefLineagePrefix: string;
  /** Key actually restored by the active cache backend, if any. */
  readonly matchedKey: string | null;
  /** Semantic lineage prefix that matched, if any. */
  readonly matchedLineagePrefix: string | null;
  /** Ordered semantic lookup candidates supplied to the backend. */
  readonly restoreCandidates: readonly CacheRestoreCandidate[];
  /** Logical record archive paths; operation-local extraction/publication roots may differ. */
  readonly paths: readonly string[];
  /** Human-readable summary suitable for logs and job summaries. */
  readonly message: string;
}

/**
 * Result of saving the base cache from the action finalize phase.
 *
 * Non-`saved` statuses are intentional control-flow outcomes, not necessarily errors. In
 * particular, save is skipped in modes that would create unsafe or redundant concurrent writers.
 */
export interface BaseCacheSaveResult {
  /** Discriminator for bootstrap consumers; always `save` for this result shape. */
  readonly operation: 'save';
  /**
   * Save outcome classification.
   *
   * Valid values:
   * - `read-only`: config forbids writes
   * - `distributed-worker`: worker jobs do not save shared base caches
   * - `feature-unavailable`: cache backend unavailable in this environment
   * - `not-required`: no material state requires a new immutable generation
   * - `missing-paths`: no configured cache paths currently exist on disk, so save is skipped
   * - `saved`: a new cache entry was created
   * - `not-saved`: the backend ran but did not create a new cache entry
   * - `failed`: the backend rejected or failed the save operation
   */
  readonly status:
    | 'read-only'
    | 'distributed-worker'
    | 'feature-unavailable'
    | 'not-required'
    | 'missing-paths'
    | 'saved'
    | 'not-saved'
    | 'failed';
  /** Immutable generation key attempted by finalize, or `null` when save eligibility failed first. */
  readonly generationKey: string | null;
  /** Cache identifier returned by the active backend when a new entry is successfully created. */
  readonly cacheId: number | null;
  /** Logical record archive paths; operation-local extraction/publication roots may differ. */
  readonly paths: readonly string[];
  /** Human-readable summary suitable for logs and job summaries. */
  readonly message: string;
}

/** Unified cache-service result shape emitted by bootstrap for either phase. */
export type BaseCacheOperationResult = BaseCacheRestoreResult | BaseCacheSaveResult;

/**
 * Creates the ordered include/exclude path list expected by the current base-cache backend.
 *
 * Excludes are emitted as negated patterns, so the cache backend never captures transient Gradle
 * state such as configuration cache content or lock files.
 */
export function createBaseCachePaths(cacheModel: CacheModel): readonly string[] {
  return generationRecordPaths(cacheModel.cacheRoot);
}

/** Creates the ordered current-ref and default-branch lineage lookup candidates. */
export function createBaseCacheRestoreCandidates(
  cacheModel: CacheModel,
): readonly CacheRestoreCandidate[] {
  return [
    { lineage: 'current-ref', keyPrefix: cacheModel.currentRefLineagePrefix },
    ...cacheModel.fallbackRefLineagePrefixes.map((keyPrefix): CacheRestoreCandidate => ({
      lineage: 'default-branch',
      keyPrefix,
    })),
  ];
}

/**
 * Restores the base cache and classifies the outcome for logs and summaries.
 *
 * This function intentionally treats cache availability and cache misses as ordinary outcomes. It
 * only delegates exceptional behavior to the active backend when restore itself fails.
 */
export async function restoreBaseCache(
  cacheModel: CacheModel,
  dependencies: BaseCacheServiceDependencies,
  exactKey?: string,
  pinned?: BaseCacheRestoreResult['partitionResults'],
): Promise<BaseCacheRestoreResult> {
  const { cacheBackend } = dependencies;
  const paths = createBaseCachePaths(cacheModel);
  const restoreCandidates = createBaseCacheRestoreCandidates(cacheModel);
  const featureAvailable = cacheBackend.isFeatureAvailable();

  if (!featureAvailable || !cacheBackend.capabilities.supportsNewestPrefixRestore) {
    return {
      operation: 'restore',
      status: 'feature-unavailable',
      cacheFamilyKey: cacheModel.cacheFamilyKey,
      currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
      matchedKey: null,
      matchedLineagePrefix: null,
      restoreCandidates,
      paths,
      message: !featureAvailable
        ? 'Base cache restore skipped because the cache backend is unavailable.'
        : 'Base cache restore skipped because the cache backend does not support newest-prefix restore.',
    };
  }

  if (
    cacheModel.buildToolId === 'maven' &&
    cacheModel.partitions.some((p) =>
      p.relativeExcludeGlobs.some((g) => !MAVEN_TRANSIENT_CACHE_EXCLUDE_GLOBS.includes(g)),
    )
  )
    await captureCacheMetadataSnapshot(cacheModel);
  const restored = await restorePartitionedGeneration(cacheModel, cacheBackend, exactKey, pinned);
  await dependencies.onRestorePartitions?.(restored);
  const candidate = restoreCandidates.find((c) => restored.selectedKey?.startsWith(c.keyPrefix));
  const successes = restored.partitions.filter((p) => p.status !== 'missing').length;
  const complete = !!candidate && successes === restored.partitions.length;
  const partial = !!candidate && successes > 0 && !complete;
  if (complete || partial) await restoreDistributionLauncherPermissions(cacheModel);
  const origin = candidate?.lineage === 'current-ref' ? 'current-lineage' : 'fallback-lineage';
  const status: BaseCacheRestoreResult['status'] = complete
    ? `${origin}-hit`
    : partial
      ? `${origin}-partial-hit`
      : 'miss';
  const partitionResults = restored.partitions.map(({ partitionId, status }) => ({
    partitionId,
    status,
  }));
  return {
    operation: 'restore',
    status,
    cacheFamilyKey: cacheModel.cacheFamilyKey,
    currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
    matchedKey: complete || partial ? restored.selectedKey : null,
    matchedLineagePrefix: complete || partial ? candidate!.keyPrefix : null,
    selectedRecordKey: restored.selectedKey,
    baselineDigest: storageDigest(restored),
    partitionResults,
    restoreCandidates,
    paths,
    message: `Base cache restore ${status}: ${partitionResults.map((p) => `${p.partitionId}=${p.status}`).join(', ') || 'no active partitions'}.`,
  };
}

/**
 * Saves the base cache from the post-action when the current job mode allows it.
 *
 * Save is intentionally gated behind read-only mode and job-mode checks. The finalize flow calls
 * this service only after validating the complete prepare-phase lifecycle record.
 */
export async function saveBaseCache(
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
  createGeneration: () => CacheGeneration | null | Promise<CacheGeneration | null>,
  dependencies: BaseCacheServiceDependencies,
): Promise<BaseCacheSaveResult> {
  const paths = createBaseCachePaths(cacheModel);

  if (config.readOnly) {
    return createSaveResult(
      'read-only',
      null,
      paths,
      'Base cache save skipped because read-only mode is enabled.',
    );
  }

  if (config.jobMode === 'distributed-worker') {
    return createSaveResult(
      'distributed-worker',
      null,
      paths,
      'Base cache save skipped for distributed-worker mode.',
    );
  }

  const { cacheBackend } = dependencies;
  if (!cacheBackend.isFeatureAvailable()) {
    return createSaveResult(
      'feature-unavailable',
      null,
      paths,
      'Base cache save skipped because the cache backend is unavailable.',
    );
  }

  if (!cacheBackend.capabilities.supportsExplicitSave) {
    return createSaveResult(
      'feature-unavailable',
      null,
      paths,
      'Base cache save skipped because the cache backend does not support explicit save operations.',
    );
  }

  const generation = await createGeneration();
  if (!generation) {
    return createSaveResult(
      'not-required',
      null,
      paths,
      'Base cache save skipped because the managed state does not require a new immutable generation.',
    );
  }
  assertGenerationMatchesModel(generation, cacheModel);
  let cacheId: number | null;

  try {
    cacheId = dependencies.publishGeneration
      ? await dependencies.publishGeneration(generation)
      : await cacheBackend.saveCache([...paths], generation.key);
  } catch (error) {
    if (cacheBackend.isMissingPathsError(error)) {
      return createSaveResult(
        'missing-paths',
        generation.key,
        paths,
        'Base cache save skipped because none of the configured cache paths exist yet.',
      );
    }
    return createSaveResult(
      'failed',
      generation.key,
      paths,
      `Base cache generation publication failed for '${generation.key}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (cacheId === null || cacheId > 0) {
    return createSaveResult(
      'saved',
      generation.key,
      paths,
      `Base cache saved under immutable generation key '${generation.key}'${cacheId === null ? ' (verified concurrent publication)' : ` (cache ID ${cacheId})`}.`,
      cacheId,
    );
  }

  return createSaveResult(
    'not-saved',
    generation.key,
    paths,
    `Base cache save did not create a new cache entry for generation key '${generation.key}'.`,
  );
}

function createSaveResult(
  status: BaseCacheSaveResult['status'],
  generationKey: string | null,
  paths: readonly string[],
  message: string,
  cacheId: number | null = null,
): BaseCacheSaveResult {
  return {
    operation: 'save',
    status,
    generationKey,
    cacheId,
    paths,
    message,
  };
}

function assertGenerationMatchesModel(generation: CacheGeneration, cacheModel: CacheModel): void {
  if (
    !/^[a-f0-9]{64}$/u.test(generation.contentDigest) ||
    generation.cacheFamilyKey !== cacheModel.cacheFamilyKey ||
    generation.lineagePrefix !== cacheModel.currentRefLineagePrefix ||
    generation.generationId !== cacheModel.plannedGenerationId ||
    generation.key !==
      `${cacheModel.currentRefLineagePrefix}${generation.generationId}-${generation.contentDigest.slice(0, 12)}`
  ) {
    throw new Error(
      'Cache generation does not belong to the current cache family and ref lineage.',
    );
  }
}
