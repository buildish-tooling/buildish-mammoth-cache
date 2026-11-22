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

import type * as Fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
const counts = vi.hoisted(() => ({ root: '', stats: 0, listings: 0, unlinks: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  const managed = (p: unknown) =>
    String(p)
      .replaceAll('\\', '/')
      .startsWith(counts.root + '/caches');
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (managed(args[0])) counts.stats++;
      return actual.lstat(...args);
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (managed(args[0])) counts.listings++;
      return actual.opendir(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (managed(args[0])) counts.unlinks++;
      return actual.unlink(...args);
    },
  };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  counts.root = '';
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
it.each([4, 16])(
  'bounds full capture/planner/report work for %i complete units and overlapping purge rules',
  async (n) => {
    const results = [];
    for (const enabled of [false, true])
      for (const reporting of [false, true]) {
        const parent = 'caches/transforms-4',
          f = await observationFixture('gradle', {
            purgeGlobs: [parent + '/*/*.lock', parent + '/*/runtime.lock'],
          }),
          summaries = reporting ? new PartitionSummaries(f.model, f.budget) : undefined;
        cleanup.push(async () => {
          summaries?.dispose();
          expect(f.budget.retained).toBe(0);
          await f.close();
        });
        const files: Record<string, string> = {};
        for (let i = 0; i < n; i++) {
          const unit = parent + '/' + i.toString(16).padStart(32, '0');
          for (const name of [
            'metadata.bin',
            'results.bin',
            'transformed/a',
            'transformed/b',
            'runtime.lock',
          ])
            files[unit + '/' + name] = name;
        }
        await f.files('', files);
        counts.root = f.root.replaceAll('\\', '/');
        counts.stats = counts.listings = counts.unlinks = 0;
        const hash = vi.spyOn(NativeReadPhase.prototype, 'hash'),
          initial = { ...f.store.root.work };
        const obs = await captureObservations(f.store, {
          budget: f.budget,
          summaries,
          ...(enabled
            ? {
                purgeWindow: {
                  root: f.store.root,
                  invocation: f.store.codec.options.invocation,
                  assertCurrent: (): undefined => {},
                },
              }
            : {}),
        });
        expect(hash).not.toHaveBeenCalled();
        const capture = { stats: counts.stats, listings: counts.listings, unlinks: counts.unlinks };
        expect(obs.purge.deleted).toBe(enabled ? n : 0);
        await executeGc(f.store, { budget: f.budget });
        const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
        cleanup.push(() => input.dispose());
        const pub = await FrozenMovingPublication.freeze(input, 'main', [], summaries);
        cleanup.push(() => pub.dispose());
        const before = { ...f.store.root.work };
        summaries?.emit(
          { info: () => {} },
          { publishLogGroup: (_title, lines, write) => lines.forEach(write) },
        );
        expect(f.store.root.work).toEqual(before);
        if (summaries)
          expect(summaries.snapshot().reduce((sum, p) => sum + p.deleted, 0)).toBe(enabled ? n : 0);
        const w = f.store.root.work;
        results.push({
          n,
          enabled,
          capture,
          total: {
            stats: counts.stats,
            listings: counts.listings,
            unlinks: counts.unlinks,
            opens: w.opens - initial.opens,
            hashes: hash.mock.calls.length,
            renames: w.renames - initial.renames,
          },
        });
        hash.mockRestore();
        counts.root = '';
      }
    expect(results[1]).toEqual(results[0]);
    expect(results[3]).toEqual(results[2]);
    expect(results[2].capture.stats - results[0].capture.stats).toBe(3 * n);
    expect(results[2].capture.listings).toBe(results[0].capture.listings);
    expect(results[2].capture.unlinks).toBe(n);
    process.stdout.write('V4D_UNIT_COST ' + JSON.stringify(results) + '\n');
  },
  60000,
);
