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

import { mkdir, writeFile, readFile, link, rm, chmod } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  baseFixture,
  preparedBase,
  nativeCacheBackend,
  cleanupBaseFixtures,
} from './base-fixtures';
import * as nativeWalker from '../../../src/cache/streaming/native-walk';
import { WorkerSpool } from '../../../src/cache/streaming/worker-spool';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import {
  NativeObjectSave,
  NativeObjectDownload,
} from '../../../src/cache/streaming/base-transport';
import {
  ValidatedBaseObject,
  createBasePayload,
  captureBaseObject,
  PreparedBaseSource,
} from '../../../src/cache/streaming/base-object';
import { PreparedWorkerSnapshot } from '../../../src/cache/streaming/worker-snapshot';
import { resolveModel, decisionId, lineageId, writerId } from '../../../src/cache/streaming/model';
import { h } from './local-fixtures';
import { createHash } from 'node:crypto';
import { baseRecordPaths } from '../../../src/cache/streaming/base-layout';
const downloads: NativeObjectDownload[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of downloads.splice(0)) await d.dispose();
  await cleanupBaseFixtures();
});
it('round trips a real fixed-path SDK object without a base body rehash', async () => {
  const f = await baseFixture(),
    read = vi.spyOn(NativeReadPhase.prototype, 'read'),
    object = await preparedBase(f, { 'd/a': 'abc', 'd/資料 🦣': 'x', empty: '' }, 'data', [
      'meaningful-empty',
    ]);
  expect(read).toHaveBeenCalledTimes(3);
  read.mockClear();
  const sdk = await nativeCacheBackend(),
    save = await NativeObjectSave.save(sdk.backend, object, { budget: f.budget });
  expect(save.serviceId).toBe(1);
  expect(save.barrierError).toBeUndefined();
  const d = await NativeObjectDownload.restore(f.store, sdk.backend, object.reference, {
    budget: f.budget,
  });
  downloads.push(d);
  expect(await readFile(f.store.root.resolve(d.object!.payload + '/d/a'), 'utf8')).toBe('abc');
  expect(sdk.calls[0].paths).toEqual(['envelope.json', 'tree.ndjson', 'payload/']);
  expect(sdk.calls[0].members?.sort()).toEqual(['envelope.json', 'payload', 'tree.ndjson']);
  expect(sdk.calls[1].paths).toEqual(sdk.calls[0].paths);
  expect((await f.store.root.stat(d.object!.payload + '/meaningful-empty'))![2]).toBe('directory');
  expect(object.tree[1]).toBe('native-tree');
  expect(read).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});
it('round trips the single literal generation path at distinct roots', async () => {
  const f = await baseFixture(),
    sdk = await nativeCacheBackend(),
    from = f.store.prefix + 'records/from',
    to = f.store.prefix + 'records/to';
  const ref = await f.store.writeNativeMetadata(
    from,
    'record.json',
    (async function* () {
      yield Buffer.from('["fixture"]\n');
    })(),
  );
  await sdk.backend.saveCache(baseRecordPaths(f.store, from), 'record', {
    archiveRoot: f.store.root.resolve(from),
  });
  await f.store.makeParents(to + '/placeholder');
  expect(
    await sdk.backend.restoreCache(baseRecordPaths(f.store, to), 'record', [], {
      archiveRoot: f.store.root.resolve(to),
    }),
  ).toBe('record');
  expect(await readFile(f.store.root.resolve(to + '/record.json'), 'utf8')).toBe('["fixture"]\n');
  expect(sdk.calls.map((c) => c.paths)).toEqual([['record.json'], ['record.json']]);
  expect(ref[3]).toBe(12);
});
it.each(['extra', 'missing', 'size', 'link', 'root', 'envelope'])(
  'rejects native %s before granting object validity',
  async (kind) => {
    const f = await baseFixture(),
      o = await preparedBase(f, { 'd/a': 'abc' });
    if (kind === 'extra') await writeFile(f.store.root.resolve(o.payload + '/extra'), 'x');
    if (kind === 'missing') await rm(f.store.root.resolve(o.payload + '/d/a'));
    if (kind === 'size') await writeFile(f.store.root.resolve(o.payload + '/d/a'), 'changed');
    if (kind === 'link')
      await link(
        f.store.root.resolve(o.payload + '/d/a'),
        f.store.root.resolve(o.payload + '/alias'),
      );
    if (kind === 'root') await mkdir(f.store.root.resolve(o.root + '/unknown'));
    if (kind === 'envelope')
      await writeFile(f.store.root.resolve(o.root + '/envelope.json'), '{}\n');
    await expect(
      ValidatedBaseObject.verify(f.store, o.root, o.reference, { budget: f.budget }),
    ).rejects.toThrow();
    expect(f.budget.retained).toBe(0);
  },
);
it('states the trusted-base same-size byte boundary and hashes only explicit strong readback', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' });
  const { utimes } = await import('node:fs/promises');
  await writeFile(f.store.root.resolve(o.payload + '/a'), 'xyz');
  await utimes(f.store.root.resolve(o.payload + '/a'), 1.234, 1.234);
  await expect(
    ValidatedBaseObject.verify(f.store, o.root, o.reference, { budget: f.budget }),
  ).resolves.toBeDefined();
  await expect(
    ValidatedBaseObject.verify(f.store, o.root, o.reference, { budget: f.budget }, true),
  ).rejects.toThrow('content');
});
it('returns only provisional SDK evidence when the stage changes during upload', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    sdk = await nativeCacheBackend();
  sdk.backend.saveCache = async () => {
    await writeFile(f.store.root.resolve(o.payload + '/late'), 'x');
    return 7;
  };
  const result = await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  expect(result.serviceId).toBe(7);
  expect(result.barrierError).toBeInstanceOf(Error);
});

