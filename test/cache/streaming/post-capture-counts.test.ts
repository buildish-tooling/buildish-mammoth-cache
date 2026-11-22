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

import { appendFile } from 'node:fs/promises';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import { RelocationSource } from '../../../src/cache/streaming/relocation-source';
import { MovingAdjustments } from '../../../src/cache/streaming/moving-adjustments';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { MovingWindow } from '../../../src/cache/streaming/moving-window';
import { afterEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { LiveBaseInputs, LiveNativeView } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import * as projection from '../../../src/cache/streaming/gc-projection';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('shares one original index/projection and avoids partition multiplication of unrelated metadata', async () => {
  const rows: { p: number; unrelated: number; metadata: number; scratch: number }[] = [];
  for (const p of [4, 16])
    for (const unrelated of [64, 256]) {
      const f = await observationFixture('maven', { partitionCount: p });
      cleanup.push(async () => {
        expect(f.budget.retained).toBe(0);
        await f.close();
      });
      const files: Record<string, string> = {};
      for (let n = 0; n < p; n++) files['shared/hot/p' + String(n).padStart(3, '0')] = 'body';
      for (let n = 0; n < unrelated; n++) files['shared/retained/' + n + '.lock'] = 'protected';
      await f.files('', files);
      await captureObservations(f.store, { budget: f.budget });
      const start = { ...f.store.root.work },
        indexes = vi.spyOn(ObservationIndex, 'open'),
        projections = vi.spyOn(projection, 'checkGcProjection'),
        sweeps = vi.spyOn(LiveNativeView.prototype, 'assertStable');
      const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
      cleanup.push(() => input.dispose());
      const pub = await FrozenMovingPublication.freeze(input, 'main');
      cleanup.push(() => pub.dispose());
      expect(indexes).toHaveBeenCalledTimes(1);
      expect(projections).toHaveBeenCalledTimes(1);
      expect(sweeps).not.toHaveBeenCalled();
      expect(input.work.hashBytes).toBe(p * 4);
      rows.push({
        p,
        unrelated,
        metadata: f.store.root.work.metadataRowsRead - start.metadataRowsRead,
        scratch: f.store.root.work.scratchReadBytes - start.scratchReadBytes,
      });
      vi.restoreAllMocks();
    }
  const growth = (p: number, key: 'metadata' | 'scratch') =>
    rows.find((r) => r.p === p && r.unrelated === 256)![key] -
    rows.find((r) => r.p === p && r.unrelated === 64)![key];
  expect(growth(4, 'metadata')).toBeGreaterThan(0);
  expect(growth(16, 'metadata')).toBeLessThanOrEqual(growth(4, 'metadata') * 1.2);
  // Physical reads can be zero when these bounded indexes fit pending/cache pages.
  expect(growth(16, 'scratch')).toBeLessThanOrEqual(Math.max(65536, growth(4, 'scratch') * 1.5));
  process.stdout.write('CAPTURE_METADATA_COUNTS ' + JSON.stringify(rows) + '\n');
}, 30000);
it('holds the original index until the final active consumer releases it', async () => {
  const f = await observationFixture();
  cleanup.push(() => f.close());
  await f.files('', { 'data/a': 'body', 'state/b': 'snapshot' });
  await captureObservations(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  cleanup.push(() => input.dispose());
  const lease = input.view.borrowOriginal()!;
  await expect(input.dispose()).rejects.toThrow('borrow active');
  ObservationIndex.assert(lease.index);
  lease.release();
  lease.release();
  await input.dispose();
  expect(input.view.borrowOriginal()).toBeUndefined();
  expect(f.budget.retained).toBe(0);
});

it('keeps the shared observation lease throughout asynchronous move planning', async () => {
  const f = await observationFixture();
  cleanup.push(() => f.close());
  await f.files('', { 'data/a': 'body', 'state/b': 'snapshot' });
  await captureObservations(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  cleanup.push(() => input.dispose());
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    }),
    rows = LiveNativeView.prototype.rows;
  vi.spyOn(LiveNativeView.prototype, 'rows').mockImplementation(async function* (
    this: LiveNativeView,
    ...args
  ) {
    entered();
    await gate;
    yield* rows.apply(this, args);
  });
  const pending = FrozenMovingPublication.freeze(input, 'main');
  await ready;
  try {
    await expect(input.dispose()).rejects.toThrow('borrow active');
  } finally {
    release();
  }
  const pub = await pending;
  pub.dispose();
  await input.dispose();
  expect(f.budget.retained).toBe(0);
});

it('rejects changed retained planning bytes before granting a warm source window', async () => {
  const f = await observationFixture();
  cleanup.push(() => f.close());
  await f.files('', { 'data/a': 'body', 'state/b': 'snapshot' });
  await captureObservations(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  cleanup.push(() => input.dispose());
  const parked: string[] = [],
    park = InstallScratch.prototype.park;
  vi.spyOn(InstallScratch.prototype, 'park').mockImplementation(async function (
    this: InstallScratch,
  ) {
    parked.push(this.path);
    return park.call(this);
  });
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  cleanup.push(() => pub.dispose());
  expect(parked).toHaveLength(1);
  await appendFile(f.store.root.resolve(parked[0]), '\n');
  await expect(MovingWindow.open(pub)).rejects.toThrow();
});

it('keeps complete post metadata work independent of partitions times unrelated directories', async () => {
  const measured: {
    partitions: number;
    directories: number;
    rows: number;
    scratch: number;
    unrelatedProbes: number;
    coldRows: number;
    coldScratch: number;
  }[] = [];
  for (const partitions of [4, 16])
    for (const directories of [64, 256]) {
      const f = await observationFixture('maven', { partitionCount: partitions });
      cleanup.push(async () => {
        expect(f.budget.retained).toBe(0);
        await f.close();
      });
      const files: Record<string, string> = {};
      for (let i = 0; i < partitions; i++)
        files['shared/hot/p' + String(i).padStart(3, '0')] = 'body';
      for (let i = 0; i < directories; i++)
        files['shared/retained/d' + String(i).padStart(4, '0') + '/keep.lock'] = 'protected';
      await f.files('', files);
      await captureObservations(f.store, { budget: f.budget });
      const before = { ...f.store.root.work },
        directory = RelocationSource.prototype.directory,
        effect = MovingAdjustments.prototype.effect;
      let unrelatedProbes = 0;
      vi.spyOn(RelocationSource.prototype, 'directory').mockImplementation(function (
        this: RelocationSource,
        path,
      ) {
        if (path.startsWith('shared/retained')) unrelatedProbes++;
        return directory.call(this, path);
      });
      vi.spyOn(MovingAdjustments.prototype, 'effect').mockImplementation(function (
        this: MovingAdjustments,
        path,
      ) {
        if (path.startsWith('shared/retained')) unrelatedProbes++;
        return effect.call(this, path);
      });
      const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
      cleanup.push(() => input.dispose());
      const pub = await FrozenMovingPublication.freeze(input, 'main');
      cleanup.push(() => pub.dispose());
      const publisher = MovingBasePublication.open(pub),
        backend: BaseCacheBackend = {
          capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
          isFeatureAvailable: () => true,
          restoreCache: async () => undefined,
          saveCache: async () => 1,
          isMissingPathsError: () => false,
        };
      cleanup.push(() => publisher.close());
      await publisher.saveObjects(backend);
      await publisher.publish(backend);
      await publisher.close();
      const post = { ...f.store.root.work },
        resumed = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
      cleanup.push(() => resumed.dispose());
      const window = await MovingWindow.open(resumed);
      cleanup.push(() => window.close());
      await window.verify(undefined, true);
      await window.close();
      expect(unrelatedProbes).toBe(0);
      measured.push({
        partitions,
        directories,
        rows: post.metadataRowsRead - before.metadataRowsRead,
        scratch: post.scratchReadBytes - before.scratchReadBytes,
        unrelatedProbes,
        coldRows: f.store.root.work.metadataRowsRead - post.metadataRowsRead,
        coldScratch: f.store.root.work.scratchReadBytes - post.scratchReadBytes,
      });
      vi.restoreAllMocks();
    }
  const growth = (p: number, key: 'rows' | 'scratch' | 'coldRows' | 'coldScratch') =>
    measured.find((m) => m.partitions === p && m.directories === 256)![key] -
    measured.find((m) => m.partitions === p && m.directories === 64)![key];
  expect(growth(4, 'rows')).toBeGreaterThan(0);
  expect(growth(16, 'rows')).toBeLessThanOrEqual(growth(4, 'rows') * 1.3);
  expect(growth(16, 'scratch')).toBeLessThanOrEqual(growth(4, 'scratch') * 1.5 + 65536);
  expect(growth(16, 'coldRows')).toBeLessThanOrEqual(growth(4, 'coldRows') * 1.3);
  expect(growth(16, 'coldScratch')).toBeLessThanOrEqual(growth(4, 'coldScratch') * 1.5 + 65536);
  process.stdout.write('COMPLETE_POST_METADATA_COUNTS ' + JSON.stringify(measured) + '\n');
}, 45000);

it('keeps shared save capture work linear across 4/16 partitions and 64/256 files', async () => {
  const measured: {
    partitions: number;
    files: number;
    stats: number;
    rows: number;
    scratch: number;
    hashes: number;
    streams: number;
    decoders: number;
  }[] = [];
  for (const partitions of [4, 16])
    for (const files of [64, 256]) {
      const f = await observationFixture('gradle', { partitionCount: partitions });
      let input: LiveBaseInputs | undefined, pub: FrozenMovingPublication | undefined;
      try {
        await f.files(
          '',
          Object.fromEntries(
            Array.from({ length: files }, (_, i) => [
              'shared/hot/d' +
                String(Math.floor(i / partitions)).padStart(3, '0') +
                '/p' +
                String(i % partitions).padStart(3, '0'),
              'body',
            ]),
          ),
        );
        const before = { ...f.store.root.work },
          captured = await captureObservations(f.store, { budget: f.budget, retainIndex: true });
        input = await LiveBaseInputs.capture(
          f.store,
          { budget: f.budget },
          undefined,
          captured.index,
        );
        pub = await FrozenMovingPublication.freeze(input, 'main');
        const after = f.store.root.work;
        measured.push({
          partitions,
          files,
          stats: after.stats - before.stats,
          rows: after.metadataRowsRead - before.metadataRowsRead,
          scratch: after.scratchReadBytes - before.scratchReadBytes,
          hashes: after.bodyHashCalls - before.bodyHashCalls,
          streams: after.bodyHashStreams - before.bodyHashStreams,
          decoders: after.scratchDecoderAllocations - before.scratchDecoderAllocations,
        });
        expect(after.bodyHashCalls - before.bodyHashCalls).toBe(files);
        expect(after.bodyHashStreams - before.bodyHashStreams).toBe(0);
      } finally {
        await pub?.dispose();
        await input?.dispose();
        expect(f.budget.retained).toBe(0);
        await f.close();
      }
    }
  for (const key of ['stats', 'rows', 'scratch'] as const) {
    const growth = (p: number) =>
      measured.find((r) => r.partitions === p && r.files === 256)![key] -
      measured.find((r) => r.partitions === p && r.files === 64)![key];
    expect(growth(16)).toBeLessThanOrEqual(
      Math.max(key === 'scratch' ? 65536 : 0, growth(4) * 1.5),
    );
  }
  process.stdout.write('SAVE_WORK_COUNTS ' + JSON.stringify(measured) + '\n');
}, 30000);
