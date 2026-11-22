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

import { mkdir, mkdtemp, rm, writeFile, utimes, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeRoot, type NativeWork } from '../../../src/cache/streaming/native';
import { nativeWork } from '../../../src/cache/streaming/native';
import { resolveModel } from '../../../src/cache/streaming/model';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import * as walker from '../../../src/cache/streaming/native-walk';
import * as workerMerge from '../../../src/cache/streaming/worker-merge';
import * as workerIncoming from '../../../src/cache/streaming/worker-incoming';
import * as codec from '../../../src/cache/streaming/worker-codec';
import { memoryArtifacts } from './memory-artifact-fixture';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import type { Context } from '../../../src/cache/streaming/schema';
const directoryWork = vi.hoisted(() => ({ root: '', listings: 0, entries: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<Record<string, unknown>>(),
    opendir = actual.opendir as (...args: unknown[]) => Promise<object>;
  return {
    ...actual,
    opendir: async (...args: unknown[]) => {
      const dir = await opendir(...args),
        p = String(args[0]);
      if (
        !directoryWork.root ||
        (p !== directoryWork.root && !p.startsWith(directoryWork.root + path.sep))
      )
        return dir;
      directoryWork.listings++;
      return new Proxy(dir, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === Symbol.asyncIterator)
            return async function* () {
              for await (const entry of Reflect.apply(
                value,
                target,
                [],
              ) as AsyncIterable<unknown>) {
                directoryWork.entries++;
                yield entry;
              }
            };
          if (key === 'read')
            return async (...a: unknown[]) => {
              const entry = await Reflect.apply(value, target, a);
              if (entry) directoryWork.entries++;
              return entry;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});
const roots: string[] = [],
  budgets: WorkingBudget[] = [];
afterEach(async () => {
  directoryWork.root = '';
  vi.restoreAllMocks();
  for (const b of budgets.splice(0)) expect(b.retained).toBe(0);
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  await cleanupBaseFixtures();
});
interface Counts extends NativeWork {
  listings: number;
  entries: number;
  guardedHashBytes: number;
  nativeDirectoryListings: number;
  nativeDirectoryEntries: number;
  validatedWorkerBodyBytes: number;
  winningStageBytes: number;
  retainedSnapshotCopyBytes: number;
  workerArchivePasses: number;
  wireBytes: number;
  sdkBytes: number;
  peak: number;
}
async function measure(width: number, analytics: boolean, purge: boolean) {
  const root = await mkdtemp(path.resolve('build/lifecycle-count-'));
  roots.push(root);
  const work = new Set<NativeWork>(),
    bind = NativeRoot.bind,
    walk = walker.walkNative,
    hash = NativeReadPhase.prototype.hash,
    readArchive = codec.readWorkerArchive;
  const counts: Counts = {
    ...nativeWork(),
    listings: 0,
    entries: 0,
    guardedHashBytes: 0,
    nativeDirectoryListings: 0,
    nativeDirectoryEntries: 0,
    validatedWorkerBodyBytes: 0,
    winningStageBytes: 0,
    retainedSnapshotCopyBytes: 0,
    workerArchivePasses: 0,
    wireBytes: 0,
    sdkBytes: 0,
    peak: 0,
  };
  directoryWork.root = root;
  directoryWork.listings = 0;
  directoryWork.entries = 0;
  const merge = workerMerge.mergeWorkerArchives,
    accept = workerIncoming.acceptWorkerMerge;
  vi.spyOn(workerMerge, 'mergeWorkerArchives').mockImplementation(async (...args) => {
    const result = await merge(...args);
    counts.winningStageBytes += result.stage.work.bodyBytes;
    return result;
  });
  vi.spyOn(workerIncoming, 'acceptWorkerMerge').mockImplementation(async (...args) => {
    const result = await accept(...args);
    counts.retainedSnapshotCopyBytes += result.work.snapshotCopyBytes;
    return result;
  });
  vi.spyOn(NativeRoot, 'bind').mockImplementation(async (...args) => {
    const n = await bind(...args);
    work.add(n.work);
    return n;
  });
  vi.spyOn(walker, 'walkNative').mockImplementation(async function* (...args) {
    for await (const event of walk(...args)) {
      if (event.tag === 'directory-open') counts.listings++;
      else if (event.tag !== 'directory-close') counts.entries++;
      yield event;
    }
  });
  vi.spyOn(NativeReadPhase.prototype, 'hash').mockImplementation(async function (
    this: NativeReadPhase,
    ...args
  ) {
    counts.guardedHashBytes += Number(args[1][5]);
    return hash.apply(this, args);
  });
  vi.spyOn(codec, 'readWorkerArchive').mockImplementation(async (...args) => {
    counts.workerArchivePasses++;
    const result = await readArchive(...args);
    counts.validatedWorkerBodyBytes += result.counts[4];
    return result;
  });
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          [
            'data',
            ['repository/**', 'data/**'],
            hard,
            'aggregate',
            null,
            'default',
            ...(purge ? [['**/*.never-purge']] : []),
          ],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default'],
        ],
      ],
      'qualification-',
      1,
    ),
    artifacts = memoryArtifacts(),
    sdk = await nativeCacheBackend();
  const context = (job: string): Context => [
    'github',
    'example/repo',
    'ci',
    '42',
    job,
    1,
    'rev-1',
    'maven',
  ];
  const prepare = async (job: string) => {
    const home = path.join(root, job);
    await mkdir(home);
    const budget = new WorkingBudget();
    budgets.push(budget);
    const result = await prepareStreaming({
      root: home,
      model,
      context: context(job),
      nonce: 'a'.repeat(32),
      budget,
      policy: {
        role: job === 'Z' ? 'distributed-aggregator' : 'distributed-worker',
        access: 'writable',
        restoreCleanup: 'none',
        gcAgeMs: null,
        ordinaryPolicy: 'strict',
        ordinaryOrder: job === 'Z' ? ['B', 'A'] : [],
      },
      currentRef: 'refs/heads/main',
      captureTempDirectory: null,
      artifactRetentionDays: 7,
      cleanupEnabled: true,
      saveAnchor: () => {},
      provision: async () => {},
      installHooks: async () => {},
      assertCurrent: (): undefined => {},
      cacheBackend: async () => sdk.backend,
      artifactBackend: async () => artifacts.api,
    });
    return { ...result, home, budget };
  };
  for (const [job, offset] of [
    ['A', 0],
    ['B', width / 2],
  ] as const) {
    const f = await prepare(job);
    for (let i = offset; i < offset + width; i++)
      for (const ext of ['jar', 'pom']) {
        const file =
          f.home + '/repository/org/example/u' + String(i).padStart(2, '0') + '/1/u-1.' + ext;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'bytes-' + i + '-' + ext);
        await utimes(file, 123, 123);
      }
    if (job === 'A') {
      await mkdir(f.home + '/state');
      await writeFile(f.home + '/state/writer', 'snapshot');
    }
    const summaries = analytics ? new PartitionSummaries(model, f.budget) : undefined;
    try {
      await postStreamingWorker({
        anchor: f.anchor,
        budget: f.budget,
        assertCurrent: (): undefined => {},
        artifactBackend: async () => artifacts.api,
        summaries,
      });
      summaries?.emit({ info: () => {} });
    } finally {
      summaries?.dispose();
    }
    counts.peak = Math.max(counts.peak, f.budget.peakRetained);
  }
  const f = await prepare('Z');
  for (let i = 0; i < width; i++) {
    const file = f.home + '/data/shared/f' + String(i).padStart(2, '0');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'new');
  }
  const summaries = analytics ? new PartitionSummaries(model, f.budget) : undefined;
  try {
    expect(
      (
        await postStreamingBase({
          anchor: f.anchor,
          budget: f.budget,
          assertCurrent: (): undefined => {},
          cacheBackend: async () => sdk.backend,
          removeHooks: async () => {},
          summaries,
        })
      ).outcome,
    ).toBe('published');
    summaries?.emit({ info: () => {} });
  } finally {
    summaries?.dispose();
  }
  counts.peak = Math.max(counts.peak, f.budget.peakRetained);
  for (const w of work)
    for (const k of Object.keys(nativeWork()) as (keyof NativeWork)[]) counts[k] += w[k];
  counts.wireBytes = [...artifacts.objects.values()].reduce((sum, x) => sum + x.bytes.length, 0);
  for (const object of sdk.objects.values())
    counts.sdkBytes += (await stat(path.join(object.directory, 'cache.tgz'))).size;
  expect(artifacts.list).toHaveBeenCalledTimes(1);
  expect(artifacts.download).toHaveBeenCalledTimes(2);
  expect(counts.workerArchivePasses).toBe(2);
  expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(3);
  expect(f.budget.retained).toBe(0);
  counts.nativeDirectoryListings = directoryWork.listings;
  counts.nativeDirectoryEntries = directoryWork.entries;
  directoryWork.root = '';
  expect(counts.nativeDirectoryListings).toBeGreaterThan(0);
  expect(counts.nativeDirectoryEntries).toBeGreaterThan(0);
  expect(counts.winningStageBytes).toBeLessThan(counts.validatedWorkerBodyBytes);
  expect(counts.retainedSnapshotCopyBytes).toBe(8);
  vi.restoreAllMocks();
  return counts;
}
const rows: Record<string, Counts[]> = {};
it.skipIf(process.platform === 'win32').each([
  ['baseline', false, false],
  ['analytics', true, false],
  ['no-match purge', false, true],
] as const)(
  'bounded complete operation: %s',
  async (name, analytics, purge) => {
    const small = await measure(4, analytics, purge),
      large = await measure(16, analytics, purge);
    rows[name] = [small, large];
    expect(large.nativeDirectoryListings).toBeLessThan(small.nativeDirectoryListings * 4);
    expect(large.nativeDirectoryEntries).toBeLessThan(small.nativeDirectoryEntries * 4);
    expect(large.listings).toBeLessThan(small.listings * 4);
    expect(large.stats).toBeLessThan(small.stats * 4);
    expect(large.opens).toBeLessThan(small.opens * 4);
    expect(large.renames).toBe(small.renames); // complete directories move once as width grows
    for (const field of [
      'nativeDirectoryListings',
      'nativeDirectoryEntries',
      'listings',
      'entries',
      'stats',
      'opens',
      'renames',
      'unlinks',
    ] as const) {
      const base = rows.baseline;
      if (base) {
        expect(small[field]).toBe(base[0][field]);
        expect(large[field]).toBe(base[1][field]);
      }
    }
    process.stdout.write(
      'V5_COMPLETE_OPERATION ' +
        JSON.stringify({ name, widths: [4, 16], counts: [small, large] }) +
        '\n',
    );
  },
  30000,
);
