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

import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  rename,
  rm,
  symlink,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import {
  NativeRoot,
  nativeIdentity,
  sameNative,
  sameObject,
  sameRename,
  type Failpoint,
} from '../../../src/cache/streaming/native';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { rawSha, type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures, h } from './local-fixtures';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(fail?: Failpoint) {
  const root = await mkdtemp(path.resolve('build/owned-store-'));
  roots.push(root);
  const f = localFixtures(),
    store = await OwnedStore.bind(root, f.codec, fail);
  const bindings = structuredClone(f.bindings);
  bindings[5] = [store.root.path, store.root.binding];
  return { ...f, root, store, bindings };
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const b of source) chunks.push(Buffer.from(b));
  return Buffer.concat(chunks);
}
it('captures bigint native identities and distinguishes locator identity from mutable directory facts', async () => {
  const f = await fixture(),
    before = f.store.root.binding;
  await writeFile(path.join(f.root, 'file'), 'body');
  expect(sameObject(before, nativeIdentity(await lstat(f.root, { bigint: true })))).toBe(true);
  await f.store.root.verifyRoot();
  const file = (await f.store.root.stat('file'))!;
  expect(file[5]).toBe('4');
  expect(typeof file[8]).toBe('string');
  const accessed = structuredClone(file);
  accessed[7] = String(BigInt(accessed[7]) + 1n);
  expect(sameNative(file, accessed)).toBe(false);
  expect(sameNative(file, accessed, true)).toBe(true);
  accessed[9] = String(BigInt(accessed[9]) + 1n);
  expect(sameNative(file, accessed, true)).toBe(false);
});
it('rejects root replacement and unsafe link ancestors', async () => {
  const f = await fixture(),
    moved = f.root + '-moved';
  roots.push(moved);
  await rename(f.root, moved);
  await mkdir(f.root);
  await expect(f.store.root.verifyRoot()).rejects.toThrow('replaced');
  const root = await NativeRoot.bind(f.root);
  await mkdir(path.join(f.root, 'actual'));
  await symlink(
    path.join(f.root, 'actual'),
    path.join(f.root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(root.stat('linked/file')).rejects.toThrow('Unsupported');
});
it('hashes guarded bytes and refuses overwrite in native rename', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'from'), 'body');
  const n = (await f.store.root.stat('from'))!;
  expect(await f.store.root.hash('from', n)).toBe(rawSha(Buffer.from('body')));
  await writeFile(path.join(f.root, 'to'), 'existing');
  await expect(f.store.root.renameAbsent('from', 'to', n)).rejects.toThrow('destination');
  await rm(path.join(f.root, 'to'));
  const after = await f.store.root.renameAbsent('from', 'to', n);
  expect(sameRename(n, after)).toBe(true);
  expect(await readFile(path.join(f.root, 'to'), 'utf8')).toBe('body');
});
it('publishes exact immutable bytes after file sync and native rename', async () => {
  const events: string[] = [],
    f = await fixture(async (event) => {
      events.push(event);
    });
  const bytes = Buffer.from('artifact bytes');
  const ref = await f.store.write(
    'worker-archive',
    (async function* () {
      yield bytes;
    })(),
  );
  expect(f.store.root.durability).toBe(
    process.platform === 'win32' ? 'file-sync-native-replace' : 'file-and-directory-sync',
  );
  expect(f.store.root.work.directorySyncs > 0).toBe(process.platform !== 'win32');
  expect(events).toEqual([
    'immutable-file-sync',
    'immutable-rename',
    'immutable-publication-barrier',
  ]);
  expect(ref.slice(3)).toEqual([bytes.length, rawSha(bytes)]);
  expect(await collect(f.store.read(ref, 'worker-archive'))).toEqual(bytes);
  await expect(collect(f.store.read(ref, 'native-tree'))).rejects.toThrow();
  await writeFile(f.store.root.resolve(ref[2]), 'tampered');
  await expect(collect(f.store.read(ref, 'worker-archive'))).rejects.toThrow();
});
it('streams local records into Q without a whole-file size quota', async () => {
  const f = await fixture(),
    budget = new WorkingBudget(),
    count = 1500;
  const ref = await f.store.writeStream(
    'installations',
    { budget, partition: null },
    (async function* () {
      for (let i = 0; i < count; i++)
        yield [
          'installation',
          ['gradle-installation', 1, f.options.invocation, '/gradle', 'v' + i, '/cache', '/java'],
        ] as Value;
    })(),
  );
  expect(ref[3]).toBeGreaterThan(65536);
  let records = 0;
  await f.store.readStream(ref, 'installations', { budget, partition: null }, async (row) => {
    if (Array.isArray(row) && row[0] === 'installation') records++;
  });
  expect(records).toBe(count);
  expect(budget.retained).toBe(0);
  await expect(f.store.readDocument(ref, 'installations')).rejects.toThrow('record bound');
});
it('publishes state before locator and discovers fixed intents even when unreferenced', async () => {
  const f = await fixture(),
    state = await f.store.initialize(f.bindings);
  expect((await f.store.locator())?.[2]).toBe(f.options.invocation);
  expect(await f.store.state()).toEqual(state);
  const intent: Value = [
    'install-intent',
    1,
    f.options.invocation,
    f.q('install-plan'),
    f.cursor(),
    f.cursor(1),
    f.q('install-evidence'),
  ];
  await f.store.publishIntent(intent);
  const again = await OwnedStore.bind(f.root, f.codec);
  await expect(again.assertNoIntents()).rejects.toThrow('destructive intent');
  await f.store.clearIntent(intent);
  await again.assertNoIntents();
});
it.each(['fixed-file-sync', 'fixed-rename', 'fixed-publication-barrier'])(
  'keeps authoritative pointer coherent after %s failure',
  async (point) => {
    let armed = false;
    const f = await fixture(async (name) => {
      if (armed && name === point) throw new Error(point);
    });
    const state = await f.store.initialize(f.bindings),
      next = structuredClone(state) as Value[];
    next[3] = 1;
    armed = true;
    await expect(f.store.updateState(next)).rejects.toThrow(point);
    const reload = await OwnedStore.bind(f.root, f.codec),
      actual = (await reload.state()) as Value[];
    expect(actual[3]).toBe(point === 'fixed-file-sync' ? 0 : 1);
    if (point === 'fixed-file-sync') await reload.updateState(next);
    expect(((await reload.state()) as Value[])[3]).toBe(1);
  },
);
it('prevents retirement of referenced Q bytes and permits replaced root-state documents', async () => {
  const f = await fixture(),
    state = (await f.store.initialize(f.bindings)) as Value[],
    old = state[5]!;
  await expect(f.store.retireReplacedDocument(old)).rejects.toThrow('referenced');
  const updated = structuredClone(f.bindings);
  (updated[8] as Value[])[9] = 999;
  const q = await f.store.writeDocument(updated),
    next = structuredClone(state);
  next[3] = 1;
  next[5] = q;
  await f.store.updateState(next);
  await f.store.retireReplacedDocument(old);
  await expect(f.store.readDocument(old, 'bindings')).rejects.toThrow();
  expect(await f.store.readDocument(q, 'bindings')).toEqual(updated);
});
it('rehydrates an intent-bound prefix once, drops only its uncommitted tail and seals immutable Q', async () => {
  const f = await fixture();
  await f.store.initialize(f.bindings);
  await writeFile(path.join(f.root, 'file'), 'bytes');
  const n = (await f.store.root.stat('file'))!,
    budget = new WorkingBudget(),
    append = await f.store.append('outbound-evidence', 'data', budget);
  const transition = (index: number): Value => [
    'transition',
    index,
    1,
    'outbound',
    n,
    n,
    ['span', h, 1, 2],
  ];
  await append.append(transition(1));
  const prefix = await append.checkpoint();
  const before = f.store.root.work.readBytes;
  await append.checkpoint();
  expect(f.store.root.work.readBytes).toBe(before);
  await append.close();
  const marker = structuredClone(f.relocation);
  marker[11] = prefix;
  await f.store.publishIntent(marker);
  await appendFile(f.store.root.resolve(prefix[2]), 'uncommitted partial record');
  const reload = await OwnedStore.bind(f.root, f.codec),
    resumed = await reload.resumePrefix(prefix, 'outbound-evidence', 'data', budget, marker);
  await resumed.append(transition(2));
  const sealed = await resumed.seal();
  let count = 0;
  await reload.readStream(
    sealed,
    'outbound-evidence',
    { budget, partition: 'data' },
    async (row) => {
      if (Array.isArray(row) && row[0] === 'transition') count++;
    },
  );
  expect(count).toBe(2);
  expect(budget.retained).toBe(0);
  await expect(resumed.append(transition(3))).rejects.toThrow('Closed');
});
it('rejects prefix truncation without matching durable intent', async () => {
  const f = await fixture();
  await f.store.initialize(f.bindings);
  const budget = new WorkingBudget(),
    append = await f.store.append('adjustments', 'data', budget);
  const prefix = await append.checkpoint();
  await append.close();
  await expect(
    f.store.resumePrefix(prefix, 'adjustments', 'data', budget, f.relocation),
  ).rejects.toThrow('live intent');
});
it('rejects known legacy destructive intents without executing or deleting them', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, '.mammoth'));
  const legacy = path.join(f.root, '.mammoth/restore-move-v1.json');
  await writeFile(legacy, 'legacy');
  await expect(f.store.initialize(f.bindings)).rejects.toThrow('legacy');
  expect(await readFile(legacy, 'utf8')).toBe('legacy');
});

