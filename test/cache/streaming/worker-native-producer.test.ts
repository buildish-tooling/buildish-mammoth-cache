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
import {
  completeFixture,
  completeArchive,
  cleanupCompleteFixtures,
  initializeCompleteFixture,
} from './worker-complete-fixtures';
import {
  mergeWorkerArchives,
  type WorkerMergeResult,
} from '../../../src/cache/streaming/worker-merge';
import { acceptWorkerMerge } from '../../../src/cache/streaming/worker-incoming';
import { WorkerNativeIndex } from '../../../src/cache/streaming/worker-native';
import { MetadataInstallContext } from '../../../src/cache/streaming/metadata-install-context';
import { WorkerSpool } from '../../../src/cache/streaming/worker-spool';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import * as nativeWalk from '../../../src/cache/streaming/native-walk';
const results: WorkerMergeResult[] = [],
  indexes: WorkerNativeIndex[] = [],
  contexts: MetadataInstallContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) await context.dispose();
  for (const index of indexes.splice(0)) await index.dispose();
  for (const result of results.splice(0)) await result.dispose();
  await cleanupCompleteFixtures();
});
const signal = () => new AbortController().signal;
async function merged(f: Awaited<ReturnType<typeof completeFixture>>, body = 'body') {
  const archive = await completeArchive(f, 'A', {
    'data/shared/a': { body, mode: 0o755, time: 1234 },
  });
  const result = await mergeWorkerArchives(f.store, [archive], {
    budget: f.budget,
    ordinaryOrder: ['A'],
    ordinaryPolicy: 'strict',
  });
  results.push(result);
  return result;
}
async function published(
  f: Awaited<ReturnType<typeof completeFixture>>,
  kind: 'install' | 'snapshot' = 'install',
) {
  const result = await merged(f),
    parts = await result.stage.publish(kind, signal()),
    index = await WorkerNativeIndex.capture(f.store, parts, f.budget, signal());
  indexes.push(index);
  return { result, parts, index };
}
it('reuses the one final native join after modes/times without readback or body hashes', async () => {
  const f = await completeFixture();
  await initializeCompleteFixture(f, ['A']);
  const result = await merged(f);
  const walks = vi.spyOn(nativeWalk, 'walkNative'),
    before = { ...f.store.root.work };
  const accepted = await acceptWorkerMerge(f.store, result, f.budget);
  expect(f.store.root.work.nativeWalks - before.nativeWalks).toBe(1);
  expect(f.store.root.work.nativeListings - before.nativeListings).toBe(3); // root, data, shared
  expect(walks).toHaveBeenCalledTimes(1);
  expect(f.store.root.work.bodyHashCalls - before.bodyHashCalls).toBe(0);
  const receipt = accepted.incoming[0];
  receipt.assertBound(f.store);
  expect(receipt.upstream.kind).toBe('verified-worker');
  async function checkHashFree(offset: number): Promise<void> {
    const { indexedNode, indexedEntries } =
      await import('../../../src/cache/streaming/install-index');
    const lease = await indexedNode(receipt.context.scratch, offset);
    try {
      expect(lease.node[4]).toBeNull();
      for await (const edge of indexedEntries(receipt.context.scratch, lease.node))
        await checkHashFree(edge[2]);
    } finally {
      lease.release();
    }
  }
  await checkHashFree(receipt.index);
  expect(accepted.work.activityDirectoryListings).toBe(0);
  expect(accepted.work.activityIndexDirectories).toBe(3);
  const native = (await f.store.root.stat(receipt.nativeRoot + '/data/shared/a'))!;
  expect(BigInt(native[8]) / 1000000n).toBe(1234n);
  if (process.platform !== 'win32') expect(native[6] & 0o777).toBe(0o755);
  await accepted.dispose();
  expect(f.budget.retained).toBe(0);
});

it('transfers original shared scratch only for genuine completed merge and exact original published install parts', async () => {
  const f = await completeFixture(),
    g = await completeFixture(),
    { result, index } = await published(f);
  const other = await merged(f, 'other'),
    sourceRoot = index.root('data'),
    scratch = index.scratch;
  const claim = (store = f.store, merge = result, budget = f.budget, max = 100000) =>
    MetadataInstallContext.fromWorkerNative(store, index, merge, {
      budget,
      maxDirectoryEntries: max,
    });
  expect(() => claim(f.store, { ...result })).toThrow('merge inputs');
  expect(() => claim(f.store, other)).toThrow('projection');
  expect(() => claim(g.store)).toThrow('Unavailable');
  expect(() => claim(f.store, result, new WorkingBudget())).toThrow('policy');
  expect(() => claim(f.store, result, f.budget, 999)).toThrow('policy');
  const context = claim();
  contexts.push(context);
  expect(context.scratch).toBe(scratch);
  expect(context.source('data')!.index).toBe(sourceRoot);
  expect(context.source('data')!.upstream.kind).toBe('verified-worker');
  expect(() => claim()).toThrow('Unavailable');
  expect(() =>
    WorkerNativeIndex.assert(Object.create(WorkerNativeIndex.prototype), f.store),
  ).toThrow('Unavailable');
  const receipt = context.source('data')!;
  await context.dispose();
  expect(() => receipt.assertBound(f.store)).toThrow('closed');
  await result.dispose();
  await other.dispose();
  expect(f.budget.retained).toBe(0);
});
it('does not turn independently published snapshot stage metadata into worker install provenance', async () => {
  const f = await completeFixture(),
    { result, index } = await published(f, 'snapshot');
  expect(() =>
    MetadataInstallContext.fromWorkerNative(f.store, index, result, { budget: f.budget }),
  ).toThrow('projection');
});
it('revokes worker authorization when stage disposal begins even if owned spool cleanup fails', async () => {
  const f = await completeFixture(),
    { result, index } = await published(f);
  const dispose = WorkerSpool.prototype.dispose,
    failure = new Error('blocked stage disposal');
  let injected = false;
  const spy = vi.spyOn(WorkerSpool.prototype, 'dispose').mockImplementation(async function (
    this: WorkerSpool,
  ) {
    if (!injected) {
      injected = true;
      throw failure;
    }
    await dispose.call(this);
  });
  await expect(result.stage.dispose()).rejects.toThrow();
  spy.mockRestore();
  expect(() =>
    MetadataInstallContext.fromWorkerNative(f.store, index, result, { budget: f.budget }),
  ).toThrow('projection');
});
