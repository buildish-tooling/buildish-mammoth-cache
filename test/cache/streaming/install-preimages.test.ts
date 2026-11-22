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
import { writeFile } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { captureInstallCurrent } from '../../../src/cache/streaming/install-current';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { buildInstallIndex } from '../../../src/cache/streaming/install-index';
import { selectInstall, type Selection } from '../../../src/cache/streaming/install-selection';
import {
  captureInstallPreimages,
  type CapturedSelection,
} from '../../../src/cache/streaming/install-preimages';
import { EvidenceFile } from '../../../src/cache/streaming/evidence-file';
import type { VerifiedIncoming } from '../../../src/cache/streaming/install-evidence';
import type { Value } from '../../../src/cache/streaming/encoding';
import { rawSha } from '../../../src/cache/streaming/encoding';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [],
  spools: InstallScratch[] = [];
afterEach(async () => {
  for (const s of spools.splice(0)) await s.close();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await installFixture();
  fixtures.push(f);
  return f;
}
async function prepare(f: Awaited<ReturnType<typeof installFixture>>, inputs: VerifiedIncoming[]) {
  const current = await captureInstallCurrent(f.store, { budget: f.budget }),
    scratch = await InstallScratch.create(f.store, f.budget);
  spools.push(scratch);
  const old = await buildInstallIndex(
      scratch,
      f.store.rows(current, 'install-current', { budget: f.budget, partition: null }),
      f.model,
      null,
    ),
    desired = [];
  for (const i of inputs)
    desired.push({
      partition: f.model.partitions.findIndex((p) => p[0] === i.partition),
      root: await buildInstallIndex(
        scratch,
        f.store.rows(i.evidence, 'native-evidence', { budget: f.budget, partition: i.partition }),
        f.model,
        i.partition,
      ),
    });
  return { scratch, root: await selectInstall(scratch, f.model, old, desired) };
}
async function operations(s: InstallScratch, root: number | null): Promise<CapturedSelection[]> {
  const ops: CapturedSelection[] = [];
  async function visit(offset: number) {
    const lease = await s.record(offset);
    try {
      const row = lease.value as Selection;
      if (row[1] === 'operation') ops.push(lease.value as CapturedSelection);
      else
        for await (const edge of s.rows(row[8], row[9])) await visit(Number((edge as Value[])[2]));
    } finally {
      lease.release();
    }
  }
  if (root !== null) await visit(root);
  return ops;
}
it('hashes only selected old roots once and leaves untouched aggregate payload unread', async () => {
  const f = await fixture();
  await f.files('', {
    'state/old/a': 'old-a',
    'state/old/b': 'old-b',
    'data/untouched': 'untouched',
  });
  const p = await prepare(f, [await f.incoming('state', { 'state/new': 'new' })]);
  const result = await captureInstallPreimages(f.store, p.scratch, p.root);
  expect(result.work).toEqual({ hashedFiles: 2, hashedBytes: 10, trustedFiles: 0 });
  const ops = await operations(p.scratch, result.root);
  expect(ops).toHaveLength(1);
  const ref = result.references[1]!;
  const reader = await EvidenceFile.open(f.store, ref, 'state', f.budget);
  const members: Value[] = [];
  try {
    await reader.member(
      ['evidence', ref, ['span', ref[4], ops[0][10], ops[0][11]]],
      'state',
      'directory',
      async (row) => {
        members.push(row);
      },
    );
  } finally {
    await reader.close();
  }
  expect(members.filter((v) => (v as Value[])[0] === 'file').map((v) => (v as Value[])[3])).toEqual(
    [rawSha(Buffer.from('old-a')), rawSha(Buffer.from('old-b'))],
  );
  await p.scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('writes old evidence in its own physical order and supplies exact spans for opposite desired kinds', async () => {
  const f = await fixture();
  await f.files('', { 'state/a/x': 'old-a', 'state/b': 'old-b', 'state/keep.lock': 'protected' });
  const p = await prepare(f, [
      await f.incoming('state', { 'state/a': 'new-a', 'state/b/y': 'new-b' }),
    ]),
    result = await captureInstallPreimages(f.store, p.scratch, p.root),
    ops = await operations(p.scratch, result.root),
    ref = result.references[1]!;
  const reader = await EvidenceFile.open(f.store, ref, 'state', f.budget);
  try {
    for (const op of ops)
      await reader.member(
        ['evidence', ref, ['span', ref[4], op[10], op[11]]],
        op[2],
        op[2] === 'state/a' ? 'directory' : 'file',
        async () => {},
      );
  } finally {
    await reader.close();
  }
  expect(result.work.hashedFiles).toBe(2);
  await p.scratch.close();
  expect(f.budget.retained).toBe(0);
});
it.each([false, true])(
  'reuses a trusted producer hash only while its full current native identity is bound (changed=%s)',
  async (changed) => {
    const f = await fixture(),
      base = await f.incoming('state', { 'state/old': 'trusted-old' }, 'trusted-base'),
      source = base.nativeRoot + '/state',
      native = (await f.store.root.stat(source))!;
    await f.store.root.renameAbsent(source, 'state', native);
    if (changed) await writeFile(f.store.root.resolve('state/old'), 'changed-old');
    const p = await prepare(f, [await f.incoming('state', { 'state/new': 'new' })]),
      result = await captureInstallPreimages(f.store, p.scratch, p.root, [base]);
    expect(result.work).toEqual(
      changed
        ? { hashedFiles: 1, hashedBytes: 11, trustedFiles: 0 }
        : { hashedFiles: 0, hashedBytes: 0, trustedFiles: 1 },
    );
    await p.scratch.close();
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects a selected old body changed after frozen inventory instead of granting a preimage', async () => {
  const f = await fixture();
  await f.files('', { 'state/old': 'old' });
  const p = await prepare(f, [await f.incoming('state', { 'state/new': 'new' })]);
  await writeFile(f.store.root.resolve('state/old'), 'changed');
  await expect(captureInstallPreimages(f.store, p.scratch, p.root)).rejects.toThrow(
    'preimage changed',
  );
  await p.scratch.close();
  expect(f.budget.retained).toBe(0);
});
it('uses active parent guards with linear selected-leaf stats across a shared directory', async () => {
  const counts = [];
  for (const width of [4, 16]) {
    const f = await fixture(),
      entries: Record<string, string> = {};
    for (let i = 0; i < width; i++) entries['state/' + String(i).padStart(2, '0')] = 'body';
    await f.files('', entries);
    const p = await prepare(f, [await f.incoming('state', {})]),
      before = f.store.root.work.stats,
      result = await captureInstallPreimages(f.store, p.scratch, p.root);
    expect(result.work.hashedFiles).toBe(width);
    counts.push(f.store.root.work.stats - before);
  }
  expect(counts[1] - counts[0]).toBe(4 * (16 - 4));
});
