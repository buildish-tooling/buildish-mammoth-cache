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

import { afterEach, expect, it } from 'vitest';
import { mixedDirectoryFixture } from './mixed-directory-fixture';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from './install-plan-fixture';
import { InstallAdmission } from '../../../src/cache/streaming/install-admission';
import { InstallProgram, InstallReaders } from '../../../src/cache/streaming/install-program';
import type { Value } from '../../../src/cache/streaming/encoding';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function fixture() {
  const f = await installFixture();
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  return f;
}
async function batches(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Awaited<ReturnType<typeof f.incoming>> | Awaited<ReturnType<typeof f.incoming>>[],
  targets: { operations: number; bytes: number },
) {
  const frozen = await freezeInstallPlan(f.store, Array.isArray(input) ? input : [input], f.budget),
    admission = await InstallAdmission.create(f.store, frozen, f.budget),
    readers = new InstallReaders(f.store, f.budget, 100000, admission);
  let program: InstallProgram | undefined;
  try {
    program = await InstallProgram.create(
      f.store,
      frozen.plan,
      readers,
      new AbortController().signal,
      targets,
      admission,
    );
    const result: { units: number; operations: number; start: number; end: number }[] = [];
    for await (const batch of program.batches.rows(0, program.batches.position)) {
      const row = batch as readonly Value[];
      let units = 0,
        operations = 0;
      for await (const frame of program.batchRows(row as ['batch', number, number])) {
        const operation = (frame as readonly Value[])[1] as readonly Value[];
        if (operation[0] === 'install-unit-close') {
          units++;
        }
        if (operation[0] === 'install' || operation[0] === 'install-parent') {
          operations++;
        }
      }
      result.push({ units, operations, start: Number(row[1]), end: Number(row[2]) });
    }
    return result;
  } finally {
    await program?.close();
    await readers.close();
    await admission.close();
    await frozen.metadata.dispose();
  }
}
it('groups consecutive complete ordinary units at operation targets', async () => {
  const f = await fixture();
  await f.files('', { 'data/shared': null });
  const rows = await batches(
    f,
    await f.incoming('data', { 'data/shared/a': 'a', 'data/shared/b': 'b', 'data/shared/c': 'c' }),
    { operations: 2, bytes: 100000 },
  );
  expect(rows.map((r) => [r.units, r.operations])).toEqual([
    [2, 2],
    [1, 1],
  ]);
  expect(rows[0].end).toBe(rows[1].start);
  expect(f.budget.retained).toBe(0);
});
it('keeps a snapshot complete even when it exceeds both batching targets', async () => {
  const f = await fixture();
  await f.files('', { 'state/keep.lock': 'protected' });
  const rows = await batches(
    f,
    await f.incoming(
      'state',
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['state/f' + i, 'body'])),
    ),
    { operations: 2, bytes: 1 },
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].units).toBe(1);
  expect(rows[0].operations).toBe(8);
  expect(f.budget.retained).toBe(0);
});
it('accepts an absent authoritative empty snapshot unit without fabricating a mutation', async () => {
  const f = await fixture();
  const rows = await batches(f, await f.incoming('state', {}), { operations: 1, bytes: 1 });
  expect(rows).toHaveLength(1);
  expect(rows[0].units).toBe(1);
  expect(rows[0].operations).toBe(0);
  expect(f.budget.retained).toBe(0);
});

it('charges structural parent operations while keeping mixed-owner units complete', async () => {
  const f = await mixedDirectoryFixture();
  fixtures.push(f);
  const rows = await batches(f, f.inputs, { operations: 3, bytes: 100000 });
  expect(rows.reduce((total, row) => total + row.operations, 0)).toBe(7);
  expect(rows.reduce((total, row) => total + row.units, 0)).toBe(5);
  expect(rows.every((row) => row.operations <= 3 && row.units > 0)).toBe(true);
  expect(f.budget.retained).toBe(0);
});
