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

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { invocationId, resolveModel, type ResolvedModel } from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { localOptions, nonce } from './local-fixtures';
import { cleanupBaseFixtures as cleanupSdk } from './native-cache-fixture';
export { nativeCacheBackend } from './native-cache-fixture';
const roots: string[] = [];
export async function cleanupBaseFixtures() {
  await cleanupSdk();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}
export async function baseFixture(model?: ResolvedModel) {
  const directory = await mkdtemp(path.resolve('build/native-base-'));
  const root = path.join(directory, 'home');
  roots.push(directory);
  await mkdir(root);
  model ??= resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default', 0]],
    ],
    'base-',
    1,
  );
  const options = localOptions();
  options.context[7] = model.tuple[2];
  const store = await OwnedStore.bind(
    root,
    new LocalCodec({ ...options, model, invocation: invocationId(options.context, nonce) }),
  );
  await store.root.createMetadataDirectory();
  return { root, store, model, budget: new WorkingBudget() };
}
