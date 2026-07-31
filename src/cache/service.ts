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

import type { NormalizedActionConfig } from '../config/types';
import type { BaseCacheBackend } from './backend';

import type { CacheGeneration, CacheModel } from './model';

const FINALIZE_ARMED_STATE = 'buildish-mammoth-cache-base-cache-armed';

/**
 * Injectable dependencies for the base cache service.
 */
export interface BaseCacheServiceDependencies {
  /** Provider-neutral cache backend used for restore and save operations. */
  readonly cacheBackend: BaseCacheBackend;
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
  readonly status: 'feature-unavailable' | 'miss' | 'current-lineage-hit' | 'fallback-lineage-hit';
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
  /** Ordered cache path list passed to the active cache backend, including negated excludes. */
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
   * - `not-armed`: finalize phase was not paired with an armed prepare phase
   * - `read-only`: config forbids writes
   * - `distributed-worker`: worker jobs do not save shared base caches
   * - `feature-unavailable`: cache backend unavailable in this environment
   * - `missing-paths`: no configured cache paths currently exist on disk, so save is skipped
   * - `saved`: a new cache entry was created
   * - `not-saved`: the backend ran but did not create a new cache entry
   */
  readonly status:
    | 'not-armed'
    | 'read-only'
    | 'distributed-worker'
    | 'feature-unavailable'
    | 'missing-paths'
    | 'saved'
    | 'not-saved';
  /** Immutable generation key attempted by finalize, or `null` when save eligibility failed first. */
  readonly generationKey: string | null;
  /** Cache identifier returned by the active backend when a new entry is successfully created. */
  readonly cacheId: number | null;
  /** Ordered cache path list passed to the active cache backend, including negated excludes. */
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
  return [...cacheModel.includePaths, ...cacheModel.excludePaths.map((pattern) => `!${pattern}`)];
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

  const [primaryCandidate, ...fallbackCandidates] = restoreCandidates;
  const matchedKey = await cacheBackend.restoreCache(
    [...paths],
    primaryCandidate.keyPrefix,
    fallbackCandidates.map((candidate) => candidate.keyPrefix),
  );

  if (!matchedKey) {
    return {
      operation: 'restore',
      status: 'miss',
      cacheFamilyKey: cacheModel.cacheFamilyKey,
      currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
      matchedKey: null,
      matchedLineagePrefix: null,
      restoreCandidates,
      paths,
      message: `Base cache restore missed for current lineage '${cacheModel.currentRefLineagePrefix}'.`,
    };
  }

  const matchedCandidate = restoreCandidates.find(
    (candidate) =>
      matchedKey.startsWith(candidate.keyPrefix) && matchedKey.length > candidate.keyPrefix.length,
  );
  if (!matchedCandidate) {
    throw new Error(
      `Cache backend returned key '${matchedKey}' outside the requested cache lineages.`,
    );
  }

  return {
    operation: 'restore',
    status:
      matchedCandidate.lineage === 'current-ref' ? 'current-lineage-hit' : 'fallback-lineage-hit',
    cacheFamilyKey: cacheModel.cacheFamilyKey,
    currentRefLineagePrefix: cacheModel.currentRefLineagePrefix,
    matchedKey,
    matchedLineagePrefix: matchedCandidate.keyPrefix,
    restoreCandidates,
    paths,
    message:
      matchedCandidate.lineage === 'current-ref'
        ? `Base cache restore reused current-ref generation '${matchedKey}'.`
        : `Base cache restore reused default-branch generation '${matchedKey}'.`,
  };
}

/**
 * Saves the base cache from the post-action when the current job mode allows it.
 *
 * Save is intentionally gated behind post-action arming, read-only mode, and job-mode checks, so
 * we avoid introducing duplicate writers or unexpected state changes in distributed execution.
 */
export async function saveBaseCache(
  config: NormalizedActionConfig,
  cacheModel: CacheModel,
  createGeneration: () => CacheGeneration | Promise<CacheGeneration>,
  postActionArmed: boolean,
  dependencies: BaseCacheServiceDependencies,
): Promise<BaseCacheSaveResult> {
  const paths = createBaseCachePaths(cacheModel);

  if (!postActionArmed) {
    return createSaveResult(
      'not-armed',
      null,
      paths,
      'Base cache save skipped because the main action phase did not arm post-save state.',
    );
  }

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
  assertGenerationMatchesModel(generation, cacheModel);
  let cacheId: number;

  try {
    cacheId = await cacheBackend.saveCache([...paths], generation.key);
  } catch (error) {
    if (cacheBackend.isMissingPathsError(error)) {
      return createSaveResult(
        'missing-paths',
        generation.key,
        paths,
        'Base cache save skipped because none of the configured cache paths exist yet.',
      );
    }

    throw error;
  }

  if (cacheId > 0) {
    return createSaveResult(
      'saved',
      generation.key,
      paths,
      `Base cache saved under immutable generation key '${generation.key}' (cache ID ${cacheId}).`,
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

/**
 * Marks the finalize phase as eligible to consider a later base-cache save.
 *
 * Arming happens during the prepare phase after restore/setup work has completed, so the finalize phase can
 * cheaply distinguish a legitimate paired execution from a standalone post-invocation.
 */
export function armBaseCacheFinalize(saveState: (name: string, value: string) => void): void {
  saveState(FINALIZE_ARMED_STATE, 'true');
}

/**
 * Returns whether the finalize phase was armed by the prepare phase for a later base-cache save.
 */
export function isBaseCacheFinalizeArmed(getState: (name: string) => string): boolean {
  return getState(FINALIZE_ARMED_STATE) === 'true';
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
