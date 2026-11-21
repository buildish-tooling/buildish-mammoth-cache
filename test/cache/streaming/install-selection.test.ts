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
import { installFixture } from './install-fixture';
import { captureInstallCurrent } from '../../../src/cache/streaming/install-current';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { buildInstallIndex } from '../../../src/cache/streaming/install-index';
import { selectInstall, type Selection } from '../../../src/cache/streaming/install-selection';
import type { VerifiedIncoming } from '../../../src/cache/streaming/install-evidence';
import type { Value } from '../../../src/cache/streaming/encoding';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(tool: 'gradle' | 'maven' = 'gradle') {
  const f = await installFixture(tool);
  fixtures.push(f);
  return f;
}
async function select(
  f: Awaited<ReturnType<typeof installFixture>>,
  inputs: VerifiedIncoming[],
  beforeSelect?: (scratch: InstallScratch) => void,
  signal?: AbortSignal,
) {
  const beforeReads = f.store.root.work.readBytes - f.store.root.work.scratchReadBytes;
  const current = await captureInstallCurrent(f.store, { budget: f.budget }),
    scratch = await InstallScratch.create(f.store, f.budget);
  try {
    const old = await buildInstallIndex(
      scratch,
      f.store.rows(current, 'install-current', { budget: f.budget, partition: null }),
      f.model,
      null,
    );
    const sources = [];
    for (const input of inputs)
      sources.push({
        partition: f.model.partitions.findIndex((p) => p[0] === input.partition),
        root: await buildInstallIndex(
          scratch,
          f.store.rows(input.evidence, 'native-evidence', {
            budget: f.budget,
            partition: input.partition,
          }),
          f.model,
          input.partition,
        ),
      });
    beforeSelect?.(scratch);
    const renames = f.store.root.work.renames,
      root = await selectInstall(scratch, f.model, old, sources, signal),
      ops: Selection[] = [];
    async function visit(offset: number) {
      const record = await scratch.record(offset);
      try {
        const node = record.value as Selection;
        if (node[1] === 'operation') ops.push(node);
        else
          for await (const value of scratch.rows(node[8], node[9]))
            await visit(Number((value as Value[])[2]));
      } finally {
        record.release();
      }
    }
    if (root !== null) await visit(root);
    expect(f.store.root.work.renames).toBe(renames);
    expect(f.store.root.work.readBytes - f.store.root.work.scratchReadBytes - beforeReads).toBe(
      current[3] + inputs.reduce((sum, i) => sum + i.evidence[3], 0),
    );
    return ops;
  } finally {
    await scratch.close();
    expect(f.budget.retained).toBe(0);
  }
}
it('keeps untouched aggregate files and excludes protected snapshot siblings', async () => {
  const f = await fixture();
  await f.files('', { 'data/keep': 'old', 'state/stale': 'old', 'state/keep.lock': 'protected' });
  const ops = await select(f, [
    await f.incoming('data', { 'data/new': 'new' }),
    await f.incoming('state', { 'state/new': 'new' }),
  ]);
  expect(ops.map((o) => [o[2], o[5] === null ? 'delete' : 'upsert'])).toEqual([
    ['data/new', 'upsert'],
    ['state/new', 'upsert'],
    ['state/stale', 'delete'],
  ]);
});
it('coarsens a complete snapshot before hashing any old payload', async () => {
  const f = await fixture();
  await f.files('', { 'state/old/a': 'old', 'state/old/b': 'old' });
  const ops = await select(f, [await f.incoming('state', { 'state/new/a': 'new' })]);
  expect(ops.map((o) => [o[2], o[3], o[7]])).toEqual([
    ['state', 'directory', ['snapshot', 'state', 'partition']],
  ]);
});
it('an explicit empty snapshot deletes complete owned stale trees', async () => {
  const f = await fixture();
  await f.files('', { 'state/sub/stale': 'old', 'data/keep': 'old' });
  const ops = await select(f, [await f.incoming('state', {})]);
  expect(ops).toHaveLength(1);
  expect(ops[0][2]).toBe('state');
  expect(ops[0][5]).toBeNull();
});
it('selects opposite file/directory replacements without losing protected siblings', async () => {
  const f = await fixture();
  await f.files('', { 'state/a/x': 'old', 'state/b': 'old', 'state/keep.lock': 'protected' });
  const ops = await select(f, [
    await f.incoming('state', { 'state/a': 'new', 'state/b/y': 'new' }),
  ]);
  expect(ops.map((o) => [o[2], o[3]])).toEqual([
    ['state/a', 'file'],
    ['state/b', 'directory'],
  ]);
});
it('preserves existing nonempty directories for aggregate empty-directory presence', async () => {
  const f = await fixture();
  await f.files('', { 'data/empty/retained': 'old' });
  expect(await select(f, [await f.incoming('data', { 'data/empty': null })])).toEqual([]);
});
it('rejects replacing a directory that contains protected native members', async () => {
  const f = await fixture();
  await f.files('', { 'data/target/keep.lock': 'protected' });
  await expect(select(f, [await f.incoming('data', { 'data/target': 'new' })])).rejects.toThrow(
    'wholly owned',
  );
});
it('keeps an indivisible workspace complete while preserving its excluded lock', async () => {
  const f = await fixture(),
    root = 'caches/transforms-4/' + 'a'.repeat(32);
  await f.files('', { [root + '/stale']: 'old', [root + '/keep.lock']: 'protected' });
  const ops = await select(f, [
    await f.incoming('data', {
      [root + '/metadata.bin']: 'm',
      [root + '/results.bin']: 'r',
      [root + '/transformed/new']: 'new',
    }),
  ]);
  expect(ops.some((o) => o[2] === root + '/stale' && o[5] === null)).toBe(true);
  expect(ops.every((o) => o[7]?.[0] === 'artifact-transform' && o[7]?.[1] === root)).toBe(true);
});

