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

import { installFixture } from './install-fixture';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
const [mode, root, point] = process.argv.slice(2);
const f = await installFixture('maven', { root });
if (mode === 'start') await f.files('', { 'data/keep': 'ordinary', 'state/stale': 'old' });
await prepareStreaming({
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
  saveAnchor: () => {},
  cacheBackend: async () => ({
    capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
    isFeatureAvailable: () => true,
    restoreCache: async () => undefined,
    saveCache: async () => 1,
    isMissingPathsError: () => false,
  }),
  provision: async () => {},
  installHooks: async () => {},
  assertCurrent: (): undefined => {},
  now: () => 12345,
  fail: async (name) => {
    if (name === point) process.exit(73);
  },
});
if (f.budget.retained) throw new Error('Prepare process leaked budget.');
