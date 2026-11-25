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
import { resolveModel } from '../../../src/cache/streaming/model';
export function mixedDirectoryModel() {
  const hard = ['.mammoth/**', '**/*.lock'];
  return resolveModel(
    [
      'model',
      1,
      'gradle',
      hard,
      [
        ['data', ['data/**'], [...hard, '**/other'], 'aggregate', null, 'default', 0],
        ['other', ['data/**/other'], hard, 'aggregate', null, 'default', 0],
      ],
    ],
    'mixed-',
    1,
  );
}
export async function mixedDirectoryInputs(f: Awaited<ReturnType<typeof installFixture>>) {
  return [
    await f.incoming('data', { 'data/a': 'a', 'data/b': 'b', 'data/sub/c': 'c' }),
    await f.incoming('other', { 'data/other': 'other', 'data/sub/other': 'other' }),
  ];
}
export async function mixedDirectoryFixture() {
  const f = await installFixture('gradle', { model: mixedDirectoryModel() });
  await f.store.initialize(f.bindings);
  return { ...f, inputs: await mixedDirectoryInputs(f) };
}
