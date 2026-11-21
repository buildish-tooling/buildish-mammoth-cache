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

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  baseFixture,
  preparedBase,
  nativeCacheBackend,
  seedBaseGeneration,
  cleanupBaseFixtures,
} from './base-fixtures';
import {
  PinnedBaseGeneration,
  ProvisionalBaseSet,
} from '../../../src/cache/streaming/base-generation';
import { NativeObjectSave } from '../../../src/cache/streaming/base-transport';
import {
  acceptBaseGeneration,
  installBaseGeneration,
} from '../../../src/cache/streaming/base-incoming';
import { resolveModel } from '../../../src/cache/streaming/model';
import * as nativeWalk from '../../../src/cache/streaming/native-walk';
import { baseFileBytes } from '../../../src/cache/streaming/base-layout';
import { decodeGeneration } from '../../../src/cache/streaming/native-records';
import { recoverInstall } from '../../../src/cache/streaming/install-execute';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { tuple } from '../../../src/cache/streaming/encoding';
import { initializeCompleteFixture } from './worker-complete-fixtures';
import { mergeWorkerArchives } from '../../../src/cache/streaming/worker-merge';
import { acceptWorkerMerge } from '../../../src/cache/streaming/worker-incoming';
const pins: PinnedBaseGeneration[] = [],
  sets: ProvisionalBaseSet[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sets.splice(0)) await s.dispose();
  for (const p of pins.splice(0)) await p.dispose();
  await cleanupBaseFixtures();
});
async function acquire(
  f: Awaited<ReturnType<typeof baseFixture>>,
  sdk: Awaited<ReturnType<typeof nativeCacheBackend>>,
) {
  await initializeCompleteFixture({ ...f, context: f.store.codec.options.context }, []);
  const pin = (await PinnedBaseGeneration.discover(
    f.store,
    sdk.backend,
    { currentRef: 'refs/heads/main' },
    { budget: f.budget },
  ))!;
  pins.push(pin);
  const set = await ProvisionalBaseSet.acquire(pin, sdk.backend, { budget: f.budget });
  sets.push(set);
  return set;
}
it('installs a real native generation through V4a with sync but no normal base body hash or copy', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    o = await preparedBase(f, { 'data/a': 'abc' });
  await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
  const set = await acquire(f, sdk),
    reads = vi.spyOn(NativeReadPhase.prototype, 'read'),
    result = await acceptBaseGeneration(f.store, set, { budget: f.budget });
  expect(reads).not.toHaveBeenCalled();
  expect(result.snapshotCopyBytes).toBe(0);
  expect(result.cold).toEqual([]);
  await installBaseGeneration(f.store, result, { budget: f.budget });
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('abc');
  expect(tuple(await f.store.state())[4]).toBe('prepare-pending');
  await set.dispose();
  await set.pin.dispose();
  const baseline = tuple(result.baseline),
    record = f.store.codec.schemas.ref('generation').parse(baseline[2]);
  expect(
    decodeGeneration(await baseFileBytes(f.store, record), f.model, String(baseline[1]))[11],
  ).toBe(baseline[1]);
  expect(record[2]).not.toBe(set.pin.record[2]);
  expect(f.budget.retained).toBe(0);
});
it('retains independent nonempty/empty snapshots and passes the genuine baseline to optional-worker fallback', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [
          ['data', ['data/**'], hard, 'aggregate', null, 'default'],
          ['state', ['state/**'], hard, 'single-writer', null, 'default'],
          ['other', ['other/**'], hard, 'single-writer', null, 'default'],
        ],
      ],
      'snap-',
      1,
    ),
    f = await baseFixture(model),
    sdk = await nativeCacheBackend(),
    data = await preparedBase(f, { 'data/a': 'a' }, 'data'),
    state = await preparedBase(f, { 'state/a': 'snapshot' }, 'state');
  for (const o of [data, state]) await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [
    ['object', 'data', data.reference],
    ['object', 'state', state.reference],
    ['empty', 'other'],
  ]);
  await mkdir(f.store.root.resolve('other'), { recursive: true });
  await writeFile(f.store.root.resolve('other/stale'), 'old');
  const set = await acquire(f, sdk),
    result = await acceptBaseGeneration(f.store, set, { budget: f.budget });
  expect(result.snapshotCopyBytes).toBe(8);
  expect(result.snapshots).toHaveLength(2);
  const retained = result.snapshots.find((s) => s.partition === 'state')!,
    empty = result.snapshots.find((s) => s.partition === 'other')!;
  expect(empty.provenance).toBe(set.pin.key);
  expect((await f.store.root.stat(retained.nativeRoot + '/state/a'))![4]).not.toBe(
    (await f.store.root.stat(f.store.prefix + 'install/state/state/a'))![4],
  );
  await installBaseGeneration(f.store, result, { budget: f.budget });
  expect(await f.store.root.stat('other/stale')).toBeNull();
  expect(await readFile(f.store.root.resolve(retained.nativeRoot + '/state/a'), 'utf8')).toBe(
    'snapshot',
  );
  const merged = await mergeWorkerArchives(f.store, [], {
    budget: f.budget,
    ordinaryOrder: [],
    ordinaryPolicy: 'strict',
    snapshots: [
      { partition: 'state', job: 'absent', required: false, baseline: retained },
      { partition: 'other', job: 'absent', required: false, baseline: empty },
    ],
  });
  try {
    const workers = await acceptWorkerMerge(f.store, merged, f.budget);
    expect(workers.snapshots).toEqual(result.snapshots);
  } finally {
    await merged.dispose();
  }
  await retained.verify(new AbortController().signal);
  await empty.verify(new AbortController().signal);
});
async function maven() {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['artifacts', ['repository/**/*.jar'], hard, 'aggregate', null, 'default'],
          ['origins', ['repository/**/_remote.repositories'], hard, 'aggregate', null, 'default'],
          ['poms', ['repository/**/*.pom'], hard, 'aggregate', null, 'default'],
          ['other', ['other/**'], hard, 'aggregate', null, 'default'],
        ],
      ],
      'groups-',
      1,
    ),
    f = await baseFixture(model),
    sdk = await nativeCacheBackend(),
    specs: { partition: string; files: Record<string, string> }[] = [
      { partition: 'artifacts', files: { 'repository/g/a/1/a.jar': 'jar' } },
      {
        partition: 'origins',
        files: {
          'repository/g/a/1/_remote.repositories': 'one',
          'repository/g/a/2/_remote.repositories': 'two',
        },
      },
      { partition: 'poms', files: { 'repository/g/a/2/a.pom': 'pom' } },
      { partition: 'other', files: { 'other/a': 'other' } },
    ],
    objects = [];
  for (const spec of specs) {
    const o = await preparedBase(f, spec.files, spec.partition);
    objects.push(o);
    await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  }
  await seedBaseGeneration(
    f,
    sdk,
    objects.map((o) => ['object', o.reference[1][2], o.reference]),
    [['artifacts', 'origins', 'poms'], ['other']],
  );
  return { ...f, sdk, objects };
}
it('reconstructs transitive direct-Maven owner groups and installs complete projections together', async () => {
  const f = await maven(),
    set = await acquire(f, f.sdk),
    result = await acceptBaseGeneration(f.store, set, { budget: f.budget });
  expect(result.cold).toEqual([]);
  await installBaseGeneration(f.store, result, { budget: f.budget });
  for (const name of [
    'repository/g/a/1/a.jar',
    'repository/g/a/1/_remote.repositories',
    'repository/g/a/2/a.pom',
    'other/a',
  ])
    expect(await f.store.root.stat(name)).not.toBeNull();
}, 30000);
it('keeps an unavailable Maven recovery group entirely cold while an independent group installs', async () => {
  const f = await maven();
  f.sdk.objects.delete(f.objects[1].reference[2]);
  const set = await acquire(f, f.sdk),
    result = await acceptBaseGeneration(f.store, set, { budget: f.budget });
  expect(result.cold).toEqual([['artifacts', 'origins', 'poms']]);
  expect(result.incoming).toHaveLength(1);
  await installBaseGeneration(f.store, result, { budget: f.budget });
  expect(await f.store.root.stat('repository')).toBeNull();
  expect(await readFile(f.store.root.resolve('other/a'), 'utf8')).toBe('other');
});
it('rejects invented Maven joins before any incoming root is published', async () => {
  const f = await maven();
  await seedBaseGeneration(
    f,
    f.sdk,
    f.objects.map((o) => ['object', o.reference[1][2], o.reference]),
    [['artifacts', 'origins', 'poms', 'other']],
  );
  const set = await acquire(f, f.sdk);
  await expect(acceptBaseGeneration(f.store, set, { budget: f.budget })).rejects.toThrow(
    'Invented',
  );
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBeNull();
  expect(await f.store.root.stat('other/a')).toBeNull();
});
it('keeps source writes, stats, spools and syncs linear across shared native parents', async () => {
  const counts = [];
  for (const count of [4, 16]) {
    const f = await baseFixture(),
      sdk = await nativeCacheBackend(),
      files = Object.fromEntries(
        Array.from({ length: count }, (_, i) => ['data/f' + String(i).padStart(2, '0'), 'x']),
      ),
      o = await preparedBase(f, files);
    await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
    await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
    const set = await acquire(f, sdk),
      before = { ...f.store.root.work },
      result = await acceptBaseGeneration(f.store, set, { budget: f.budget });
    counts.push({
      syncs: f.store.root.work.fileSyncs - before.fileSyncs,
      stats: f.store.root.work.stats - before.stats,
      scratch: f.store.root.work.scratchWriteBytes - before.scratchWriteBytes,
      writes: f.store.root.work.writeBytes - before.writeBytes,
      reads: f.store.root.work.readBytes - before.readBytes,
    });
    expect(result.snapshotCopyBytes).toBe(0);
    await installBaseGeneration(f.store, result, { budget: f.budget });
  }
  expect(counts[1].syncs - counts[0].syncs).toBe(12);
  expect(counts[1].stats).toBeLessThan(counts[0].stats * 4);
  expect(counts[1].scratch).toBeLessThanOrEqual(counts[0].scratch * 5);
  expect(counts[1].writes).toBeLessThan(counts[0].writes * 5);
  expect(counts[1].reads).toBeLessThan(counts[0].reads * 5);
});

