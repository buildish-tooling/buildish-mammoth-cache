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
import type { Value } from '../../../src/cache/streaming/encoding';
import { readFile } from 'node:fs/promises';
import { installFixture } from './install-fixture';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function pair() {
  const old = await installFixture();
  fixtures.push(old);
  const next = await installFixture('gradle', { root: old.root, nonce: 'b'.repeat(32) });
  return { old, next };
}
async function complete(old: Awaited<ReturnType<typeof installFixture>>) {
  const state = old.store.codec.schemas.documents['local-state'].parse(await old.store.state());
  const activity = await old.store.writeStream(
    'activity',
    { budget: old.budget, partition: null },
    (async function* (): AsyncGenerator<Value> {
      yield ['dir-open', ''];
      yield ['dir-close', ''];
    })(),
  );
  const handoff = await old.store.writeStream(
    'handoff',
    { budget: old.budget, partition: null },
    (async function* (): AsyncGenerator<Value> {
      yield ['handoff', 4, 'base-key', null, null, 1, 'disabled', null, null, activity, 0, 0, null];
      for (const p of old.model.partitions) yield ['partition', p[0], 'miss', null, null];
    })(),
  );
  state[6] = old.store.codec.schemas.ref('handoff').parse(handoff);
  state[3]++;
  state[4] = 'completed';
  state[7] = ['outcome', 'abandoned', null, null, null];
  await old.store.updateState(state);
}
it('supersedes completed control ownership while retaining the old namespace and live data', async () => {
  const { old, next } = await pair();
  await old.store.initialize(old.bindings);
  await old.files('', { 'data/live': 'live', [old.store.prefix + 'orphan/file']: 'old-private' });
  await complete(old);
  const before = await readFile(old.store.root.resolve(old.store.prefix + 'state.json'));
  await next.store.initialize(next.bindings, old.store);
  expect(await readFile(old.store.root.resolve(old.store.prefix + 'state.json'))).toEqual(before);
  expect(await readFile(old.store.root.resolve(old.store.prefix + 'orphan/file'), 'utf8')).toBe(
    'old-private',
  );
  expect(await readFile(old.store.root.resolve('data/live'), 'utf8')).toBe('live');
  expect(await next.store.root.stat(next.store.prefix + 'retired')).toBeNull();
  expect(await next.store.root.stat(next.store.prefix + 'retirements')).toBeNull();
});
it('rejects an interrupted owner without deleting private or live data', async () => {
  const { old, next } = await pair();
  await old.store.initialize(old.bindings);
  await old.files('', { 'data/live': 'live', [old.store.prefix + 'orphan/file']: 'private' });
  await expect(next.store.initialize(next.bindings, old.store)).rejects.toThrow(
    'fresh dedicated root',
  );
  expect(await readFile(old.store.root.resolve('data/live'), 'utf8')).toBe('live');
  expect(await readFile(old.store.root.resolve(old.store.prefix + 'orphan/file'), 'utf8')).toBe(
    'private',
  );
});
it('rejects same-invocation initialization without replacing terminal control state', async () => {
  const { old } = await pair();
  await old.store.initialize(old.bindings);
  await complete(old);
  const before = await readFile(old.store.root.resolve('.mammoth/v1/current.json'));
  await expect(old.store.initialize(old.bindings, old.store)).rejects.toThrow('same invocation');
  expect(await readFile(old.store.root.resolve('.mammoth/v1/current.json'))).toEqual(before);
});
it.each(['retired', 'ReTiReD', 'retired.', 'RETIRED  ', 'retıred'])(
  'rejects %s aliases in owned references and active references',
  async (segment) => {
    const { old } = await pair();
    const schema = old.store.codec.schemas;
    const path = old.store.prefix + segment + '/' + 'd'.repeat(64) + '/body';
    expect(schema.owned.safeParse(path).success).toBe(false);
    expect(
      schema.ref('activity').safeParse(['ref', 'activity', path, 1, 'a'.repeat(64)]).success,
    ).toBe(false);
  },
);
