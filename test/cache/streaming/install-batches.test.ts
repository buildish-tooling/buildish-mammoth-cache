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

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  installUnits,
  installBatches,
  validateInstallCursor,
  validateInstallCursors,
  type InstallSpan,
} from '../../../src/cache/streaming/install-batches';
import { OwnedStore, type Reference } from '../../../src/cache/streaming/owned-store';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, directory } from './local-fixtures';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.resolve('build/install-batches-'));
  roots.push(root);
  const f = localFixtures(),
    store = await OwnedStore.bind(root, f.codec),
    options = { budget: new WorkingBudget(), installKind: () => 'file' as const };
  async function plan(rows: Value[]) {
    return store.writeStream(
      'install-plan',
      { ...options, partition: null },
      (async function* () {
        yield ['install-context', f.q('install-current')];
        yield* rows;
      })(),
    );
  }
  const file = (index: number, logical: string): Value => [
    'install',
    index,
    logical,
    f.prefix + 'install/metadata/' + logical,
    f.evidence(),
    null,
    'insert',
    null,
  ];
  const unit = (index: number): Value[] => [
    ['install-unit-open', 'file', 'metadata/' + index, 'file'],
    file(index, 'metadata/' + index),
    ['install-unit-close', 'file', 'metadata/' + index],
  ];
  return { ...f, store, options, plan, file, unit };
}
async function collect(source: AsyncIterable<InstallSpan>) {
  const rows = [];
  for await (const row of source) rows.push(row);
  return rows;
}
it('groups consecutive complete ordinary units and counts structural parent rows', async () => {
  const f = await fixture();
  const rows = [...f.unit(1), ...f.unit(2), ...f.unit(3)];
  rows.splice(1, 0, ['install-parent', 1, 'metadata', f.prefix + 'parents/1', directory]);
  (rows[2] as Value[])[1] = 2;
  (rows[5] as Value[])[1] = 3;
  (rows[8] as Value[])[1] = 4;
  const plan = await f.plan(rows),
    opens = f.store.root.work.opens;
  const batches = await collect(
    installBatches(installUnits(f.store, plan, f.options), { operations: 3 }),
  );
  expect(batches.map((b) => [b.units, b.operations])).toEqual([
    [2, 3],
    [1, 1],
  ]);
  expect(batches[0].end).toEqual(batches[1].start);
  expect(f.store.root.work.opens - opens).toBe(1);
  expect(f.options.budget.retained).toBe(0);
});
it('does not split a snapshot above either target and allows an empty authoritative unit', async () => {
  const f = await fixture();
  const rows: Value[] = [['install-unit-open', 'snapshot', 'metadata', 'partition']];
  for (let i = 1; i <= 8; i++) rows.push(f.file(i, 'metadata/' + i));
  rows.push(['install-unit-close', 'snapshot', 'metadata']);
  const plan = await f.plan(rows),
    batches = await collect(
      installBatches(installUnits(f.store, plan, f.options), { operations: 2, bytes: 1 }),
    );
  expect(batches).toHaveLength(1);
  expect(batches[0].operations).toBe(8);
  expect(batches[0].units).toBe(1);
  const empty = await f.plan([rows[0], rows[rows.length - 1]]);
  expect(
    (await collect(installBatches(installUnits(f.store, empty, f.options))))[0].operations,
  ).toBe(0);
});
it('checks actual byte, physical record and complete-unit count at every cursor boundary', async () => {
  const f = await fixture(),
    plan = await f.plan([...f.unit(1), ...f.unit(2)]);
  const units = await collect(installUnits(f.store, plan, f.options));
  for (const cursor of [units[0].start, units[0].end, units[1].end])
    expect(await validateInstallCursor(f.store, plan, cursor, f.options)).toEqual(cursor);
  for (const field of [1, 2, 3, 4]) {
    const cursor: Value[] = [...units[0].end];
    cursor[field] = field === 1 ? '0'.repeat(64) : Number(cursor[field]) + 1;
    await expect(validateInstallCursor(f.store, plan, cursor, f.options)).rejects.toThrow();
  }
  expect(f.options.budget.retained).toBe(0);
});
it('does not accept a mid-unit cursor or a correct-looking cursor with bad final reference hash', async () => {
  const f = await fixture(),
    plan = await f.plan(f.unit(1));
  const units = await collect(installUnits(f.store, plan, f.options));
  const bad = [...plan] as Reference;
  bad[4] = '0'.repeat(64);
  const cursor = [...units[0].end];
  cursor[1] = bad[4];
  await expect(validateInstallCursor(f.store, bad, cursor, f.options)).rejects.toThrow(
    'local reference',
  );
  const middle = [...units[0].start];
  middle[2] = Number(middle[2]) + 1;
  await expect(validateInstallCursor(f.store, plan, middle, f.options)).rejects.toThrow(
    'complete-unit',
  );
  expect(f.options.budget.retained).toBe(0);
});
it('releases readers when batch consumption stops or is cancelled', async () => {
  const f = await fixture(),
    plan = await f.plan([...f.unit(1), ...f.unit(2), ...f.unit(3)]);
  for await (const batch of installBatches(installUnits(f.store, plan, f.options), {
    operations: 1,
  })) {
    expect(batch.units).toBe(1);
    break;
  }
  expect(f.options.budget.retained).toBe(0);
  const controller = new AbortController();
  controller.abort(new Error('cancel batch scan'));
  await expect(
    collect(installBatches(installUnits(f.store, plan, f.options, controller.signal))),
  ).rejects.toThrow('cancel batch scan');
  expect(f.options.budget.retained).toBe(0);
});

it('validates progress and both intent cursors with one bound plan read', async () => {
  const f = await fixture(),
    plan = await f.plan([...f.unit(1), ...f.unit(2)]);
  const units = await collect(installUnits(f.store, plan, f.options));
  const cursors = [units[0].start, units[0].end, units[1].end];
  const opens = f.store.root.work.opens,
    bytes = f.store.root.work.readBytes;
  expect(await validateInstallCursors(f.store, plan, cursors, f.options)).toEqual(cursors);
  expect(f.store.root.work.opens - opens).toBe(1);
  expect(f.store.root.work.readBytes - bytes).toBe(plan[3]);
  await expect(
    validateInstallCursors(f.store, plan, [...cursors, cursors[0]], f.options),
  ).rejects.toThrow('bounded');
  expect(f.options.budget.retained).toBe(0);
});

it('binds an empty plan initial cursor after context and rejects the header-only position', async () => {
  const f = await fixture(),
    plan = await f.plan([]);
  let headerEnd = 0,
    contextEnd = 0;
  for await (const row of f.store.rows(plan, 'install-plan', { ...f.options, partition: null })) {
    const value = row.value as readonly Value[];
    if (value[0] === 'local-stream') headerEnd = row.end;
    if (value[0] === 'install-context') contextEnd = row.end;
  }
  const initial: Value = ['cursor', plan[4], contextEnd, 2, 0, null];
  expect(await validateInstallCursor(f.store, plan, initial, f.options)).toEqual(initial);
  await expect(
    validateInstallCursor(f.store, plan, ['cursor', plan[4], headerEnd, 1, 0, null], f.options),
  ).rejects.toThrow('complete-unit');
  expect(await collect(installBatches(installUnits(f.store, plan, f.options)))).toEqual([]);
  expect(f.options.budget.retained).toBe(0);
});
