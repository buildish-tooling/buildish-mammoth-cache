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
import { readFile, rename } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import { gradleResolver } from './quiescence-fixture';
import {
  checkHandoffGeneration,
  handoffSchemas,
} from '../../../src/cache/streaming/lifecycle-handoff';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { PostAttempt } from '../../../src/cache/streaming/lifecycle-attempt';
import { resolveModel } from '../../../src/cache/streaming/model';
import { createMetadataGeneration } from '../../../src/cache/streaming/metadata-base-records';
import { MetadataInstallContext } from '../../../src/cache/streaming/metadata-install-context';
import { freezeMetadataInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import { BaseMoveBoundaries } from '../../../src/cache/streaming/base-move-boundaries';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';

const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
const contexts: MetadataInstallContext[] = [];
const restoreFixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const context of contexts.splice(0)) await context.dispose();
  for (const f of fixtures.splice(0)) await f.close();
  for (const f of restoreFixtures.splice(0)) await f.close();
});

async function fixture(filesPerUnit: number, alias = false) {
  const hard = ['.mammoth/**', '**/*.lock'];
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      hard,
      [
        ['a', ['shared/a/**'], hard, 'aggregate', null, 'default'],
        ['b', ['shared/b/**'], hard, 'aggregate', null, 'default'],
      ],
    ],
    'bounded-index-',
    1,
  );
  const f = await installFixture('gradle', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  await f.files('', { 'shared/a/keep.lock': 'protected' });
  const offers = [];
  for (const id of ['a', 'b']) {
    const files: Record<string, string> = {};
    for (const unit of ['first', 'second'])
      for (let i = 0; i < filesPerUnit; i++) files[`shared/${id}/${unit}/file-${i}`] = id;
    if (alias && id === 'a') {
      files['shared/a/first/A'] = '1';
      files['shared/a/first/a'] = '2';
    }
    offers.push(await f.incoming(id, files, 'trusted-base'));
  }
  const digest = 'a'.repeat(64);
  const generation = createMetadataGeneration(
    model,
    digest,
    digest,
    digest,
    offers.map((o) => ['object', o.partition, o.reference]),
    [['a'], ['b']],
  );
  const materialized = offers.map((o) => ({ partition: o.partition, root: o.objectRoot }));
  return { ...f, materialized, generation };
}

it('keeps install records at shared and split boundaries as intact subtrees grow', async () => {
  const rows = [];
  for (const size of [2, 16]) {
    const f = await fixture(size);
    const before = f.store.root.work.metadataRowsWritten;
    const context = await MetadataInstallContext.discover(f.store, f.generation, f.materialized, {
      budget: f.budget,
      baseSourceMode: 'trusted-summary',
    });
    contexts.push(context);
    rows.push(f.store.root.work.metadataRowsWritten - before);
    const a = context.source('a')!.upstream;
    expect(a.kind === 'native-metadata' && a.source.summary[3]).toBe(size * 2);
    const plan = await freezeMetadataInstallPlan(f.store, context, f.budget);
    const movePaths = [];
    for await (const row of f.store.rows(plan.plan, 'install-plan', {
      budget: f.budget,
      partition: null,
      installKind: () => 'directory',
    })) {
      if (Array.isArray(row.value) && row.value[0] === 'install') movePaths.push(row.value[2]);
    }
    expect(movePaths).toEqual(['shared/a/first', 'shared/a/second', 'shared/b']);
    await executeInstall(f.store, plan, f.budget);
    expect(await readFile(f.store.root.resolve('shared/a/keep.lock'), 'utf8')).toBe('protected');
    expect(await readFile(f.store.root.resolve(`shared/b/second/file-${size - 1}`), 'utf8')).toBe(
      'b',
    );
    expect(f.budget.retained).toBe(0);
  }
  expect(rows[0]).toBeGreaterThan(0);
  expect(rows[1]).toBe(rows[0]);
});

it('releases shared-name views before denying mandatory names and retains detail thereafter', async () => {
  const f = await fixture(2);
  const budget = new WorkingBudget(4096);
  const boundaries = new BaseMoveBoundaries(f.store, budget, f.materialized, 100);
  try {
    const a = await boundaries.begin('a');
    expect(await a('shared')).toBe(false);
    expect(await a('shared/a')).toBe(false);
    expect(await a('shared/a/first')).toBe(true);
    expect(budget.retained).toBeGreaterThan(0);
    const listings = f.store.root.work.nativeListings;
    budget.retain(budget.limit);
    budget.release(budget.limit);
    expect(await a('shared/a/second')).toBe(false);
    const b = await boundaries.begin('b');
    expect(await b('shared')).toBe(false);
    expect(f.store.root.work.nativeListings).toBe(listings);
  } finally {
    boundaries.close();
  }
  expect(budget.retained).toBe(0);
});

