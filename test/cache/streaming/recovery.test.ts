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
import { readFile } from 'node:fs/promises';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { PostAttempt } from '../../../src/cache/streaming/lifecycle-attempt';
const fixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const f = await metadataFixture();
  fixtures.push(f);
  return f;
}
const assertCurrent = (): undefined => {};
it('claims a real successful local-v2 handoff once and rejects later post admission without touching payload', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'body' });
  const attempt = await PostAttempt.open(await OpenedInvocation.open(ready.anchor, f.budget), {
    budget: f.budget,
    assertCurrent,
  });
  expect(attempt.state[4]).toBe('post-active');
  expect(attempt.state).toHaveLength(8);
  attempt.close();
  const before = await readFile(f.root + '/data/a');
  await expect(
    PostAttempt.open(await OpenedInvocation.open(ready.anchor, f.budget), {
      budget: f.budget,
      assertCurrent,
    }),
  ).rejects.toThrow('cannot resume');
  expect(await readFile(f.root + '/data/a')).toEqual(before);
});
it.each(['prepare-pending', 'prepare-failed', 'post-active'] as const)(
  'never grants a post owner or invokes a resolver for %s',
  async (phase) => {
    const f = await fixture(),
      ready = await f.prepare(),
      state = ready.store.codec.schemas.documents['local-state'].parse(await ready.store.state());
    state[3]++;
    state[4] = phase;
    await ready.store.updateState(state);
    await f.files(f.root, { 'data/a': 'retained' });
    const lifecycle = vi.fn();
    await expect(
      PostAttempt.open(await OpenedInvocation.open(ready.anchor, f.budget), {
        budget: f.budget,
        assertCurrent,
        lifecycle,
      }),
    ).rejects.toThrow('cannot resume');
    expect(lifecycle).not.toHaveBeenCalled();
    expect(await readFile(f.root + '/data/a', 'utf8')).toBe('retained');
  },
);
it('does not adopt an interrupted existing owner when a new prepare is attempted', async () => {
  const f = await fixture(),
    ready = await f.prepare(),
    state = ready.store.codec.schemas.documents['local-state'].parse(await ready.store.state());
  state[3]++;
  state[4] = 'post-active';
  await ready.store.updateState(state);
  await f.files(f.root, { 'data/a': 'retained' });
  await expect(f.prepare({ nonce: 'b'.repeat(32) })).rejects.toThrow('Interrupted lifecycle');
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('retained');
});
it('rejects a copied invocation receipt instead of manufacturing a post owner', async () => {
  const f = await fixture(),
    ready = await f.prepare(),
    opened = await OpenedInvocation.open(ready.anchor, f.budget);
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(opened)),
    opened,
  ) as OpenedInvocation;
  await expect(PostAttempt.open(copy, { budget: f.budget, assertCurrent })).rejects.toThrow(
    'Unbound',
  );
  expect(((await ready.store.state()) as unknown[])[4]).toBe('build-ready');
});
