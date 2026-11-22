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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { MovingWindow } from '../../../src/cache/streaming/moving-window';
import { RelocationEpoch } from '../../../src/cache/streaming/relocation-epoch';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { updateMovingCatalog } from '../../../src/cache/streaming/moving-catalog';
import { resolveModel, type Partition } from '../../../src/cache/streaming/model';
import { tuple } from '../../../src/cache/streaming/encoding';

const cleanup: (() => unknown)[] = [];
const empty = () => ({ walks: 0, observedNodes: 0, records: 0, rows: 0, scratchReadBytes: 0 });
let active: ReturnType<typeof empty> | null = null,
  returning = false;
beforeEach(() => {
  const walk = ObservationIndex.prototype.walk,
    record = InstallScratch.prototype.record,
    rows = InstallScratch.prototype.rows;
  vi.spyOn(ObservationIndex.prototype, 'walk').mockImplementation(async function* (
    this: ObservationIndex,
    offset,
  ) {
    if (active && offset === undefined) active.walks++;
    yield* walk.call(this, offset);
  });
  vi.spyOn(InstallScratch.prototype, 'record').mockImplementation(async function (
    this: InstallScratch,
    offset,
  ) {
    const row = await record.call(this, offset);
    if (active) {
      active.records++;
      const tag = tuple(row.value)[0];
      if (tag === 'observed-file' || tag === 'observed-directory') active.observedNodes++;
    }
    return row;
  });
  vi.spyOn(InstallScratch.prototype, 'rows').mockImplementation(async function* (
    this: InstallScratch,
    ...args
  ) {
    for await (const row of rows.apply(this, args)) {
      if (active) active.rows++;
      yield row;
    }
  });
});
afterEach(async () => {
  active = null;
  returning = false;
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function measure(partitions: number, retained: number, descendants: number) {
  const hard = ['.mammoth/**'],
    definitions: Partition[] = Array.from({ length: partitions }, (_, i) => {
      const id = 'p' + String(i).padStart(3, '0'),
        root = 'shared/hot/' + id;
      return [id, [root, root + '/**'], hard, 'aggregate', null, 'default'];
    });
  definitions.push(['retained', ['retained/**'], hard, 'aggregate', null, 'default']);
  const model = resolveModel(['model', 1, 'maven', hard, definitions], 'h1-002-', 1),
    f = await observationFixture('maven', { model });
  cleanup.push(async () => {
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  const files: Record<string, string> = {};
  for (let i = 0; i < partitions; i++) {
    const path = 'shared/hot/p' + String(i).padStart(3, '0');
    if (!descendants) files[path] = 'body';
    else for (let j = 0; j < descendants; j++) files[path + '/child-' + j] = 'body';
  }
  for (let i = 0; i < retained; i++) files['retained/item-' + i] = 'unchanged';
  await f.files('', files);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  cleanup.push(() => input.dispose());
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  cleanup.push(() => pub.dispose());
  const window = await MovingWindow.open(pub, { operations: 1 });
  cleanup.push(() => window.close());
  await window.verify();
  const candidates: ReturnType<typeof empty>[] = [],
    write = f.store.writeStream.bind(f.store);
  vi.spyOn(f.store, 'writeStream').mockImplementation(async (...args) => {
    if (!returning || args[0] !== 'adjustments') return write(...args);
    const count = empty(),
      before = f.store.root.work.scratchReadBytes;
    active = count;
    try {
      return await write(...args);
    } finally {
      count.scratchReadBytes = f.store.root.work.scratchReadBytes - before;
      candidates.push(count);
      active = null;
    }
  });
  const returnBefore = f.store.root.work.scratchReadBytes;
  for (const choice of pub.choices.filter((c) => c[1] !== 'retained')) {
    const epoch = await RelocationEpoch.open(pub, choice[1], { operations: 1 }, window);
    cleanup.push(() => epoch.close());
    await epoch.evacuate();
    returning = true;
    let q;
    try {
      q = await epoch.returnSources();
    } finally {
      returning = false;
    }
    const proof = await window.checkCandidate(epoch, q);
    await proof.close();
    const result = [];
    for await (const row of f.store.rows(q, 'adjustments', {
      budget: f.budget,
      partition: choice[1],
    })) {
      const value = tuple(row.value);
      if (value[0] === 'adjust') result.push([value[1], tuple(value[3])[2]]);
    }
    expect(result).toEqual([['shared/hot/' + choice[1], descendants ? 'directory' : 'file']]);
    await epoch.cleanupStage();
    await updateMovingCatalog(pub, (cells) => {
      cells.find((c) => c[1] === choice[1])![3] = f.store.codec.schemas.ref('adjustments').parse(q);
    });
    await window.adopt(choice[1], q);
    await window.verifyPart(choice[1]);
    await f.store.clearIntent(epoch.current!);
    await epoch.close();
  }
  await window.verify();
  const total = empty();
  for (const count of candidates)
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += count[k];
  const result = {
    partitions,
    retained,
    descendants,
    candidates: candidates.length,
    ...total,
    // Includes required member/admission/candidate/final guards, not just sparse row production.
    guardedPhaseScratchReadBytes: f.store.root.work.scratchReadBytes - returnBefore,
  };
  process.stdout.write('H1_002_COST ' + JSON.stringify(result) + '\n');
  return result;
}
it.each([4, 16])(
  'enumerates only sparse adjustment metadata for %i changed partitions',
  async (partitions) => {
    const small = await measure(partitions, 4, 0),
      unrelated = await measure(partitions, 32, 0),
      directories = await measure(partitions, 32, 32);
    for (const result of [small, unrelated, directories]) {
      expect(result.candidates).toBe(partitions);
      expect(result.walks).toBe(0);
      expect(result.observedNodes).toBe(0);
      expect(result.records).toBeLessThanOrEqual(16 * partitions);
      expect(result.rows).toBeLessThanOrEqual(16 * partitions);
      expect(result.scratchReadBytes).toBeLessThanOrEqual(32768 * partitions);
    }
    // New unrelated retained nodes and opaque moved-root descendants must not enter the enumeration.
    for (const result of [unrelated, directories]) {
      expect(result.records).toBe(small.records);
      expect(result.rows).toBe(small.rows);
      expect(result.scratchReadBytes).toBeLessThanOrEqual(small.scratchReadBytes * 1.25 + 4096);
    }
  },
  120_000,
);
