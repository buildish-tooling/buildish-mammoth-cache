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

import { afterEach, expect, it, vi } from 'vitest';
import { createGitHubBaseCacheBackend, githubCacheFinalizesSave } from '../../src/ci/github/cache';
afterEach(() => vi.unstubAllEnvs());
it.each([
  [undefined, undefined, false],
  ['https://github.com', '', false],
  ['https://github.com', '0', true],
  ['https://GITHUB.COM', 'false', true],
  ['https://tenant.ghe.com', '1', true],
  ['https://cache.localhost', '1', true],
  ['https://github.example.org', '1', false],
  ['https://github.com.example.org', '1', false],
])('mirrors installed service selection for host=%s flag=%s', (host, flag, expected) => {
  expect(
    githubCacheFinalizesSave({ GITHUB_SERVER_URL: host, ACTIONS_CACHE_SERVICE_V2: flag }),
  ).toBe(expected);
});
it('gates V1 outgoing but retains restore, then allows V2 finalized direct results', async () => {
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('ACTIONS_CACHE_SERVICE_V2', '');
  const sdk = {
      isFeatureAvailable: () => true,
      saveCache: vi.fn(async () => 123),
      restoreCache: vi.fn(async () => 'key'),
    },
    warn = vi.fn();
  const backend = createGitHubBaseCacheBackend(sdk, undefined, warn);
  expect(backend.canConfirmSave!()).toBe(false);
  expect(backend.isFeatureAvailable()).toBe(true);
  expect(await backend.saveCache([], 'key')).toBe(-1);
  expect(sdk.saveCache).not.toHaveBeenCalled();
  expect(await backend.restoreCache([], 'key')).toBe('key');
  expect(warn).toHaveBeenCalledTimes(1);
  vi.stubEnv('ACTIONS_CACHE_SERVICE_V2', '1');
  expect(backend.canConfirmSave!()).toBe(true);
  expect(await backend.saveCache([], 'key')).toBe(123);
  vi.stubEnv('GITHUB_SERVER_URL', 'https://ghe.example');
  expect(backend.canConfirmSave!()).toBe(false);
});
