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

import { readFile, writeFile } from 'node:fs/promises';
import { NativeRoot, type nativeWork } from '../../../src/cache/streaming/native';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
const [input, output] = process.argv.slice(2);
const anchor = JSON.parse(await readFile(input, 'utf8'));
const work = new Set<ReturnType<typeof nativeWork>>(),
  bind = NativeRoot.bind;
NativeRoot.bind = async (...args) => {
  const r = await bind(...args);
  work.add(r.work);
  return r;
};
const budget = new WorkingBudget();
const result = await postStreamingBase({
  anchor,
  budget,
  assertCurrent: () => undefined,
  removeHooks: async () => {},
  cacheBackend: async () => ({
    capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
    isFeatureAvailable: () => true,
    restoreCache: async () => {
      throw new Error('unexpected restore');
    },
    saveCache: async () => {
      throw new Error('unchanged post must not upload');
    },
    isMissingPathsError: () => false,
  }),
});
if (budget.retained) throw new Error('Post leaked budget.');
await writeFile(
  output,
  JSON.stringify({
    outcome: result.outcome,
    hashes: [...work].reduce((n, w) => n + w.bodyHashCalls, 0),
  }),
);
