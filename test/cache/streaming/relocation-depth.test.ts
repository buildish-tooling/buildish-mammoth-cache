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

import { it, expect, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { MovingWindow } from '../../../src/cache/streaming/moving-window';
import { RelocationEpoch } from '../../../src/cache/streaming/relocation-epoch';

const counts = vi.hoisted(() => ({ target: '', opens: 0, entries: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<Record<string, unknown>>(),
    opendir = actual.opendir as (...args: unknown[]) => Promise<object>;
  return {
    ...actual,
    opendir: async (...args: unknown[]) => {
      const directory = await opendir(...args);
      if (String(args[0]) !== counts.target) return directory;
      counts.opens++;
      return new Proxy(directory, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'read')
            return async (...a: unknown[]) => {
              const entry = await Reflect.apply(value, target, a);
              if (entry) counts.entries++;
              return entry;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

it('keeps added-file ancestor work independent of shared parent depth', async () => {
  const results = [];
  for (const depth of [0, 6])
    for (const count of [4, 16]) {
      const f = await observationFixture('maven');
      let input: LiveBaseInputs | undefined,
        pub: FrozenMovingPublication | undefined,
        window: MovingWindow | undefined,
        epoch: RelocationEpoch | undefined;
      try {
        const parent = 'data/hot' + '/nested'.repeat(depth);
        await f.files(
          '',
          Object.fromEntries([
            [parent + '/keep.lock', 'keep'],
            ...Array.from({ length: count }, (_, i) => [
              parent + '/f' + String(i).padStart(3, '0'),
              'body',
            ]),
          ]),
        );
        await captureObservations(f.store, { budget: f.budget });
        await executeGc(f.store, { budget: f.budget });
        input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
        pub = await FrozenMovingPublication.freeze(input, 'main');
        counts.target = f.store.root.resolve(parent);
        counts.opens = 0;
        counts.entries = 0;
        window = await MovingWindow.open(pub);
        await window.verify();
        expect(counts.opens).toBeGreaterThan(0);
        epoch = await RelocationEpoch.open(pub, 'data', {}, window);
        const parents = f.store.root.parents.bind(f.store.root);
        let calls = 0;
        const spy = vi.spyOn(f.store.root, 'parents').mockImplementation(async (p) => {
          if (p.startsWith(parent + '/f')) calls++;
          await parents(p);
        });
        counts.opens = 0;
        counts.entries = 0;
        const before = { ...f.store.root.work };
        try {
          await epoch.evacuate();
          await epoch.returnSources();
        } finally {
          spy.mockRestore();
        }
        results.push({
          depth,
          count,
          calls,
          stats: f.store.root.work.stats - before.stats,
          listings: counts.opens,
          entries: counts.entries,
        });
        expect(calls).toBe(0);
      } finally {
        counts.target = '';
        await epoch?.close();
        await window?.close();
        pub?.dispose();
        await input?.dispose();
        await f.close();
      }
    }
  process.stdout.write('V4B_DEPTH_COST ' + JSON.stringify(results) + '\n');
  expect(results[1].listings).toBe(results[0].listings);
  expect(results[3].listings).toBe(results[2].listings);
  expect(results[1].entries - results[0].entries).toBe(12 * results[0].listings);
  expect(results[3].entries - results[2].entries).toBe(12 * results[2].listings);
  expect(results[3].stats - results[2].stats).toBe(results[1].stats - results[0].stats);
}, 30000);