it('distinguishes completed legacy journals from unfinished legacy deletion without parsing a file catalogue', async () => {
  const f = await fixture(),
    id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    base = path.join(f.root, '.mammoth/cutoff-state-v2');
  await mkdir(base, { recursive: true });
  await writeFile(
    path.join(base, 'current.json'),
    JSON.stringify({ schemaVersion: 1, journal: 'journal-' + id + '.json' }) + '\n',
  );
  const journal = path.join(base, 'journal-' + id + '.json');
  await writeFile(
    journal,
    JSON.stringify({ schemaVersion: 6, invocation: id, phase: 'deleting', model: {} }) + '\n',
  );
  await expect(f.store.assertNoIntents()).rejects.toThrow('unfinished legacy');
  await writeFile(
    journal,
    JSON.stringify({ schemaVersion: 6, invocation: id, phase: 'completed', model: {} }) + '\n',
  );
  await f.store.assertNoIntents();
});
it('cancels an owned stream and closes/discards its unpublished candidate', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const source = async function* () {
    yield Buffer.from('data');
    controller.abort(new Error('cancel owned'));
    yield Buffer.from('more');
  };
  await expect(f.store.write('worker-archive', source(), controller.signal)).rejects.toThrow(
    'cancel owned',
  );
  const fresh = await f.store.write(
    'worker-archive',
    (async function* () {
      yield Buffer.from('next');
    })(),
  );
  expect(await collect(f.store.read(fresh, 'worker-archive'))).toEqual(Buffer.from('next'));
});