it.runIf(process.platform === 'linux')(
  'preserves alias rejection at a split restore boundary',
  async () => {
    const f = await fixture(2, true);
    await f.files('', { 'shared/a/first/keep.lock': 'protected' });
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    const context = await MetadataInstallContext.discover(f.store, f.generation, f.materialized, {
      budget: f.budget,
      baseSourceMode: 'trusted-boundaries',
    });
    contexts.push(context);
    await expect(freezeMetadataInstallPlan(f.store, context, f.budget)).rejects.toThrow(
      'case/normalization path alias',
    );
    expect(f.budget.retained).toBe(0);
  },
);

it('checks each staged parent once across shared depth and partition count', async () => {
  for (const count of [2, 8]) {
    const ids = Array.from({ length: count }, (_, i) => 'p' + i);
    const hard = ['.mammoth/**'];
    const model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        ids.map((id) => [id, ['shared/**/file-' + id], hard, 'aggregate', null, 'default']),
      ],
      'shared-boundaries-',
      1,
    );
    for (const depth of [4, 16]) {
      const f = await installFixture('gradle', { model });
      fixtures.push(f);
      const paths = Array.from({ length: depth }, (_, i) =>
        ['shared', ...Array<string>(i).fill('dir')].join('/'),
      );
      const sources = [];
      for (const id of ids) {
        const input = await f.incoming(id, { [paths.at(-1)! + '/file-' + id]: id });
        sources.push({ partition: id, root: input.objectRoot });
      }
      const work = f.store.root.work,
        listings = work.nativeListings,
        stats = work.stats;
      const boundaries = new BaseMoveBoundaries(f.store, f.budget, sources, 100);
      try {
        for (const id of ids) {
          const intact = await boundaries.begin(id);
          for (const path of paths) expect(await intact(path)).toBe(false);
        }
        expect(work.nativeListings - listings).toBe(count * depth);
        expect(work.stats - stats).toBeLessThanOrEqual(count * (4 * depth + 20));
      } finally {
        boundaries.close();
      }
      expect(f.budget.retained).toBe(0);
    }
  }
});

it('keeps detail after an observed live parent changes', async () => {
  const f = await fixture(2);
  const boundaries = new BaseMoveBoundaries(f.store, f.budget, f.materialized, 100);
  try {
    const intact = await boundaries.begin('a');
    expect(await intact('shared')).toBe(false);
    expect(await intact('shared/a')).toBe(false);
    await rename(f.store.root.resolve('shared/a'), f.store.root.resolve('shared/replaced'));
    await f.files('', { 'shared/a/foreign.lock': 'keep' });
    expect(await intact('shared/a/first')).toBe(false);
  } finally {
    boundaries.close();
  }
  expect(f.budget.retained).toBe(0);
});

it('stops boundary-only restore work below intact roots and preserves the exact writable summary', async () => {
  const boundaryWork = [];
  for (const size of [2, 16]) {
    const f = await fixture(size);
    const discover = async (baseSourceMode?: 'trusted-summary' | 'trusted-boundaries') => {
      const before = { ...f.store.root.work };
      const context = await MetadataInstallContext.discover(f.store, f.generation, f.materialized, {
        budget: f.budget,
        baseSourceMode,
      });
      contexts.push(context);
      return {
        context,
        stats: f.store.root.work.stats - before.stats,
        listings: f.store.root.work.nativeListings - before.nativeListings,
        rows: f.store.root.work.metadataRowsWritten - before.metadataRowsWritten,
      };
    };
    const original = await discover();
    const full = original.context.source('a')!.upstream;
    if (full.kind !== 'native-metadata') throw new Error('Missing base discovery.');
    const pin = full.source.pin();
    await original.context.dispose();
    const publisher = await discover('trusted-summary');
    const publishing = publisher.context.source('a')!.upstream;
    if (publishing.kind !== 'native-metadata') throw new Error('Missing base discovery.');
    expect(publishing.source.pin()).toEqual(pin);
    expect(publisher.rows).toBeLessThan(original.rows);
    await publisher.context.dispose();
    const boundary = await discover('trusted-boundaries');
    const reader = boundary.context.source('a')!.upstream;
    if (reader.kind !== 'native-metadata') throw new Error('Missing base discovery.');
    expect(reader.source.pin()).toBeNull();
    boundaryWork.push([boundary.stats, boundary.listings, boundary.rows]);
    await executeInstall(
      f.store,
      await freezeMetadataInstallPlan(f.store, boundary.context, f.budget),
      f.budget,
    );
  }
  expect(boundaryWork[1]).toEqual(boundaryWork[0]);
});

