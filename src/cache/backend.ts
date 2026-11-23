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
 * Minimal provider-neutral base-cache backend contract.
 *
 * Provider adapters may map this to toolkit- or service-specific cache APIs, but shared
 * orchestration should depend only on this narrower backend seam.
 */
export interface BaseCacheBackendCapabilities {
  /** Whether the backend restores the newest matching immutable generation for a key prefix. */
  readonly supportsNewestPrefixRestore: boolean;
  /** Whether the backend supports explicit save calls from shared post-action logic. */
  readonly supportsExplicitSave: boolean;
}

/** Capability set for a fully programmatic cache backend such as GitHub Actions cache. */
export const STANDARD_BASE_CACHE_BACKEND_CAPABILITIES: BaseCacheBackendCapabilities = {
  supportsNewestPrefixRestore: true,
  supportsExplicitSave: true,
};

/** Explicit extraction/archive root; relative request patterns remain version-stable. */
export interface BaseCacheOperationOptions {
  readonly archiveRoot?: string;
  readonly lookupOnly?: boolean;
}

/**
 * Provider-neutral interface for base cache operations.
 *
 * Shared orchestration code calls only this interface; provider-specific implementations
 * (e.g. `createGitHubBaseCacheBackend`) adapt the underlying toolkit APIs to this surface.
 * Use `capabilities` to branch on optional features rather than checking the provider identity.
 */
export interface BaseCacheBackend {
  /** Declares optional cache features that shared orchestration may need to branch on. */
  readonly capabilities: BaseCacheBackendCapabilities;
  /** Reports whether the active cache backend is usable in the current environment. */
  isFeatureAvailable(): boolean;
  /** Whether a positive direct save result proves finalized upload (checked before moving sources). */
  canConfirmSave?(): boolean;
  /** Restores the newest matching entry. Undefined reports unavailability, not proven
   * absence: some SDK adapters suppress download/extraction failures. Native callers
   * reject partial extraction; publication readback then remains unconfirmed. */
  restoreCache(
    paths: string[],
    primaryKeyPrefix: string,
    fallbackKeyPrefixes?: string[],
    options?: BaseCacheOperationOptions,
  ): Promise<string | undefined>;
  /** Attempts once to create an immutable cache entry. A valid positive integer must
   * mean finalized direct confirmation; adapters unable to promise that disable
   * canConfirmSave before callers evacuate sources. Settlement must release base
   * source-reading archive consumers even when the result is unconfirmed. */
  saveCache(paths: string[], key: string, options?: BaseCacheOperationOptions): Promise<number>;
  /** Optional version-aware existence check; caller must require exact returned-key equality. */
  lookupCache?(
    paths: string[],
    key: string,
    options?: BaseCacheOperationOptions,
  ): Promise<string | undefined>;
  /**
   * Returns `true` when the given error was thrown by {@link saveCache} because none of the
   * requested cache paths exist on disk yet.
   *
   * Implementations encapsulate provider-specific error detection (e.g. message-string matching
   * for `@actions/cache`) so shared orchestration never depends on provider error formats.
   */
  isMissingPathsError(error: unknown): boolean;
}
