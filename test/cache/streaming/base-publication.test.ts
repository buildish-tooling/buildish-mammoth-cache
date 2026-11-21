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

import { writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { FrozenBasePublication } from '../../../src/cache/streaming/base-publication';
import { NativeObjectDownload } from '../../../src/cache/streaming/base-transport';
import { PreparedBaseSource } from '../../../src/cache/streaming/base-object';
import type { Value } from '../../../src/cache/streaming/encoding';
import { cleanupBaseFixtures, nativeCacheBackend } from './base-fixtures';
import {
  publicationFixture,
  restartPublisher,
  receipts,
  stream,
} from './base-publication-fixtures';
afterEach(() => {
  vi.restoreAllMocks();
  return cleanupBaseFixtures();
});
async function freeze(f: Awaited<ReturnType<typeof publicationFixture>>) {
  return FrozenBasePublication.freeze(
    f.store,
    'refs/heads/main',
    [{ kind: 'new', source: f.source }],
    { budget: f.budget },
  );
}
it.each([false, true])(
  'freezes exact identities after real post-source commitment; source=%s',
  async (single) => {
    const f = await publicationFixture(undefined, single),
      sdk = await nativeCacheBackend(),
      p = await freeze(f);
    await f.source.dispose();
    try {
      expect(sdk.calls).toEqual([]);
      await p.saveObjects(sdk.backend);
      expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(1);
      const cell = (await receipts(f))[0] as Value[];
      expect((cell[5] as Value[])[0]).toBe('object-receipt');
      expect(((await f.store.state()) as Value[])[4]).toBe('sources-returned');
      expect(sdk.objects.has(p.generation[11])).toBe(false);
    } finally {
      p.dispose();
    }
    expect(f.budget.retained).toBe(0);
  },
);
it('resumes original evidence and keys with no latest or history lookup', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    first = await freeze(f),
    key = first.generation[8];
  first.dispose();
  await f.source.dispose();
  const next = await FrozenBasePublication.resume(await restartPublisher(f.store), {
    budget: f.budget,
  });
  try {
    expect(next.generation[8]).toEqual(key);
    await next.saveObjects(sdk.backend);
  } finally {
    next.dispose();
  }
  expect(sdk.calls.some((c) => c.kind === 'lookup')).toBe(false);
  expect(f.budget.retained).toBe(0);
});
it('rejects resumed changed sources instead of recapturing their native identities', async () => {
  const f = await publicationFixture(),
    p = await freeze(f);
  p.dispose();
  await f.source.dispose();
  await writeFile(f.store.root.resolve(f.payload + '/a'), 'xyz');
  await expect(
    FrozenBasePublication.resume(await restartPublisher(f.store), { budget: f.budget }),
  ).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it.each(['before', 'after', 'unknown'])(
  'reconciles lost response %s under the same key',
  async (when) => {
    const f = await publicationFixture(),
      sdk = await nativeCacheBackend(),
      p = await freeze(f),
      save = sdk.backend.saveCache.bind(sdk.backend);
    let first = true;
    vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        if (when !== 'before') await save(...args);
        if (when === 'unknown') return -1;
        throw new Error('lost');
      }
      return save(...args);
    });
    try {
      if (when === 'before')
        await expect(p.saveObjects(sdk.backend)).rejects.toThrow('unconfirmed');
      await p.saveObjects(sdk.backend);
      expect((await receipts(f))[0]).toBeTruthy();
      expect(new Set(sdk.calls.filter((c) => c.kind === 'save').map((c) => c.key)).size).toBe(1);
    } finally {
      p.dispose();
      await f.source.dispose();
    }
  },
);
it('requires strong readback after post-stage mutation but grants no source receipt', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    p = await freeze(f),
    save = sdk.backend.saveCache.bind(sdk.backend),
    readback = vi.spyOn(NativeObjectDownload, 'restore');
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    const id = await save(...args),
      transient = f.store.root.resolve(f.payload + '/transient');
    await writeFile(transient, 'x');
    await rm(transient);
    return id;
  });
  try {
    await expect(p.saveObjects(sdk.backend)).rejects.toThrow();
    expect(readback.mock.calls[0][4]).toBe(true);
    expect((await receipts(f))[0] as Value[]).toHaveProperty('5', null);
    expect(sdk.objects.has(p.generation[11])).toBe(false);
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it('rejects wrong exact-key readback and never substitutes a fresh identity', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    p = await freeze(f);
  vi.spyOn(sdk.backend, 'saveCache').mockResolvedValue(-1);
  vi.spyOn(sdk.backend, 'restoreCache').mockResolvedValue('wrong-key');
  try {
    await expect(p.saveObjects(sdk.backend)).rejects.toThrow('exact-key');
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it('keeps backend-active sources alive on cancellation and blocks disposal', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    abort = new AbortController(),
    p = await FrozenBasePublication.freeze(
      f.store,
      'refs/heads/main',
      [{ kind: 'new', source: f.source }],
      { budget: f.budget, signal: abort.signal },
    );
  let release!: () => void, entered!: () => void;
  const start = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async () => {
    entered();
    await wait;
    expect(await readFile(f.store.root.resolve(f.payload + '/a'), 'utf8')).toBe('abc');
    return 1;
  });
  const work = p.saveObjects(sdk.backend);
  await start;
  abort.abort(new Error('cancel'));
  expect(() => p.dispose()).toThrow('active');
  release();
  await expect(work).rejects.toThrow();
  p.dispose();
  await f.source.dispose();
});
it('rejects live root changes, GC/relocation state and uncommitted source replacement', async () => {
  const f = await publicationFixture(undefined, true);
  await mkdir(f.store.root.resolve('live'));
  await expect(freeze(f)).rejects.toThrow();
  await rm(f.store.root.resolve('live'), { recursive: true });
  // Original root ctime is evidence too: removing the extra directory cannot repair it.
  await expect(freeze(f)).rejects.toThrow();
  await f.source.dispose();
  expect(f.budget.retained).toBe(0);
});
it('reconciles same-process partial metadata without replacing it or hashing source bodies again', async () => {
  const f = await publicationFixture(),
    write = f.store.writeNativeMetadata.bind(f.store);
  let fail = true;
  vi.spyOn(f.store, 'writeNativeMetadata').mockImplementation(async (...args) => {
    if (args[1] === 'envelope.json' && fail) {
      fail = false;
      throw new Error('interrupted render');
    }
    return write(...args);
  });
  await expect(freeze(f)).rejects.toThrow('interrupted render');
  await expect(PreparedBaseSource.capture(f.store, 'data', { budget: f.budget })).rejects.toThrow(
    'cannot recapture',
  );
  await expect(
    FrozenBasePublication.resume(await restartPublisher(f.store), { budget: f.budget }),
  ).rejects.toThrow('No committed');
  const hash = vi.spyOn(PreparedBaseSource, 'capture'),
    p = await freeze(f);
  expect(hash).not.toHaveBeenCalled();
  p.dispose();
  await f.source.dispose();
  expect(f.budget.retained).toBe(0);
});
it('rejects an absent single-writer post-source despite a genuine prepared source', async () => {
  const f = await publicationFixture(undefined, true),
    state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[7] = f.store.codec.schemas
    .ref('post-sources')
    .parse(
      await f.store.writeStream('post-sources', { budget: f.budget, partition: null }, stream([])),
    );
  await f.store.updateState(state);
  await expect(freeze(f)).rejects.toThrow('committed source');
  await f.source.dispose();
});

it('detects corrupted remote bodies on the mandatory strong readback path', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    p = await freeze(f),
    save = sdk.backend.saveCache.bind(sdk.backend);
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    const file = f.store.root.resolve(f.payload + '/a');
    await writeFile(file, 'bad');
    const { utimes } = await import('node:fs/promises');
    await utimes(file, 1.234, 1.234);
    return save(...args);
  });
  try {
    await expect(p.saveObjects(sdk.backend)).rejects.toThrow('content differs');
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it('rejects changed phase evidence instead of accepting a newly observed live-root identity', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    p = await freeze(f),
    state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[6] = f.store.codec.schemas.ref('observations').parse(
    await f.store.writeStream(
      'observations',
      { budget: f.budget, partition: null },
      stream([
        ['dir-open', '', (await f.store.root.stat(''))!],
        ['dir-close', ''],
      ]),
    ),
  );
  await f.store.updateState(state);
  try {
    await expect(p.saveObjects(sdk.backend)).rejects.toThrow('phase evidence');
    expect(sdk.calls).toEqual([]);
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});

it('checks each native source a constant number of times as partition fan-in grows 4→16', async () => {
  const { resolveModel } = await import('../../../src/cache/streaming/model'),
    { createBasePayload } = await import('../../../src/cache/streaming/base-object'),
    evidence = await import('../../../src/cache/streaming/install-evidence'),
    { baseFixture } = await import('./base-fixtures'),
    { initializePublisher } = await import('./base-publication-fixtures');
  for (const count of [4, 16]) {
    const hard = ['.mammoth/**'],
      ids = Array.from({ length: count }, (_, n) => 'p' + String(n).padStart(2, '0')),
      f = await baseFixture(
        resolveModel(
          [
            'model',
            1,
            'maven',
            hard,
            ids.map((p) => [p, [p + '/**'], hard, 'aggregate', null, 'default']),
          ],
          'fan-',
          1,
        ),
      ),
      sources: PreparedBaseSource[] = [];
    for (const id of ids) {
      const root = await createBasePayload(f.store, id);
      await mkdir(f.store.root.resolve(root + '/' + id));
      await writeFile(f.store.root.resolve(root + '/' + id + '/a'), 'x', { mode: 0o644 });
      sources.push(await PreparedBaseSource.capture(f.store, id, { budget: f.budget }));
    }
    await initializePublisher(f);
    const p = await FrozenBasePublication.freeze(
        f.store,
        'refs/heads/main',
        sources.map((source) => ({ kind: 'new', source })),
        { budget: f.budget },
      ),
      spy = vi.spyOn(evidence, 'verifyNativeEvidence'),
      sdk = await nativeCacheBackend();
    try {
      await p.saveObjects(sdk.backend);
      expect(spy.mock.calls.length).toBe(5 * count);
      for (const id of ids) expect(spy.mock.calls.filter((c) => c[3] === id)).toHaveLength(5);
      expect(sdk.calls.filter((c) => c.kind === 'save').every((c) => c.paths.length === 3)).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
      p.dispose();
      for (const s of sources) await s.dispose();
    }
    expect(f.budget.retained).toBe(0);
  }
}, 30000);

it.each([false, true])(
  'empty snapshot choice agrees with committed source contents: populated=%s',
  async (populated) => {
    const f = await publicationFixture(populated ? { a: 'x' } : {}, true),
      sdk = await nativeCacheBackend();
    if (populated)
      await expect(
        FrozenBasePublication.freeze(
          f.store,
          'refs/heads/main',
          [{ kind: 'empty', partition: 'data' }],
          { budget: f.budget },
        ),
      ).rejects.toThrow('discards');
    else {
      const p = await FrozenBasePublication.freeze(
        f.store,
        'refs/heads/main',
        [{ kind: 'empty', partition: 'data' }],
        { budget: f.budget },
      );
      try {
        await p.saveObjects(sdk.backend);
        expect(sdk.calls).toEqual([]);
        expect(p.generation[8]).toEqual([['empty', 'data']]);
      } finally {
        p.dispose();
      }
    }
    await f.source.dispose();
    expect(f.budget.retained).toBe(0);
  },
);
it('reuses only an exact pinned reference without another object upload', async () => {
  const { resolveModel } = await import('../../../src/cache/streaming/model'),
    { encodeRecord } = await import('../../../src/cache/streaming/encoding'),
    { baseFixture, preparedBase, seedBaseGeneration } = await import('./base-fixtures'),
    { initializePublisher } = await import('./base-publication-fixtures'),
    hard = ['.mammoth/**'],
    f = await baseFixture(
      resolveModel(
        ['model', 1, 'maven', hard, [['data', ['**'], hard, 'aggregate', null, 'default']]],
        'reuse-',
        1,
      ),
    ),
    sdk = await nativeCacheBackend(),
    object = await preparedBase(f, { a: 'old' }),
    baseline = await seedBaseGeneration(f, sdk, [['object', 'data', object.reference]]),
    q = await f.store.write(
      'generation',
      (async function* () {
        yield encodeRecord(baseline);
      })(),
    );
  await initializePublisher(f, [], ['baseline', baseline[11], q]);
  sdk.calls.length = 0;
  const p = await FrozenBasePublication.freeze(
    f.store,
    'refs/heads/new',
    [{ kind: 'reuse', object }],
    { budget: f.budget },
  );
  try {
    await p.saveObjects(sdk.backend);
    expect(sdk.calls).toEqual([]);
    expect(p.generation[8][0]).toEqual(['object', 'data', object.reference]);
    expect(p.generation[8][0][2]![1][3]).not.toBe(p.generation[5]);
  } finally {
    p.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it('rejects a broader directory allowance than the committed policy before source consumers', async () => {
  const f = await publicationFixture();
  await expect(
    FrozenBasePublication.freeze(f.store, 'refs/heads/main', [{ kind: 'new', source: f.source }], {
      budget: f.budget,
      maxDirectoryEntries: 200000,
    }),
  ).rejects.toThrow('committed policy');
  const p = await freeze(f);
  p.dispose();
  await expect(
    FrozenBasePublication.resume(f.store, { budget: f.budget, maxDirectoryEntries: 200000 }),
  ).rejects.toThrow('committed policy');
  await f.source.dispose();
  expect(f.budget.retained).toBe(0);
});
