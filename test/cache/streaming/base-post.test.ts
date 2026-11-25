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
import { readFile } from 'node:fs/promises';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import { postStreamingBase, type BasePostRequest } from '../../../src/cache/streaming/base-post';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { NativeRoot } from '../../../src/cache/streaming/native';
import { resolveModel } from '../../../src/cache/streaming/model';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { gradleResolver } from './quiescence-fixture';
const fixtures: MetadataFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(model?: Parameters<typeof metadataFixture>[0]) {
  const f = await metadataFixture(model);
  fixtures.push(f);
  return f;
}
function post(
  f: MetadataFixture,
  anchor: BasePostRequest['anchor'],
  options: Partial<BasePostRequest> = {},
) {
  return postStreamingBase({
    anchor,
    budget: f.budget,
    cacheBackend: async () => f.api,
    removeHooks: async () => {},
    assertCurrent: (): undefined => {},
    ...options,
  });
}
it('completes actual prepare/build/native return/record publication and reads only terminal data on a second post', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'body' });
  const logs: string[] = [];
  const result = await post(f, ready.anchor, {
    timing: { now: () => 0, info: (s) => logs.push(s) },
  });
  for (const label of [
    'required quiescence',
    'observation capture and index construction',
    'GC',
    'base publication',
    'partition staging',
    'generation SDK save',
    'source return',
  ]) {
    expect(logs.some((s) => s.includes('Finished ' + label))).toBe(true);
  }
  expect(result.outcome).toBe('published');
  expect(result.key).toBeTruthy();
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('body');
  const backend = vi.fn(async () => f.api),
    hooks = vi.fn(async () => {});
  expect(await post(f, ready.anchor, { cacheBackend: backend, removeHooks: hooks })).toEqual(
    result,
  );
  expect(backend).not.toHaveBeenCalled();
  expect(hooks).not.toHaveBeenCalled();
  const opened = await OpenedInvocation.open(ready.anchor, f.budget);
  expect(opened.state).toHaveLength(8);
  expect(opened.state[7]).toEqual(['outcome', 'published', result.key, null, null]);
});
it('reuses exact prior choices without saves on a fresh invocation', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'body' });
  const first = await post(f, ready.anchor);
  const next = await f.prepare({ nonce: 'b'.repeat(32), root: f.directory + '/fresh' }),
    before = f.save.mock.calls.length;
  const logs: string[] = [];
  expect(await post(f, next.anchor, { timing: { info: (s) => logs.push(s) } })).toEqual({
    outcome: 'no-change',
    key: first.key,
  });
  expect(logs.some((s) => s.includes('(reuse)'))).toBe(true);
  expect(logs.some((s) => s.includes('SDK save'))).toBe(false);
  expect(f.save).toHaveBeenCalledTimes(before);
});
it.each([
  [4, 3],
  [24, 3],
  [4, 24],
])(
  'folds warm Maven survivors once with %i shared coordinates and %i files per partition',
  async (units, width) => {
    const hard = ['.mammoth/**', '**/*.lock'],
      partitions = ['a', 'b'],
      model = resolveModel(
        [
          'model',
          1,
          'maven',
          hard,
          ['a', 'empty', 'b'].map((id) => [
            id,
            [`repository/**/${id}*.jar`],
            hard,
            'aggregate',
            null,
            'default',
            0,
          ]),
        ],
        'survivor-work-',
        1,
      );
    const f = await fixture(model),
      initial = await f.prepare();
    for (let unit = 0; unit < units; unit++) {
      const parent = `repository/group/unit-${unit}/0-version/`;
      const files: Record<string, string> = { [parent + 'keep.lock']: 'protected' };
      for (const id of partitions)
        for (let file = 0; file < width; file++) files[`${parent}${id}${file}.jar`] = 'dependency';
      await f.files(f.root, files);
    }
    // Direct files must precede the lexically earlier subdirectory in the summary.
    await f.files(f.root, {
      'repository/group/unit-0/a-direct.jar': 'dependency',
      'repository/group/unit-0/b-direct.jar': 'dependency',
    });
    const first = await post(f, initial.anchor);
    expect(first.outcome).toBe('published');
    const fresh = f.directory + '/fresh';
    for (let unit = 0; unit < units; unit++)
      await f.files(fresh, { [`repository/group/unit-${unit}/0-version/keep.lock`]: 'protected' });
    const saves = f.save.mock.calls.length,
      next = await f.prepare({ nonce: 'b'.repeat(32), root: fresh });
    const directories = 3 + units * 2, // root, repository, group, and two directories per coordinate
      filesPerPartition = units * width + 1,
      files = filesPerPartition * partitions.length,
      projectedChildren = directories - 1 + files + units + 1; // includes keep.lock and .mammoth
    const realFold = MetadataPublicationSource.survivors;
    const fold = vi
      .spyOn(MetadataPublicationSource, 'survivors')
      .mockImplementation(async (owner) => {
        const work = owner.index.store.root.work,
          before = { ...work },
          children = vi.spyOn(ObservationIndex.prototype, 'children'),
          lookup = vi.spyOn(ObservationIndex.prototype, 'directory');
        const source = await realFold(owner);
        try {
          for (const id of partitions) expect(source.summary(id)[3]).toBe(filesPerPartition);
          expect(source.summary('empty').slice(3)).toEqual([0, 0, 0]);
          expect(children).toHaveBeenCalledTimes(directories);
          expect(lookup).not.toHaveBeenCalled();
          expect(work.metadataRowsRead - before.metadataRowsRead).toBe(
            directories + files + projectedChildren,
          );
          for (const counter of [
            'stats',
            'nativeWalks',
            'indexBuilds',
            'scratchLogicalWriteBytes',
            'renames',
            'unlinks',
          ] as const)
            expect(work[counter], counter).toBe(before[counter]);
          return source;
        } catch (error) {
          await source.dispose();
          throw error;
        }
      });
    const logs: string[] = [];
    expect(await post(f, next.anchor, { timing: { info: (s) => logs.push(s) } })).toEqual({
      outcome: 'no-change',
      key: first.key,
    });
    expect(fold).toHaveBeenCalledTimes(1);
    for (const id of partitions)
      expect(logs).toContain(`Mammoth: partition publication [partition=${id}] (reuse).`);
    expect(logs.some((s) => s.includes('partition staging') || s.includes('source return'))).toBe(
      false,
    );
    expect(f.save).toHaveBeenCalledTimes(saves);
    expect(await readFile(fresh + '/repository/group/unit-0/0-version/keep.lock', 'utf8')).toBe(
      'protected',
    );
  },
);
it.each([
  'object-null',
  'object-throw',
  'object-lost',
  'record-null',
  'record-throw',
  'record-lost',
] as const)('abandons %s without discovery/readback/retry or a success receipt', async (kind) => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'body' });
  const save = f.save.getMockImplementation()!,
    boundary = kind.startsWith('object') ? 1 : 2;
  let calls = 0;
  f.save.mockImplementation(async (...args) => {
    if (++calls === boundary) {
      if (kind.endsWith('lost')) await save(...args);
      if (kind.endsWith('null')) return -1;
      throw new Error('outgoing response unavailable');
    }
    return save(...args);
  });
  const restores = f.restore.mock.calls.length,
    warning = vi.fn(),
    result = await post(f, ready.anchor, { onWarning: warning });
  expect(result).toEqual({ outcome: 'abandoned', key: null });
  expect(f.save).toHaveBeenCalledTimes(boundary);
  expect(f.restore).toHaveBeenCalledTimes(restores);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('body');
  const opened = await OpenedInvocation.open(ready.anchor, f.budget);
  expect(opened.state[7]).toEqual(['outcome', 'abandoned', null, null, null]);
});
it.each(['unavailable', 'unconfirmable'] as const)(
  'handles %s before evacuation or output-only snapshots',
  async (kind) => {
    const f = await fixture(),
      ready = await f.prepare();
    await f.files(f.root, { 'data/a': 'body' });
    const renamed = vi.spyOn(NativeRoot.prototype, 'renameAbsent'),
      warning = vi.fn();
    const api = {
      ...f.api,
      isFeatureAvailable: () => kind !== 'unavailable',
      canConfirmSave: () => kind !== 'unconfirmable',
    };
    expect(
      (await post(f, ready.anchor, { cacheBackend: async () => api, onWarning: warning })).outcome,
    ).toBe(kind === 'unavailable' ? 'feature-unavailable' : 'abandoned');
    expect(
      renamed.mock.calls.filter(([a, b]) =>
        [a, b].some((p) => p === 'data' || p.startsWith('data/')),
      ),
    ).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(await readFile(f.root + '/data/a', 'utf8')).toBe('body');
  },
);
it('keeps a local source return failure hard, retains stage paths and prevents final record publication or a second attempt', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'body' });
  const rename = NativeRoot.prototype.renameAbsent;
  vi.spyOn(NativeRoot.prototype, 'renameAbsent').mockImplementation(async function (
    this: NativeRoot,
    ...args
  ) {
    if (args[1] === 'data') throw new Error('return destination unavailable');
    return rename.apply(this, args);
  });
  const warning = vi.fn();
  await expect(post(f, ready.anchor, { onWarning: warning })).rejects.toThrow(/return|retained/i);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(warning).not.toHaveBeenCalled();
  const opened = await OpenedInvocation.open(ready.anchor, f.budget);
  expect(opened.state[4]).toBe('post-active');
  expect(opened.state[7]).toBeNull();
  const backend = vi.fn(async () => f.api);
  await expect(post(f, ready.anchor, { cacheBackend: backend })).rejects.toThrow('Interrupted');
  expect(backend).not.toHaveBeenCalled();
});
it('checks fresh Gradle quiescence before hook removal, observation or backend construction', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', ['data/**'], hard, 'aggregate', null, 'default', 0]]],
      'post-gradle-',
      1,
    ),
    f = await fixture(model),
    ready = await f.prepare({
      lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: false }) }),
    });
  const backend = vi.fn(async () => f.api),
    hooks = vi.fn(async () => {});
  const result = await post(f, ready.anchor, {
    cacheBackend: backend,
    removeHooks: hooks,
    lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: true }) }),
  });
  expect(result.outcome).toBe('skipped-not-quiescent');
  expect(backend).not.toHaveBeenCalled();
  expect(hooks).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

it('identifies saved and reused partitions when only one partition changes', async () => {
  const f = await fixture(),
    ready = await f.prepare();
  await f.files(f.root, { 'data/a': 'first', 'state/a': 'stable' });
  await post(f, ready.anchor);
  const next = await f.prepare({ nonce: 'b'.repeat(32), root: f.directory + '/fresh' });
  await f.files(next.store.root.path, { 'data/a': 'changed body' });
  const logs: string[] = [],
    before = f.save.mock.calls.length;
  expect(
    (await post(f, next.anchor, { timing: { now: () => 0, info: (s) => logs.push(s) } })).outcome,
  ).toBe('published');
  expect(f.save.mock.calls.length - before).toBe(2);
  expect(logs).toContain('Mammoth: partition publication [partition=state] (reuse).');
  expect(
    logs.some(
      (s) => s.includes('Finished base SDK save [partition=data]') && s.includes('(confirmed)'),
    ),
  ).toBe(true);
  expect(logs.some((s) => s.includes('SDK save [partition=state]'))).toBe(false);
});
