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

import path from 'node:path';
import { mkdir, writeFile, readFile, utimes, chmod, stat, readdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareLifecycle, cleanupLifecycleFixtures } from './lifecycle-fixture';
import { nativeCacheBackend, cleanupBaseFixtures } from './native-cache-fixture';
import { memoryArtifacts } from './memory-artifact-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import { NativeRoot, nativeWork } from '../../../src/cache/streaming/native';
import { recordEncodingWork } from '../../../src/cache/streaming/encoding';
import { FrozenWorkerArchive } from '../../../src/cache/streaming/worker-package';
import { WorkerFrontier } from '../../../src/cache/streaming/worker-frontier';
import * as workerIncoming from '../../../src/cache/streaming/worker-incoming';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import type { NativeWork } from '../../../src/cache/streaming/native';
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupLifecycleFixtures();
  await cleanupBaseFixtures();
});

it('counts complete 4/16-partition shared-parent worker → metadata base → restored no-change phases including losers and cleanup', async () => {
  const ledger = [];
  for (const partitions of [4, 16]) {
    const hard = ['.mammoth/**'],
      ids = Array.from({ length: partitions }, (_, i) => 'p' + String(i).padStart(2, '0')),
      model = resolveModel(
        [
          'model',
          1,
          'maven',
          hard,
          ids.map((id) => [
            id,
            ['repository/**/' + id + '.*'],
            hard,
            'aggregate',
            null,
            'default',
            0,
          ]),
        ],
        'complete-ls4-',
        1,
      ),
      sdk = await nativeCacheBackend(),
      artifacts = memoryArtifacts(),
      roots = new Set<NativeRoot>(),
      frontiers = new Set<WorkerFrontier>(),
      packages: {
        bytes: number;
        bodyBytes: number;
        tarBytes: number;
        controlMembers: number;
        controlBodyBytes: number;
      }[] = [],
      accepts: unknown[] = [],
      phases: { phase: string; native: NativeWork; codec: typeof recordEncodingWork }[] = [],
      originalBind = NativeRoot.bind,
      originalNext = WorkerFrontier.prototype.next,
      originalAccept = workerIncoming.acceptWorkerMerge,
      originalPackage = FrozenWorkerArchive.package;
    const packageSpy = vi
      .spyOn(FrozenWorkerArchive, 'package')
      .mockImplementation(async (...args) => {
        const value = await originalPackage(...args);
        packages.push({ bytes: value.bytes, bodyBytes: value.summary.counts[4], ...value.work });
        return value;
      });
    const bindSpy = vi.spyOn(NativeRoot, 'bind').mockImplementation(async (...args) => {
      const root = await originalBind(...args);
      roots.add(root);
      return root;
    });
    const frontierSpy = vi.spyOn(WorkerFrontier.prototype, 'next').mockImplementation(function (
      this: WorkerFrontier,
    ) {
      frontiers.add(this);
      return originalNext.call(this);
    });
    const acceptSpy = vi
      .spyOn(workerIncoming, 'acceptWorkerMerge')
      .mockImplementation(async (...args) => {
        const value = await originalAccept(...args);
        accepts.push(value.work);
        return value;
      });
    const totals = () => {
      const total = nativeWork();
      for (const root of roots)
        for (const key of Object.keys(total) as (keyof NativeWork)[]) total[key] += root.work[key];
      return total;
    };
    let before = totals(),
      codec = { ...recordEncodingWork };
    const phase = (name: string) => {
      const now = totals(),
        encoded = { ...recordEncodingWork };
      phases.push({
        phase: name,
        native: Object.fromEntries(
          Object.keys(now).map((k) => [
            k,
            now[k as keyof NativeWork] - before[k as keyof NativeWork],
          ]),
        ) as unknown as NativeWork,
        codec: Object.fromEntries(
          Object.keys(encoded).map((k) => [
            k,
            encoded[k as keyof typeof encoded] - codec[k as keyof typeof codec],
          ]),
        ) as typeof codec,
      });
      before = now;
      codec = encoded;
    };
    for (const [j, job] of ['A', 'B'].entries()) {
      const worker = await prepareLifecycle(sdk.backend, String(j + 1).repeat(32), {
        model,
        job,
        role: 'distributed-worker',
      });
      phase('worker-' + job + '-prepare');
      for (const unit of ['one', 'two'])
        for (const id of ids)
          for (const suffix of ['jar', 'pom']) {
            const logical = 'repository/shared/' + unit + '/1/' + id + '.' + suffix,
              file = worker.store.root.resolve(logical);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, 'bodybody');
            await chmod(file, 0o644);
            await utimes(file, 1.2345, 1.2345);
          }
      expect(
        (
          await postStreamingWorker({
            anchor: worker.anchor,
            budget: worker.budget,
            artifactBackend: async () => artifacts.api,
            assertCurrent: (): undefined => {},
          })
        ).outcome,
      ).toBe('worker-uploaded');
      expect(worker.budget.retained).toBe(0);
      phase('worker-' + job + '-post');
    }
    const parent = await prepareLifecycle(sdk.backend, '3'.repeat(32), {
      model,
      role: 'distributed-aggregator',
      order: ['A', 'B'],
      artifacts: artifacts.api,
      gcAgeMs: 1,
      now: () => Date.now() + 600000,
    });
    const expired = parent.store.root.resolve('repository/expired/1/p00.jar');
    await mkdir(path.dirname(expired), { recursive: true });
    await writeFile(expired, 'expired');
    await utimes(expired, 1, 1);
    expect(parent.workerCount).toBe(2);
    expect(parent.budget.retained).toBe(0);
    phase('parent-prepare');
    expect([...frontiers].reduce((n, f) => n + f.work.bodyBytes, 0)).toBe(64 * partitions);
    expect([...frontiers].reduce((n, f) => n + f.work.files, 0)).toBe(8 * partitions);
    expect(accepts).toEqual([
      {
        snapshotCopyBytes: 0,
        activityDirectoryListings: 0,
        activityIndexDirectories: expect.any(Number),
      },
    ]);
    expect(
      (
        await postStreamingBase({
          anchor: parent.anchor,
          budget: parent.budget,
          cacheBackend: async () => sdk.backend,
          removeHooks: async () => {},
          assertCurrent: (): undefined => {},
        })
      ).outcome,
    ).toBe('published');
    expect(await parent.store.root.stat('repository/expired/1/p00.jar')).toBeNull();
    expect(parent.budget.retained).toBe(0);
    phase('parent-post');
    const archivesBefore = [...sdk.objects.values()];
    const warm = await prepareLifecycle(sdk.backend, '4'.repeat(32), { model });
    expect(warm.restoreStatus).toBe('current-lineage-hit');
    phase('warm-prepare');
    const saves = sdk.calls.filter((c) => c.kind === 'save').length;
    expect(
      (
        await postStreamingBase({
          anchor: warm.anchor,
          budget: warm.budget,
          cacheBackend: async () => sdk.backend,
          removeHooks: async () => {},
          assertCurrent: (): undefined => {},
        })
      ).outcome,
    ).toBe('no-change');
    expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(saves);
    expect(warm.budget.retained).toBe(0);
    phase('warm-post');
    for (const name of await readdir(warm.store.root.resolve(warm.store.prefix + 'files'))) {
      const first = JSON.parse(
        (
          await readFile(warm.store.root.resolve(warm.store.prefix + 'files/' + name), 'utf8')
        ).split('\n')[0],
      );
      if (first[0] === 'local-stream') expect(['model', 'handoff']).toContain(first[2]);
    }
    const sdkArchiveBytes = (
        await Promise.all(
          archivesBefore.map(async (o) => (await stat(path.join(o.directory, 'cache.tgz'))).size),
        )
      ).reduce((n, v) => n + v, 0),
      workerArchiveBytes = [...artifacts.objects.values()].reduce((n, o) => n + o.bytes.length, 0),
      total = totals();
    expect(packages.reduce((n, p) => n + p.bytes, 0)).toBe(workerArchiveBytes);
    expect(packages.reduce((n, p) => n + p.bodyBytes, 0)).toBe(64 * partitions);
    expect(total.bodyHashBytes).toBe(0); // Native phase has no base content hashing; worker codec hashes below remain mandatory.
    expect(phases.find((p) => p.phase === 'warm-post')!.native.nativeWalks).toBe(1);
    ledger.push({
      partitions,
      units: 2,
      filesPerWorker: 4 * partitions,
      payloadBytesPerWorker: 32 * partitions,
      verifiedIncomingBodyBytesIncludingLosers: [...frontiers].reduce(
        (n, f) => n + f.work.bodyBytes,
        0,
      ),
      outgoingWorkerBodyShaBytes: packages.reduce((n, p) => n + p.bodyBytes, 0),
      incomingWorkerBodyShaBytes: [...frontiers].reduce((n, f) => n + f.work.bodyBytes, 0),
      packages,
      workerArchiveBytes,
      archiveSha: {
        outgoingImmutableWriterBytes: workerArchiveBytes,
        incomingDownloadBindingBytes: workerArchiveBytes,
        incomingOwnedReadBytes: workerArchiveBytes,
        productionTotalBytes: 3 * workerArchiveBytes,
        productionContexts: 6,
        simulatedBackendUploadDigestBytes: workerArchiveBytes,
        simulatedBackendContexts: 2,
      },
      sdkArchiveBytes,
      accepts,
      frontiers: [...frontiers].map((f) => f.work),
      phases,
      total,
    });
    packageSpy.mockRestore();
    acceptSpy.mockRestore();
    frontierSpy.mockRestore();
    bindSpy.mockRestore();
  }
  expect(ledger[1].total.nativeWalks - ledger[0].total.nativeWalks).toBe(24); // Final selected worker discovery and later immutable restore each visit P roots once.
  expect(ledger[1].total.scratchReadBytes).toBeLessThan(ledger[0].total.scratchReadBytes * 6);
  await writeFile(
    'build/lifecycle-ls4-complete-counts.json',
    JSON.stringify(ledger, null, 2) + '\n',
  );
}, 120000);
