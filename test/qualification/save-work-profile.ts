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

// Opt-in fixed warm case; real local archive transport, no hosted services.
import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { composedFixture } from '../cache/streaming/composed-fixture';
import { nativeCacheBackend, cleanupBaseFixtures } from '../cache/streaming/base-fixtures';
import { NativeRoot, nativeWork } from '../../src/cache/streaming/native';
import { prepareStreaming } from '../../src/cache/streaming/prepare';
import { postStreamingBase } from '../../src/cache/streaming/base-post';
it('fixed5000-file prepare plus warm post', async () => {
  const sdk = await nativeCacheBackend();
  const work = new Set<ReturnType<typeof nativeWork>>(),
    bind = NativeRoot.bind;
  vi.spyOn(NativeRoot, 'bind').mockImplementation(async (...args) => {
    const r = await bind(...args);
    work.add(r.work);
    return r;
  });
  const f = await composedFixture({ cacheBackend: async () => sdk.backend });
  const total = () => {
    const sum = nativeWork();
    for (const w of work)
      for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += w[key];
    return sum;
  };
  const difference = (a: ReturnType<typeof nativeWork>, b: ReturnType<typeof nativeWork>) =>
    Object.fromEntries(
      Object.keys(a).map((k) => [k, a[k as keyof typeof a] - b[k as keyof typeof b]]),
    );
  const post = (anchor: Parameters<typeof postStreamingBase>[0]['anchor']) =>
    postStreamingBase({
      anchor,
      budget: f.budget,
      assertCurrent: () => undefined,
      cacheBackend: async () => sdk.backend,
      removeHooks: async () => {},
    });
  try {
    const ready = await prepareStreaming(f.request);
    for (let n = 0; n < 5000; n++)
      await f.files('', { ['data/' + Math.floor(n / 100) + '/' + n]: 'x'.repeat(64) });
    expect((await post(ready.anchor)).outcome).toBe('published');
    const initial = total(),
      cpu = process.cpuUsage(),
      start = performance.now();
    const warm = await prepareStreaming({ ...f.request, nonce: 'd'.repeat(32) });
    const prepared = total(),
      prepareMs = performance.now() - start;
    const result = await post(warm.anchor),
      end = total();
    expect(result.outcome).toBe('no-change');
    expect(f.budget.retained).toBe(0);
    const record = {
      files: 5000,
      prepareMs,
      totalMs: performance.now() - start,
      cpu: process.cpuUsage(cpu),
      prepare: difference(prepared, initial),
      post: difference(end, prepared),
      total: difference(end, initial),
      peakCharged: f.budget.peakRetained,
      scope:
        'prepare+warm post; local native gzip archive backend; no HTTP; seed/oracle/cleanup excluded; charged peak cumulative, not RSS',
    };
    await mkdir('build/save-work', { recursive: true });
    await writeFile(
      'build/save-work/' + (process.env.SAVE_WORK_STAGE ?? 'current') + '.json',
      JSON.stringify(record, null, 2) + '\n',
    );
    console.log('SAVE_WORK ' + JSON.stringify(record));
  } finally {
    vi.restoreAllMocks();
    await f.close();
    await cleanupBaseFixtures();
  }
}, 60000);
