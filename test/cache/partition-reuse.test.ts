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

import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { Hash } from 'node:crypto';
import * as fileIO from '../../src/util/fs';
import type * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { CutoffArtifacts } from '../support/cutoff-artifacts';
import { writeKotlinWorkspace } from '../support/kotlin-cache';
import { writeTransformWorkspace } from '../support/transform-cache';
import * as installInventory from '../../src/cache/install-inventory';
import * as metadataIO from '../../src/cache/metadata-io';
import { writeGroovyWorkspace } from '../support/groovy-cache';
import { cutoffJob } from '../support/cutoff-job';
import { ImmutableCacheBackend } from '../support/immutable-cache-backend';
import { executeCutoffPrepareAction } from '../../src/phases/prepare/cutoff-flow';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { GENERATION_RECORD_PATH, type GenerationRecord } from '../../src/cache/partition-format';
import * as guarded from '../../src/cache/guarded-files';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(partitionDefinitions?: object[], tool = 'test') {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/partition-reuse-'));
  roots.push(root);
  const backend = new ImmutableCacheBackend(path.join(root, 'archives'));
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  const definitions = partitionDefinitions ?? [
    { id: 'data', includes: [] },
    ...['a', 'b', 'c'].map((id) => ({ id, includes: [`${id}/**`] })),
  ];
  async function job(name: string, extra: Record<string, string> = {}) {
    const j = await cutoffJob(path.join(root, name), {
      cacheBackend: backend,
      artifactBackend: artifacts,
      inputs: { 'cache-partitions': JSON.stringify(definitions), 'cache-gc-mode': 'off', ...extra },
    });
    j.adapter.getBuildToolId = () => tool;
    return {
      ...j,
      prepare: () => executeCutoffPrepareAction({ ...j.deps, now: () => Date.now() + 1 }),
    };
  }
  return { root, backend, artifacts, job };
}
type Job = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['job']>>;
async function put(job: Job, name: string, value: string) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await mkdir(path.dirname(path.join(job.home, name)), { recursive: true });
  await writeFile(path.join(job.home, name), value);
}
function record(backend: ImmutableCacheBackend): GenerationRecord {
  const entry = [...backend.entries]
    .reverse()
    .find((e) => e.files.some((f) => f.name === GENERATION_RECORD_PATH))!;
  return JSON.parse(entry.files.find((f) => f.name === GENERATION_RECORD_PATH)!.bytes.toString());
}
it('real archives seed independently, save only changed A, reuse B/C, and perform no-op finalize', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/one', 'A');
  await put(seed, 'b/two', 'B'.repeat(113));
  await put(seed, 'c/three', 'C'.repeat(507));
  expect((await executeFinalizeAction(seed.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  const first = record(f.backend);
  expect(f.backend.savedKeys).toHaveLength(4);
  const next = await f.job('next');
  await next.prepare();
  await expect(lstat(path.join(next.home, 'a/.mammoth'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(next.home, 'b/two'), 'utf8')).toBe('B'.repeat(113));
  await put(next, 'a/one', 'new A');
  const copy = vi.spyOn(guarded, 'copyGuardedFile');
  const before = f.backend.transfers.length;
  expect((await executeFinalizeAction(next.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  const transfers = f.backend.transfers.slice(before);
  expect(transfers.filter((t) => t.operation === 'save')).toHaveLength(2);
  expect(
    transfers
      .filter((t) => t.operation === 'save')
      .flatMap((t) => t.members)
      .some((n) => /^(?:b|c)\//.test(n)),
  ).toBe(false);
  expect(copy.mock.calls.some(([, name]) => name.startsWith('b/') || name.startsWith('c/'))).toBe(
    false,
  );
  expect(transfers.filter((t) => t.operation === 'restore')).toEqual([]);
  expect(record(f.backend).partitions.slice(1)).toEqual(first.partitions.slice(1));
  copy.mockRestore();
  const last = await f.job('last');
  await last.prepare();
  const count = f.backend.savedKeys.length;
  expect((await executeFinalizeAction(last.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
  expect(f.backend.savedKeys).toHaveLength(count);
});
it('recovers A/C when B expires, then seeds only rebuilt B', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  for (const id of ['a', 'b', 'c']) await put(seed, `${id}/file`, id.repeat(30));
  await executeFinalizeAction(seed.deps);
  const first = record(f.backend),
    b = first.partitions[1]!;
  if (b.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(b.reference.key);
  const next = await f.job('partial'),
    prep = await next.prepare();
  expect(prep.bootstrap.baseCacheResult?.status).toBe('current-lineage-partial-hit');
  expect(await readFile(path.join(next.home, 'a/file'), 'utf8')).toBe('a'.repeat(30));
  await expect(lstat(path.join(next.home, 'b/file'))).rejects.toMatchObject({ code: 'ENOENT' });
  await put(next, 'b/file', 'rebuilt B');
  const before = f.backend.savedKeys.length;
  expect((await executeFinalizeAction(next.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(f.backend.savedKeys.slice(before)).toHaveLength(2);
  const second = record(f.backend);
  expect(second.partitions[0]).toEqual(first.partitions[0]);
  expect(second.partitions[2]).toEqual(first.partitions[2]);
});
it('publishes an external deletion with GC disabled and restores explicit empty without old fallback', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'old');
  await executeFinalizeAction(seed.deps);
  const next = await f.job('remove');
  await next.prepare();
  await rm(path.join(next.home, 'a/file'));
  const before = f.backend.savedKeys.length;
  expect((await executeFinalizeAction(next.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(f.backend.savedKeys.slice(before)).toHaveLength(1);
  expect(record(f.backend).partitions.every((p) => p.kind === 'empty')).toBe(true);
  const last = await f.job('empty'),
    prep = await last.prepare();
  expect(prep.bootstrap.baseCacheResult?.status).toBe('current-lineage-hit');
  await expect(lstat(path.join(last.home, 'a/file'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('never publishes a record after partial upload and retries frozen object identities', async () => {
  const f = await fixture(),
    seed = await f.job('retry');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  const save = f.backend.saveCache.bind(f.backend);
  let fail = true;
  vi.spyOn(f.backend, 'saveCache').mockImplementation(async (...args) => {
    if (fail && args[1].includes('-partition-b-')) throw new Error('upload B failed');
    return save(...args);
  });
  expect((await executeFinalizeAction(seed.deps)).bootstrap.baseCacheResult?.status).toBe('failed');
  expect(
    f.backend.entries.some((e) => e.files.some((file) => file.name === GENERATION_RECORD_PATH)),
  ).toBe(false);
  const aKey = f.backend.savedKeys[0];
  fail = false;
  expect((await executeFinalizeAction(seed.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(f.backend.savedKeys.filter((key) => key === aKey)).toHaveLength(1);
  const before = f.backend.savedKeys.length;
  await executeFinalizeAction(seed.deps);
  expect(f.backend.savedKeys).toHaveLength(before);
});

it('retains staging for same-invocation retry and reclaims it when fresh prepare supersedes the journal', async () => {
  const f = await fixture(),
    job = await f.job('abandoned');
  await job.prepare();
  await put(job, 'a/file', 'payload');
  const spy = vi.spyOn(f.backend, 'saveCache').mockRejectedValue(new Error('offline'));
  expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe('failed');
  const stateModule = await import('../../src/cache/cutoff-state');
  const lifecycle = await import('../../src/phases/cutoff-lifecycle');
  const rec = lifecycle.readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!rec.cacheEnabled) throw new Error('enabled');
  const staging = path.join(job.home, '.mammoth/cutoff-state-v2', `publication-${rec.invocation}`);
  expect((await lstat(staging)).isDirectory()).toBe(true);
  const frozen = await stateModule.loadCutoffJournal(
    rec.model,
    stateModule.cutoffJournalPath(rec.invocation),
  );
  expect(frozen.publicationPlan).not.toBeNull();
  spy.mockRestore();
  await job.prepare();
  await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['object', 'record'])(
  'confirms ambiguous concurrent %s saves by full exact readback',
  async (which) => {
    const f = await fixture(),
      job = await f.job('concurrent');
    await job.prepare();
    await put(job, 'a/file', 'payload');
    const save = f.backend.saveCache.bind(f.backend);
    vi.spyOn(f.backend, 'saveCache').mockImplementation(async (...args) => {
      const id = await save(...args);
      return (which === 'record') === args[1].includes('-gen-') ? -1 : id;
    });
    expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
    expect(
      f.backend.transfers.some(
        (t) => t.operation === 'restore' && (which === 'record') === t.key.includes('-gen-'),
      ),
    ).toBe(true);
  },
);
it('keeps explicit emptiness distinct from missing objects and all-object loss', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await executeFinalizeAction(seed.deps);
  const a = record(f.backend).partitions[0]!;
  if (a.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(a.reference.key);
  const partial = await f.job('empty-plus-missing');
  const result = (await partial.prepare()).bootstrap.baseCacheResult;
  expect(result?.status).toBe('current-lineage-partial-hit');
  if (result?.operation !== 'restore') throw new Error('restore');
  expect(result.partitionResults?.map((p) => p.status)).toEqual(['missing', 'empty', 'empty']);
  const all = await fixture([
    { id: 'data', includes: [] },
    { id: 'a', includes: ['a/**'] },
  ]);
  const one = await all.job('one');
  await one.prepare();
  await put(one, 'a/file', 'A');
  await executeFinalizeAction(one.deps);
  const ref = record(all.backend).partitions[0]!;
  if (ref.kind !== 'object') throw new Error('object');
  all.backend.unavailableKeys.add(ref.reference.key);
  const missing = (await (await all.job('all-missing')).prepare()).bootstrap.baseCacheResult;
  expect(missing?.status).toBe('miss');
  if (missing?.operation !== 'restore') throw new Error('restore');
  expect(missing.matchedKey).toBeNull();
  expect(missing.selectedRecordKey).not.toBeNull();
});
it('recovers connected Maven marker/artifact partitions together while keeping unrelated payload', async () => {
  const f = await fixture(
    [
      { id: 'data', includes: [] },
      { id: 'jars', includes: ['repository/**'], excludes: ['**/_remote.repositories'] },
      { id: 'origins', includes: ['repository/**'], excludes: ['**/*.jar'] },
      { id: 'other', includes: ['other/**'] },
    ],
    'maven',
  );
  const seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'repository/g/a/1/a.jar', 'artifact');
  await put(seed, 'repository/g/a/1/_remote.repositories', 'a.jar>central=\n');
  await put(seed, 'other/file', 'keep');
  expect((await executeFinalizeAction(seed.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  const first = record(f.backend);
  expect(first.recoveryGroups).toContainEqual(['jars', 'origins']);
  const origin = first.partitions.find((p) => p.partitionId === 'origins')!;
  if (origin.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(origin.reference.key);
  const next = await f.job('partial');
  const prep = (await next.prepare()).bootstrap.baseCacheResult;
  expect(prep?.status).toBe('current-lineage-partial-hit');
  await expect(lstat(path.join(next.home, 'repository/g/a/1/a.jar'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(path.join(next.home, 'other/file'), 'utf8')).toBe('keep');
});
it('saves only a changed Groovy partition and recovers another after object eviction', async () => {
  const ka = 'a'.repeat(32),
    kb = 'b'.repeat(32);
  const f = await fixture(
    [
      { id: 'data', includes: [] },
      { id: 'ga', includes: [`caches/*/groovy-dsl/${ka}/**`] },
      { id: 'gb', includes: [`caches/*/groovy-dsl/${kb}/**`] },
    ],
    'gradle',
  );
  const seed = await f.job('seed');
  await seed.prepare();
  await writeGroovyWorkspace(seed.home, ka, 'A');
  await writeGroovyWorkspace(seed.home, kb, 'B');
  await executeFinalizeAction(seed.deps);
  const first = record(f.backend),
    next = await f.job('next');
  await next.prepare();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeGroovyWorkspace(next.home, ka, 'A2');
  const before = f.backend.savedKeys.length;
  expect((await executeFinalizeAction(next.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(f.backend.savedKeys.slice(before)).toHaveLength(2);
  expect(record(f.backend).partitions[1]).toEqual(first.partitions[1]);
  const ga = record(f.backend).partitions[0]!;
  if (ga.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(ga.reference.key);
  const partial = await f.job('partial');
  expect((await partial.prepare()).bootstrap.baseCacheResult?.status).toBe(
    'current-lineage-partial-hit',
  );
  expect(
    await readFile(path.join(partial.home, `caches/9.8.1/groovy-dsl/${kb}/metadata.bin`), 'utf8'),
  ).toBe('origin-B');
  await expect(
    lstat(path.join(partial.home, `caches/9.8.1/groovy-dsl/${ka}`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
it('treats a missing single-writer snapshot as cold and preserves another snapshot', async () => {
  const f = await fixture([
    { id: 'data', includes: [] },
    { id: 'a', includes: ['a/**'], publication: 'single-writer' },
    { id: 'b', includes: ['b/**'], publication: 'single-writer' },
  ]);
  const seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const first = record(f.backend),
    a = first.partitions[0]!;
  if (a.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(a.reference.key);
  const partial = await f.job('partial');
  expect((await partial.prepare()).bootstrap.baseCacheResult?.status).toBe(
    'current-lineage-partial-hit',
  );
  await expect(lstat(path.join(partial.home, 'a/file'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(partial.home, 'b/file'), 'utf8')).toBe('B');
  await put(partial, 'a/file', 'rebuilt');
  const before = f.backend.savedKeys.length;
  await executeFinalizeAction(partial.deps);
  expect(record(f.backend).partitions[1]).toEqual(first.partitions[1]);
  expect(f.backend.savedKeys.slice(before)).toHaveLength(2);
});
it('preserves default-branch object identities when a feature publishes its own generation', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const original = record(f.backend);
  const feature = await f.job('feature');
  Object.assign(feature.ci, { resolvedRefName: 'feature', safeRefName: 'feature' });
  expect((await feature.prepare()).bootstrap.baseCacheResult?.status).toBe('fallback-lineage-hit');
  await put(feature, 'a/file', 'feature A');
  await executeFinalizeAction(feature.deps);
  const newer = record(f.backend);
  expect(newer.partitions[1]).toEqual(original.partitions[1]);
  const repeat = await f.job('repeat');
  Object.assign(repeat.ci, { resolvedRefName: 'feature', safeRefName: 'feature' });
  expect((await repeat.prepare()).bootstrap.baseCacheResult?.status).toBe('current-lineage-hit');
});

it('read-only partial restore does no save-oriented finalize work', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const b = record(f.backend).partitions[1]!;
  if (b.kind !== 'object') throw new Error('object');
  f.backend.unavailableKeys.add(b.reference.key);
  const reader = await f.job('reader', { 'read-only': 'true' });
  expect((await reader.prepare()).bootstrap.baseCacheResult?.status).toBe(
    'current-lineage-partial-hit',
  );
  const copy = vi.spyOn(guarded, 'copyGuardedFile'),
    save = vi.spyOn(f.backend, 'saveCache');
  expect((await executeFinalizeAction(reader.deps)).bootstrap.baseCacheResult?.status).toBe(
    'read-only',
  );
  expect(copy).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it('rejects size corruption before installing any downloaded partition', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const restore = f.backend.restoreCache.bind(f.backend);
  vi.spyOn(f.backend, 'restoreCache').mockImplementation(async (...args) => {
    const key = await restore(...args);
    if (key?.includes('-partition-b-'))
      await writeFile(path.join(args[3]!.archiveRoot!, 'b/file'), 'bad');
    return key;
  });
  const reader = await f.job('reader');
  await expect(reader.prepare()).rejects.toThrow(/size mismatch/);
  await expect(lstat(path.join(reader.home, 'a/file'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not accept a longer prefix match as an exact partition object', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await executeFinalizeAction(seed.deps);
  const restore = f.backend.restoreCache.bind(f.backend);
  vi.spyOn(f.backend, 'restoreCache').mockImplementation(async (...args) => {
    const key = await restore(...args);
    return key?.includes('-partition-a-') ? key + '-suffix' : key;
  });
  const reader = await f.job('reader');
  const result = (await reader.prepare()).bootstrap.baseCacheResult;
  expect(result?.status).toBe('current-lineage-partial-hit');
  await expect(lstat(path.join(reader.home, 'a/file'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails pinned cleanup if an originally available object disappears', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await executeFinalizeAction(seed.deps);
  const a = record(f.backend).partitions[0]!;
  if (a.kind !== 'object') throw new Error('object');
  const restore = f.backend.restoreCache.bind(f.backend);
  let seen = 0;
  vi.spyOn(f.backend, 'restoreCache').mockImplementation(async (...args) => {
    if (args[1] === a.reference.key && ++seen === 2) return undefined;
    return restore(...args);
  });
  const reader = await f.job('reader', { 'restore-cleanup-mode': 'prune-managed' });
  await expect(reader.prepare()).rejects.toThrow(/Pinned cache partition/);
});
it('does not publish a generation when a reused object expires before commit', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const b = record(f.backend).partitions[1]!;
  if (b.kind !== 'object') throw new Error('object');
  const next = await f.job('next');
  await next.prepare();
  await put(next, 'a/file', 'changed');
  f.backend.unavailableKeys.add(b.reference.key);
  const records = f.backend.entries.filter((e) => e.key.includes('-gen-')).length;
  expect((await executeFinalizeAction(next.deps)).bootstrap.baseCacheResult?.status).toBe('failed');
  expect(f.backend.entries.filter((e) => e.key.includes('-gen-'))).toHaveLength(records);
});
it('keeps a zero-active-partition cold run as a no-op', async () => {
  const f = await fixture([{ id: 'data', includes: [] }]),
    j = await f.job('empty');
  await j.prepare();
  expect((await executeFinalizeAction(j.deps)).bootstrap.baseCacheResult?.status).toBe(
    'not-required',
  );
  expect(f.backend.savedKeys).toEqual([]);
});
it('uploads only worker-changed A and a record while retaining B during aggregation', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await put(seed, 'b/file', 'B');
  await executeFinalizeAction(seed.deps);
  const first = record(f.backend),
    worker = await f.job('worker', { 'job-mode': 'distributed-worker' });
  await worker.prepare();
  await put(worker, 'a/file', 'worker A');
  const beforeWorker = f.backend.savedKeys.length;
  await executeFinalizeAction(worker.deps);
  await executeFinalizeAction(worker.deps);
  expect(f.artifacts.artifacts).toHaveLength(1);
  expect(f.backend.savedKeys).toHaveLength(beforeWorker);
  const aggregator = await f.job('aggregator', {
    'job-mode': 'distributed-aggregator',
    'dependent-jobs': 'build',
  });
  await aggregator.prepare();
  const before = f.backend.savedKeys.length;
  expect((await executeFinalizeAction(aggregator.deps)).bootstrap.baseCacheResult?.status).toBe(
    'saved',
  );
  expect(f.backend.savedKeys.slice(before)).toHaveLength(2);
  expect(record(f.backend).partitions[1]).toEqual(first.partitions[1]);
});

it('saves native ordinary paths without copying or linking and restores by rename', async () => {
  const f = await fixture(),
    seed = await f.job('native');
  await seed.prepare();
  await put(seed, 'a/deep/file', 'native payload');
  const fs = await import('node:fs/promises');
  const copy = vi.spyOn(guarded, 'copyGuardedFile'),
    link = vi.spyOn(fs, 'link');
  expect((await executeFinalizeAction(seed.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(copy).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(f.backend.entries.flatMap((e) => e.files).some((e) => e.name === 'a/deep/file')).toBe(
    true,
  );
  const rename = vi.spyOn(fs, 'rename'),
    reader = await f.job('native-reader');
  await reader.prepare();
  expect(copy).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(
    rename.mock.calls.some(
      ([from, to]) =>
        String(from).includes('/restore-staging/') &&
        String(to) === path.join(reader.home, 'a/deep/file'),
    ),
  ).toBe(true);
  expect(await readFile(path.join(reader.home, 'a/deep/file'), 'utf8')).toBe('native payload');
});
it.each(['positive', 'declined', 'thrown'])(
  'rejects live-source mutation during %s upload before publishing its record',
  async (outcome) => {
    const f = await fixture(),
      job = await f.job('mutating');
    await job.prepare();
    await put(job, 'a/file', 'original');
    const save = f.backend.saveCache.bind(f.backend);
    let changed = false;
    vi.spyOn(f.backend, 'saveCache').mockImplementation(async (...args) => {
      const id = await save(...args);
      if (!changed && args[1].includes('-partition-a-')) {
        changed = true;
        await writeFile(path.join(job.home, 'a/file'), 'mutated');
        if (outcome === 'thrown') throw new Error('ambiguous completion');
        return outcome === 'declined' ? -1 : id;
      }
      return id;
    });
    expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe(
      'failed',
    );
    expect(
      f.backend.entries.some((e) => e.files.some((file) => file.name === GENERATION_RECORD_PATH)),
    ).toBe(false);
    const lifecycle = await import('../../src/phases/cutoff-lifecycle'),
      stateModule = await import('../../src/cache/cutoff-state');
    const record = lifecycle.readCutoffLifecycle(job.deps.runtimeHost.getState);
    if (!record.cacheEnabled) throw new Error('enabled');
    const frozen = await stateModule.loadCutoffJournal(
      record.model,
      stateModule.cutoffJournalPath(record.invocation),
    );
    expect(frozen.phase).toBe('publication-intent');
    expect(frozen.saved).toBe(false);
    await expect(executeFinalizeAction(job.deps)).rejects.toThrow(/changed/);
    expect(
      (
        await stateModule.loadCutoffJournal(
          record.model,
          stateModule.cutoffJournalPath(record.invocation),
        )
      ).publicationKey,
    ).toBe(frozen.publicationKey);
  },
);

it('fresh prepare reclaims only owned abandoned restore extraction trees', async () => {
  const f = await fixture(),
    job = await f.job('interrupted');
  const base = path.join(job.home, '.mammoth/restore-staging');
  await mkdir(path.join(base, 'generation-Ab12Cd'), { recursive: true });
  await writeFile(path.join(base, 'generation-Ab12Cd/partial'), 'partial');
  await mkdir(path.join(base, 'unrelated'), { recursive: true });
  await writeFile(path.join(base, 'unrelated/keep'), 'keep');
  await job.prepare();
  await expect(lstat(path.join(base, 'generation-Ab12Cd'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(path.join(base, 'unrelated/keep'), 'utf8')).toBe('keep');
});

it('reads changed ordinary payload bytes only for descriptor creation and pre-upload verification', async () => {
  const f = await fixture(),
    job = await f.job('hash-passes');
  await job.prepare();
  await put(job, 'a/file', 'payload');
  const hash = vi.spyOn(guarded, 'hashGuardedFile');
  expect((await executeFinalizeAction(job.deps)).bootstrap.baseCacheResult?.status).toBe('saved');
  expect(
    hash.mock.calls.filter(([root, relative]) => root === job.home && relative === 'a/file'),
  ).toHaveLength(2);
});

it('base prepare trusts same-size bytes and performs zero payload hashes', async () => {
  const f = await fixture(),
    seed = await f.job('seed');
  await seed.prepare();
  await put(seed, 'a/file', 'A');
  await executeFinalizeAction(seed.deps);
  const object = f.backend.entries.find((e) => e.files.some((f) => f.name === 'a/file'))!;
  object.files.find((f) => f.name === 'a/file')!.bytes = Buffer.from('B');
  object.archive = undefined;
  const hashes = vi.spyOn(Hash.prototype, 'update');
  const fileHashes = vi.spyOn(fileIO, 'hashStableFileSha256');
  const reader = await f.job('hash-free');
  await reader.prepare();
  expect(hashes.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0);
  expect(fileHashes).not.toHaveBeenCalled();
  expect(await readFile(path.join(reader.home, 'a/file'), 'utf8')).toBe('B');
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'native workspaces use one inventory and whole-tree moves (EXDEV=%s, existing=%s)',
  async (crossDevice, existing) => {
    const f = await fixture(
      [
        { id: 'data', includes: [] },
        { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
        { id: 'kotlin-dsl', includes: ['caches/*/kotlin-dsl/**'] },
        { id: 'transforms-metadata', includes: ['caches/*/transforms/**'] },
      ],
      'gradle',
    );
    const seed = await f.job('native-seed');
    await seed.prepare();
    const names = [
      await writeGroovyWorkspace(seed.home),
      await writeKotlinWorkspace(seed.home),
      await writeTransformWorkspace(seed.home),
    ];
    // Establish already-correct portable modes independently of the developer's umask.
    const fixtureFS = await import('node:fs/promises');
    for (const entry of await fixtureFS.readdir(path.join(seed.home, 'caches'), {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile()) await fixtureFS.chmod(path.join(entry.parentPath, entry.name), 0o644);
    await executeFinalizeAction(seed.deps);
    const reader = await f.job('native-reader');
    if (existing) {
      await writeGroovyWorkspace(reader.home, undefined, 'old');
      await writeKotlinWorkspace(reader.home, undefined, undefined, 'old');
      await writeTransformWorkspace(reader.home, undefined, undefined, 'old');
      for (const name of names) await writeFile(path.join(reader.home, name, 'obsolete'), 'stale');
    }
    const fs = await import('node:fs/promises'),
      original = fs.rename;
    const renames = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (crossDevice && String(from).includes('/restore-staging/'))
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return original(from, to);
    });
    const modes = vi.spyOn(fs, 'chmod'),
      times = vi.spyOn(fs, 'utimes');
    const inventories = vi.spyOn(installInventory, 'inventoryInstallTree');
    const hashes = vi.spyOn(fileIO, 'hashStableFileSha256');
    const copies = vi.spyOn(Hash.prototype, 'update');
    const moves = vi.spyOn(guarded, 'moveGuardedFile');
    const metadata = vi.spyOn(metadataIO, 'writeMetadata');
    await reader.prepare();
    expect(inventories).toHaveBeenCalledTimes(3);
    expect(
      copies.mock.calls.filter(([data]) => {
        if (typeof data !== 'string' || !data.startsWith('{')) return false;
        return JSON.parse(data).kind === 'workspace';
      }),
    ).toHaveLength(3);
    expect(hashes).not.toHaveBeenCalled();
    expect(copies.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0);
    if (!crossDevice) {
      if (process.platform !== 'win32') expect(modes).not.toHaveBeenCalled();
      expect(times).not.toHaveBeenCalled();
      expect(moves).not.toHaveBeenCalled();
      expect(
        renames.mock.calls.filter(([from]) => String(from).includes('/restore-staging/')),
      ).toHaveLength(3);
    }
    expect(
      metadata.mock.calls.filter(([, name]) => name === '.mammoth/workspace-apply-v3/intent.json'),
    ).toHaveLength(existing ? 3 : 0);
    for (const name of names) {
      expect(await readFile(path.join(reader.home, name, 'metadata.bin'), 'utf8')).toBe(
        'origin-compiled',
      );
      await expect(lstat(path.join(reader.home, name, 'obsolete'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    expect((await lstat(path.join(reader.home, names[0]!, 'reports'))).isDirectory()).toBe(true);
    expect((await lstat(path.join(reader.home, names[1]!, 'reports/empty'))).isDirectory()).toBe(
      true,
    );
    expect(
      (await lstat(path.join(reader.home, names[2]!, 'transformed/empty'))).isDirectory(),
    ).toBe(true);
  },
);

it.each(['before', 'after'])(
  're-downloads a native workspace after interruption %s its fresh rename',
  async (when) => {
    const f = await fixture(
      [
        { id: 'data', includes: [] },
        { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
      ],
      'gradle',
    );
    const seed = await f.job('seed');
    await seed.prepare();
    const name = await writeGroovyWorkspace(seed.home);
    await executeFinalizeAction(seed.deps);
    const reader = await f.job('interrupted');
    const fs = await import('node:fs/promises'),
      original = fs.rename;
    let fail = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (
        fail &&
        String(from).includes('/restore-staging/') &&
        String(to) === path.join(reader.home, name)
      ) {
        fail = false;
        if (when === 'after') await original(from, to);
        throw new Error('interrupted native rename');
      }
      return original(from, to);
    });
    await expect(reader.prepare()).rejects.toThrow(/interrupted native rename/);
    if (when === 'after')
      expect(await readFile(path.join(reader.home, name, 'metadata.bin'), 'utf8')).toBe(
        'origin-compiled',
      );
    else
      await expect(lstat(path.join(reader.home, name))).rejects.toMatchObject({ code: 'ENOENT' });
    await reader.prepare();
    expect(await readFile(path.join(reader.home, name, 'metadata.bin'), 'utf8')).toBe(
      'origin-compiled',
    );
  },
);

it('rejects native workspace topology changes after the extraction inventory', async () => {
  const f = await fixture(
    [
      { id: 'data', includes: [] },
      { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
    ],
    'gradle',
  );
  const seed = await f.job('seed');
  await seed.prepare();
  const name = await writeGroovyWorkspace(seed.home);
  await executeFinalizeAction(seed.deps);
  const original = installInventory.inventoryInstallTree;
  vi.spyOn(installInventory, 'inventoryInstallTree').mockImplementation(async (...args) => {
    const inventory = await original(...args);
    if (args[0].includes('/restore-staging/'))
      await writeFile(path.join(args[0], name, 'surprise'), 'unexpected');
    return inventory;
  });
  const reader = await f.job('mutated-source');
  await expect(reader.prepare()).rejects.toThrow(/directory changed/);
  await expect(lstat(path.join(reader.home, name))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([false, true])(
  'production prepare consumes ordinary and all workspace kinds and retries partial consumption=%s',
  async (interrupt) => {
    const f = await fixture(
      [
        { id: 'data', includes: ['data/**'] },
        { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
        { id: 'kotlin-dsl', includes: ['caches/*/kotlin-dsl/**'] },
        { id: 'transforms-metadata', includes: ['caches/*/transforms/**'] },
      ],
      'gradle',
    );
    const worker = await f.job('worker', { 'job-mode': 'distributed-worker' });
    await worker.prepare();
    await put(worker, 'data/ordinary', 'ordinary');
    const names = [
      await writeGroovyWorkspace(worker.home),
      await writeKotlinWorkspace(worker.home),
      await writeTransformWorkspace(worker.home),
    ];
    await executeFinalizeAction(worker.deps);
    const aggregator = await f.job('aggregator', {
      'job-mode': 'distributed-aggregator',
      'dependent-jobs': 'build',
    });
    const original = guarded.moveGuardedFile;
    let consumed = 0,
      failed = false;
    vi.spyOn(guarded, 'moveGuardedFile').mockImplementation(async (...args) => {
      const result = await original(...args);
      await expect(lstat(path.join(args[0], args[1]))).rejects.toMatchObject({ code: 'ENOENT' });
      consumed++;
      if (interrupt && !failed) {
        failed = true;
        throw new Error('interrupted consumed worker');
      }
      return result;
    });
    const copy = vi.spyOn(guarded, 'copyGuardedFile');
    if (interrupt) {
      await expect(aggregator.prepare()).rejects.toThrow(/interrupted consumed worker/);
      for (const name of names)
        await expect(lstat(path.join(aggregator.home, name))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    }
    await aggregator.prepare();
    expect(copy).not.toHaveBeenCalled();
    expect(consumed).toBeGreaterThan(3);
    expect(await readFile(path.join(aggregator.home, 'data/ordinary'), 'utf8')).toBe('ordinary');
    for (const name of names)
      expect(await readFile(path.join(aggregator.home, name, 'metadata.bin'), 'utf8')).toBe(
        'origin-compiled',
      );
    expect(f.artifacts.downloads).toHaveLength(interrupt ? 2 : 1);
    for (const download of f.artifacts.downloads)
      await expect(lstat(download)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('rejects extra native staged members after the whole-tree staging rename', async () => {
  const f = await fixture(
    [
      { id: 'data', includes: [] },
      { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
    ],
    'gradle',
  );
  const seed = await f.job('seed');
  await seed.prepare();
  const name = await writeGroovyWorkspace(seed.home);
  await executeFinalizeAction(seed.deps);
  const reader = await f.job('staged-mutation');
  await writeGroovyWorkspace(reader.home, undefined, 'keep old');
  const fs = await import('node:fs/promises'),
    original = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await original(from, to);
    if (String(from).includes('/restore-staging/') && String(to).includes('/.mammoth/stage-'))
      await writeFile(path.join(String(to), 'surprise'), 'not in descriptor');
  });
  await expect(reader.prepare()).rejects.toThrow(/staging directory changed/);
  expect(await readFile(path.join(reader.home, name, 'metadata.bin'), 'utf8')).toBe(
    'origin-keep old',
  );
});

it('carries the one base snapshot inventory through journal model cloning and live initialization', async () => {
  const f = await fixture([
    { id: 'data', includes: [] },
    { id: 'metadata', includes: ['metadata/**'], publication: 'single-writer' },
  ]);
  const seed = await f.job('snapshot-seed');
  await seed.prepare();
  await put(seed, 'metadata/index', 'snapshot');
  await executeFinalizeAction(seed.deps);
  const inventories = vi.spyOn(installInventory, 'inventoryInstallTree');
  const reader = await f.job('snapshot-reader');
  await reader.prepare();
  expect(inventories).toHaveBeenCalledTimes(1);
  expect(await readFile(path.join(reader.home, 'metadata/index'), 'utf8')).toBe('snapshot');
});

it.each([false, true])(
  'directory inventory visits scale with total workspace directories (existing=%s)',
  async (existing) => {
    const visits: number[] = [];
    for (const count of [2, 8, 32]) {
      const f = await fixture(
        [
          { id: 'data', includes: [] },
          { id: 'groovy-dsl', includes: ['caches/*/groovy-dsl/**'] },
        ],
        'gradle',
      );
      const seed = await f.job('directory-seed');
      await seed.prepare();
      for (let i = 0; i < count; i++)
        await writeGroovyWorkspace(seed.home, i.toString(16).padStart(32, '0'));
      await executeFinalizeAction(seed.deps);
      const reader = await f.job('directory-reader');
      if (existing)
        for (let i = 0; i < count; i++)
          await writeGroovyWorkspace(reader.home, i.toString(16).padStart(32, '0'), 'old');
      let directoryVisits = 0;
      const observe = (value: unknown) => {
        // Count actual directory identities yielded, including the workspace indexes.
        if (
          value &&
          typeof value === 'object' &&
          'mode' in value &&
          typeof value.mode === 'number' &&
          (value.mode & 0o170000) === 0o040000
        )
          directoryVisits++;
      };
      const originalIterator = Map.prototype[Symbol.iterator],
        originalEntries = Map.prototype.entries,
        originalKeys = Map.prototype.keys;
      const iterator = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
        this: Map<unknown, unknown>,
      ) {
        for (const entry of originalIterator.call(this)) {
          observe(entry[1]);
          yield entry;
        }
        return undefined;
      });
      const entries = vi.spyOn(Map.prototype, 'entries').mockImplementation(function* (
        this: Map<unknown, unknown>,
      ) {
        for (const entry of originalEntries.call(this)) {
          observe(entry[1]);
          yield entry;
        }
        return undefined;
      });
      const keys = vi.spyOn(Map.prototype, 'keys').mockImplementation(function* (
        this: Map<unknown, unknown>,
      ) {
        for (const key of originalKeys.call(this)) {
          observe(this.get(key));
          yield key;
        }
        return undefined;
      });
      try {
        await reader.prepare();
      } finally {
        iterator.mockRestore();
        entries.mockRestore();
        keys.mockRestore();
      }
      visits.push(directoryVisits);
      expect(
        await readFile(
          path.join(reader.home, `caches/9.8.1/groovy-dsl/${'0'.repeat(32)}/metadata.bin`),
          'utf8',
        ),
      ).toBe('origin-compiled');
    }
    expect(visits[0]).toBeGreaterThan(0);
    // Four times the workspaces may visit four times their directories, plus fixed ancestors.
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i]).toBeGreaterThan(visits[i - 1]!);
      expect(visits[i]).toBeLessThanOrEqual(4 * visits[i - 1]!);
    }
  },
);
