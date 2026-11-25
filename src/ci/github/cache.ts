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
import { warning } from '@actions/core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
  type BaseCacheOperationOptions,
} from '../../cache/backend';

/**
 * Fragment of the error message thrown by `@actions/cache` when none of the supplied paths exist
 * on disk at save time. Used by {@link createGitHubBaseCacheBackend}'s `isMissingPathsError` to
 * classify the error without propagating an `@actions/cache` dependency into shared orchestration.
 */
const NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT =
  'Path Validation Error: Path(s) specified in the action for caching do(es) not exist';

/** Installed @actions/cache 6.3.0 internal/config selector, mirrored because it is not exported. */
export function githubCacheFinalizesSave(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = new URL(env.GITHUB_SERVER_URL || 'https://github.com').hostname
    .trimEnd()
    .toUpperCase();
  return (
    (host === 'GITHUB.COM' || host.endsWith('.GHE.COM') || host.endsWith('.LOCALHOST')) &&
    !!env.ACTIONS_CACHE_SERVICE_V2
  );
}

/**
 * Creates a {@link BaseCacheBackend} backed by the `@actions/cache` toolkit package.
 *
 * @param cacheBackend - Cache implementation to delegate to; defaults to the toolkit cache client.
 *   Inject a test double to exercise cache logic without touching the GitHub cache API.
 * @param cacheRoot - Managed root used for portable path hashing and archive member names.
 * @param warn - Reports unsupported SDK archive paths without failing the build.
 */
export function createGitHubBaseCacheBackend(
  cacheBackend: Pick<
    typeof toolkitCache,
    'isFeatureAvailable' | 'restoreCache' | 'saveCache'
  > = toolkitCache,
  cacheRoot?: string,
  warn: (message: string) => void = warning,
  finalizesSave: () => boolean = githubCacheFinalizesSave,
): BaseCacheBackend {
  const root = cacheRoot === undefined ? undefined : path.resolve(cacheRoot);
  let warned = false;
  const supportsRoot = (operationRoot = root) => {
    if (operationRoot !== undefined && /[\s"]/u.test(operationRoot)) {
      if (!warned) {
        warn(
          'Base cache unavailable: the GitHub cache toolkit cannot quote cache-root paths containing whitespace or double quotes. Use a runner/cache home without these characters. Workflow artifact exchange remains available.',
        );
      }
      warned = true;
      return false;
    }
    return true;
  };
  const canConfirmSave = () => supportsRoot() && finalizesSave();
  return {
    canConfirmSave,
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable(): boolean {
      return supportsRoot() && cacheBackend.isFeatureAvailable();
    },
    async restoreCache(
      paths: string[],
      primaryKeyPrefix: string,
      fallbackKeyPrefixes?: string[],
      options?: BaseCacheOperationOptions,
    ) {
      const operationRoot = options?.archiveRoot ?? root;
      if (!supportsRoot(operationRoot)) {
        return undefined;
      }
      return await withCacheRoot(operationRoot, paths, (relativePaths) =>
        cacheBackend.restoreCache(
          relativePaths,
          primaryKeyPrefix,
          fallbackKeyPrefixes,
          options?.lookupOnly ? { lookupOnly: true } : undefined,
          true,
        ),
      );
    },
    async saveCache(paths: string[], key: string, options?: BaseCacheOperationOptions) {
      const operationRoot = options?.archiveRoot ?? root;
      if (!supportsRoot(operationRoot)) {
        return -1;
      }
      if (!canConfirmSave()) {
        if (!warned) {
          warn(
            'Base cache save unavailable: finalized direct confirmation requires GitHub cache service V2. Restore remains available.',
          );
        }
        warned = true;
        return -1;
      }
      return await withCacheRoot(operationRoot, paths, (relativePaths) =>
        cacheBackend.saveCache(relativePaths, key, undefined, true),
      );
    },
    async lookupCache(paths, key, options) {
      const operationRoot = options?.archiveRoot ?? root;
      if (!supportsRoot(operationRoot)) {
        return undefined;
      }
      return await withCacheRoot(operationRoot, paths, (relativePaths) =>
        cacheBackend.restoreCache(relativePaths, key, [], { lookupOnly: true }, true),
      );
    },
    isMissingPathsError(error: unknown): boolean {
      return error instanceof Error && error.message.includes(NO_CACHE_PATHS_FOUND_ERROR_FRAGMENT);
    },
  };
}

// The toolkit hashes its path arguments and archives relative to GITHUB_WORKSPACE. Both must
// refer to the cache root rather than a platform-specific home or checkout. The action awaits
// cache operations sequentially; serialize instances too, and always restore process context.
let cacheOperation: Promise<unknown> = Promise.resolve();
async function withCacheRoot<T>(
  root: string | undefined,
  paths: string[],
  operation: (paths: string[]) => Promise<T>,
): Promise<T> {
  if (root === undefined) {
    return await operation(paths);
  }
  const relativePaths = paths.map((pattern) => {
    const negated = pattern.startsWith('!');
    const relative = path.relative(root, negated ? pattern.slice(1) : pattern);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Cache archive path is outside the cache root.');
    }
    return (
      (negated ? '!' : '') +
      (relative || '.').split(path.sep).join('/') +
      (/[\\/]$/u.test(pattern) ? '/' : '')
    );
  });
  const previous = cacheOperation;
  let release!: () => void;
  cacheOperation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const cwd = process.cwd();
  const workspace = process.env.GITHUB_WORKSPACE;
  try {
    await mkdir(root, { recursive: true });
    process.chdir(root);
    process.env.GITHUB_WORKSPACE = root;
    return await operation(relativePaths);
  } finally {
    process.chdir(cwd);
    if (workspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = workspace;
    }
    release();
  }
}
