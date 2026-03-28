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

/** Shared normalization for raw action inputs used by every build-tool adapter. */

import {
  parseBooleanInput,
  parseEnumInput,
  parseListInput,
  validateNamedValue,
} from '../util/action-input';
import { resolveReadOnlyInput } from './input-provenance';
import { normalizeRelativePath, parseCachePartitionsInput, validateCacheKeyPrefix } from './shared';
import {
  CACHE_GC_MODES,
  CACHE_SCHEMA_VERSION,
  JOB_MODES,
  RESTORE_CLEANUP_MODES,
  type NormalizedActionConfig,
  type NormalizeActionConfigOptions,
  type RawSharedActionInputs,
} from './types';

/** Validates shared raw inputs and returns the provider-neutral runtime configuration. */
export function normalizeSharedActionConfig(
  rawInputs: RawSharedActionInputs,
  options: NormalizeActionConfigOptions,
): NormalizedActionConfig {
  const jobMode = parseEnumInput(rawInputs.jobMode || 'standalone', JOB_MODES, 'job-mode');
  const dependentJobs = parseListInput(rawInputs.dependentJobs).map((jobName) =>
    validateNamedValue(jobName, 'dependent-jobs'),
  );
  if (dependentJobs.length > 0 && jobMode === 'standalone') {
    throw new Error('dependent-jobs can only be used with distributed job modes.');
  }

  return {
    phase: options.phase,
    baseDirectory: normalizeRelativePath(rawInputs.baseDirectory || '.', 'base-directory'),
    cacheEnabled: parseBooleanInput(rawInputs.cacheEnabled || 'true', 'cache-enabled'),
    readOnly: resolveReadOnlyInput(rawInputs, rawInputs.readOnly, options.ciContext),
    jobMode,
    dependentJobs,
    allowDuplicateDependentDeltaPaths: parseBooleanInput(
      rawInputs.allowDuplicateDependentDeltaPaths || 'false',
      'allow-duplicate-dependent-delta-paths',
    ),
    cacheKeyPrefix: validateCacheKeyPrefix(rawInputs.cacheKeyPrefix || 'buildish-mammoth-cache-'),
    cachePartitions: parseCachePartitionsInput(rawInputs.cachePartitions),
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    cleanupEnabled: parseBooleanInput(rawInputs.cleanupEnabled || 'true', 'cleanup-enabled'),
    restoreCleanupMode: parseEnumInput(
      rawInputs.restoreCleanupMode || 'none',
      RESTORE_CLEANUP_MODES,
      'restore-cleanup-mode',
    ),
    cacheGcMode: parseEnumInput(
      rawInputs.cacheGcMode || 'timestamp',
      CACHE_GC_MODES,
      'cache-gc-mode',
    ),
    cacheGcOlderThanDays: parseCacheGcOlderThanDays(rawInputs.cacheGcOlderThanDays || '14'),
  };
}

function parseCacheGcOlderThanDays(input: string): number {
  const value = Number(input.trim());
  if (!Number.isFinite(value) || value < 2) {
    throw new Error('cache-gc-older-than-days must be a number greater than or equal to 2.');
  }
  return value;
}
