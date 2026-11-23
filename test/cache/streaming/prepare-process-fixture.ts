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

import { mkdir, writeFile } from 'node:fs/promises';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { resolveModel } from '../../../src/cache/streaming/model';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import type { Context } from '../../../src/cache/streaming/schema';
const [mode, root, point] = process.argv.slice(2),
  budget = new WorkingBudget(),
  hard = ['.mammoth/**'];
const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['data/**'], hard, 'aggregate', null, 'default'],
        ['state', ['state/**'], hard, 'single-writer', null, 'default'],
      ],
    ],
    'process-v2-',
    1,
  ),
  context: Context = ['github', 'host', 'repository', 'workflow', 'job', 1, 'run', 'maven'];
const backend: BaseCacheBackend = {
  capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
  isFeatureAvailable: () => true,
  restoreCache: async () => undefined,
  saveCache: async () => {
    if (mode === 'post-crash') process.exit(73);
    return 1;
  },
  isMissingPathsError: () => false,
};
if (mode === 'post' || mode === 'post-crash') {
  const opened = (await OpenedInvocation.current(root, budget))!;
  const result = await postStreamingBase({
    anchor: opened.anchor,
    budget,
    assertCurrent: (): undefined => {},
    removeHooks: async () => {},
    cacheBackend: async () => backend,
  });
  if (result.outcome !== 'published') throw new Error('Post did not publish: ' + result.outcome);
} else {
  if (mode === 'start' || mode === 'success') {
    await mkdir(root + '/data', { recursive: true });
    await mkdir(root + '/state', { recursive: true });
    await writeFile(root + '/data/keep', 'ordinary');
    await writeFile(root + '/state/stale', 'old');
  }
  await prepareStreaming({
    root,
    model,
    context,
    nonce: 'a'.repeat(32),
    budget,
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
    saveAnchor() {},
    cacheBackend: async () => backend,
    provision: async () => {},
    installHooks: async () => {},
    assertCurrent: (): undefined => {},
    now: () => 12345,
    fail: async (name) => {
      if (name === point) process.exit(73);
    },
  });
}
if (budget.retained) throw new Error('Process leaked budget.');