it('rejects declared group splits when actual direct Maven ownership crosses them', async () => {
  const f = await maven();
  await seedBaseGeneration(
    f,
    f.sdk,
    f.objects.map((o) => ['object', o.reference[1][2], o.reference]),
    [['artifacts'], ['origins', 'poms'], ['other']],
  );
  const set = await acquire(f, f.sdk);
  await expect(acceptBaseGeneration(f.store, set, { budget: f.budget })).rejects.toThrow('crosses');
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBeNull();
});
it('rejects a late native change before staging any incoming root', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    o = await preparedBase(f, { 'data/a': 'abc' });
  await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
  const set = await acquire(f, sdk);
  await writeFile(f.store.root.resolve(set.downloads[0].object!.payload + '/data/a'), 'xyz');
  await expect(acceptBaseGeneration(f.store, set, { budget: f.budget })).rejects.toThrow();
  expect(await f.store.root.stat('data/a')).toBeNull();
  expect(await f.store.root.stat(f.store.prefix + 'install')).toBeNull();
});
it('preserves V4a-owned sources after interrupted install even when SDK download owners retire', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    o = await preparedBase(f, { 'data/a': 'a', 'data/b': 'b' });
  await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
  const set = await acquire(f, sdk),
    result = await acceptBaseGeneration(f.store, set, { budget: f.budget }),
    fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point === 'install-source-renamed') throw new Error('interrupted native base install');
    });
  await expect(installBaseGeneration(f.store, result, { budget: f.budget })).rejects.toThrow(
    'interrupted',
  );
  fail.mockRestore();
  await set.dispose();
  expect(await f.store.readFixed(f.store.prefix + 'install-intent.json')).not.toBeNull();
  await recoverInstall(f.store, f.budget);
  expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
  expect(await readFile(f.store.root.resolve('data/b'), 'utf8')).toBe('b');
});
it('blocks provisional-set disposal while a native install acceptance owns its source lease', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    o = await preparedBase(f, { 'data/a': 'a' });
  await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
  const set = await acquire(f, sdk),
    sync = NativeReadPhase.prototype.sync;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  vi.spyOn(NativeReadPhase.prototype, 'sync').mockImplementation(async function (
    this: NativeReadPhase,
    ...args
  ) {
    entered();
    await gate;
    return sync.apply(this, args);
  });
  const pending = acceptBaseGeneration(f.store, set, { budget: f.budget });
  await ready;
  try {
    await expect(set.dispose()).rejects.toThrow('active consumers');
  } finally {
    release();
  }
  const result = await pending;
  await installBaseGeneration(f.store, result, { budget: f.budget });
});

