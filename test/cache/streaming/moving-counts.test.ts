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

import { sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { MovingWindow } from '../../../src/cache/streaming/moving-window';
import { RelocationEpoch } from '../../../src/cache/streaming/relocation-epoch';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { updateMovingCatalog } from '../../../src/cache/streaming/moving-catalog';
const counts = vi.hoisted(() => ({ target: '', opens: 0, entries: 0, renames: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<Record<string, unknown>>(),
    opendir = actual.opendir as (...args: unknown[]) => Promise<object>;
  return {
    ...actual,
    rename: async (...args: unknown[]) => {
      if (counts.target && args.slice(0, 2).some((p) => String(p).startsWith(counts.target + sep)))
        counts.renames++;
      return (actual.rename as (...a: unknown[]) => Promise<void>)(...args);
    },
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
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  counts.target = '';
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
it.each([4, 16])(
  'lists a shared hot parent only in common guards across %i partitions',
  async (n) => {
    const f = await observationFixture('maven', { partitionCount: n });
    cleanup.push(async () => {
      expect(f.budget.retained).toBe(0);
      await f.close();
    });
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files['shared/hot/p' + String(i).padStart(3, '0')] = 'body';
    await f.files('', files);
    await captureObservations(f.store, { budget: f.budget });
    await executeGc(f.store, { budget: f.budget });
    const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
    cleanup.push(() => input.dispose());
    const pub = await FrozenMovingPublication.freeze(input, 'main');
    cleanup.push(() => pub.dispose());
    const start = { ...f.store.root.work };
    let hashBytes = 0;
    const hash = NativeReadPhase.prototype.hash;
    vi.spyOn(NativeReadPhase.prototype, 'hash').mockImplementation(async function (
      this: NativeReadPhase,
      ...args: Parameters<NativeReadPhase['hash']>
    ) {
      if (args[2] === null) hashBytes += Number(args[1][5]);
      return hash.apply(this, args);
    });
    counts.target = f.store.root.resolve('shared/hot');
    counts.renames = 0;
    counts.opens = 0;
    counts.entries = 0;
    const window = await MovingWindow.open(pub, { operations: 1 });
    cleanup.push(() => window.close());
    await window.verify();
    for (const row of pub.choices) {
      const epoch = await RelocationEpoch.open(pub, row[1], { operations: 1 }, window);
      cleanup.push(() => epoch.close());
      await epoch.evacuate();
      const q = await epoch.returnSources(),
        proof = await window.checkCandidate(epoch, q);
      await proof.close();
      await epoch.cleanupStage();
      await updateMovingCatalog(pub, (cells) => {
        cells.find((c) => c[1] === row[1])![3] = f.store.codec.schemas.ref('adjustments').parse(q);
      });
      await window.adopt(row[1], q);
      await window.verifyPart(row[1]);
      await f.store.clearIntent(epoch.current!);
      await epoch.close();
    }
    await window.verify();
    expect(counts.opens).toBe(2);
    expect(counts.entries).toBe(2 * n);
    expect(hashBytes).toBe(0);
    expect(counts.renames).toBe(2 * n);
    const work = Object.fromEntries(
      Object.entries(f.store.root.work).map(([key, value]) => [
        key,
        value - start[key as keyof typeof start],
      ]),
    );
    process.stdout.write(
      'V4B_COST ' +
        JSON.stringify({
          partitions: n,
          hotListings: counts.opens,
          hotEntries: counts.entries,
          payloadRenames: counts.renames,
          sourceCapture: input.work,
          movingPayloadHashBytes: hashBytes,
          work,
          workingBudgetPeak: f.budget.peakRetained,
        }) +
        '\n',
    );
  },
  60000,
);
