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

import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  baseFixture,
  preparedBase,
  nativeCacheBackend,
  cleanupBaseFixtures,
} from './base-fixtures';
import {
  PinnedBaseGeneration,
  ProvisionalBaseSet,
} from '../../../src/cache/streaming/base-generation';
import {
  createGeneration,
  type GenerationEntry,
} from '../../../src/cache/streaming/native-records';
import { NativeObjectSave } from '../../../src/cache/streaming/base-transport';
import { baseRecordPaths } from '../../../src/cache/streaming/base-layout';
import { encodeRecord } from '../../../src/cache/streaming/encoding';
import { lineageId, resolveModel } from '../../../src/cache/streaming/model';
import * as retirement from '../../../src/cache/streaming/owned-retirement';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { h } from './local-fixtures';
const pins: PinnedBaseGeneration[] = [],
  sets: ProvisionalBaseSet[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const set of sets.splice(0)) await set.dispose();
  for (const pin of pins.splice(0)) await pin.dispose();
  await cleanupBaseFixtures();
});
async function fixture() {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [
          ['data', ['data/**'], hard, 'aggregate', null, 'default'],
          ['meta', ['meta/**'], hard, 'aggregate', null, 'default'],
        ],
      ],
      'acquire-',
      1,
    ),
    f = await baseFixture(model),
    sdk = await nativeCacheBackend(),
    a = await preparedBase(f, { 'data/a': 'abc' }, 'data'),
    b = await preparedBase(f, { 'meta/a': 'def' }, 'meta');
  await NativeObjectSave.save(sdk.backend, a, { budget: f.budget });
  await NativeObjectSave.save(sdk.backend, b, { budget: f.budget });
  async function record(
    entries: GenerationEntry[] = [
      ['object', 'data', a.reference],
      ['object', 'meta', b.reference],
    ],
    ref = 'refs/heads/main',
    decision = h,
  ) {
    const generation = createGeneration(model, lineageId(ref), h, decision, entries, [
        ['data'],
        ['meta'],
      ]),
      root = f.store.prefix + 'records/' + randomUUID();
    const q = await f.store.writeNativeMetadata(
      root,
      'record.json',
      (async function* () {
        yield encodeRecord(generation);
      })(),
    );
    await sdk.backend.saveCache(baseRecordPaths(f.store, root), generation[11], {
      archiveRoot: f.store.root.resolve(root),
    });
    return { generation, q };
  }
  const r = await record();
  return { ...f, sdk, a, b, record, ...r };
}
async function pin(
  f: Awaited<ReturnType<typeof fixture>>,
  currentRef = 'refs/heads/main',
  defaultRef?: string,
) {
  const result = await PinnedBaseGeneration.discover(
    f.store,
    f.sdk.backend,
    { currentRef, defaultRef },
    { budget: f.budget },
  );
  if (!result) throw new Error('Expected pinned generation.');
  pins.push(result);
  return result;
}
it('pins record once, validates both objects without body rehash and keeps the generation alive for consumers', async () => {
  const f = await fixture(),
    read = vi.spyOn(NativeReadPhase.prototype, 'read'),
    p = await pin(f),
    set = await ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget });
  sets.push(set);
  expect(p.key).toBe(f.generation[11]);
  expect(p.record[1]).toBe('generation');
  expect([...set.available()]).toEqual(['data', 'meta']);
  expect(set.downloads).toHaveLength(2);
  expect(read).not.toHaveBeenCalled();
  await expect(p.dispose()).rejects.toThrow('active object consumers');
  await set.dispose();
  await p.dispose();
  expect(f.budget.retained).toBe(0);
});
it('pins default lineage once and never consults a newly published generation or predecessor during acquisition retry', async () => {
  const f = await fixture(),
    p = await pin(f, 'refs/heads/feature', 'refs/heads/main'),
    start = f.sdk.calls.length;
  await f.record(
    [
      ['empty', 'data'],
      ['empty', 'meta'],
    ],
    'refs/heads/feature',
    'b'.repeat(64),
  );
  const afterPublication = f.sdk.calls.length;
  for (let i = 0; i < 2; i++) {
    const s = await ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget });
    sets.push(s);
    expect(s.downloads).toHaveLength(2);
    await s.dispose();
  }
  expect(f.sdk.calls.slice(afterPublication).map((c) => c.key)).toEqual([
    f.a.reference[2],
    f.b.reference[2],
    f.a.reference[2],
    f.b.reference[2],
  ]);
  expect(f.sdk.calls.length - start).toBe(5);
});
it('resumes exact persisted bytes without latest lookup and keeps resume metadata invocation-owned', async () => {
  const f = await fixture(),
    before = f.sdk.calls.length,
    p = await PinnedBaseGeneration.resume(
      f.store,
      f.generation[11],
      f.q,
      { currentRef: 'refs/heads/main' },
      { budget: f.budget },
    );
  pins.push(p);
  expect(p.key).toBe(f.generation[11]);
  expect(f.sdk.calls).toHaveLength(before);
  await p.dispose();
  expect(await f.store.root.stat(f.q[2])).not.toBeNull();
});
it('distinguishes unavailable object from intentional empty without granting group/install capabilities', async () => {
  const f = await fixture();
  f.sdk.objects.delete(f.a.reference[2]);
  const p = await pin(f),
    set = await ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget });
  sets.push(set);
  expect([...set.available()]).toEqual(['meta']);
  expect(set.downloads[0].object).toBeNull();
  await set.dispose();
  await p.dispose();
  await f.record(
    [
      ['empty', 'data'],
      ['object', 'meta', f.b.reference],
    ],
    'refs/heads/main',
    'b'.repeat(64),
  );
  const p2 = await pin(f),
    s2 = await ProvisionalBaseSet.acquire(p2, f.sdk.backend, { budget: f.budget });
  sets.push(s2);
  expect([...s2.available()]).toEqual(['data', 'meta']);
  expect(s2.downloads).toHaveLength(1);
});
it('still rejects a malformed available sibling when an earlier object is unavailable', async () => {
  const f = await fixture(),
    p = await pin(f),
    restore = f.sdk.backend.restoreCache.bind(f.sdk.backend);
  f.sdk.objects.delete(f.a.reference[2]);
  f.sdk.backend.restoreCache = async (...args) => {
    const result = await restore(...args);
    if (args[1] === f.b.reference[2])
      await writeFile(args[3]!.archiveRoot! + '/payload/extra', 'x');
    return result;
  };
  await expect(
    ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget }),
  ).rejects.toThrow();
  await p.dispose();
  expect(f.budget.retained).toBe(0);
});
it.each(['oversize', 'malformed', 'partial', 'wrong-key'] as const)(
  'rejects %s record before admitting a pin',
  async (kind) => {
    const f = await fixture(),
      restore = f.sdk.backend.restoreCache.bind(f.sdk.backend);
    f.sdk.backend.restoreCache = async (...args) => {
      const result = await restore(...args);
      if (kind === 'oversize')
        await writeFile(args[3]!.archiveRoot! + '/record.json', Buffer.alloc(65537, 32));
      if (kind === 'malformed') await writeFile(args[3]!.archiveRoot! + '/record.json', '{}\n');
      if (kind === 'partial') return undefined;
      return kind === 'wrong-key' ? 'wrong-key' : result;
    };
    await expect(
      PinnedBaseGeneration.discover(
        f.store,
        f.sdk.backend,
        { currentRef: 'refs/heads/main' },
        { budget: f.budget },
      ),
    ).rejects.toThrow();
    expect(f.budget.retained).toBe(0);
  },
);
it('surfaces exposed backend errors but treats an empty unavailable generation as cold', async () => {
  const f = await fixture();
  f.sdk.backend.restoreCache = async () => undefined;
  await expect(
    PinnedBaseGeneration.discover(
      f.store,
      f.sdk.backend,
      { currentRef: 'refs/heads/main' },
      { budget: f.budget },
    ),
  ).resolves.toBeNull();
  f.sdk.backend.restoreCache = async () => {
    throw new Error('exposed transport failure');
  };
  await expect(
    PinnedBaseGeneration.discover(
      f.store,
      f.sdk.backend,
      { currentRef: 'refs/heads/main' },
      { budget: f.budget },
    ),
  ).rejects.toThrow('exposed transport');
});
it('rejects wrong authorized lineage on exact local resume and fake pins before object RPCs', async () => {
  const f = await fixture();
  await expect(
    PinnedBaseGeneration.resume(
      f.store,
      f.generation[11],
      f.q,
      { currentRef: 'refs/heads/other' },
      { budget: f.budget },
    ),
  ).rejects.toThrow('authorized lineages');
  const calls = f.sdk.calls.length;
  await expect(
    ProvisionalBaseSet.acquire(
      { lease: () => () => {}, assertStable: async () => {} } as unknown as PinnedBaseGeneration,
      f.sdk.backend,
      { budget: f.budget },
    ),
  ).rejects.toThrow('Unbound');
  expect(f.sdk.calls).toHaveLength(calls);
  expect(f.budget.retained).toBe(0);
});

it.each(['pin', 'set'] as const)(
  'rejects new capability use while %s retirement awaits filesystem work',
  async (which) => {
    const f = await fixture(),
      p = await pin(f),
      s =
        which === 'set'
          ? await ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget })
          : null;
    if (s) sets.push(s);
    const retire = retirement.retireOwnedDirectory;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    vi.spyOn(retirement, 'retireOwnedDirectory').mockImplementation(async (...args) => {
      entered();
      await gate;
      return retire(...args);
    });
    const done = which === 'pin' ? p.dispose() : s!.dispose();
    await ready;
    try {
      if (which === 'pin')
        await expect(
          ProvisionalBaseSet.acquire(p, f.sdk.backend, { budget: f.budget }),
        ).rejects.toThrow('retired');
      else expect(() => s!.available()).toThrow('retired');
    } finally {
      release();
      await done;
    }
  },
);
