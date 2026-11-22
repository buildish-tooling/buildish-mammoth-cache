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
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { resolveModel } from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { observationFixture } from './observation-fixtures';
const counts = vi.hoisted(() => ({ listings: 0, stats: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      counts.listings++;
      return actual.opendir(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      counts.stats++;
      return actual.lstat(...args);
    },
  };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function summary() {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['data/**'], hard, 'aggregate', null, 'default', ['data/*.lock']],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default'],
        ],
      ],
      'test-',
      1,
    ),
    budget = new WorkingBudget(),
    out = new PartitionSummaries(model, budget);
  cleanup.push(() => {
    out.dispose();
    expect(budget.retained).toBe(0);
  });
  return { out, model, budget };
}
function logs(out: PartitionSummaries) {
  const lines: string[] = [],
    groups: { title: string; lines: readonly string[] }[] = [];
  out.emit(
    { info: (s) => lines.push(s) },
    {
      publishLogGroup: (title, lines) => {
        groups.push({ title, lines });
      },
    },
  );
  return { lines: lines.join('\n'), groups };
}
it('formats effective configuration, actual partial deletion, skipped and all plan actions honestly', () => {
  const { out } = summary();
  expect(logs(out).lines).toContain('purge=skipped');
  out.capture(true);
  out.purge('data', 'deleted');
  out.purge('data', 'missing');
  out.purge('data', 'unsupported');
  expect(logs(out).lines).toContain('planning incomplete, purged=1');
  out.choice('data', 'new');
  expect(logs(out).lines).toContain('planned-roots=0 directories/0 files');
  out.root('data', 'directory');
  out.root('data', 'file');
  out.choice('state', 'empty');
  const rendered = logs(out);
  expect(rendered.lines).toContain('planned-roots=1 directories/1 files');
  expect(rendered.lines).toContain('missing=1, unsupported=1');
  expect(rendered.lines).toContain(
    'state: action=empty, no upload moves planned, purge=not applicable',
  );
  expect(JSON.parse(rendered.groups[0].lines[0])).toMatchObject({
    purgeableGlobs: ['data/*.lock'],
    excludes: ['.mammoth/**', 'data/*.lock'],
    publication: 'aggregate',
    writer: null,
  });
  out.choice('data', 'reuse');
  expect(logs(out).lines).toContain('data: action=reuse, no upload moves planned');
});
it('bounds path count and suppresses descendant noise without attributing opaque scopes to partitions', () => {
  const { out, budget } = summary();
  out.choice('data', 'new');
  out.hint('data', 'excluded or unmanaged entries remain', 'data/a');
  out.hint('data', 'excluded or unmanaged entries remain', 'data/a/descendant');
  for (let i = 0; i < 1000; i++) {
    out.hint('data', 'mixed partition ownership', 'data/x' + i);
    out.opaqueScope('opaque/' + i);
  }
  const [data, state] = out.snapshot();
  expect(data.examples).toHaveLength(8);
  expect(data.truncated).toBe(true);
  expect(state.examples).toEqual([]);
  expect(state.hints).toEqual([]);
  expect(budget.retained).toBeLessThan(100000);
  const text = logs(out).lines;
  expect(text).toContain('additional examples omitted');
  expect(text).toContain('1000 hard-pruned directories not inspected');
  expect(text).toContain('descendant match counts unknown');
});
it('bounds UTF-8 sample bytes as well as count and rejects reuse after disposal or a model change', () => {
  const { out, model } = summary();
  for (let i = 0; i < 20; i++) out.hint('data', 'unselected contents', i + 'é'.repeat(700));
  const data = out.snapshot()[0];
  expect(data.examples).toHaveLength(2);
  expect(data.examples.reduce((n, p) => n + Buffer.byteLength(p), 0)).toBeLessThanOrEqual(4096);
  expect(data.truncated).toBe(true);
  expect(() => out.assert({ ...model, id: '0'.repeat(64) })).toThrow('Unbound');
  out.dispose();
  expect(() => out.snapshot()).toThrow('closed');
});
it('does not double count shared purge claims or attach split hints to unrelated partitions', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    rules = ['shared/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [
          ['a', ['shared/a/**', 'shared/runtime.lock'], hard, 'aggregate', null, 'default', rules],
          ['b', ['shared/b/**', 'shared/runtime.lock'], hard, 'aggregate', null, 'default', rules],
          ['other', ['other/**'], hard, 'aggregate', null, 'default'],
        ],
      ],
      'shared-',
      1,
    ),
    f = await observationFixture('gradle', { model }),
    out = new PartitionSummaries(model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  // Shared claims only overlap on an ordinarily excluded file; actual content has one owner.
  await f.files('', { 'shared/runtime.lock': 'runtime', 'other/file': 'body' });
  const captured = await captureObservations(f.store, {
    budget: f.budget,
    summaries: out,
    purgeWindow: {
      root: f.store.root,
      invocation: f.store.codec.options.invocation,
      assertCurrent: (): undefined => {},
    },
  });
  expect(captured.purge.deleted).toBe(1);
  expect(out.snapshot().reduce((n, p) => n + p.deleted, 0)).toBe(1);
  expect(out.snapshot().find((p) => p.id === 'other')!.deleted).toBe(0);
});
it.each([4, 16])(
  'reporting on/off has identical complete capture/GC/planner filesystem work at %i files',
  async (n) => {
    const results = [];
    for (const reporting of [false, true]) {
      const f = await observationFixture('gradle', { purgeGlobs: ['data/runtime.lock'] }),
        out = reporting ? new PartitionSummaries(f.model, f.budget) : undefined;
      cleanup.push(async () => {
        out?.dispose();
        expect(f.budget.retained).toBe(0);
        await f.close();
      });
      const files: Record<string, string> = {
        'data/runtime.lock': 'runtime',
        'data/keep.lock': 'excluded',
      };
      for (let i = 0; i < n; i++) files['data/f' + i] = 'body';
      await f.files('', files);
      counts.listings = counts.stats = 0;
      const initial = { ...f.store.root.work },
        hash = vi.spyOn(NativeReadPhase.prototype, 'hash');
      await captureObservations(f.store, {
        budget: f.budget,
        summaries: out,
        purgeWindow: {
          root: f.store.root,
          invocation: f.store.codec.options.invocation,
          assertCurrent: (): undefined => {},
        },
      });
      await executeGc(f.store, { budget: f.budget });
      const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
      cleanup.push(() => input.dispose());
      const pub = await FrozenMovingPublication.freeze(input, 'main', [], out);
      cleanup.push(() => pub.dispose());
      const beforeEmit = { ...f.store.root.work },
        beforeListings = counts.listings,
        beforeStats = counts.stats;
      if (out) {
        const [data, state] = out.snapshot();
        expect(data).toMatchObject({ action: 'new', directories: 0, files: n, deleted: 1 });
        expect(data.hints).toContain('excluded or unmanaged entries remain');
        expect(state).toMatchObject({ action: 'empty', hints: [], examples: [] });
        expect(logs(out).lines).toContain('finer-grained moves');
      }
      expect(f.store.root.work).toEqual(beforeEmit);
      expect(counts.listings).toBe(beforeListings);
      expect(counts.stats).toBe(beforeStats);
      const w = f.store.root.work;
      results.push({
        n,
        stats: counts.stats,
        listings: counts.listings,
        opens: w.opens - initial.opens,
        renames: w.renames - initial.renames,
        unlinks: w.unlinks - initial.unlinks,
        hashes: hash.mock.calls.length,
      });
      hash.mockRestore();
    }
    expect(results[1]).toEqual(results[0]);
    process.stdout.write('V4D_REPORT_COST ' + JSON.stringify(results) + '\n');
  },
  30000,
);