it('rejects truncating an adjustments Q committed before the old P marker is retired', async () => {
  const f = await fixture(),
    state = (await f.store.initialize(f.bindings)) as Value[],
    budget = new WorkingBudget();
  const append = await f.store.append('adjustments', 'data', budget);
  await append.append(['ancestor-effect', 'repository', '1', '3', h]);
  const prefix = await append.checkpoint(),
    q = await append.seal(),
    marker = structuredClone(f.relocation);
  marker[13] = prefix;
  await f.store.publishIntent(marker);
  const catalog = await f.store.writeStream(
    'partition-state',
    { budget, partition: null },
    (async function* () {
      yield [
        'partition-state',
        'data',
        ['baseline-partition', 'empty', null],
        q,
        null,
        null,
        null,
      ] as Value;
      yield [
        'partition-state',
        'metadata',
        ['baseline-partition', 'empty', null],
        null,
        null,
        null,
        null,
      ] as Value;
    })(),
  );
  const next = structuredClone(state);
  next[3] = 1;
  next[9] = catalog;
  await f.store.updateState(next);
  const before = await readFile(f.store.root.resolve(q[2]));
  await expect(f.store.resumePrefix(prefix, 'adjustments', 'data', budget, marker)).rejects.toThrow(
    'published as immutable',
  );
  expect(await readFile(f.store.root.resolve(q[2]))).toEqual(before);
});
it('rejects sealed candidates and mismatched partition ownership before truncation', async () => {
  const f = await fixture(),
    budget = new WorkingBudget();
  await f.store.initialize(f.bindings);
  const append = await f.store.append('outbound-evidence', 'metadata', budget),
    prefix = await append.checkpoint();
  await append.close();
  const marker = structuredClone(f.relocation);
  marker[11] = prefix;
  await f.store.publishIntent(marker);
  await expect(
    f.store.resumePrefix(prefix, 'outbound-evidence', 'metadata', budget, marker),
  ).rejects.toThrow('partition');
  await f.store.clearIntent(marker);
  const data = await f.store.append('adjustments', 'data', budget),
    p = await data.checkpoint(),
    q = await data.seal();
  marker[11] = null;
  marker[13] = p;
  await f.store.publishIntent(marker);
  const before = await readFile(f.store.root.resolve(q[2]));
  await expect(f.store.resumePrefix(p, 'adjustments', 'data', budget, marker)).rejects.toThrow(
    'sealed',
  );
  expect(await readFile(f.store.root.resolve(q[2]))).toEqual(before);
});
it('removes verified unpublished Q files after repeated post-rename failure', async () => {
  const f = await fixture(async (name) => {
    if (name === 'immutable-rename') throw new Error('publication failed');
  });
  for (let i = 0; i < 3; i++)
    await expect(
      f.store.write(
        'worker-archive',
        (async function* () {
          yield Buffer.alloc(131072, 65);
        })(),
      ),
    ).rejects.toThrow('publication failed');
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(f.store.root.resolve(f.prefix + 'files'))).toEqual([]);
});
it('permits only attributable rename fields while ordinary birth identity stays strict', async () => {
  const f = await fixture();
  await writeFile(path.join(f.root, 'file'), 'bytes');
  const n = (await f.store.root.stat('file'))!;
  for (const index of [5, 6, 8] as const) {
    const changed = structuredClone(n);
    if (index === 6) changed[index]++;
    else changed[index] = String(BigInt(changed[index]) + 1n);
    expect(sameRename(n, changed)).toBe(false);
  }
  const changed = structuredClone(n);
  changed[10] = changed[10] === null ? '1' : String(BigInt(changed[10]) + 1n);
  expect(sameObject(n, changed)).toBe(false);
  expect(sameRename(n, changed)).toBe(process.platform === 'win32');
});