it('reconciles an owned rename that completed before its helper returned an error', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    o = await preparedBase(f, { 'data/a': 'abc' });
  await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  await seedBaseGeneration(f, sdk, [['object', 'data', o.reference]]);
  const set = await acquire(f, sdk),
    object = set.downloads[0].object!,
    before = (await f.store.root.stat(object.payload))!,
    rename = f.store.root.renameAbsent.bind(f.store.root);
  let injected = false;
  vi.spyOn(f.store.root, 'renameAbsent').mockImplementation(async (...args) => {
    const result = await rename(...args);
    if (!injected && args[1] === f.store.prefix + 'install/data') {
      injected = true;
      throw new Error('post-syscall failure');
    }
    return result;
  });
  await expect(acceptBaseGeneration(f.store, set, { budget: f.budget })).rejects.toThrow(
    'post-syscall',
  );
  expect((await f.store.root.stat(object.payload))![4]).toBe(before[4]);
  expect(await f.store.root.stat(f.store.prefix + 'install/data')).toBeNull();
  expect(await f.store.root.stat('data/a')).toBeNull();
});
it.each([false, true])(
  'rejects an unplanned empty directory in a snapshot copy (empty source=%s)',
  async (empty) => {
    const hard = ['.mammoth/**'],
      model = resolveModel(
        [
          'model',
          1,
          'gradle',
          hard,
          [['state', ['state/**'], hard, 'single-writer', null, 'default']],
        ],
        'copy-proof-',
        1,
      ),
      f = await baseFixture(model),
      sdk = await nativeCacheBackend();
    if (empty) await seedBaseGeneration(f, sdk, [['empty', 'state']]);
    else {
      const o = await preparedBase(f, { 'state/a': 'a' }, 'state');
      await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
      await seedBaseGeneration(f, sdk, [['object', 'state', o.reference]]);
    }
    const set = await acquire(f, sdk),
      walk = nativeWalk.walkNative;
    vi.spyOn(nativeWalk, 'walkNative').mockImplementation((...args) => {
      const original = walk(...args);
      return (async function* () {
        if (args[1].endsWith('/copy')) await mkdir(f.store.root.resolve(args[1] + '/unplanned'));
        yield* original;
      })();
    });
    await expect(acceptBaseGeneration(f.store, set, { budget: f.budget })).rejects.toThrow(
      'copy directory',
    );
    expect(await f.store.root.stat(f.store.prefix + 'install/state')).toBeNull();
    expect(await f.store.root.stat('state')).toBeNull();
  },
);
