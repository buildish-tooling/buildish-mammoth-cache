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
import { baseEvidence, syncBasePayload } from '../../../src/cache/streaming/base-evidence';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { baseFixture, preparedBase, cleanupBaseFixtures } from './base-fixtures';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBaseFixtures();
});

it.each([false, true])(
  'rejects already-aborted directory evidence before native work; syncing=%s',
  async (syncing) => {
    const f = await baseFixture(),
      object = await preparedBase(f, {}, 'data', ['empty']),
      abort = new AbortController(),
      reason = new Error('already cancelled'),
      rows = vi.spyOn(f.store, 'rows'),
      enter = vi.spyOn(NativeReadPhase.prototype, 'enter'),
      sync = vi.spyOn(f.store.root, 'syncDirectory');
    abort.abort(reason);
    const work = async () => {
      const options = { budget: f.budget, signal: abort.signal };
      if (syncing) await syncBasePayload(f.store, object.payload, object.evidence, 'data', options);
      else
        for await (const row of baseEvidence(
          f.store,
          object.payload,
          object.evidence,
          'data',
          options,
        )) {
          expect(row).toBeUndefined();
        }
    };
    await expect(work()).rejects.toBe(reason);
    expect(rows).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(f.budget.retained).toBe(0);
  },
);

it('stops a directory-only payload after the in-flight sync settles and releases its evidence state', async () => {
  const f = await baseFixture(),
    directories = Array.from({ length: 32 }, (_, n) => 'd' + String(n).padStart(2, '0')),
    object = await preparedBase(f, {}, 'data', directories),
    abort = new AbortController(),
    reason = new Error('cancel after first sync'),
    original = f.store.root.syncDirectory.bind(f.store.root),
    sync = vi.spyOn(f.store.root, 'syncDirectory');
  sync.mockImplementation(async (...args) => {
    const result = await original(...args);
    abort.abort(reason);
    return result;
  });
  await expect(
    syncBasePayload(f.store, object.payload, object.evidence, 'data', {
      budget: f.budget,
      signal: abort.signal,
    }),
  ).rejects.toBe(reason);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(f.budget.retained).toBe(0);
  sync.mockRestore();
  const retry = vi.spyOn(f.store.root, 'syncDirectory');
  await syncBasePayload(f.store, object.payload, object.evidence, 'data', { budget: f.budget });
  expect(retry).toHaveBeenCalledTimes(33);
  expect(f.budget.retained).toBe(0);
});

it('stops before yielding further directories when cancellation arrives during native validation', async () => {
  const f = await baseFixture(),
    object = await preparedBase(f, {}, 'data', ['a/b', 'c']),
    abort = new AbortController(),
    reason = new Error('cancel during enter'),
    enter = NativeReadPhase.prototype.enter,
    sync = vi.spyOn(f.store.root, 'syncDirectory');
  vi.spyOn(NativeReadPhase.prototype, 'enter').mockImplementation(async function (
    this: NativeReadPhase,
    ...args
  ) {
    await enter.apply(this, args);
    abort.abort(reason);
  });
  const yielded: string[] = [];
  const work = async () => {
    for await (const row of baseEvidence(
      f.store,
      object.payload,
      object.evidence,
      'data',
      { budget: f.budget, signal: abort.signal },
      true,
    ))
      yielded.push(row.logical);
  };
  await expect(work()).rejects.toBe(reason);
  expect(yielded).toEqual([]);
  expect(sync).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});
