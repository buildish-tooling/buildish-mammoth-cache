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

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OwnedStore } from '../../src/cache/streaming/owned-store';
import { NativeRoot } from '../../src/cache/streaming/native';
import { walkNative, walkWork } from '../../src/cache/streaming/native-walk';
import { resolveModel, invocationId } from '../../src/cache/streaming/model';
import { LocalCodec } from '../../src/cache/streaming/local-schema';
import { WorkingBudget } from '../../src/cache/streaming/tree-state';
import { DiskMembership } from '../../src/cache/streaming/worker-spool';
import { writeWorkerArchive, type WorkerEvent } from '../../src/cache/streaming/worker-codec';
import { WorkerFrontier } from '../../src/cache/streaming/worker-frontier';
import { mergeWorkerArchives } from '../../src/cache/streaming/worker-merge';
import type { Context } from '../../src/cache/streaming/schema';
const signal = () => new AbortController().signal;
const root = await mkdtemp(path.resolve('build/worker-frontier-qualification-'));
async function measure(name: string, fn: () => Promise<unknown>) {
  global.gc?.();
  const before = process.memoryUsage(),
    peak = { heapUsed: before.heapUsed, rss: before.rss };
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
    peak.rss = Math.max(peak.rss, m.rss);
  }, 20);
  try {
    const evidence = await fn();
    const after = process.memoryUsage();
    console.log(JSON.stringify({ name, node: process.version, before, peak, after, evidence }));
  } finally {
    clearInterval(timer);
  }
}
try {
  if (!process.argv.includes('--merge-only')) {
    const wide = path.join(root, 'wide');
    await mkdir(wide);
    let next = 0;
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        while (true) {
          const n = next++;
          if (n === 100000 || n > 100000) return;
          await writeFile(path.join(wide, n.toString(36).padStart(4, '0')), '');
        }
      }),
    );
    await measure('real-100000-short-name-directory', async () => {
      const native = await NativeRoot.bind(wide),
        budget = new WorkingBudget(),
        work = walkWork();
      let count = 0;
      for await (const e of walkNative(native, '', { budget }, work)) if (e.tag === 'file') count++;
      assert.equal(count, 100000);
      assert.equal(budget.retained, 0);
      return { count, work, accountedPeak: budget.peakRetained, nativeWork: native.work };
    });
  }
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
    ],
    'v2-',
    1,
  );
  const context: Context = ['github', 'repo', 'run', 'attempt', 'aggregator', 1, 'linux', 'gradle'];
  const store = await OwnedStore.bind(
    root,
    new LocalCodec({
      model,
      context,
      invocation: invocationId(context, 'a'.repeat(32)),
      role: 'standalone',
      access: 'writable',
    }),
  );
  async function archive(job: string, count: number, width: number, long = false) {
    const ctx: Context = [...context];
    ctx[4] = job;
    const file = path.join(root, job + '-' + count + '.tar.gz'),
      budget = new WorkingBudget();
    async function* events(): AsyncGenerator<WorkerEvent> {
      yield { type: 'channel-open' };
      yield { type: 'dir-open', path: '' };
      for (let start = 0, d = 0; start < count; start += width, d++) {
        const dir = 'd' + String(d).padStart(5, '0');
        yield { type: 'dir-open', path: dir };
        for (let i = start; i < Math.min(count, start + width); i++)
          yield {
            type: 'file',
            path: dir + '/' + (long ? 'a'.repeat(60) : '') + String(i - start).padStart(6, '0'),
            size: 0,
            mode: 0o644,
            mtimeMs: 1000,
            bytes: (async function* () {})(),
            assertStable: async () => {},
          };
        yield { type: 'dir-close', path: dir };
      }
      yield { type: 'dir-close', path: '' };
      yield { type: 'channel-close' };
      yield { type: 'channel-open' };
      yield { type: 'dir-open', path: '' };
      yield { type: 'dir-close', path: '' };
      yield { type: 'channel-close' };
    }
    await writeWorkerArchive(
      createWriteStream(file, { highWaterMark: 16384 }),
      {
        model,
        context: ctx,
        authorizedSnapshots: [],
        budget,
        membership: await DiskMembership.create(store, budget),
        snapshots: [],
        assertStable: async () => {},
      },
      () => events(),
    );
    assert.equal(budget.retained, 0);
    return { job, context: ctx, file };
  }
  if (!process.argv.includes('--merge-only')) {
    const many = await archive('controls', 100001, 1000);
    await measure('more-than-100000-controls-narrow-directories', async () => {
      const budget = new WorkingBudget(),
        reader = new WorkerFrontier(
          createReadStream(many.file, { highWaterMark: 65536 }),
          {
            model,
            context: many.context,
            authorizedSnapshots: [],
            budget,
            membership: await DiskMembership.create(store, budget),
          },
          signal(),
        );
      try {
        let item;
        while ((item = await reader.next()))
          if (item.type === 'file') for await (const b of item.file.body) void b;
        await reader.completion;
        assert.ok(reader.work.controls > 100000);
        assert.equal(budget.retained, 0);
        return { work: reader.work, accountedPeak: budget.peakRetained };
      } finally {
        await reader.close();
      }
    });
  }
  const a = await archive('A', 2000, 1000, true),
    b = await archive('B', 2000, 1000, true);
  await measure('two-reader-long-name-actual-merge-staging', async () => {
    const budget = new WorkingBudget(),
      before = { ...store.root.work };
    const result = await mergeWorkerArchives(
      store,
      [a, b].map((x) => ({ ...x, source: createReadStream(x.file, { highWaterMark: 65536 }) })),
      { budget, ordinaryOrder: ['A', 'B'], ordinaryPolicy: 'strict' },
    );
    const evidence = {
      accountedPeak: budget.peakRetained,
      stage: result.stage.work,
      readers: result.readers.map((r) => r.work),
      nativeBefore: before,
      nativeAfter: { ...store.root.work },
    };
    await result.dispose();
    assert.equal(budget.retained, 0);
    return evidence;
  });
  await measure('shared-budget-rejection-before-live-mutation', async () => {
    const budget = new WorkingBudget(64000);
    await assert.rejects(
      mergeWorkerArchives(
        store,
        [a, b].map((x) => ({ ...x, source: createReadStream(x.file, { highWaterMark: 65536 }) })),
        { budget, ordinaryOrder: ['A', 'B'], ordinaryPolicy: 'strict' },
      ),
      /budget/,
    );
    assert.equal(await store.root.stat('d00000'), null);
    assert.equal(budget.retained, 0);
    return { accountedPeak: budget.peakRetained, liveWrites: 0 };
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