async function gradleRestore() {
  const hard = ['.mammoth/**', '**/*.lock'];
  const model = resolveModel(
    ['model', 1, 'gradle', hard, [['data', ['caches/**'], hard, 'aggregate', null, 'default']]],
    'trusted-base-',
    1,
  );
  const f = await metadataFixture(model);
  restoreFixtures.push(f);
  const accessor = 'caches/8.7/kotlin-dsl/accessors/' + 'a'.repeat(32);
  await f.files(f.root, { 'caches/8.7/kotlin-dsl/accessors/keep.lock': 'protect' });
  const seeded = await f.seed({
    data: {
      [accessor + '/CLASSES.JAR']: 'uppercase extra',
      [accessor + '/classes/fixture.class']: 'classes',
      [accessor + '/sources/fixture.kt']: 'sources',
      [accessor + '/metadata.bin']: 'metadata',
      ...Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [accessor + '/classes/file-' + i, 'class']),
      ),
    },
  });
  return {
    ...f,
    ...seeded,
    accessor,
    lifecycle: gradleResolver({
      inspect: async () => ({ remaining: false, uncertain: false }),
    }),
  };
}

it.each(['read-only', 'distributed-worker'] as const)(
  'restores a trusted aggregate into a native home and preserves summary-free provenance for %s',
  async (mode) => {
    const f = await gradleRestore();
    const ready = await f.prepare({
      lifecycle: f.lifecycle,
      maxDirectoryEntries: 4,
      policy: {
        ...f.request.policy,
        access: mode === 'read-only' ? 'read-only' : 'writable',
        role: mode === 'distributed-worker' ? mode : 'standalone',
      },
    });
    expect(ready.restoredKey).toBe(f.generation[11]);
    expect(await readFile(ready.store.root.resolve(f.accessor + '/classes/file-6'), 'utf8')).toBe(
      'class',
    );
    const opened = await OpenedInvocation.open(ready.anchor, f.budget);
    const attempt = await PostAttempt.open(opened, {
      budget: f.budget,
      assertCurrent: () => undefined,
    });
    try {
      expect(attempt.handoff.entries[0][3]).toEqual(['restored-object', f.entries[0][2]]);
      const entries = structuredClone(attempt.handoff.entries);
      const restored = entries[0][3];
      if (restored?.[0] !== 'restored-object') throw new Error('Missing exact object reference.');
      restored[1][4] = 'c'.repeat(64);
      expect(() =>
        checkHandoffGeneration(
          ready.store,
          attempt.handoff.header,
          entries,
          f.generation,
          attempt.bindings[8],
        ),
      ).toThrow('exact restored object');
      const publishingCodec = new LocalCodec({
        ...ready.store.codec.options,
        access: 'writable',
        role: 'standalone',
      });
      expect(
        handoffSchemas(publishingCodec).entry.safeParse(attempt.handoff.entries[0]).success,
      ).toBe(false);
    } finally {
      attempt.close();
    }
    expect(f.budget.retained).toBe(0);
  },
);

it('enforces consumer breadth when a writable restore needs a reuse summary', async () => {
  const f = await gradleRestore();
  await expect(f.prepare({ lifecycle: f.lifecycle, maxDirectoryEntries: 4 })).rejects.toThrow(
    /directory breadth/i,
  );
  expect(await f.store.root.stat(f.accessor)).toBeNull();
  expect(f.budget.retained).toBe(0);
});

it('keeps the accessor workspace kind when an intact directory has an uppercase JAR extra', async () => {
  const hard = ['.mammoth/**', '**/*.lock'];
  const model = resolveModel(
    ['model', 1, 'gradle', hard, [['data', ['caches/**'], hard, 'aggregate', null, 'default']]],
    'workspace-boundary-',
    1,
  );
  const f = await installFixture('gradle', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  const parent = 'caches/8.7/kotlin-dsl/accessors';
  const workspace = parent + '/' + 'b'.repeat(32);
  await f.files('', { [parent + '/keep.lock']: 'protected' });
  const offer = await f.incoming('data', {
    [workspace + '/CLASSES.JAR']: 'extra',
    [workspace + '/classes/file']: 'class',
    [workspace + '/sources/file']: 'source',
    [workspace + '/metadata.bin']: 'metadata',
  });
  const hash = 'b'.repeat(64);
  const generation = createMetadataGeneration(
    model,
    hash,
    hash,
    hash,
    [['object', 'data', offer.reference]],
    [['data']],
  );
  const context = await MetadataInstallContext.discover(
    f.store,
    generation,
    [{ partition: 'data', root: offer.objectRoot }],
    { budget: f.budget, baseSourceMode: 'trusted-boundaries' },
  );
  contexts.push(context);
  const plan = await freezeMetadataInstallPlan(f.store, context, f.budget);
  const units = [];
  for await (const row of f.store.rows(plan.plan, 'install-plan', {
    budget: f.budget,
    partition: null,
    installKind: () => 'directory',
  })) {
    if (Array.isArray(row.value) && row.value[0] === 'install-unit-open') units.push(row.value);
  }
  expect(units).toEqual([
    ['install-unit-open', 'kotlin-accessor-directories', workspace, 'subtree'],
  ]);
  await executeInstall(f.store, plan, f.budget);
  expect(await readFile(f.store.root.resolve(workspace + '/CLASSES.JAR'), 'utf8')).toBe('extra');
});