it('removes stale workspace descendants when desired subdirectory is empty but an excluded lock survives', async () => {
  const f = await fixture(),
    root = 'caches/transforms-4/' + 'b'.repeat(32);
  await f.files('', {
    [root + '/transformed/stale']: 'old',
    [root + '/transformed/keep.lock']: 'protected',
  });
  const ops = await select(f, [
    await f.incoming('data', {
      [root + '/metadata.bin']: 'm',
      [root + '/results.bin']: 'r',
      [root + '/transformed']: null,
    }),
  ]);
  expect(ops.some((o) => o[2] === root + '/transformed/stale' && o[5] === null)).toBe(true);
  expect(ops.every((o) => !o[2].endsWith('keep.lock'))).toBe(true);
});
it.each(['final-append', 'no-op-read'] as const)(
  'rejects terminal cancellation at %s instead of returning a selector',
  async (where) => {
    const f = await fixture(),
      controller = new AbortController();
    const inputs = where === 'final-append' ? [await f.incoming('data', { 'data/a': 'new' })] : [];
    await expect(
      select(
        f,
        inputs,
        (scratch) => {
          if (where === 'final-append') {
            const append = scratch.append.bind(scratch);
            vi.spyOn(scratch, 'append').mockImplementation(async (value, owner) => {
              const at = await append(value, owner);
              if (
                Array.isArray(value) &&
                value[0] === 'candidate' &&
                value[1] === 'branch' &&
                value[2] === ''
              )
                controller.abort(new Error('cancel terminal selection'));
              return at;
            });
          } else {
            const record = scratch.record.bind(scratch);
            vi.spyOn(scratch, 'record').mockImplementation(async (at) => {
              const lease = await record(at);
              controller.abort(new Error('cancel terminal selection'));
              return lease;
            });
          }
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancel terminal selection');
  },
);

it('selects complete Maven direct files while preserving nested coordinates and transient locks', async () => {
  const f = await fixture('maven'),
    root = 'repository/g/artifact/1';
  await f.files('', {
    [root + '/old.jar']: 'stale',
    [root + '/keep.lock']: 'transient',
    [root + '/child/nested.jar']: 'preserved',
  });
  const ops = await select(f, [await f.incoming('data', { [root + '/new.jar']: 'new' })]);
  expect(ops.map((o) => [o[2], o[5] === null ? 'delete' : 'upsert'])).toEqual([
    [root + '/new.jar', 'upsert'],
    [root + '/old.jar', 'delete'],
  ]);
  expect(
    ops.every(
      (o) => o[7]?.[0] === 'maven-directory' && o[7]?.[1] === root && o[7]?.[2] === 'direct',
    ),
  ).toBe(true);
});
