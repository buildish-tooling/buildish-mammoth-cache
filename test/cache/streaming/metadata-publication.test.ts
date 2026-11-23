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

import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './install-fixture';
import { nativeCacheBackend, cleanupBaseFixtures } from './native-cache-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import {
  MetadataPublicationSource,
  MetadataPublicationSet,
} from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { recordEncodingWork } from '../../../src/cache/streaming/encoding';
const h = 'a'.repeat(64),
  request = { lineage: h, writer: h, decision: h };
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [],
  sources: MetadataPublicationSource[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sources.splice(0)) await s.dispose();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
  await cleanupBaseFixtures();
});
async function fixture(files = 2) {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['data/**', 'cache/**'], hard, 'aggregate', null, 'default'],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default'],
        ],
      ],
      'metadata-publish-',
      1,
    );
  const f = await installFixture('maven', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  for (let i = 0; i < files; i++)
    await f.files('', {
      ['data/shared/' + i]: 'data-' + i,
      ['cache/shared/' + i]: 'cache-' + i,
      ['state/shared/' + i]: 'state-' + i,
    });
  const captureBefore = { ...f.store.root.work },
    captureCodecBefore = { ...recordEncodingWork };
  const timingLogs: string[] = [];
  const source = await MetadataPublicationSource.capture(f.store, '', {
    budget: f.budget,
    timing: { now: () => 0, info: (s) => timingLogs.push(s) },
  });
  const initialCapture = Object.fromEntries(
    Object.entries(f.store.root.work).map(([k, v]) => [
      k,
      v - captureBefore[k as keyof typeof captureBefore],
    ]),
  );
  const captureCodec = Object.fromEntries(
    Object.entries(recordEncodingWork).map(([k, v]) => [
      k,
      v - captureCodecBefore[k as keyof typeof captureCodecBefore],
    ]),
  );
  sources.push(source);
  const save = vi.fn<BaseCacheBackend['saveCache']>(async () => 1),
    restore = vi.fn<BaseCacheBackend['restoreCache']>(async () => undefined),
    lookup = vi.fn(async () => undefined);
  const backend: BaseCacheBackend = {
    capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
    isFeatureAvailable: () => true,
    saveCache: save,
    restoreCache: restore,
    lookupCache: lookup,
    isMissingPathsError: () => false,
  };
  return { timingLogs, ...f, source, backend, save, restore, lookup, initialCapture, captureCodec };
}
it('publishes descriptor-only multi-root objects, returning each before the next save and record last', async () => {
  const f = await fixture(),
    moves = vi.spyOn(f.store.root, 'renameAbsent');
  f.save.mockImplementation(async (paths, key, options) => {
    if (paths.length === 2) {
      expect(await readdir(options!.archiveRoot!)).toEqual(['envelope.json', 'payload']);
      expect(JSON.parse(await readFile(paths[0], 'utf8'))).toHaveLength(4);
      const p = key.includes('-pstate-')
        ? 'state'
        : JSON.parse(await readFile(paths[0], 'utf8'))[3][2];
      if (p === 'state')
        expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
    } else {
      expect(moves).toHaveBeenCalledTimes(6);
      expect(await readFile(f.store.root.resolve('state/shared/0'), 'utf8')).toBe('state-0');
    }
    return 1;
  });
  expect((await publishMetadataBase(f.source, f.backend, request)).outcome).toBe('published');
  expect(f.save).toHaveBeenCalledTimes(3);
  expect(moves).toHaveBeenCalledTimes(6);
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.lookup).not.toHaveBeenCalled();
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'base'))).toEqual([]);
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow(
    'already attempted',
  );
});
it.each(['null', 'throw', 'lost'] as const)(
  'abandons unconfirmed first object %s with no salvage, retry or record',
  async (mode) => {
    const f = await fixture(),
      warnings: string[] = [];
    f.save.mockImplementation(async () => {
      if (mode !== 'null') throw new Error(mode);
      return null as unknown as number;
    });
    expect(
      await publishMetadataBase(f.source, f.backend, {
        ...request,
        onWarning: (m) => warnings.push(m),
      }),
    ).toEqual({ outcome: 'abandoned', generation: null });
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    for (const p of ['data', 'cache', 'state'])
      expect(await readFile(f.store.root.resolve(p + '/shared/0'), 'utf8')).toBe(p + '-0');
  },
);
it.each(['null', 'throw', 'lost'] as const)(
  'abandons final record %s after all objects/returns without claiming confirmation',
  async (mode) => {
    const f = await fixture();
    let calls = 0;
    f.save.mockImplementation(async () => {
      if (++calls < 3) return 1;
      if (mode !== 'null') throw new Error(mode);
      return null as unknown as number;
    });
    expect((await publishMetadataBase(f.source, f.backend, request)).outcome).toBe('abandoned');
    expect(f.save).toHaveBeenCalledTimes(3);
    expect(f.restore).not.toHaveBeenCalled();
    expect(await readFile(f.store.root.resolve('cache/shared/0'), 'utf8')).toBe('cache-0');
  },
);
it('checks finalized-save eligibility before creating stages or evacuating sources', async () => {
  const f = await fixture(),
    before = { ...f.store.root.work };
  f.backend.canConfirmSave = () => false;
  expect((await publishMetadataBase(f.source, f.backend, request)).outcome).toBe('abandoned');
  expect(f.store.root.work).toEqual(before);
  expect(f.save).not.toHaveBeenCalled();
});
it('keeps source ownership until delayed SDK settlement, then returns on foreground cancellation', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await f.source.dispose();
  sources.splice(sources.indexOf(f.source), 1);
  const source = await MetadataPublicationSource.capture(f.store, '', {
    budget: f.budget,
    signal: controller.signal,
  });
  sources.push(source);
  let settle!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.save.mockImplementation(async (paths) => {
    entered();
    await new Promise<void>((r) => {
      settle = r;
    });
    expect(await readFile(paths[1] + '/data/shared/0', 'utf8')).toBe('data-0');
    return 1;
  });
  const pending = publishMetadataBase(source, f.backend, request);
  void pending.catch(() => {});
  await started;
  controller.abort(new Error('foreground cancelled'));
  await expect(source.dispose()).rejects.toThrow('active SDK');
  expect(await f.store.root.stat('data')).toBeNull();
  settle();
  await expect(pending).rejects.toThrow('foreground cancelled');
  expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
  expect(f.save).toHaveBeenCalledTimes(1);
});
it('owns a rename before an injected success-then-after-stat failure', async () => {
  const f = await fixture(),
    rename = f.store.root.renameAbsent.bind(f.store.root);
  let once = true;
  vi.spyOn(f.store.root, 'renameAbsent').mockImplementation(async (...args) => {
    const id = await rename(...args);
    if (once) {
      once = false;
      throw new Error('after stat failed');
    }
    return id;
  });
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow(
    'after stat failed',
  );
  expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
  expect(await readFile(f.store.root.resolve('cache/shared/0'), 'utf8')).toBe('cache-0');
  expect(f.save).not.toHaveBeenCalled();
});
it('returns earlier roots after partial evacuation and cancellation', async () => {
  const f = await fixture(),
    rename = f.store.root.renameAbsent.bind(f.store.root);
  let calls = 0;
  vi.spyOn(f.store.root, 'renameAbsent').mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error('EXDEV');
    return rename(...args);
  });
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow('EXDEV');
  for (const p of ['data', 'cache'])
    expect(await readFile(f.store.root.resolve(p + '/shared/0'), 'utf8')).toBe(p + '-0');
  expect(f.save).not.toHaveBeenCalled();
});
it('returns every safe independent root while retaining an occupied return root and actionable stage paths', async () => {
  const f = await fixture();
  let retained = '';
  f.save.mockImplementation(async (_paths, _key, options) => {
    retained = options!.archiveRoot!;
    await mkdir(f.store.root.resolve('data'));
    await writeFile(f.store.root.resolve('data/foreign'), 'foreign');
    return 1;
  });
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow(/retained stage/);
  expect(await readFile(retained + '/payload/data/shared/0', 'utf8')).toBe('data-0');
  expect(await readFile(f.store.root.resolve('data/foreign'), 'utf8')).toBe('foreign');
  expect(await readFile(f.store.root.resolve('cache/shared/0'), 'utf8')).toBe('cache-0');
  expect(f.save).toHaveBeenCalledTimes(1);
});
it('treats empty seed partitions as explicit empties and supports admitted prior refs without moving them', async () => {
  const empty = await fixture(0);
  const result = await publishMetadataBase(empty.source, empty.backend, request);
  expect(result.outcome).toBe('published');
  if (result.outcome === 'published')
    expect(result.generation[8]).toEqual([
      ['empty', 'data'],
      ['empty', 'state'],
    ]);
  expect(empty.save).toHaveBeenCalledTimes(1);
  const f = await fixture(),
    first = await publishMetadataBase(f.source, f.backend, request);
  if (first.outcome !== 'published') throw new Error('fixture');
  const source = await MetadataPublicationSource.capture(f.store, '', { budget: f.budget });
  sources.push(source);
  const before = f.store.root.work.renames;
  const choices = first.generation[8].map((e) =>
    e[0] === 'object' ? (['reuse', e[1], e[2]] as const) : (['empty', e[1]] as const),
  );
  expect((await publishMetadataBase(source, f.backend, { ...request, choices })).outcome).toBe(
    'published',
  );
  expect(f.store.root.work.renames).toBe(before);
  expect(f.save).toHaveBeenCalledTimes(4);
});
it('does not delete unknown shell contents or publish after source shell cleanup fails', async () => {
  const f = await fixture();
  f.save.mockImplementation(async (_paths, _key, options) => {
    await writeFile(options!.archiveRoot! + '/unknown', 'retain');
    return 1;
  });
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow(
    'Staging cleanup failed',
  );
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
});
it('keeps relocation/return work fixed as descendants grow, charging capture, native SDK archives and cleanup separately', async () => {
  const results = [];
  for (const count of [4, 32]) {
    const f = await fixture(count),
      sdk = await nativeCacheBackend(),
      captured = { ...f.store.root.work },
      codecBefore = { ...recordEncodingWork };
    let inputControlBytes = 0;
    const save = sdk.backend.saveCache.bind(sdk.backend);
    sdk.backend.saveCache = async (paths, key, options) => {
      for (const file of paths)
        if (file.endsWith('.json')) inputControlBytes += (await stat(file)).size;
      return save(paths, key, options);
    };
    await publishMetadataBase(f.source, sdk.backend, request);
    expect(f.timingLogs.filter((s) => s.includes('Started base SDK save'))).toHaveLength(2);
    expect(f.timingLogs.filter((s) => s.includes('Started partition staging'))).toHaveLength(2);
    expect(f.timingLogs).toHaveLength(20);
    await f.source.dispose();
    const codec = Object.fromEntries(
      Object.entries(recordEncodingWork).map(([k, v]) => [
        k,
        v - codecBefore[k as keyof typeof codecBefore],
      ]),
    );
    const after = f.store.root.work,
      operation = Object.fromEntries(
        Object.keys(after).map((k) => [
          k,
          after[k as keyof typeof after] - captured[k as keyof typeof captured],
        ]),
      );
    const controls = [];
    let compressedArchiveBytes = 0;
    for (const call of sdk.calls) {
      expect(call.kind).toBe('save');
      const root = call.paths[0].startsWith('envelope') ? 'object' : 'record';
      controls.push({
        root,
        inputPaths: call.paths.length,
        resolvedArchiveRoots: call.members?.length ?? 0,
      });
    }
    for (const object of sdk.objects.values())
      compressedArchiveBytes += (await stat(object.directory + '/cache.tgz')).size;
    const sdkWork = {
      calls: sdk.calls.length,
      inputRegularFiles: 3 * count + 3,
      inputPayloadBytes: Array.from(
        { length: count },
        (_, i) =>
          Buffer.byteLength('data-' + i) +
          Buffer.byteLength('cache-' + i) +
          Buffer.byteLength('state-' + i),
      ).reduce((a, b) => a + b, 0),
      compressedArchiveBytes,
      inputControlBytes,
      controls,
    };
    results.push({
      count,
      initialCapture: f.initialCapture,
      captureCodec: f.captureCodec,
      publicationAndSourceRelease: operation,
      codec,
      sdk: sdkWork,
    });
    expect(operation.nativeWalks).toBe(0);
    expect(operation.nativeListings).toBe(0);
    expect(operation.bodyHashBytes).toBe(0);
    expect(operation.renames).toBe(6);
    expect(operation.cleanupListings).toBe(0);
    expect(sdkWork.calls).toBe(3);
    expect(compressedArchiveBytes).toBeGreaterThan(0);
  }
  expect(results[0].publicationAndSourceRelease.stats).toBe(
    results[1].publicationAndSourceRelease.stats,
  );
  expect(results[0].publicationAndSourceRelease.directoryCreations).toBe(
    results[1].publicationAndSourceRelease.directoryCreations,
  );
  await writeFile('build/ls3-publication-counts.json', JSON.stringify(results, null, 2) + '\n');
});
it('selects independent snapshot metadata/roots while leaving the live snapshot untouched', async () => {
  const f = await fixture(),
    root = f.store.prefix + 'snapshots/independent';
  await f.files(root, { 'state/shared/0': 'retained-snapshot', 'state/authoritative-empty': null });
  const snapshot = await MetadataPublicationSource.capture(f.store, root, { budget: f.budget });
  sources.push(snapshot);
  const selected = MetadataPublicationSet.select(f.source, [['state', snapshot]]),
    before = f.store.root.work.nativeWalks;
  expect(selected.summary('state')).toEqual(snapshot.summary('state'));
  expect(selected.summary('state')).not.toEqual(f.source.summary('state'));
  f.save.mockImplementation(async (paths) => {
    if (paths.length === 2 && JSON.parse(await readFile(paths[0], 'utf8'))[3][2] === 'state') {
      expect(await readFile(paths[1] + '/state/shared/0', 'utf8')).toBe('retained-snapshot');
      expect(await readFile(f.store.root.resolve('state/shared/0'), 'utf8')).toBe('state-0');
      expect(await f.store.root.stat(root + '/state')).toBeNull();
    }
    return 1;
  });
  expect((await publishMetadataBase(selected, f.backend, request)).outcome).toBe('published');
  expect(f.store.root.work.nativeWalks).toBe(before);
  expect(await readFile(f.store.root.resolve(root + '/state/shared/0'), 'utf8')).toBe(
    'retained-snapshot',
  );
  expect(await readFile(f.store.root.resolve('state/shared/0'), 'utf8')).toBe('state-0');
});
it('folds candidate coordinate groups across selected physical sources, excluding stale live snapshot metadata', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['repository/**/data'], hard, 'aggregate', null, 'default'],
          ['state', ['repository/**/state'], hard, 'single-writer', 'A', 'default'],
        ],
      ],
      'metadata-groups-',
      1,
    ),
    f = await installFixture('maven', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  await f.files('', {
    'repository/g/parent/data': 'a',
    'repository/g/parent/child/data': 'b',
    'repository/a/sub/data': 'punctuation',
    'repository/a-b/data': 'sibling',
    'repository/stale/state': 'stale',
  });
  const root = f.store.prefix + 'snapshots/independent';
  await f.files(root, {
    'repository/g/snapshot/child/state': 'independent',
    'repository/a/sub/state': 'cross-source-punctuation',
    'repository/other/state': 'other',
  });
  const live = await MetadataPublicationSource.capture(f.store, '', { budget: f.budget }),
    snapshot = await MetadataPublicationSource.capture(f.store, root, { budget: f.budget });
  sources.push(live, snapshot);
  const save = vi.fn<BaseCacheBackend['saveCache']>(async () => 1),
    backend: BaseCacheBackend = {
      capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
      isFeatureAvailable: () => true,
      saveCache: save,
      restoreCache: async () => undefined,
      isMissingPathsError: () => false,
    };
  const result = await publishMetadataBase(
    MetadataPublicationSet.select(live, [['state', snapshot]]),
    backend,
    request,
  );
  if (result.outcome !== 'published') throw new Error('fixture');
  expect(result.generation[9]).toEqual([['data', 'state']]);
  expect(await readFile(f.store.root.resolve('repository/stale/state'), 'utf8')).toBe('stale');
  expect(
    await readFile(f.store.root.resolve(root + '/repository/g/snapshot/child/state'), 'utf8'),
  ).toBe('independent');
});
it('rejects copied or revoked source-set owners without a rewalk or source mutation', async () => {
  const f = await fixture(),
    walks = f.store.root.work.nativeWalks;
  const fake = Object.assign(
    Object.create(MetadataPublicationSource.prototype),
    f.source,
  ) as MetadataPublicationSource;
  expect(() => MetadataPublicationSet.select(f.source, [['state', fake]])).toThrow('unbound');
  const set = MetadataPublicationSet.select(f.source);
  await f.source.dispose();
  await expect(publishMetadataBase(set, f.backend, request)).rejects.toThrow('Closed');
  expect(f.store.root.work.nativeWalks).toBe(walks);
  expect(f.save).not.toHaveBeenCalled();
});

