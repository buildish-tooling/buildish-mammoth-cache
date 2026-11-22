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
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { installFixture } from './install-fixture';
import { NativeHashBuffer, NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
it('shares one charged buffer across short reads, files and empty bodies without streams', async () => {
  const f = await installFixture();
  cleanup.push(f.close);
  const body = 'abcdefgh'.repeat(20000);
  await f.files('', { 'data/a': body, 'data/b': '', 'data/c': 'next' });
  using hashes = new NativeHashBuffer(f.budget);
  const allocations = vi.spyOn(Buffer, 'allocUnsafe');
  const phase = new NativeReadPhase(f.store.root, 'data', hashes),
    n = (await f.store.root.stat('data'))!;
  await phase.enter('data', n);
  for (const [name, text] of [
    ['a', body],
    ['b', ''],
    ['c', 'next'],
  ]) {
    expect(
      await phase.hash(
        'data/' + name,
        (await f.store.root.stat('data/' + name))!,
        null,
        new AbortController().signal,
      ),
    ).toBe(createHash('sha256').update(text).digest('hex'));
  }
  await phase.leave('data', n);
  expect(f.store.root.work.bodyHashStreams).toBe(0);
  expect(f.store.root.work.bodyHashCalls).toBe(3);
  expect(f.store.root.work.bodyHashBytes).toBe(Buffer.byteLength(body) + 4);
  expect(allocations.mock.calls.filter(([size]) => size === 65536)).toHaveLength(1);
  expect(f.budget.retained).toBe(65536);
  hashes.dispose();
  expect(f.budget.retained).toBe(0);
});
it('honors short reads and cancellation during an in-flight read', async () => {
  const f = await installFixture();
  cleanup.push(f.close);
  await f.files('', { 'data/a': 'abcdefghijk' });
  using hashes = new NativeHashBuffer(f.budget);
  const handle = await open(f.store.root.resolve('data/a'), 'r'),
    read = handle.read.bind(handle);
  let body = '';
  try {
    vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
      const [buffer, offset, length, position] = args as unknown as [
        Buffer,
        number,
        number,
        number | null,
      ];
      return Reflect.apply(read, handle, [buffer, offset, Math.min(3, length), position]);
    });
    await hashes.hash(handle, new AbortController().signal, (bytes) => {
      body += bytes.toString();
    });
    expect(body).toBe('abcdefghijk');
    const abort = new AbortController();
    vi.spyOn(handle, 'read').mockImplementation(async () => {
      abort.abort(new Error('read canceled'));
      return { bytesRead: 0, buffer: Buffer.alloc(0) };
    });
    await expect(
      hashes.hash(handle, abort.signal, () => {
        throw new Error('must not consume');
      }),
    ).rejects.toThrow('read canceled');
  } finally {
    await handle.close();
  }
  hashes.dispose();
  expect(f.budget.retained).toBe(0);
});
