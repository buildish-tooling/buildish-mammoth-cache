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
import { localRecords, type PrepareSelection } from '../../../src/cache/streaming/prepare-state';
import type { Value } from '../../../src/cache/streaming/encoding';
export async function prepareStateFixture(configuration?: Parameters<typeof installFixture>[1]) {
  const f = await installFixture('maven', configuration),
    stream = { budget: f.budget, partition: null };
  await f.store.makeParents(f.store.prefix + 'install/pending');
  const owner = (await f.store.root.stat(f.store.prefix + 'install'))!;
  const selection: PrepareSelection = [
    'prepare-selection',
    1,
    'refs/heads/main',
    null,
    ['execution', 1, null, 7, 'enabled', null],
    ['pending'],
    ['pending'],
    null,
    owner,
    'selected',
  ];
  const b = f.bindings;
  (b[8] as Value[])[7] = null;
  b[9] = null;
  b[12] = null;
  b[6] = await f.store.writeStream(
    'model',
    stream,
    localRecords([
      ['model-header', 'maven', f.model.tuple[3]],
      ...f.model.partitions.map((p) => ['partition', ...p] as Value),
    ]),
  );
  b[10] = await f.store.writeStream('producers', stream, localRecords([]));
  b[11] = await f.store.writeStream('prepare-sources', stream, localRecords([selection]));
  await f.store.initialize(b);
  return { ...f, selection };
}
