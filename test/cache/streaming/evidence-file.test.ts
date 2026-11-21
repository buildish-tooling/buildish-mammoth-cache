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

import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalRow } from '../../../src/cache/streaming/local-stream';
import { EvidenceFile } from '../../../src/cache/streaming/evidence-file';
import { OwnedStore, type Reference } from '../../../src/cache/streaming/owned-store';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, native, directory } from './local-fixtures';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
async function fixture() {
  const root = await mkdtemp(path.resolve('build/evidence-file-'));
  roots.push(root);
  const f = localFixtures(),
    store = await OwnedStore.bind(root, f.codec),
    budget = new WorkingBudget();
  async function create(desired = false) {
    const rows: Value[] = [
      ['directory', '', directory],
      ['directory', 'metadata', directory],
      ['file', desired ? 'metadata/a' : 'metadata/b', native, sha],
      ['directory', desired ? 'metadata/b' : 'metadata/a', directory],
      ['file', desired ? 'metadata/b/x' : 'metadata/a/x', native, sha],
    ];
    const ref = await store.writeStream(
      'native-evidence',
      { budget, partition: 'metadata' },
      (async function* () {
        yield* rows;
      })(),
    );
    const frames: LocalRow[] = [];
    for await (const row of store.rows(ref, 'native-evidence', { budget, partition: 'metadata' }))
      frames.push(row);
    const bind = (logical: string, subtree = false): Value[] => {
      const index = frames.findIndex((row) => Array.isArray(row.value) && row.value[1] === logical);
      const first = frames[index];
      let next = index + 1;
      while (subtree) {
        const value = frames[next].value;
        if (!Array.isArray(value) || !String(value[1]).startsWith(logical + '/')) break;
        next++;
      }
      return ['evidence', ref, ['span', ref[4], first.start, frames[next].start]];
    };
    return { ref, frames, bind };
  }
  return { root, store, budget, create };
}
it('reads opposite source/preimage orders from two once-validated open evidence files', async () => {
  const f = await fixture(),
    old = await f.create(),
    desired = await f.create(true),
    before = f.store.root.work.opens;
  const oldReader = await EvidenceFile.open(f.store, old.ref, 'metadata', f.budget),
    newReader = await EvidenceFile.open(f.store, desired.ref, 'metadata', f.budget);
  try {
    const paths: string[] = [];
    for (const [logical, newKind, oldKind] of [
      ['metadata/a', 'file', 'directory'],
      ['metadata/b', 'directory', 'file'],
    ] as const) {
      await newReader.member(
        desired.bind(logical, newKind === 'directory'),
        logical,
        newKind,
        async (row) => {
          paths.push(String((row as Value[])[1]));
        },
      );
      await oldReader.member(
        old.bind(logical, oldKind === 'directory'),
        logical,
        oldKind,
        async (row) => {
          paths.push(String((row as Value[])[1]));
        },
      );
    }
    expect(paths).toEqual([
      'metadata/a',
      'metadata/a',
      'metadata/a/x',
      'metadata/b',
      'metadata/b/x',
      'metadata/b',
    ]);
    expect(f.store.root.work.opens - before).toBe(2);
    expect(oldReader.work.validationBytes).toBe(old.ref[3]);
    expect(newReader.work.validationBytes).toBe(desired.ref[3]);
    expect(oldReader.work.lookaheadBytes).toBeLessThanOrEqual(256);
    expect(newReader.work.lookaheadBytes).toBeLessThanOrEqual(256);
  } finally {
    await oldReader.close();
    await newReader.close();
  }
  expect(f.budget.retained).toBe(0);
});
it.each(['mid-start', 'mid-end', 'wrong-member', 'file-extra', 'directory-short', 'framing'])(
  'rejects %s range despite tuple-valid offsets',
  async (kind) => {
    const f = await fixture(),
      data = await f.create(),
      reader = await EvidenceFile.open(f.store, data.ref, 'metadata', f.budget);
    const binding = data.bind(
        kind === 'directory-short' ? 'metadata/a' : 'metadata/b',
        kind === 'directory-short',
      ),
      span = binding[2] as Value[];
    if (kind === 'mid-start') span[2] = Number(span[2]) + 1;
    if (kind === 'mid-end') span[3] = Number(span[3]) - 1;
    if (kind === 'file-extra') span[3] = data.frames[data.frames.length - 1].start;
    if (kind === 'directory-short') span[3] = data.frames[4].start;
    if (kind === 'framing') span[2] = 0;
    try {
      await expect(
        reader.member(
          binding,
          kind === 'wrong-member'
            ? 'metadata/other'
            : kind === 'directory-short'
              ? 'metadata/a'
              : 'metadata/b',
          kind === 'directory-short' ? 'directory' : 'file',
          async () => {},
        ),
      ).rejects.toThrow();
    } finally {
      await reader.close();
    }
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects changed metadata identity and wrong full-Q hash before accepting members', async () => {
  const f = await fixture(),
    data = await f.create(),
    bad = [...data.ref] as Reference;
  bad[4] = '0'.repeat(64);
  await expect(EvidenceFile.open(f.store, bad, 'metadata', f.budget)).rejects.toThrow(
    'local reference',
  );
  const reader = await EvidenceFile.open(f.store, data.ref, 'metadata', f.budget);
  await appendFile(f.store.root.resolve(data.ref[2]), 'x');
  try {
    await expect(
      reader.member(data.bind('metadata/b'), 'metadata/b', 'file', async () => {}),
    ).rejects.toThrow('identity changed');
  } finally {
    await reader.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('cancels a pending provisional visit and closes shared handles explicitly', async () => {
  const f = await fixture(),
    data = await f.create(),
    reader = await EvidenceFile.open(f.store, data.ref, 'metadata', f.budget),
    controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = reader.member(
    data.bind('metadata/b'),
    'metadata/b',
    'file',
    async (_row, signal) => {
      expect(signal).toBe(controller.signal);
      entered();
      await new Promise<void>(() => {});
    },
    controller.signal,
  );
  await started;
  controller.abort(new Error('cancel span visit'));
  await expect(pending).rejects.toThrow('cancel span visit');
  await reader.close();
  await expect(
    reader.member(data.bind('metadata/b'), 'metadata/b', 'file', async () => {}),
  ).rejects.toThrow('unavailable');
  expect(f.budget.retained).toBe(0);
});

it.each(['open', 'member'] as const)(
  'does not accept %s after cancellation during its final stability check',
  async (operation) => {
    const f = await fixture(),
      data = await f.create(),
      controller = new AbortController();
    const reader =
      operation === 'member'
        ? await EvidenceFile.open(f.store, data.ref, 'metadata', f.budget)
        : undefined;
    // Wrap the internal asynchronous boundary without adding a production test hook.
    const prototype = EvidenceFile.prototype as unknown as { stable(): Promise<void> };
    const original = prototype.stable;
    let calls = 0;
    const delayed = vi.spyOn(prototype, 'stable').mockImplementation(async function (
      this: EvidenceFile,
    ) {
      await original.call(this);
      if (++calls === (operation === 'open' ? 1 : 2))
        controller.abort(new Error('cancel final evidence check'));
    });
    try {
      const pending = reader
        ? reader.member(
            data.bind('metadata/b'),
            'metadata/b',
            'file',
            async () => {},
            controller.signal,
          )
        : EvidenceFile.open(f.store, data.ref, 'metadata', f.budget, controller.signal);
      await expect(pending).rejects.toThrow('cancel final evidence check');
    } finally {
      delayed.mockRestore();
      await reader?.close();
    }
    expect(f.budget.retained).toBe(0);
  },
);