it('preserves an ambiguous post-rename candidate instead of guessing cleanup authority', async () => {
  const f = await fixture(),
    rename = f.store.root.renameAbsent.bind(f.store.root);
  const spy = vi.spyOn(f.store.root, 'renameAbsent').mockImplementation(async (...args) => {
    await rename(...args);
    throw new Error('ambiguous rename');
  });
  try {
    await expect(
      f.store.write(
        'worker-archive',
        (async function* () {
          yield Buffer.from('preserve');
        })(),
      ),
    ).rejects.toThrow('cleanup blocked');
    const { readdir } = await import('node:fs/promises'),
      files = await readdir(f.store.root.resolve(f.prefix + 'files'));
    expect(files).toHaveLength(1);
    expect(await readFile(f.store.root.resolve(f.prefix + 'files/' + files[0]), 'utf8')).toBe(
      'preserve',
    );
  } finally {
    spy.mockRestore();
  }
});

it('shares cancellation through owned/local stream layers and releases a pending producer', async () => {
  const f = await fixture(),
    budget = new WorkingBudget(),
    controller = new AbortController();
  let entered!: () => void,
    retired = false,
    index = 0;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const records: AsyncIterable<Value> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index++ === 0) return { done: false as const, value: ['dir-open', ''] as Value };
          entered();
          return new Promise<IteratorResult<Value>>(() => {});
        },
        async return() {
          retired = true;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  const operation = f.store.writeStream(
    'activity',
    { budget, partition: null },
    records,
    controller.signal,
  );
  const assertion = expect(operation).rejects.toThrow('cancel stream');
  await pending;
  controller.abort(new Error('cancel stream'));
  await assertion;
  expect(retired).toBe(true);
  expect(budget.retained).toBe(0);
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(f.store.root.resolve(f.prefix + 'files'))).toEqual([]);
});
