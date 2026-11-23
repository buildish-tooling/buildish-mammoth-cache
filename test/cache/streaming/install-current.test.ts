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

import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installCurrentRows } from '../../../src/cache/streaming/install-current';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { walkWork } from '../../../src/cache/streaming/native-walk';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures } from './local-fixtures';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.resolve('build/install-current-'));
  roots.push(directory);
  const f = localFixtures(),
    store = await OwnedStore.bind(directory, f.codec),
    budget = new WorkingBudget();
  return { directory, store, budget };
}
it('captures one complete physical projection without reading untouched payload bodies', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'cache/shared'), { recursive: true });
  for (const file of ['cache/a', 'cache/shared/a', 'cache/shared/b', 'unmanaged'])
    await writeFile(path.join(f.directory, file), 'untouched body');
  const work = walkWork(),
    before = f.store.root.work.readBytes;
  const rows: Value[] = [];
  for await (const row of installCurrentRows(f.store, { budget: f.budget }, work)) rows.push(row);
  expect(f.store.root.work.readBytes).toBe(before);
  expect(
    rows.filter((r) => Array.isArray(r) && r[0] === 'file').map((r) => (r as Value[])[1]),
  ).toEqual(['unmanaged', 'cache/a', 'cache/shared/a', 'cache/shared/b']);
  expect(
    rows
      .filter((r) => Array.isArray(r) && r[0] === 'parent-child')
      .map((r) => (r as Value[]).slice(1, 4)),
  ).toEqual([]);
  expect(work.listings).toBe(3);
  expect(work.entries).toBe(6);
  expect(f.budget.retained).toBe(0);
});
it('records every adjacent protected link by native IDs without following their targets', async () => {
  const f = await fixture();
  await mkdir(path.join(f.directory, 'target'));
  await writeFile(path.join(f.directory, 'target/file'), 'payload');
  for (const name of ['link-a', 'link-b'])
    await symlink(
      path.join(f.directory, 'target'),
      path.join(f.directory, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  const work = walkWork(),
    protectedRows: Value[][] = [];
  for await (const row of installCurrentRows(f.store, { budget: f.budget }, work))
    if (Array.isArray(row) && row[0] === 'parent-child') protectedRows.push([...row]);
  expect(protectedRows.map((r) => [r[2], r[3]])).toEqual([
    ['link-a', 'symlink'],
    ['link-b', 'symlink'],
  ]);
  expect(
    protectedRows.every((r) => /^[0-9]+$/.test(String(r[4])) && /^[0-9]+$/.test(String(r[5]))),
  ).toBe(true);
  expect(work.listings).toBe(2);
  expect(f.budget.retained).toBe(0);
});
it('bounds direct-child names and releases both producer and validator charges on failure', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) await writeFile(path.join(f.directory, String(i)), 'body');
  await expect(
    collect(installCurrentRows(f.store, { budget: f.budget, maxDirectoryEntries: 3 })),
  ).rejects.toThrow('breadth');
  expect(f.budget.retained).toBe(0);
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancel inventory'));
  await expect(
    collect(installCurrentRows(f.store, { budget: f.budget, signal: cancelled.signal })),
  ).rejects.toThrow('cancel inventory');
  expect(f.budget.retained).toBe(0);
});

async function collect(source: AsyncIterable<Value>) {
  for await (const row of source) void row;
}