it.each(['null', 'throw', 'lost'] as const)(
  'abandons unconfirmed second object %s after returning both source sets',
  async (mode) => {
    const f = await fixture();
    let calls = 0;
    f.save.mockImplementation(async () => {
      if (++calls === 1) return 1;
      if (mode !== 'null') throw new Error(mode);
      return null as unknown as number;
    });
    expect((await publishMetadataBase(f.source, f.backend, request)).outcome).toBe('abandoned');
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.lookup).not.toHaveBeenCalled();
    for (const p of ['data', 'cache', 'state'])
      expect(await readFile(f.store.root.resolve(p + '/shared/0'), 'utf8')).toBe(p + '-0');
  },
);
it('owns partial evacuation before cancellation and returns earlier independent roots', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await f.source.dispose();
  const source = await MetadataPublicationSource.capture(f.store, '', {
    budget: f.budget,
    signal: controller.signal,
  });
  sources.push(source);
  vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'metadata-source-evacuated')
      controller.abort(new Error('cancelled mid-evacuation'));
  });
  await expect(publishMetadataBase(source, f.backend, request)).rejects.toThrow(
    'cancelled mid-evacuation',
  );
  expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
  expect(await readFile(f.store.root.resolve('cache/shared/0'), 'utf8')).toBe('cache-0');
  expect(f.save).not.toHaveBeenCalled();
});
it('resolves success-then-after-stat failures on the reverse attempt without losing return ownership', async () => {
  const f = await fixture(),
    rename = f.store.root.renameAbsent.bind(f.store.root);
  let calls = 0;
  vi.spyOn(f.store.root, 'renameAbsent').mockImplementation(async (...args) => {
    const result = await rename(...args);
    if (++calls <= 2) throw new Error('after stat failed');
    return result;
  });
  await expect(publishMetadataBase(f.source, f.backend, request)).rejects.toThrow(
    'after stat failed',
  );
  expect(await readFile(f.store.root.resolve('data/shared/0'), 'utf8')).toBe('data-0');
  expect(await readFile(f.store.root.resolve('cache/shared/0'), 'utf8')).toBe('cache-0');
  expect(f.save).not.toHaveBeenCalled();
});
it('rechecks outgoing eligibility before evacuating a later object', async () => {
  const f = await fixture(),
    moves = vi.spyOn(f.store.root, 'renameAbsent');
  let available = true;
  f.backend.canConfirmSave = () => available;
  f.save.mockImplementation(async () => {
    available = false;
    return 1;
  });
  expect((await publishMetadataBase(f.source, f.backend, request)).outcome).toBe('abandoned');
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(moves).toHaveBeenCalledTimes(4);
  expect(await readFile(f.store.root.resolve('state/shared/0'), 'utf8')).toBe('state-0');
});
