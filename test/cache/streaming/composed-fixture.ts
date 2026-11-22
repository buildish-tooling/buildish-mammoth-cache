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

import { vi } from 'vitest';
import { installFixture } from './install-fixture';
import type { StreamingPrepareRequest } from '../../../src/cache/streaming/prepare';
import type { ResolvedModel } from '../../../src/cache/streaming/model';
import type { BaseCacheBackend } from '../../../src/cache/backend';
export async function composedFixture(
  overrides: Partial<StreamingPrepareRequest> = {},
  model?: ResolvedModel,
) {
  const f = await installFixture(model?.tuple[2] ?? 'maven', { model });
  let saved = '';
  const backend: BaseCacheBackend = {
    capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
    isFeatureAvailable: () => true,
    restoreCache: vi.fn(async () => undefined),
    saveCache: vi.fn(async () => 1),
    isMissingPathsError: () => false,
  };
  const provision = vi.fn(async () => {}),
    hooks = vi.fn(async () => {});
  const request: StreamingPrepareRequest = {
    root: f.root,
    model: f.model,
    context: f.store.codec.options.context,
    nonce: String(f.bindings[4]),
    budget: f.budget,
    policy: {
      role: 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: [],
    },
    currentRef: 'refs/heads/main',
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    saveAnchor: (raw) => {
      saved = raw;
    },
    cacheBackend: async () => backend,
    provision,
    installHooks: hooks,
    assertCurrent: (): undefined => {},
    ...overrides,
  };
  return { ...f, request, backend, provision, hooks, saved: () => saved };
}
