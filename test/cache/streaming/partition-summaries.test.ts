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
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import type * as glob from '../../../src/cache/glob';
import * as localStream from '../../../src/cache/streaming/local-stream';
import * as fs from 'node:fs/promises';
import { resolveModel } from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { executeFixtureGc as executeGc } from './observation-fixtures';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
import { observationFixture } from './observation-fixtures';
const counts = vi.hoisted(() => ({ listings: 0, stats: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
    unlink: vi.fn(actual.unlink),
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
const globWork = vi.hoisted(() => ({ matches: 0 }));
vi.mock('../../../src/cache/glob', async (original) => {
  const actual = await original<typeof glob>();
  return {
    createCacheGlobMatcher(patterns: readonly string[]) {
      const match = actual.createCacheGlobMatcher(patterns);
      return (path: string) => {
        globWork.matches++;
        return match(path);
      };
    },
  };
});
const summaryBackend = {
  capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
  isFeatureAvailable: () => true,
  saveCache: async () => 1,
  restoreCache: async () => undefined,
  isMissingPathsError: () => false,
};
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
          ['data', ['data/**'], hard, 'aggregate', null, 'default', 0, ['data/*.lock']],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default', 0],
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
  out.capture(true);
  out.purge('data', 'deleted');
  out.purge('data', 'missing');
  out.purge('data', 'unsupported');
  const capture: string[] = [];
  out.finishCapture(false, (line) => capture.push(line));
  expect(capture.join('\n')).toContain('purged=1');
  expect(capture.join('\n')).toContain('missing=1, unsupported=1');
  expect(capture.join('\n')).toContain('state: captured=0 files/0 logical bytes');
  expect(capture[0]).toContain('partial');
  expect(logs(out).lines).toContain('planning incomplete');
  out.choice('data', 'new');
  expect(logs(out).lines).toContain('planned-roots=0 directories/0 files');
  out.root('data', 'directory');
  out.root('data', 'file');
  out.choice('state', 'empty');
  const rendered = logs(out);
  expect(rendered.lines).toContain('planned-roots=1 directories/1 files');
  expect(rendered.lines).toContain('state: action=empty, no upload moves planned');
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
  out.capture(false);
  out.hint('data', 'excluded or unmanaged entries remain', 'data/a');
  out.hint('data', 'excluded or unmanaged entries remain', 'data/a/descendant');
  for (let i = 0; i < 1000; i++) {
    out.hint('data', 'mixed partition ownership', 'data/x' + i);
    out.prunedDirectory('opaque/' + i);
  }
  const [data, state] = out.snapshot();
  expect(data.examples).toHaveLength(8);
  expect(data.truncated).toBe(true);
  expect(state.examples).toEqual([]);
  expect(state.hints).toEqual([]);
  expect(budget.retained).toBeLessThan(100000);
  expect(logs(out).lines).toContain('additional examples omitted');
  const capture: string[] = [];
  out.finishCapture(true, (line) => capture.push(line));
  expect(capture.join('\n')).toContain('pruned=1000 directories (descendant counts unknown)');
  expect(capture.join('\n')).toContain('purge=skipped');
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
it('bounds escaped file examples and releases their budget even when the reporter throws', () => {
  const { out, budget } = summary();
  const charges = vi.spyOn(WorkingBudget.prototype, 'holdRecord');
  out.capture(false);
  out.unsupportedLayout('data', 'caches/ic/a\n\u001b\u202e.txt');
  for (let i = 0; i < 1000; i++) out.unsupportedLayout('data', `caches/ic/${i}/` + 'é'.repeat(800));
  const sampleBudget = charges.mock.contexts[0] as WorkingBudget;
  expect(sampleBudget).not.toBe(budget);
  expect(charges.mock.calls.length).toBeLessThanOrEqual(8);
  expect(sampleBudget.retained).toBeGreaterThan(0);
  expect(budget.retained).toBe(0);
  const warning = vi.fn((_message: string) => {
    throw new Error('diagnostics unavailable');
  });
  const info = vi.fn();
  out.finishCapture(false, info, warning);
  out.finishCapture(false, info, warning);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(info.mock.calls.filter(([line]) => String(line).includes('capture summary'))).toHaveLength(
    1,
  );
  const message = String(warning.mock.calls[0][0]);
  const examples = message.split('\n').filter((line) => line.startsWith('  '));
  expect(examples.join('\n')).toContain('data: caches/ic/a\\u{a}\\u{1b}\\u{202e}.txt');
  expect(examples.join('\n')).toContain('… [truncated]');
  expect(
    examples.reduce((bytes, example) => bytes + Buffer.byteLength(example.trimStart()), 0),
  ).toBeLessThanOrEqual(4096);
  expect(message).toContain('Omitted 1001 Gradle files');
  expect(message).toContain('Additional examples omitted');
  expect(sampleBudget.retained).toBe(0);
});

it('keeps totals when the diagnostic budget cannot hold any examples', () => {
  const { model } = summary();
  const out = new PartitionSummaries(model, new WorkingBudget(1), false);
  out.capture(false);
  out.unsupportedLayout('data', 'caches/ic/actual-file');
  const warning = vi.fn();
  out.finishCapture(true, undefined, warning);
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Omitted 1 Gradle file'));
  expect(warning.mock.calls[0][0]).toContain('Additional examples omitted');
  out.dispose();
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
          [
            'a',
            ['shared/a/**', 'shared/runtime.lock'],
            hard,
            'aggregate',
            null,
            'default',
            0,
            rules,
          ],
          [
            'b',
            ['shared/b/**', 'shared/runtime.lock'],
            hard,
            'aggregate',
            null,
            'default',
            0,
            rules,
          ],
          ['other', ['other/**'], hard, 'aggregate', null, 'default', 0],
        ],
      ],
      'shared-',
      1,
    ),
    f = await observationFixture('gradle', { model }),
    out = new PartitionSummaries(model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    await f.finish();
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
it.each([
  { units: 4, width: 2 },
  { units: 4, width: 8 },
  { units: 16, width: 2 },
])(
  'keeps capture/GC/planner work equal with $units units of width $width',
  async ({ units, width }) => {
    const results = [];
    const hard = ['.mammoth/**', '**/*.lock', 'shared/pruned/**'];
    const rules = ['shared/*/*.lock', 'shared/*/runtime.lock'];
    for (const reporting of ['none', 'warnings', 'all'] as const) {
      const model = resolveModel(
        [
          'model',
          1,
          'gradle',
          hard,
          [
            ['a', ['shared/**/a*', 'caches/**'], hard, 'aggregate', null, 'default', 0, rules],
            ['b', ['shared/**/b*'], hard, 'aggregate', null, 'default', 0, rules],
          ],
        ],
        'report-',
        1,
      );
      const f = await observationFixture('gradle', { model });
      const out =
        reporting === 'none'
          ? undefined
          : new PartitionSummaries(model, f.budget, reporting === 'all');
      cleanup.push(async () => {
        out?.dispose();
        await f.finish();
        expect(f.budget.retained).toBe(0);
        await f.close();
      });
      const files: Record<string, string> = { 'shared/pruned/hidden/member': 'hidden' };
      for (let i = 0; i < units; i++) {
        const dir = 'shared/unit' + i;
        files[dir + '/runtime.lock'] = 'runtime';
        files['caches/9.9.2/kotlin-dsl/ic/file' + i] = 'unknown';
        for (let j = 0; j < width; j++) {
          files[dir + '/a' + j] = 'body';
          files[dir + '/b' + j] = 'longer';
        }
      }
      await f.files('', files);
      counts.listings = counts.stats = globWork.matches = 0;
      const owners = vi.spyOn(f.store.codec.options.model, 'owner');
      const streams = vi.spyOn(localStream, 'readLocalRows');
      const batches = vi.spyOn(localStream, 'readLocalBatches');
      const scratch = ['record', 'rows', 'batches', 'append', 'appendBatch'] as const;
      const scratchSpies = scratch.map((name) => vi.spyOn(InstallScratch.prototype, name));
      const initial = { ...f.store.root.work };
      const io = [fs.open, fs.readFile, fs.readdir, fs.unlink].map((fn) => vi.mocked(fn));
      for (const spy of io) spy.mockClear();
      const info: string[] = [],
        warnings: string[] = [];
      const capture = await captureObservations(f.store, {
        budget: f.budget,
        summaries: out,
        onCaptureInfo: (line) => info.push(line),
        ...(out ? { onWarning: (line: string) => warnings.push(line) } : {}),
        purgeWindow: {
          root: f.store.root,
          invocation: f.store.codec.options.invocation,
          assertCurrent: (): undefined => {},
        },
      });
      const result = await executeGc(f.store, { budget: f.budget });
      const input = await MetadataPublicationSource.survivors(result.owner);
      cleanup.push(() => input.dispose());
      await publishMetadataBase(input, summaryBackend, {
        lineage: 'a'.repeat(64),
        writer: 'b'.repeat(64),
        decision: 'c'.repeat(64),
        summaries: reporting === 'all' ? out : undefined,
      });
      if (reporting === 'all') {
        const [a, b] = out!.snapshot();
        expect(a).toMatchObject({
          action: 'new',
          directories: 0,
          files: units * width,
          deleted: units,
          capturedFiles: units * width,
          logicalBytes: BigInt(4 * units * width),
          unsupportedLayouts: units,
          excluded: { file: units },
        });
        expect(b).toMatchObject({
          action: 'new',
          capturedFiles: units * width,
          logicalBytes: BigInt(6 * units * width),
          deleted: 0,
        });
        expect(info[0]).toContain('capture summary (complete)');
        expect(info.join('\n')).toContain('pruned=2 directories (descendant counts unknown)');
        expect(info.join('\n')).not.toContain('pruned/hidden');
        expect(logs(out!).lines).toContain('mixed partition ownership');
      } else {
        expect(info).toEqual([]);
      }
      if (out) {
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`Omitted ${units} Gradle files`);
        expect(warnings[0]).toContain('a: caches/9.9.2/kotlin-dsl/ic/file0');
        if (units > 8) expect(warnings[0]).toContain('Additional examples omitted');
      } else {
        expect(warnings).toEqual([]);
      }
      // Native identity strings vary in length between fixtures (inode and timestamps).
      // The counts and body-byte totals must match exactly.
      const variable = new Set([
        'readBytes',
        'writeBytes',
        'scratchReadBytes',
        'scratchWriteBytes',
        'scratchLogicalWriteBytes',
      ]);
      const native = Object.fromEntries(
        Object.entries(f.store.root.work)
          .filter(([key]) => !variable.has(key))
          .map(([key, value]) => [key, value - initial[key as keyof typeof initial]]),
      );
      results.push({
        native,
        capture: capture.work,
        stats: counts.stats,
        listings: counts.listings,
        fs: io.map((spy) => spy.mock.calls.length),
        owners: owners.mock.calls.length,
        matches: globWork.matches,
        streams: streams.mock.calls.length,
        batches: batches.mock.calls.length,
        scratch: Object.fromEntries(
          scratch.map((name, index) => [name, scratchSpies[index].mock.calls.length]),
        ),
      });
      owners.mockRestore();
      streams.mockRestore();
      batches.mockRestore();
      for (const spy of scratchSpies) spy.mockRestore();
    }
    expect(results[0].owners).toBeGreaterThan(0);
    expect(results[0].matches).toBeGreaterThan(0);
    expect(results[0].native.indexBuilds).toBeGreaterThan(0);
    expect(results[0].streams + results[0].batches).toBeGreaterThan(0);
    expect(results).toEqual([results[0], results[0], results[0]]);
    process.stdout.write(
      'FINALIZATION_REPORT_COST ' + JSON.stringify({ units, width, ...results[0] }) + '\n',
    );
  },
  30000,
);

it('keeps rejected capture admission skipped when diagnostics are emitted after failure', async () => {
  const f = await observationFixture('gradle', { purgeGlobs: ['data/*.lock'] }),
    out = new PartitionSummaries(f.model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    await f.finish();
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
  expect(out.snapshot()[0]).toMatchObject({ purge: 'skipped', deleted: 0 });
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
});

it('retains actual deletion counts after an admitted capture fails part way through', async () => {
  const f = await observationFixture('gradle', { purgeGlobs: ['data/*.lock'] }),
    out = new PartitionSummaries(f.model, f.budget);
  cleanup.push(async () => {
    out.dispose();
    await f.finish();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', { 'data/a.lock': 'a', 'data/b.lock': 'b' });
  const info = vi.fn();
  vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'observation-purge-unlinked') throw new Error('capture interrupted');
  });
  await expect(
    captureObservations(f.store, {
      budget: f.budget,
      summaries: out,
      onCaptureInfo: info,
      purgeWindow: {
        root: f.store.root,
        invocation: f.store.codec.options.invocation,
        assertCurrent: (): undefined => {},
      },
    }),
  ).rejects.toThrow('capture interrupted');
  expect(out.snapshot()[0]).toMatchObject({ purge: 'executed', deleted: 1 });
  expect(info.mock.calls[0][0]).toContain('capture summary (partial)');
  expect(info.mock.calls.flat().join('\n')).toContain('purged=1');
  expect(await f.store.root.stat('data/a.lock')).toBeNull();
  expect(await f.store.root.stat('data/b.lock')).not.toBeNull();
});
