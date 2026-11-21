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

import type { Value } from '../../../src/cache/streaming/encoding';
import { installFixture } from './install-fixture';
export const rows = (values: readonly Value[]) =>
  (async function* () {
    yield* values;
  })();
export async function observationFixture(
  tool: 'gradle' | 'maven' = 'maven',
  options: Parameters<typeof installFixture>[1] = {},
  activity: readonly Value[] = [
    ['dir-open', ''],
    ['dir-close', ''],
  ],
) {
  const f = await installFixture(tool, options),
    spec = { budget: f.budget, partition: null },
    b = f.bindings,
    policy = b[8] as Value[];
  b[6] = await f.store.writeStream(
    'model',
    spec,
    rows([
      ['model-header', tool, f.model.tuple[3]],
      ...f.model.partitions.map((p) => ['partition', ...p]),
    ]),
  );
  b[10] = await f.store.writeStream('producers', spec, rows([]));
  b[11] = await f.store.writeStream('prepare-sources', spec, rows([]));
  b[12] = await f.store.writeStream('activity', spec, rows(activity));
  policy[5] = 'timestamp';
  policy[6] = 1000000;
  policy[7] = Date.now() + 600000;
  await f.store.initialize(b);
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'quiescent';
  if (tool === 'gradle') {
    const installations = await f.store.writeStream('installations', spec, rows([]));
    state[13] = f.store.codec.schemas
      .ref('quiescence')
      .parse(
        await f.store.writeDocument([
          'quiescence',
          1,
          f.store.codec.options.invocation,
          installations,
          'all-exited',
          0,
        ]),
      );
  }
  await f.store.updateState(state);
  return f;
}
