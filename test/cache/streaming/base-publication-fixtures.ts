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

import { mkdir, writeFile, utimes } from 'node:fs/promises';
import type { Value } from '../../../src/cache/streaming/encoding';
import { OwnedStore, type Reference } from '../../../src/cache/streaming/owned-store';
import { PreparedBaseSource, createBasePayload } from '../../../src/cache/streaming/base-object';
import { resolveModel } from '../../../src/cache/streaming/model';
import { localFixtures } from './local-fixtures';
import { baseFixture } from './base-fixtures';
export const stream = (rows: readonly Value[]) =>
  (async function* () {
    yield* rows;
  })();
export async function publicationFixture(
  files: Record<string, string> = { a: 'abc' },
  single = false,
) {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [['data', ['**'], hard, single ? 'single-writer' : 'aggregate', null, 'default']],
      ],
      'pub-',
      1,
    ),
    f = await baseFixture(model),
    payload = await createBasePayload(f.store, 'data');
  for (const [name, content] of Object.entries(files)) {
    const file = f.store.root.resolve(payload + '/' + name);
    await mkdir(file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))), {
      recursive: true,
    });
    await writeFile(file, content, { mode: 0o644 });
    await utimes(file, 1.234, 1.234);
  }
  const source = await PreparedBaseSource.capture(f.store, 'data', { budget: f.budget });
  await initializePublisher(f, single ? [['snapshot-source', source.snapshotSource()]] : []);
  return { ...f, source, payload };
}
export async function initializePublisher(
  f: Awaited<ReturnType<typeof baseFixture>>,
  sources: Value[] = [],
  baseline?: Value,
  prepareSources: Value[] = [],
) {
  const store = f.store,
    opts = { budget: f.budget, partition: null },
    model = await store.writeStream(
      'model',
      opts,
      stream([
        ['model-header', f.model.tuple[2], f.model.tuple[3]],
        ...f.model.partitions.map((p) => ['partition', ...p] as Value),
      ]),
    ),
    producers = await store.writeStream('producers', opts, stream([])),
    prepare = await store.writeStream('prepare-sources', opts, stream(prepareSources)),
    activity = await store.writeStream(
      'activity',
      opts,
      stream([
        ['dir-open', ''],
        ['dir-close', ''],
      ]),
    ),
    b = localFixtures(store.codec.options).bindings;
  b[5] = [f.root, store.root.binding];
  b[6] = model;
  b[9] = baseline ?? null;
  b[10] = producers;
  b[11] = prepare;
  b[12] = activity;
  await store.initialize(b);
  const root = (await store.root.stat(''))!,
    own = (await store.root.stat('.mammoth'))!,
    observations = await store.writeStream(
      'observations',
      opts,
      stream([
        ['dir-open', '', root],
        ['child', '.mammoth', 'directory', own[3], own[4]],
        ['dir-close', ''],
      ]),
    ),
    post = await store.writeStream('post-sources', opts, stream(sources));
  let end = 0,
    record = 0;
  for await (const r of store.rows(observations, 'observations', opts))
    if ((r.value as Value[])[0] === 'dir-close') {
      end = r.end;
      record = r.record;
    }
  const gc = await store.writeDocument([
      'gc-progress',
      1,
      store.codec.options.invocation,
      observations,
      ['cursor', observations[4], end, record, 0, null],
      null,
    ]),
    state = store.codec.schemas.documents['local-state'].parse(await store.state());
  state[3]++;
  state[4] = 'gc-complete';
  state[6] = store.codec.schemas.ref('observations').parse(observations);
  state[7] = store.codec.schemas.ref('post-sources').parse(post);
  state[10] = store.codec.schemas.ref('gc-progress').parse(gc);
  await store.updateState(state);
}
export async function restartPublisher(store: OwnedStore): Promise<OwnedStore> {
  return OwnedStore.bind(store.root.path, store.codec);
}
export type PublicationFixture = Awaited<ReturnType<typeof publicationFixture>>;
export async function receipts(f: PublicationFixture): Promise<Value[]> {
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
    values: Value[] = [];
  await f.store.readStream(
    state[9] as Reference,
    'partition-state',
    { budget: f.budget, partition: null },
    async (v) => {
      if ((v as Value[])[0] === 'partition-state') values.push(v);
    },
  );
  return values;
}