it('reuses a genuine native hash proof only at the same prearranged payload without reading bodies again', async () => {
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'single-writer', null, 'default']],
    ],
    'proof-',
    1,
  );
  const f = await baseFixture(model),
    payload = await createBasePayload(f.store, 'data');
  await writeFile(f.store.root.resolve(payload + '/a'), 'abc', { mode: 0o644 });
  const evidence = await f.store.writeStream(
    'native-evidence',
    { budget: f.budget, partition: 'data' },
    (async function* () {
      yield ['directory', '', (await f.store.root.stat(payload))!] as const;
      yield [
        'file',
        'a',
        (await f.store.root.stat(payload + '/a'))!,
        createHash('sha256').update('abc').digest('hex'),
      ] as const;
    })(),
  );
  const proof = await PreparedWorkerSnapshot.verify(
      f.store,
      {
        partition: 'data',
        nativeRoot: payload,
        evidence,
        provenance: 'fixture',
        finishVerification: async (b) => b,
      },
      f.budget,
    ),
    read = vi.spyOn(NativeReadPhase.prototype, 'read');
  await captureBaseObject(
    f.store,
    [f.model.family, f.model.id, 'data', h, h, h],
    { budget: f.budget },
    proof,
  );
  expect(read).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});
it.each(['gradle', 'maven'] as const)(
  'captures real complete/projected %s units through summary-first spools',
  async (tool) => {
    const hard = ['.mammoth/**'],
      model = resolveModel(
        ['model', 1, tool, hard, [['data', ['**'], hard, 'aggregate', null, 'default']]],
        'units-',
        1,
      ),
      f = await baseFixture(model),
      root = tool === 'gradle' ? 'caches/transforms-4/' + 'a'.repeat(32) : 'repository/g/a/1',
      files =
        tool === 'gradle'
          ? {
              [root + '/metadata.bin']: 'm',
              [root + '/results.bin']: 'r',
              [root + '/transformed/a']: 'a',
            }
          : { [root + '/a.jar']: 'jar', [root + '/nested/child.jar']: 'child' };
    const o = await preparedBase(f, files);
    expect(o.envelope[7][2]).toBe(tool === 'gradle' ? 1 : 2);
    await o.verifyStable({ budget: f.budget });
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects same-byte transient metadata edits during the native SDK operation', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    sdk = await nativeCacheBackend(),
    name = f.store.root.resolve(o.root + '/tree.ndjson'),
    bytes = await readFile(name);
  sdk.backend.saveCache = async () => {
    await writeFile(name, bytes);
    return 1;
  };
  const result = await NativeObjectSave.save(sdk.backend, o, { budget: f.budget });
  expect(result.barrierError).toBeInstanceOf(Error);
});
it('waits for an uncancellable download before cleaning its private root after cancellation', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    sdk = await nativeCacheBackend(),
    controller = new AbortController();
  let release!: () => void,
    entered!: () => void,
    destination = '';
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  sdk.backend.restoreCache = async (_p, _k, _f, options) => {
    destination = options!.archiveRoot!;
    entered();
    await gate;
    await writeFile(destination + '/late', 'x');
    return undefined;
  };
  const promise = NativeObjectDownload.restore(f.store, sdk.backend, o.reference, {
    budget: f.budget,
    signal: controller.signal,
  });
  await ready;
  controller.abort();
  expect(
    await f.store.root.stat(
      destination
        .slice(f.root.length + 1)
        .split('\\')
        .join('/'),
    ),
  ).toBeTruthy();
  release();
  await expect(promise).rejects.toThrow();
  await expect(readFile(destination + '/late')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('checks genuine object membership before SDK calls rather than trusting virtual validators', async () => {
  const sdk = await nativeCacheBackend(),
    f = await baseFixture(),
    save = vi.spyOn(sdk.backend, 'saveCache');
  const fake = {
    assertBound: () => {},
    verifyStable: async () => {},
    store: f.store,
    root: f.store.prefix + 'objects/data',
    reference: ['object-ref'],
  } as unknown as ValidatedBaseObject;
  await expect(NativeObjectSave.save(sdk.backend, fake, { budget: f.budget })).rejects.toThrow(
    'Unbound',
  );
  expect(save).not.toHaveBeenCalled();
});
it.each(['ordinary', 'launcher', 'readonly'] as const)(
  'repairs permitted %s mode before final native evidence',
  async (kind) => {
    const f = await baseFixture(),
      name = kind !== 'launcher' ? 'a' : 'wrapper/dists/gradle-9-bin/hash/gradle-9/bin/gradle',
      o = await preparedBase(f, { [name]: 'abc' });
    await chmod(f.store.root.resolve(o.payload + '/' + name), kind === 'readonly' ? 0o400 : 0o600);
    const repaired = await ValidatedBaseObject.verify(f.store, o.root, o.reference, {
      budget: f.budget,
    });
    const actual = (await f.store.root.stat(o.payload + '/' + name))!;
    if (process.platform !== 'win32')
      expect(actual[6] & 0o777).toBe(kind !== 'launcher' ? 0o644 : 0o755);
    await repaired.verifyStable({ budget: f.budget });
  },
);
it('rejects noncanonical immutable prepared modes without modifying their identities', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' });
  await chmod(f.store.root.resolve(o.payload + '/a'), 0o400);
  const before = (await f.store.root.stat(o.payload + '/a'))!;
  await expect(
    ValidatedBaseObject.verify(
      f.store,
      o.root,
      o.reference,
      { budget: f.budget },
      false,
      'prepared',
    ),
  ).rejects.toThrow('Prepared native mode');
  expect((await f.store.root.stat(o.payload + '/a'))!.filter((_v, i) => i !== 7)).toEqual(
    before.filter((_v, i) => i !== 7),
  );
});
it('does not expose a newly branded proof if cancellation arrives during final spool cleanup', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    controller = new AbortController(),
    dispose = WorkerSpool.prototype.dispose;
  vi.spyOn(WorkerSpool.prototype, 'dispose').mockImplementation(async function (this: WorkerSpool) {
    await dispose.call(this);
    controller.abort();
  });
  await expect(
    ValidatedBaseObject.verify(f.store, o.root, o.reference, {
      budget: f.budget,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('retires independent event spools when a unit iterator cleanup fails', async () => {
  const f = await baseFixture(),
    payload = await createBasePayload(f.store, 'data');
  await writeFile(f.store.root.resolve(payload + '/a'), 'abc', { mode: 0o644 });
  const dispose = vi.spyOn(WorkerSpool.prototype, 'dispose'),
    original = dispose.getMockImplementation()!;
  let first = true;
  dispose.mockImplementation(async function (this: WorkerSpool) {
    await original.call(this);
    if (first) {
      first = false;
      throw new Error('injected retirement failure');
    }
  });
  await expect(
    captureBaseObject(f.store, [f.model.family, f.model.id, 'data', h, h, h], { budget: f.budget }),
  ).rejects.toThrow('cleanup');
  expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(f.budget.retained).toBe(0);
});

it('still retires the evidence spool if native iterator retirement fails', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    walk = nativeWalker.walkNative,
    dispose = vi.spyOn(WorkerSpool.prototype, 'dispose');
  let first = true;
  vi.spyOn(nativeWalker, 'walkNative').mockImplementation((...args) => {
    if (!first) return walk(...args);
    first = false;
    const generator = walk(...args),
      close = generator.return.bind(generator);
    generator.return = async (value) => {
      await close(value);
      throw new Error('injected iterator close');
    };
    return generator;
  });
  await expect(
    ValidatedBaseObject.verify(f.store, o.root, o.reference, { budget: f.budget }),
  ).rejects.toThrow('cleanup');
  expect(dispose).toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});

it('does not rebase an envelope identity changed between verified bytes and metadata sealing', async () => {
  const f = await baseFixture(),
    o = await preparedBase(f, { a: 'abc' }),
    read = f.store.root.read.bind(f.store.root);
  let envelopes = 0;
  vi.spyOn(f.store.root, 'read').mockImplementation(async function* (name, expected) {
    yield* read(name, expected);
    if (name === o.root + '/envelope.json' && ++envelopes === 2) {
      const bytes = await readFile(f.store.root.resolve(name));
      await writeFile(
        f.store.root.resolve(name),
        Buffer.from(bytes.toString().replace('partition-projection', 'partition-Projection')),
      );
    }
  });
  await expect(
    ValidatedBaseObject.verify(f.store, o.root, o.reference, { budget: f.budget }),
  ).rejects.toThrow('metadata changed');
  expect(f.budget.retained).toBe(0);
});

it('keeps original full native identities through metadata publication after a new capture hash', async () => {
  const f = await baseFixture(),
    write = f.store.writeNativeMetadata.bind(f.store);
  const { utimes } = await import('node:fs/promises');
  vi.spyOn(f.store, 'writeNativeMetadata').mockImplementation(async (...args) => {
    const result = await write(...args);
    if (args[1] === 'tree.ndjson') {
      const file = f.store.root.resolve(args[0] + '/payload/a');
      await writeFile(file, 'xyz');
      await utimes(file, 1.234, 1.234);
    }
    return result;
  });
  await expect(preparedBase(f, { a: 'abc' })).rejects.toThrow('Captured native source');
  expect(f.budget.retained).toBe(0);
});

it('captures source evidence before a keyed identity and renders metadata without another body read', async () => {
  const f = await baseFixture(),
    payload = await createBasePayload(f.store, 'data');
  await writeFile(f.store.root.resolve(payload + '/a'), 'abc', { mode: 0o644 });
  const read = vi.spyOn(NativeReadPhase.prototype, 'read'),
    source = await PreparedBaseSource.capture(f.store, 'data', { budget: f.budget });
  expect(read).toHaveBeenCalledTimes(1);
  expect(source.evidence[1]).toBe('native-evidence');
  expect(await f.store.root.stat(source.root + '/tree.ndjson')).toBeNull();
  read.mockClear();
  try {
    const object = await source.render([f.model.family, f.model.id, 'data', h, h, 'b'.repeat(64)], {
      budget: f.budget,
    });
    expect(object.reference[1][5]).toBe('b'.repeat(64));
    expect(read).not.toHaveBeenCalled();
  } finally {
    await source.dispose();
  }
  await source.verifyStable({ budget: f.budget });
  expect(f.budget.retained).toBe(0);
});
it('blocks keyed rendering while unpublished source metadata is retiring', async () => {
  const f = await baseFixture(),
    payload = await createBasePayload(f.store, 'data');
  await writeFile(f.store.root.resolve(payload + '/a'), 'a', { mode: 0o644 });
  const source = await PreparedBaseSource.capture(f.store, 'data', { budget: f.budget }),
    dispose = WorkerSpool.prototype.dispose;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  vi.spyOn(WorkerSpool.prototype, 'dispose').mockImplementation(async function (this: WorkerSpool) {
    entered();
    await gate;
    return dispose.call(this);
  });
  const closing = source.dispose();
  await ready;
  try {
    await expect(
      source.render([f.model.family, f.model.id, 'data', h, h, h], { budget: f.budget }),
    ).rejects.toThrow('unavailable');
  } finally {
    release();
    await closing;
  }
});

it('seals a single-writer source tuple before deriving its decision and rendering the keyed object', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [['state', ['state/**'], hard, 'single-writer', null, 'default']],
      ],
      'preidentity-',
      1,
    ),
    f = await baseFixture(model),
    payload = await createBasePayload(f.store, 'state');
  await mkdir(f.store.root.resolve(payload + '/state'));
  await writeFile(f.store.root.resolve(payload + '/state/a'), 'x', { mode: 0o644 });
  const source = await PreparedBaseSource.capture(f.store, 'state', { budget: f.budget });
  try {
    const post = await f.store.writeStream(
      'post-sources',
      { budget: f.budget, partition: null },
      (async function* () {
        yield ['snapshot-source', source.snapshotSource()] as const;
      })(),
    );
    await f.store.readStream(post, 'post-sources', { budget: f.budget, partition: null });
    const decision = decisionId([
        'decision',
        1,
        f.store.codec.options.invocation,
        model.id,
        model.family,
        h,
        h,
        null,
        h,
        post[4],
      ]),
      object = await source.render(
        [
          model.family,
          model.id,
          'state',
          lineageId('refs/heads/main'),
          writerId(f.store.codec.options.invocation, f.store.codec.options.context),
          decision,
        ],
        { budget: f.budget },
      );
    expect(object.reference[1][5]).toBe(decision);
    expect(source.snapshotSource()).toEqual([
      'state',
      'local-writer',
      ['local-writer', f.store.codec.options.invocation],
      source.evidence,
      payload,
    ]);
  } finally {
    await source.dispose();
  }
});
