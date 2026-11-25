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

import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, utimes } from 'node:fs/promises';
import {
  observationFixture,
  captureFixtureObservations,
  executeFixtureGc,
} from './observation-fixtures';
import { WorkerSources } from '../../../src/cache/streaming/worker-walk';
import { resolveModel } from '../../../src/cache/streaming/model';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(width = 1) {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [['data', ['d/**', 'caches/**'], hard, 'aggregate', null, 'default', 0]],
      ],
      'scaffold-',
      1,
    ),
    f = await observationFixture('gradle', { role: 'distributed-worker', model }, [
      ['dir-open', ''],
      ['dir-open', 'd'],
      ['upsert', 'a', 'data'],
      ['dir-close', 'd'],
      ['dir-close', ''],
    ]);
  fixtures.push(f);
  await f.files('', { 'd/a': 'body' });
  for (let n = 0; n < width; n++) await f.files('', { ['init' + n + '/keep.txt']: 'protected' });
  return f;
}
it.each([1, 8])(
  'keeps %s physical unowned scaffolds in the original capture without rewalking or uploading them',
  async (width) => {
    const f = await fixture(width),
      capture = await captureFixtureObservations(f.store, { budget: f.budget }),
      result = await executeFixtureGc(f.store, { budget: f.budget }),
      before = { ...f.store.root.work },
      source = await WorkerSources.create(f.store, { survivors: result.owner }, f.budget);
    try {
      expect(source.work.listings).toBe(0);
      expect(f.store.root.work.nativeWalks).toBe(before.nativeWalks);
      expect(f.store.root.work.nativeListings).toBe(before.nativeListings);
      const paths: string[] = [];
      for await (const event of source.events(new AbortController().signal)) {
        if ('path' in event) paths.push(event.path);
        if (event.type === 'file') for await (const body of event.bytes) void body;
      }
      expect(paths.some((p) => p.startsWith('init'))).toBe(false);
      expect(paths).toContain('d/a');
      expect(capture.work.listings).toBe(width + 2);
      for (let n = 0; n < width; n++)
        expect(await f.store.root.stat('init' + n + '/keep.txt')).not.toBeNull();
    } finally {
      await source.dispose();
    }
    await f.finish();
    expect(f.budget.retained).toBe(0);
  },
);
it.each(['unowned', 'owned-empty'] as const)(
  'retains actual %s directory facts without inventing source authority',
  async (kind) => {
    const f = await fixture();
    await mkdir(f.store.root.resolve(kind === 'unowned' ? 'local/empty' : 'd/empty'), {
      recursive: true,
    });
    await captureFixtureObservations(f.store, { budget: f.budget });
    const result = await executeFixtureGc(f.store, { budget: f.budget }),
      source = await WorkerSources.create(f.store, { survivors: result.owner }, f.budget),
      paths: string[] = [];
    try {
      for await (const event of source.events(new AbortController().signal)) {
        if ('path' in event) paths.push(event.path);
        if (event.type === 'file') for await (const body of event.bytes) void body;
      }
    } finally {
      await source.dispose();
    }
    expect(paths.includes('d/empty')).toBe(kind === 'owned-empty');
    expect(paths).not.toContain('local/empty');
    await f.finish();
    expect(f.budget.retained).toBe(0);
  },
);
it('uses the captured hard-prune boundary without following opaque descendants', async () => {
  const f = await fixture(),
    warnings: string[] = [];
  await f.files('', { '.mammoth/opaque/more/private': 'private', 'd/private.lock': 'private' });
  const capture = await captureFixtureObservations(f.store, {
      budget: f.budget,
      onWarning: (m) => warnings.push(m),
    }),
    result = await executeFixtureGc(f.store, { budget: f.budget }),
    source = await MetadataPublicationSource.survivors(result.owner);
  try {
    expect(capture.work.listings).toBe(3);
    expect(source.summary('data')[3]).toBe(2);
  } finally {
    await source.dispose();
  }
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('preserves the workspace namespace after actual GC removes its last supported unit', async () => {
  const f = await fixture(),
    unit = 'caches/transforms-4/' + 'a'.repeat(32);
  for (const name of ['metadata.bin', 'results.bin', 'transformed/file']) {
    await f.files('', { [unit + '/' + name]: 'old' });
    await utimes(f.store.root.resolve(unit + '/' + name), 1, 1);
  }
  const capture = await captureFixtureObservations(f.store, { budget: f.budget });
  expect(capture.index).toBeDefined();
  const result = await executeFixtureGc(f.store, { budget: f.budget }),
    source = await WorkerSources.create(f.store, { survivors: result.owner }, f.budget);
  try {
    for await (const event of source.events(new AbortController().signal)) {
      if ('path' in event) expect(event.path).not.toBe(unit);
      if (event.type === 'file') for await (const body of event.bytes) void body;
    }
    expect(await f.store.root.stat('caches/transforms-4')).not.toBeNull();
  } finally {
    await source.dispose();
  }
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
it('keeps unknown workspace surfaces opaque with bounded warnings during the original walk', async () => {
  const f = await fixture(),
    warnings: string[] = [];
  for (let n = 0; n < 16; n++)
    await f.files('', { ['caches/transforms-4/not-a-unit-' + n + '/value']: 'unknown' });
  const capture = await captureFixtureObservations(f.store, {
    budget: f.budget,
    onWarning: (m) => warnings.push(m),
  });
  expect(warnings.length).toBeLessThanOrEqual(11);
  const result = await executeFixtureGc(f.store, { budget: f.budget }),
    source = await WorkerSources.create(f.store, { survivors: result.owner }, f.budget);
  try {
    for await (const event of source.events(new AbortController().signal)) {
      if ('path' in event) expect(event.path).not.toContain('not-a-unit');
      if (event.type === 'file') for await (const body of event.bytes) void body;
    }
    expect(capture.work.listings).toBe(21);
  } finally {
    await source.dispose();
  }
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
