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

import { lstat, opendir, utimes, writeFile, readFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  observationFixture,
  captureFixtureObservations,
  executeFixtureGc,
} from './observation-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { recordEncodingWork } from '../../../src/cache/streaming/encoding';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';

// Count the actual APIs, including custom walks which do not increment nativeListings.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir) };
});
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
it('never re-admits unrelated retained trees after fixed shared-parent deletions as trees and partitions grow', async () => {
  const results = [];
  for (const partitions of [4, 16]) {
    for (const directories of [2, 8]) {
      const hard = ['.mammoth/**'];
      const ids = Array.from({ length: partitions }, (_, i) => 'p' + String(i).padStart(2, '0'));
      const model = resolveModel(
        [
          'model',
          1,
          'maven',
          hard,
          ids.map((id) => [id, ['**/' + id + '/**'], hard, 'aggregate', null, 'default', 0]),
        ],
        'gc-scoped-work-',
        1,
      );
      const f = await observationFixture('maven', { model });
      fixtures.push(f);
      const deleted = ['selected/p00/shared/a', 'selected/p00/shared/b'];
      await f.files('', Object.fromEntries(deleted.map((p) => [p, 'expired'])));
      for (const p of deleted) {
        await utimes(f.store.root.resolve(p), 1, 1);
      }
      for (const id of ids) {
        for (let d = 0; d < directories; d++) {
          const parent = 'retained/' + id + '/shared/d' + d;
          await f.files('', {
            [parent + '/one']: 'keep',
            [parent + '/two']: 'keep',
            [parent + '/keep.lock']: 'protected',
          });
        }
      }
      await captureFixtureObservations(f.store, { budget: f.budget });
      const native = vi.mocked(lstat),
        listings = vi.mocked(opendir);
      native.mockClear();
      listings.mockClear();
      const before = { ...f.store.root.work },
        codec = { ...recordEncodingWork };
      let afterDeletion:
        { native: number; listings: number; work: typeof before; codec: typeof codec } | undefined;
      let completions = 0;
      vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
        if (name === 'gc-target-deleted' && ++completions === 2) {
          afterDeletion = {
            native: native.mock.calls.length,
            listings: listings.mock.calls.length,
            work: { ...f.store.root.work },
            codec: { ...recordEncodingWork },
          };
        }
      });
      const { owner } = await executeFixtureGc(f.store, { budget: f.budget, batchOperations: 1 });
      expect(completions).toBe(2);
      expect(afterDeletion).toBeDefined();
      const difference = (a: Record<string, number>, b: Record<string, number>) =>
        Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
      const managed = (p: unknown) =>
        String(p).startsWith(f.root + '/') &&
        String(p) !== f.root + '/.mammoth' &&
        !String(p).startsWith(f.root + '/.mammoth/');
      const calls = native.mock.calls.map(([p]) => String(p));
      const opened = listings.mock.calls.map(([p]) => String(p));
      const work = difference(
        f.store.root.work as unknown as Record<string, number>,
        before as unknown as Record<string, number>,
      );
      const afterWork = difference(
        f.store.root.work as unknown as Record<string, number>,
        afterDeletion!.work as unknown as Record<string, number>,
      );
      results.push({
        selection: {
          stats: 0,
          rootStats: 0,
          metadataStats: 0,
          work: {} as Record<string, number>,
          codec: {} as Record<string, number>,
        },
        partitions,
        directories,
        retainedFiles: partitions * directories * 2,
        native: {
          stats: calls.length,
          managedStats: calls.filter(managed).length,
          unrelatedStats: calls.filter((p) => p.startsWith(f.root + '/retained')).length,
          listings: opened.length,
          managedListings: opened.filter(managed).length,
        },
        afterDeletion: {
          stats: calls.length - afterDeletion!.native,
          listings: opened.length - afterDeletion!.listings,
          work: afterWork,
          codec: difference(recordEncodingWork, afterDeletion!.codec),
        },
        work,
        codec: difference(recordEncodingWork, codec),
      });
      expect(calls.filter((p) => p.startsWith(f.root + '/retained'))).toEqual([]);
      expect(opened.filter((p) => p === f.root || managed(p))).toEqual([]);
      for (const p of deleted) {
        expect(await f.store.root.stat(p)).toBeNull();
      }
      for (const id of ids) {
        for (let d = 0; d < directories; d++) {
          const parent = 'retained/' + id + '/shared/d' + d;
          expect(await readFile(f.store.root.resolve(parent + '/one'), 'utf8')).toBe('keep');
          expect(await readFile(f.store.root.resolve(parent + '/keep.lock'), 'utf8')).toBe(
            'protected',
          );
        }
      }
      const selectionBefore = { ...f.store.root.work },
        selectionCodec = { ...recordEncodingWork },
        selectionStats = native.mock.calls.length;
      const source = await MetadataPublicationSource.survivors(owner);
      try {
        for (const id of ids) {
          expect(source.summary(id)[3]).toBe(directories * 2);
        }
        const names: string[] = [];
        async function visit(offset: number): Promise<void> {
          const lease = await source.node(offset);
          try {
            if (lease.node[1] === 'file') {
              names.push(lease.node[2]);
            }
            for await (const edge of source.children(lease.node)) {
              await visit(edge[2]);
            }
          } finally {
            lease.release();
          }
        }
        await visit(source.index);
        expect(names).toHaveLength(partitions * directories * 2);
        expect(names.every((name) => name.startsWith('retained/') && !name.endsWith('.lock'))).toBe(
          true,
        );
        const selectionCalls = native.mock.calls.slice(selectionStats).map(([p]) => String(p));
        expect(selectionCalls.filter(managed)).toEqual([]);
        results[results.length - 1].selection = {
          stats: selectionCalls.length,
          rootStats: selectionCalls.filter((p) => p === f.root).length,
          metadataStats: selectionCalls.filter((p) => p.startsWith(f.root + '/.mammoth')).length,
          work: difference(
            f.store.root.work as unknown as Record<string, number>,
            selectionBefore as unknown as Record<string, number>,
          ),
          codec: difference(recordEncodingWork, selectionCodec),
        };
      } finally {
        await source.dispose();
      }
      await f.finish();
      expect(f.budget.retained).toBe(0);
    }
  }
  for (const result of results) {
    expect(result.native.managedStats).toBe(results[0].native.managedStats);
    expect(result.afterDeletion.stats).toBe(results[0].afterDeletion.stats);
    expect(result.afterDeletion.listings).toBe(results[0].afterDeletion.listings);
    expect(result.afterDeletion.work.scratchReadCalls).toBe(
      results[0].afterDeletion.work.scratchReadCalls,
    );
  }
  await writeFile('build/gc-scoped-work-counts.json', JSON.stringify(results, null, 2) + '\n');
});
