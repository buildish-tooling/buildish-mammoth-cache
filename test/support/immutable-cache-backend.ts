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

import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';

/**
 * In-memory cache backend that models immutable saves and newest-prefix restores.
 *
 * The fake intentionally rejects duplicate keys instead of silently treating them as updates.
 * This makes tests exercise the same lifecycle constraint as GitHub's cache service.
 */
export class ImmutableCacheBackend implements BaseCacheBackend {
  readonly capabilities = STANDARD_BASE_CACHE_BACKEND_CAPABILITIES;
  readonly #entries: Array<{ readonly id: number; readonly key: string }> = [];

  isFeatureAvailable(): boolean {
    return true;
  }

  async restoreCache(
    _paths: string[],
    primaryKey: string,
    restoreKeys: string[] = [],
  ): Promise<string | undefined> {
    for (const candidate of [primaryKey, ...restoreKeys]) {
      for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
        const entry = this.#entries[index];
        if (entry?.key.startsWith(candidate)) {
          return entry.key;
        }
      }
    }

    return undefined;
  }

  async saveCache(_paths: string[], key: string): Promise<number> {
    if (this.#entries.some((entry) => entry.key === key)) {
      throw new Error(`Immutable cache key '${key}' already exists.`);
    }

    const id = this.#entries.length + 1;
    this.#entries.push({ id, key });
    return id;
  }

  isMissingPathsError(): boolean {
    return false;
  }

  get savedKeys(): readonly string[] {
    return this.#entries.map((entry) => entry.key);
  }
}
