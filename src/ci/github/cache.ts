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

import * as toolkitCache from '@actions/cache';

import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../cache/backend';

/**
 * Fragment of the error message thrown by `@actions/cache` when none of the supplied paths exist
 * on disk at save time. Used by {@link createGitHubBaseCacheBackend}'s `isMissingPathsError` to
 * classify the error without propagating an `@actions/cache` dependency into shared orchestration.
 */
const NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT =
  'Path Validation Error: Path(s) specified in the action for caching do(es) not exist';

/**
 * Creates a {@link BaseCacheBackend} backed by the `@actions/cache` toolkit package.
 *
 * @param cacheBackend - Cache implementation to delegate to; defaults to the toolkit cache client.
 *   Inject a test double to exercise cache logic without touching the GitHub cache API.
 */
export function createGitHubBaseCacheBackend(
  cacheBackend: Pick<
    BaseCacheBackend,
    'isFeatureAvailable' | 'restoreCache' | 'saveCache'
  > = toolkitCache,
): BaseCacheBackend {
  return {
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return cacheBackend.isFeatureAvailable();
    },
    async restoreCache(paths: string[], primaryKeyPrefix: string, fallbackKeyPrefixes?: string[]) {
      return await cacheBackend.restoreCache(paths, primaryKeyPrefix, fallbackKeyPrefixes);
    },
    async saveCache(paths: string[], key: string) {
      return await cacheBackend.saveCache(paths, key);
    },
    isMissingPathsError(error: unknown): boolean {
      return error instanceof Error && error.message.includes(NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT);
    },
  };
}
