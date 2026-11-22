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

// Q1-only selected P/D cases; separate config prevents automatic benchmark execution.
import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { composedFixture } from '../cache/streaming/composed-fixture';
import { NativeRoot, nativeWork } from '../../src/cache/streaming/native';
import { resolveModel } from '../../src/cache/streaming/model';
import { prepareStreaming } from '../../src/cache/streaming/prepare';
import { postStreamingBase } from '../../src/cache/streaming/base-post';
it.each([
  { partitions: 1, depth: 1, length: 8 },
  { partitions: 64, depth: 1, length: 8 },
  { partitions: 1, depth: 32, length: 8 },
  { partitions: 1, depth: 1, length: 128 },
])(
  'native metadata case %j',
  async (params) => {
    const hard = ['.mammoth/**'];
    const model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        Array.from({ length: params.partitions }, (_, n) => [
          'p' + String(n).padStart(3, '0'),
          ['shared/**/p' + String(n).padStart(3, '0') + '/**'],
          hard,
          'aggregate',
          null,
          'default',
        ]),
      ],
      'q1-count-',
      1,
    );
    const work = new Set<ReturnType<typeof nativeWork>>(),
      bind = NativeRoot.bind;
    vi.spyOn(NativeRoot, 'bind').mockImplementation(async (...args) => {
      const r = await bind(...args);
      work.add(r.work);
      return r;
    });
    const f = await composedFixture({}, model);
    try {
      const prepared = await prepareStreaming(f.request);
      for (let n = 0; n < 128; n++)
        await f.files('', {
          ['shared/' +
          'd/'.repeat(params.depth) +
          'p' +
          String(n % params.partitions).padStart(3, '0') +
          '/' +
          String(n).padStart(params.length, 'f')]: 'body',
        });
      const before = process.cpuUsage(),
        start = Date.now();
      const result = await postStreamingBase({
        anchor: prepared.anchor,
        budget: f.budget,
        assertCurrent: () => undefined,
        cacheBackend: async () => f.backend,
        removeHooks: async () => {},
      });
      expect(result.outcome).toBe('published');
      expect(f.budget.retained).toBe(0);
      const totals = nativeWork();
      for (const w of work)
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += w[key];
      const report = {
        params,
        files: 128,
        work: totals,
        chargedPeak: f.budget.peakRetained,
        cpu: process.cpuUsage(before),
        milliseconds: Date.now() - start,
        backend: 'acknowledging diagnostic double; not hosted SDK throughput',
      };
      await mkdir('build/q1-results', { recursive: true });
      await writeFile(
        `build/q1-results/metadata-${params.partitions}-${params.depth}-${params.length}.json`,
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log('Q1_METADATA ' + JSON.stringify(report));
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
  120000,
);
