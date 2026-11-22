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
import { baseEvidence } from '../../../src/cache/streaming/base-evidence';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { baseFixture, preparedBase, cleanupBaseFixtures } from './base-fixtures';

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBaseFixtures();
});

it('rejects already-aborted directory evidence before native work', async () => {
  const f = await baseFixture(),
    object = await preparedBase(f, {}, 'data', ['empty']),
    abort = new AbortController(),
    reason = new Error('already cancelled'),
    rows = vi.spyOn(f.store, 'rows'),
    enter = vi.spyOn(NativeReadPhase.prototype, 'enter');
  abort.abort(reason);
  const work = async () => {
    for await (const row of baseEvidence(f.store, object.payload, object.evidence, 'data', {
      budget: f.budget,
      signal: abort.signal,
    }))
      expect(row).toBeUndefined();
  };
  await expect(work()).rejects.toBe(reason);
  expect(rows).not.toHaveBeenCalled();
  expect(enter).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});

it('stops directory evidence after in-flight validation and releases its state for retry', async () => {
  const f = await baseFixture(),
    directories = Array.from({ length: 32 }, (_, n) => 'd' + String(n).padStart(2, '0')),
    object = await preparedBase(f, {}, 'data', directories),
    abort = new AbortController(),
    reason = new Error('cancel after first directory close'),
    original = NativeReadPhase.prototype.leave,
    leave = vi.spyOn(NativeReadPhase.prototype, 'leave');
  leave.mockImplementation(async function (this: NativeReadPhase, ...args) {
    await original.apply(this, args);
    abort.abort(reason);
  });
  const collect = async (signal?: AbortSignal) => {
    let count = 0;
    for await (const row of baseEvidence(f.store, object.payload, object.evidence, 'data', {
      budget: f.budget,
      signal,
    })) {
      expect(row.native[2]).toBe('directory');
      count++;
    }
    return count;
  };
  await expect(collect(abort.signal)).rejects.toBe(reason);
  expect(leave).toHaveBeenCalledTimes(1);
  expect(f.budget.retained).toBe(0);
  leave.mockRestore();
  expect(await collect()).toBe(33);
  expect(f.budget.retained).toBe(0);
});

it('stops before yielding directories when cancellation arrives during native validation', async () => {
  const f = await baseFixture(),
    object = await preparedBase(f, {}, 'data', ['a/b', 'c']),
    abort = new AbortController(),
    reason = new Error('cancel during enter'),
    enter = NativeReadPhase.prototype.enter;
  vi.spyOn(NativeReadPhase.prototype, 'enter').mockImplementation(async function (
    this: NativeReadPhase,
    ...args
  ) {
    await enter.apply(this, args);
    abort.abort(reason);
  });
  const yielded: string[] = [];
  const work = async () => {
    for await (const row of baseEvidence(f.store, object.payload, object.evidence, 'data', {
      budget: f.budget,
      signal: abort.signal,
    }))
      yielded.push(row.logical);
  };
  await expect(work()).rejects.toBe(reason);
  expect(yielded).toEqual([]);
  expect(f.budget.retained).toBe(0);
});