it('keeps rejected capture admission skipped when diagnostics are emitted after failure', async () => {
  const f = await observationFixture('gradle', { purgeGlobs: ['data/*.lock'] }),
    out = new PartitionSummaries(f.model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', { 'data/runtime.lock': 'lock' });
  await expect(
    captureObservations(f.store, {
      budget: f.budget,
      summaries: out,
      purgeWindow: {
        root: f.store.root,
        invocation: f.store.codec.options.invocation,
        assertCurrent() {
          throw new Error('expired');
        },
      },
    }),
  ).rejects.toThrow('expired');
  expect(logs(out).lines).toContain('planning incomplete, purge=skipped');
  expect(logs(out).lines).not.toContain('purged=0');
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
});

it('retains actual deletion counts after an admitted capture fails part way through', async () => {
  const f = await observationFixture('gradle', { purgeGlobs: ['data/*.lock'] }),
    out = new PartitionSummaries(f.model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', { 'data/a.lock': 'a', 'data/b.lock': 'b' });
  vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'observation-purge-unlinked') throw new Error('capture interrupted');
  });
  await expect(
    captureObservations(f.store, {
      budget: f.budget,
      summaries: out,
      purgeWindow: {
        root: f.store.root,
        invocation: f.store.codec.options.invocation,
        assertCurrent: (): undefined => {},
      },
    }),
  ).rejects.toThrow('capture interrupted');
  expect(logs(out).lines).toContain('planning incomplete, purged=1');
  expect(await f.store.root.stat('data/a.lock')).toBeNull();
  expect(await f.store.root.stat('data/b.lock')).not.toBeNull();
});
