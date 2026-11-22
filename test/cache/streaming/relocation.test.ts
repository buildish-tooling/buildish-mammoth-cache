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

import type * as Fs from 'node:fs/promises';
import { mkdir, writeFile, chmod, utimes, link, readFile, rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { tuple, type Value } from '../../../src/cache/streaming/encoding';
import { ObservationIndex } from '../../../src/cache/streaming/observation-index';
import { NativeObjectDownload } from '../../../src/cache/streaming/base-transport';
import { movingObjectRef } from '../../../src/cache/streaming/base-moving-publication';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import { nativeCacheBackend, cleanupBaseFixtures } from './base-fixtures';
import { MovingWindow } from '../../../src/cache/streaming/moving-window';
import { RelocationRoots } from '../../../src/cache/streaming/relocation-roots';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { IndexDirectories } from '../../../src/cache/streaming/install-index';
import { sameNative } from '../../../src/cache/streaming/native';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { RelocationProgram, type MoveRow } from '../../../src/cache/streaming/relocation-program';
import { RelocationEpoch } from '../../../src/cache/streaming/relocation-epoch';
import { RelocationSource } from '../../../src/cache/streaming/relocation-source';
import { RelocationTreeFile } from '../../../src/cache/streaming/relocation-tree-file';
import { checkMoveMember } from '../../../src/cache/streaming/relocation-member';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { observationFixture } from './observation-fixtures';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  await cleanupBaseFixtures();
});
async function fixture(
  files: Record<string, string> = { 'data/a': 'one', 'state/b': 'two' },
  tool: 'maven' | 'gradle' = 'maven',
  before?: (fixture: Awaited<ReturnType<typeof observationFixture>>) => Promise<void>,
  signal?: AbortSignal,
) {
  const f = await observationFixture(tool);
  cleanups.push(async () => {
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', files);
  await before?.(f);
  await captureObservations(f.store, { budget: f.budget, signal });
  await executeGc(f.store, { budget: f.budget, signal });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget, signal });
  cleanups.push(() => input.dispose());
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  cleanups.push(() => pub.dispose());
  return { ...f, input, pub };
}
async function readers(pub: FrozenMovingPublication, partition = 'data', operations = 1) {
  const program = await RelocationProgram.create(pub, partition, [], { operations });
  cleanups.push(() => program.close());
  const source = await RelocationSource.open(program);
  cleanups.push(() => source.close());
  const tree = await RelocationTreeFile.open(pub.tree(partition), pub.options);
  cleanups.push(() => tree.close());
  const check = async (
    move: MoveRow,
    physical = move[3],
    options: Parameters<typeof checkMoveMember>[6] = {},
  ) =>
    checkMoveMember(
      program,
      move,
      physical,
      source.evidence,
      (await source.member(move)).span,
      tree,
      options,
    );
  return { program, source, tree, check };
}
async function first(program: RelocationProgram) {
  for await (const range of program.ranges())
    for await (const move of program.moves(range)) return move;
  throw new Error('No fixture moves.');
}
it('reads a live subtree and an owned snapshot through exact post-GC and portable spans without body reads', async () => {
  const f = await fixture();
  for (const p of ['data', 'state']) {
    const r = await readers(f.pub, p),
      move = await first(r.program),
      checked = await r.check(move);
    expect(checked.work).toEqual({ hashBytes: 0, files: 1, directories: 1 });
    expect(sameNative(checked.native, (await r.source.member(move)).native, true)).toBe(true);
  }
});
it('checks a split ordinary file without repairing its source mode', async () => {
  const f = await fixture({ 'data/a': 'one', 'data/keep.lock': 'guard' });
  if (process.platform !== 'win32') await chmod(f.root + '/data/a', 0o600);
  // mode changes after freeze must reject, rather than being silently canonicalized.
  const r = await readers(f.pub),
    move = await first(r.program);
  expect(move[5]).toBe('file');
  if (process.platform !== 'win32') await expect(r.check(move)).rejects.toThrow('identity');
  else expect((await r.check(move)).work.files).toBe(1);
});
it.each(['before', 'during'] as const)(
  'rejects scoped file parent changes %s member checking',
  async (when) => {
    const f = await fixture({ 'data/a': 'one', 'data/keep.lock': 'guard' }),
      window = await MovingWindow.open(f.pub);
    cleanups.push(() => window.close());
    await window.verify();
    const r = await readers(f.pub),
      move = await first(r.program);
    await window.livePhase.parents(move[3]);
    const mutate = () => utimes(f.root + '/data', 0, 0);
    if (when === 'before') await mutate();
    else {
      const hash = NativeReadPhase.prototype.hash;
      vi.spyOn(NativeReadPhase.prototype, 'hash').mockImplementation(async function (
        this: NativeReadPhase,
        ...args: Parameters<NativeReadPhase['hash']>
      ) {
        const result = await hash.apply(this, args);
        await mutate();
        return result;
      });
    }
    await expect(r.check(move, move[3], { parentPhase: window.livePhase })).rejects.toThrow();
  },
);
it('requires explicit, bounded root rename evidence and hashes ambiguous moved bodies', async () => {
  const f = await fixture(),
    r = await readers(f.pub),
    move = await first(r.program),
    before = await r.check(move),
    destination = f.pub.tree('data').root + '/payload/' + move[4];
  await mkdir(f.store.root.resolve(destination.slice(0, destination.lastIndexOf('/'))), {
    recursive: true,
  });
  const moved = await f.store.root.renameAbsent(move[3], destination, before.native);
  await expect(r.check(move, destination)).rejects.toThrow('identity');
  expect((await r.check(move, destination, { rootNative: moved })).work.hashBytes).toBe(0);
  expect((await r.check(move, destination, { uncertain: true })).work.hashBytes).toBe(3);
});
it.each(['extra', 'same-size', 'directory-clock'] as const)(
  'rejects %s changes under a planned member',
  async (bad) => {
    const f = await fixture(),
      r = await readers(f.pub),
      move = await first(r.program);
    if (bad === 'extra') await writeFile(f.root + '/data/extra', 'x');
    if (bad === 'same-size') await writeFile(f.root + '/data/a', 'bad');
    if (bad === 'directory-clock') await utimes(f.root + '/data', new Date(0), new Date(0));
    await expect(r.check(move)).rejects.toThrow();
  },
);
it('keeps an oversized multi-root semantic unit complete while batching separate units', async () => {
  const root = 'caches/transforms-4/' + 'a'.repeat(32),
    f = await fixture(
      {
        [root + '/metadata.bin']: 'm',
        [root + '/results.bin']: 'r',
        [root + '/transformed/a']: 'a',
        [root + '/keep.lock']: 'k',
        'data/b': 'b',
        'data/c': 'c',
        'data/keep.lock': 'k',
      },
      'gradle',
    ),
    r = await readers(f.pub),
    counts: number[] = [];
  for await (const range of r.program.ranges()) {
    let count = 0;
    for await (const move of r.program.moves(range)) {
      await r.check(move);
      count++;
    }
    counts.push(count);
  }
  expect(counts).toEqual([3, 1, 1]);
});
it('accepts only actual complete cursors including byte and record boundaries', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/b': 'b', 'data/keep.lock': 'k' }),
    r = await readers(f.pub),
    ranges = [];
  for await (const range of r.program.ranges()) ranges.push(range);
  expect(ranges).toHaveLength(2);
  const next = await RelocationProgram.create(f.pub, 'data', [ranges[0].end]);
  cleanups.push(() => next.close());
  expect(await next.index(ranges[0].end)).toBe(1);
  const changed = structuredClone(ranges[0].end);
  changed[3]++;
  await expect(RelocationProgram.create(f.pub, 'data', [changed])).rejects.toThrow('boundary');
});
it('keeps a zero-move projected-empty source context without inventing a semantic unit', async () => {
  const f = await fixture({ 'data/empty/keep.lock': 'guard' }),
    r = await readers(f.pub);
  expect(r.program.rootCount).toBe(0);
  expect(r.program.final[2]).toBeGreaterThan(0);
  expect(r.program.final[4]).toBe(0);
  expect(await r.program.index(r.program.final)).toBe(0);
  for await (const range of r.program.ranges()) throw new Error('invented unit ' + range.end[4]);
});

it.each([true, false])(
  'rejects a hardlinked file during uncertain recovery (split=%s)',
  async (split) => {
    const f = await fixture(
        split ? { 'data/a': 'one', 'data/keep.lock': 'guard' } : { 'data/a': 'one' },
      ),
      r = await readers(f.pub),
      move = await first(r.program);
    await link(f.root + '/data/a', f.root + '/alias');
    await expect(r.check(move, move[3], { uncertain: true })).rejects.toThrow('Aliased');
  },
);

it('refuses competing lookups and cleanup throughout an awaited member-page load', async () => {
  const f = await fixture(),
    r = await readers(f.pub),
    move = await first(r.program);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    original = IndexDirectories.prototype.member;
  const spy = vi.spyOn(IndexDirectories.prototype, 'member').mockImplementation(async function (
    this: IndexDirectories,
    path: string,
  ) {
    enter();
    await gate;
    return original.call(this, path);
  });
  const pending = r.source.member(move);
  await entered;
  await expect(r.source.directory('')).rejects.toThrow('active');
  await expect(r.source.close()).rejects.toThrow('active');
  resume();
  await pending;
  spy.mockRestore();
  await r.source.close();
  await expect(r.source.member(move)).rejects.toThrow('unavailable');
});

it.each(['data', 'state'])(
  'evacuates and returns native %s roots before exposing only an adjustment candidate',
  async (p) => {
    const f = await fixture(),
      epoch = await RelocationEpoch.open(f.pub, p, { operations: 1 });
    cleanups.push(() => epoch.close());
    const object = await epoch.evacuate();
    expect(epoch.current?.[7]).toBe('staged');
    await object.verifyStable(f.pub.options);
    const candidate = await epoch.returnSources();
    expect(candidate[1]).toBe('adjustments');
    expect(epoch.current?.[7]).toBe('sources-returned');
    expect(
      await f.store.root.stat(p === 'data' ? 'data' : f.input.partitions[1].nativeRoot! + '/state'),
    ).not.toBeNull();
    const cells = await f.pub.cells();
    try {
      expect(cells.rows.every((c) => c[5] === null)).toBe(true);
    } finally {
      cells.release();
    }
  },
);

async function reopen(f: Awaited<ReturnType<typeof fixture>>, p = 'data', operations = 1) {
  const store = await OwnedStore.bind(f.root, f.store.codec),
    pub = await FrozenMovingPublication.resume(store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const epoch = await RelocationEpoch.open(pub, p, { operations });
  cleanups.push(() => epoch.close());
  return { epoch, pub, store };
}
it('recovers two completed batches plus a partial multi-root unit from the entire owned prefix', async () => {
  const root = 'caches/transforms-4/' + 'a'.repeat(32),
    files = {
      'caches/a': 'a',
      'caches/b': 'b',
      [root + '/metadata.bin']: 'm',
      [root + '/results.bin']: 'r',
      [root + '/transformed/a']: 'a',
      [root + '/keep.lock']: 'guard',
    },
    f = await fixture(files, 'gradle'),
    epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 });
  cleanups.push(() => epoch.close());
  let n = 0;
  const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-outbound-rename' && ++n === 4) throw new Error('process gap');
  });
  await expect(epoch.evacuate()).rejects.toThrow('process gap');
  expect(epoch.current?.[8][4]).toBe(2);
  expect(epoch.current?.[10]?.[0]).toBe('outbound');
  fail.mockRestore();
  await epoch.close();
  const recovered = await reopen(f, 'data', 2);
  await recovered.epoch.returnSources();
  for (const [path, body] of Object.entries(files))
    expect(await readFile(f.root + '/' + path, 'utf8')).toBe(body);
  expect(recovered.epoch.current?.[7]).toBe('sources-returned');
});
it.each(['both', 'missing', 'descendant'] as const)(
  'blocks ambiguous %s recovery endpoints without forgetting ownership',
  async (bad) => {
    const f = await fixture(),
      epoch = await RelocationEpoch.open(f.pub, 'data');
    cleanups.push(() => epoch.close());
    await epoch.evacuate();
    await epoch.close();
    const payload = f.pub.tree('data').root + '/payload/data';
    if (bad === 'both') await f.files('', { 'data/a': 'replacement' });
    if (bad === 'descendant') await writeFile(f.store.root.resolve(payload + '/extra'), 'unknown');
    if (bad === 'missing') {
      const native = (await f.store.root.stat(payload))!;
      await f.store.root.renameAbsent(payload, payload + '-missing', native);
    }
    const store = await OwnedStore.bind(f.root, f.store.codec),
      pub = await FrozenMovingPublication.resume(store, { budget: f.budget });
    cleanups.push(() => pub.dispose());
    await expect(RelocationEpoch.open(pub, 'data')).rejects.toThrow();
    expect(await store.readFixed(store.prefix + 'relocation/data.json')).not.toBeNull();
  },
);
it('returns earlier roots after EXDEV and never copies payloads', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/b': 'b', 'data/keep.lock': 'guard' }),
    epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 });
  cleanups.push(() => epoch.close());
  const actual = await vi.importActual<typeof Fs>('node:fs/promises');
  await vi.mocked(rename).withImplementation(
    async (from, to) => {
      if (String(from) === f.store.root.resolve('data/b'))
        throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
      return actual.rename(from, to);
    },
    async () => {
      await expect(epoch.evacuate()).rejects.toThrow('cross device');
    },
  );
  await epoch.close();
  const recovered = await reopen(f);
  await recovered.epoch.returnSources();
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('a');
  expect(await readFile(f.root + '/data/b', 'utf8')).toBe('b');
});

it.each([
  'relocation-return-rename',
  'relocation-return-evidence',
  'relocation-return-cursor',
  'relocation-adjustment-candidate',
  'relocation-sources-returned',
] as const)('reopens and finishes source return after %s', async (point) => {
  const f = await fixture({ 'data/a': 'a', 'data/b': 'b', 'data/keep.lock': 'guard' }),
    epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 });
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  let armed = true;
  const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === point && armed) {
      armed = false;
      throw new Error('return gap');
    }
  });
  await expect(epoch.returnSources()).rejects.toThrow('return gap');
  fail.mockRestore();
  await epoch.close();
  const recovered = await reopen(f, 'data', 2);
  await recovered.epoch.returnSources();
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('a');
  expect(await readFile(f.root + '/data/b', 'utf8')).toBe('b');
  expect(recovered.epoch.current?.[7]).toBe('sources-returned');
});

it.each(['outbound-evidence', 'return-evidence'] as const)(
  'rejects %s in a source-only suffix outside durable ownership',
  async (purpose) => {
    const f = await fixture({ 'data/a': 'a', 'data/b': 'b', 'data/keep.lock': 'guard' }),
      epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 });
    cleanups.push(() => epoch.close());
    const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point === 'relocation-outbound-intent') throw new Error('active first unit');
    });
    await expect(epoch.evacuate()).rejects.toThrow('active first unit');
    fail.mockRestore();
    const marker = epoch.current!,
      program = await RelocationProgram.create(f.pub, 'data'),
      source = await RelocationSource.open(program);
    let prefix;
    try {
      const log = await f.store.append(purpose, 'data', f.budget);
      try {
        for await (const range of program.ranges())
          for await (const move of program.moves(range))
            if (move[1] === 2) {
              const fact = await source.member(move);
              await log.append([
                'transition',
                2,
                1,
                purpose === 'outbound-evidence' ? 'outbound' : 'return',
                fact.native,
                fact.native,
                move[6],
              ]);
            }
        prefix = await log.checkpoint();
      } finally {
        await log.close();
      }
    } finally {
      await source.close();
      await program.close();
    }
    const forged = structuredClone(marker);
    if (purpose === 'outbound-evidence')
      forged[11] = f.store.codec.schemas.appendPrefix(purpose).parse(prefix);
    else forged[12] = f.store.codec.schemas.appendPrefix(purpose).parse(prefix);
    await f.store.replaceRelocation(marker, forged);
    await epoch.close();
    const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
    cleanups.push(() => pub.dispose());
    await expect(RelocationEpoch.open(pub, 'data')).rejects.toThrow('outside relocation ownership');
  },
);

it('rejects an unexplained grandparent clock change during cold live recovery', async () => {
  const f = await fixture({
      'data/nested/a': 'a',
      'data/nested/keep.lock': 'guard',
      'data/keep.lock': 'guard',
    }),
    epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 });
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  await epoch.close();
  await utimes(f.root + '/data', new Date(0), new Date(0));
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  await expect(RelocationEpoch.open(pub, 'data')).rejects.toThrow();
  expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).not.toBeNull();
});

it('stops a sparse directory page at the first edge after cancellation and releases all leases', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    before = f.budget.retained,
    original = InstallScratch.prototype.append;
  let edges = 0;
  vi.spyOn(InstallScratch.prototype, 'append').mockImplementation(async function (
    this: InstallScratch,
    ...args: Parameters<InstallScratch['append']>
  ) {
    const at = await original.apply(this, args);
    if (Array.isArray(args[0]) && args[0][0] === 'edge') {
      edges++;
      controller.abort(new Error('edge abort'));
    }
    return at;
  });
  await expect(
    RelocationRoots.create(
      f.store,
      f.budget,
      (async function* () {
        for (let i = 0; i < 8; i++) yield ['root' + i, ['test', i]] as const;
      })(),
      controller.signal,
    ),
  ).rejects.toThrow('edge abort');
  expect(edges).toBe(1);
  expect(f.budget.retained).toBe(before);
});

it('orders native directory roots after sibling files and emits no directory descendants', async () => {
  const f = await fixture({
      'data/a-directory/child': 'nested',
      'data/z-file': 'sibling',
      'data/keep.lock': 'protected',
    }),
    window = await MovingWindow.open(f.pub, { operations: 1 });
  cleanups.push(() => window.close());
  await window.verify();
  const epoch = await RelocationEpoch.open(f.pub, 'data', { operations: 1 }, window);
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  const candidate = await epoch.returnSources(),
    proof = await window.checkCandidate(epoch, candidate);
  await proof.close();
  const values = [];
  for await (const row of f.store.rows(candidate, 'adjustments', {
    budget: f.budget,
    partition: 'data',
  })) {
    const r = tuple(row.value);
    if (r[0] === 'adjust') values.push([r[0], r[1], tuple(r[3])[2]]);
    else if (r[0] === 'ancestor-effect') values.push([r[0], r[1]]);
  }
  expect(values).toEqual([
    ['ancestor-effect', 'data'],
    ['adjust', 'data/z-file', 'file'],
    ['adjust', 'data/a-directory', 'directory'],
  ]);
});
it('releases ordered sparse iterator leases on early return and cancellation', async () => {
  const f = await fixture(),
    roots = await RelocationRoots.create(
      f.store,
      f.budget,
      (async function* () {
        yield ['z-file', ['claim', 'file']] as const;
        yield ['a-directory', ['claim', 'directory']] as const;
        yield ['context/member', ['claim', 'file']] as const;
      })(),
    ),
    directory = (value: Value) => tuple(value)[1] === 'directory',
    before = f.budget.retained;
  cleanups.push(() => roots.close());
  const paths = [];
  for await (const [path] of roots.entries(directory)) paths.push(path);
  expect(paths).toEqual(['', 'z-file', 'a-directory', 'context', 'context/member']);
  expect(f.budget.retained).toBe(before);
  const controller = new AbortController(),
    stream = roots.entries(directory, controller.signal);
  expect((await stream.next()).value![0]).toBe('');
  await expect(roots.close()).rejects.toThrow('active');
  await expect(roots.claim('z-file')).rejects.toThrow('active');
  controller.abort(new Error('iteration cancelled'));
  await expect(stream.next()).rejects.toThrow('iteration cancelled');
  expect(f.budget.retained).toBe(before);
  const early = roots.entries(directory);
  await early.next();
  await early.next();
  await early.return(undefined);
  expect(f.budget.retained).toBe(before);
  const claim = await roots.claim('z-file');
  expect(claim!.value).toEqual(['claim', 'file']);
  claim!.release();
});

it('rejects a synthetic stage directory clock mutation before native object proof', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/keep.lock': 'guard' }),
    epoch = await RelocationEpoch.open(f.pub, 'data');
  cleanups.push(() => epoch.close());
  const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-stage-admission')
      await utimes(f.store.root.resolve(epoch.payload + '/data'), new Date(0), new Date(0));
  });
  await expect(epoch.evacuate()).rejects.toThrow('Captured native source changed');
  expect(epoch.current?.[7]).toBe('outbound');
  expect(epoch.current?.[14]).toBeNull();
  fail.mockRestore();
  await epoch.close();
  const recovered = await reopen(f);
  await recovered.epoch.returnSources();
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('a');
});

it.skipIf(process.platform === 'win32')(
  'preserves a pre-capture0600 file identity/mode through stage and native return',
  async () => {
    const f = await fixture({ 'data/a': 'private' }, 'maven', async (f) =>
        chmod(f.root + '/data/a', 0o600),
      ),
      before = (await f.store.root.stat('data/a'))!,
      epoch = await RelocationEpoch.open(f.pub, 'data');
    cleanups.push(() => epoch.close());
    const object = await epoch.evacuate(),
      staged = (await f.store.root.stat(object.payload + '/data/a'))!;
    expect(staged[4]).toBe(before[4]);
    expect(staged[6] & 0o777).toBe(0o600);
    await epoch.returnSources();
    const after = (await f.store.root.stat('data/a'))!;
    expect(after[4]).toBe(before[4]);
    expect(after[6] & 0o777).toBe(0o600);
  },
);

it('shares one original index/parent phase through two partition return candidates', async () => {
  const f = await fixture(),
    opens = vi.spyOn(ObservationIndex, 'open'),
    window = await MovingWindow.open(f.pub, { operations: 1 });
  cleanups.push(() => window.close());
  await window.verify();
  for (const p of ['data', 'state']) {
    const epoch = await RelocationEpoch.open(f.pub, p, { operations: 1 }, window);
    cleanups.push(() => epoch.close());
    await epoch.evacuate();
    const q = await epoch.returnSources(),
      proof = await window.checkCandidate(epoch, q);
    await proof.close();
    const cells = await f.pub.cells();
    try {
      cells.rows.find((c) => c[1] === p)![3] = f.store.codec.schemas.ref('adjustments').parse(q);
      const catalog = await f.store.writeStream(
          'partition-state',
          { ...f.pub.options, partition: null },
          (async function* () {
            yield* cells.rows;
          })(),
        ),
        state = await f.pub.state();
      state[3]++;
      state[9] = f.store.codec.schemas.ref('partition-state').parse(catalog);
      await f.store.updateState(state);
    } finally {
      cells.release();
    }
    await window.adopt(p, q);
    await window.verifyPart(p);
    await f.store.clearIntent(epoch.current!);
    await epoch.close();
  }
  await window.verify();
  expect(opens).toHaveBeenCalledTimes(1);
});

it('saves native live/owned SDK objects, commits returns and publishes the generation last', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub, { operations: 1 });
  cleanups.push(() => publisher.close());
  await publisher.saveObjects(sdk.backend);
  expect(sdk.objects.has(f.pub.generation[11])).toBe(false);
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('one');
  const cells = await f.pub.cells();
  try {
    expect(cells.rows.every((c) => c[3] !== null && c[5] !== null && c[6] === null)).toBe(true);
  } finally {
    cells.release();
  }
  for (const p of ['data', 'state']) {
    expect(await f.store.readFixed(f.store.prefix + 'relocation/' + p + '.json')).toBeNull();
    expect(await f.store.root.stat(f.pub.tree(p).root + '/payload')).toBeNull();
  }
  expect(await publisher.publish(sdk.backend)).toEqual(f.pub.generation);
  expect(sdk.calls.filter((c) => c.kind === 'save').at(-1)?.key).toBe(f.pub.generation[11]);
  expect(sdk.calls.some((c) => c.kind === 'lookup')).toBe(false);
});

it('rejects a cold SDK-stage synthetic-parent clock rebase', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/keep.lock': 'guard' }),
    epoch = await RelocationEpoch.open(f.pub, 'data');
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  await epoch.close();
  await utimes(f.store.root.resolve(epoch.payload + '/data'), new Date(0), new Date(0));
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  await expect(RelocationEpoch.open(pub, 'data')).rejects.toThrow(
    'Sealed synthetic stage identity changed',
  );
});
it('resumes interrupted synthetic-shell cleanup without adopting unknown stage directories', async () => {
  const f = await fixture({
      'data/nested/a': 'a',
      'data/nested/keep.lock': 'guard',
      'data/keep.lock': 'guard',
    }),
    epoch = await RelocationEpoch.open(f.pub, 'data');
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  await epoch.returnSources();
  let armed = true;
  const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-stage-directory-removed' && armed) {
      armed = false;
      throw new Error('shell gap');
    }
  });
  await expect(epoch.cleanupStage()).rejects.toThrow('shell gap');
  fail.mockRestore();
  await epoch.close();
  const recovered = await reopen(f);
  await recovered.epoch.cleanupStage();
  expect(await recovered.store.root.stat(recovered.epoch.payload)).toBeNull();
  expect(await readFile(f.root + '/data/nested/a', 'utf8')).toBe('a');
});
it.each(['native', 'effect'] as const)(
  'rejects a resealed returned candidate with changed %s evidence',
  async (bad) => {
    const f = await fixture(),
      epoch = await RelocationEpoch.open(f.pub, 'data');
    cleanups.push(() => epoch.close());
    await epoch.evacuate();
    const q = await epoch.returnSources(),
      marker = epoch.current!,
      rows: Value[][] = [];
    for await (const item of f.store.rows(q, 'adjustments', {
      ...f.pub.options,
      partition: 'data',
    })) {
      const row = tuple(item.value);
      if (row[0] === 'local-stream' || row[0] === 'local-end') continue;
      const r = structuredClone([...row]);
      if (bad === 'native' && r[0] === 'adjust')
        (r[3] as Value[])[9] = String(BigInt(String((r[3] as Value[])[9])) + 1n);
      if (bad === 'effect' && r[0] === 'ancestor-effect') r[4] = 'f'.repeat(64);
      rows.push(r);
    }
    const fake = await f.store.writeStream(
      'adjustments',
      { ...f.pub.options, partition: 'data' },
      (async function* () {
        yield* rows;
      })(),
    );
    const changed = structuredClone(marker);
    changed[13] = f.store.codec.schemas.ref('adjustments').parse(fake);
    await f.store.replaceRelocation(marker, changed);
    await epoch.close();
    const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
    cleanups.push(() => pub.dispose());
    const window = await MovingWindow.open(pub);
    cleanups.push(() => window.close());
    const recovered = await RelocationEpoch.open(pub, 'data', {}, window);
    cleanups.push(() => recovered.close());
    await expect(window.checkCandidate(recovered, fake)).rejects.toThrow();
  },
);
it('pins a sealed candidate NativeN after a return gap with no return transition', async () => {
  const f = await fixture(),
    epoch = await RelocationEpoch.open(f.pub, 'data');
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  let armed = true;
  const fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-return-rename' && armed) {
      armed = false;
      throw new Error('missing return record');
    }
  });
  await expect(epoch.returnSources()).rejects.toThrow('missing return record');
  fail.mockRestore();
  await epoch.close();
  const r = await reopen(f);
  const candidate = await r.epoch.returnSources();
  await r.epoch.close();
  if (process.platform === 'win32') await utimes(f.root + '/data', new Date(0), new Date(0));
  else {
    const native = (await f.store.root.stat('data'))!;
    await chmod(f.root + '/data', 0o700);
    await chmod(f.root + '/data', native[6] & 0o7777);
  }
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const window = await MovingWindow.open(pub);
  cleanups.push(() => window.close());
  if (process.platform === 'win32') {
    await expect(RelocationEpoch.open(pub, 'data', {}, window)).rejects.toThrow();
    return;
  }
  const current = await RelocationEpoch.open(pub, 'data', {}, window);
  cleanups.push(() => current.close());
  await expect(window.checkCandidate(current, candidate)).rejects.toThrow('native root changed');
});

it.each(['data', 'state'])('rechecks actual %s contents after candidate seal', async (p) => {
  const f = await fixture(),
    window = await MovingWindow.open(f.pub);
  cleanups.push(() => window.close());
  await window.verify();
  const epoch = await RelocationEpoch.open(f.pub, p, {}, window);
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  const q = await epoch.returnSources();
  if (p === 'data') await writeFile(f.root + '/data/a', 'bad');
  else
    await writeFile(
      f.store.root.resolve(f.input.partitions[1].nativeRoot! + '/unexpected'),
      'unknown',
    );
  await expect(window.checkCandidate(epoch, q)).rejects.toThrow();
});
it('pins a borrowed window and excludes competing async native operations', async () => {
  const f = await fixture(),
    window = await MovingWindow.open(f.pub);
  cleanups.push(() => window.close());
  await window.verify();
  const epoch = await RelocationEpoch.open(f.pub, 'data', {}, window);
  cleanups.push(() => epoch.close());
  await expect(window.close()).rejects.toThrow('borrow');
  await expect(RelocationEpoch.open(f.pub, 'state', {}, window)).rejects.toThrow('borrow');
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    original = f.store.fail;
  const spy = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-outbound-intent') {
      entered();
      await gate;
    }
    await original(point);
  });
  const pending = epoch.evacuate();
  await ready;
  await expect(window.close()).rejects.toThrow('borrow');
  await expect(window.verifyPart('data')).rejects.toThrow('active');
  resume();
  await pending;
  spy.mockRestore();
  await epoch.returnSources();
  await epoch.close();
  await window.close();
});
it('reopens the exact catalog-committed candidate before marker retirement', async () => {
  const f = await fixture(),
    window = await MovingWindow.open(f.pub);
  cleanups.push(() => window.close());
  await window.verify();
  const epoch = await RelocationEpoch.open(f.pub, 'data', {}, window);
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  const q = await epoch.returnSources();
  const cells = await f.pub.cells();
  try {
    cells.rows[0][3] = f.store.codec.schemas.ref('adjustments').parse(q);
    const catalog = await f.store.writeStream(
        'partition-state',
        { ...f.pub.options, partition: null },
        (async function* () {
          yield* cells.rows;
        })(),
      ),
      state = await f.pub.state();
    state[3]++;
    state[9] = f.store.codec.schemas.ref('partition-state').parse(catalog);
    await f.store.updateState(state);
  } finally {
    cells.release();
  }
  await epoch.close();
  await window.close();
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const next = await MovingWindow.open(pub);
  cleanups.push(() => next.close());
  const recovered = await RelocationEpoch.open(pub, 'data', {}, next);
  cleanups.push(() => recovered.close());
  const proof = await next.checkCandidate(recovered, q);
  await proof.close();
  await next.adopt('data', q);
  await next.verifyPart('data');
});
it('reuses epoch1 only while a presence-only plan has no native transition history', async () => {
  const f = await fixture({ 'data/empty/keep.lock': 'guard' }),
    sdk = await nativeCacheBackend(),
    first = MovingBasePublication.open(f.pub);
  cleanups.push(() => first.close());
  const save = vi.spyOn(sdk.backend, 'saveCache').mockResolvedValue(-1);
  await expect(first.saveObjects(sdk.backend)).rejects.toThrow('unconfirmed');
  await first.close();
  save.mockRestore();
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const window = await MovingWindow.open(pub);
  cleanups.push(() => window.close());
  await window.verify();
  const epoch = await RelocationEpoch.open(pub, 'data', {}, window);
  cleanups.push(() => epoch.close());
  expect((await epoch.reserve())[4]).toBe(1);
  expect(window.part('data').program.rootCount).toBe(0);
});

it('returns and commits sources before exact-key readback after a lost SDK response', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub),
    save = sdk.backend.saveCache.bind(sdk.backend),
    restore = sdk.backend.restoreCache.bind(sdk.backend);
  cleanups.push(() => publisher.close());
  let lost = false,
    readbacks = 0;
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    const result = await save(...args);
    if (!lost) {
      lost = true;
      throw new Error('saved response lost');
    }
    return result;
  });
  vi.spyOn(sdk.backend, 'restoreCache').mockImplementation(async (...args) => {
    readbacks++;
    expect(await readFile(f.root + '/data/a', 'utf8')).toBe('one');
    expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).toBeNull();
    const cells = await f.pub.cells();
    try {
      expect(cells.rows[0][3]).not.toBeNull();
      expect(cells.rows[0][5]).toBeNull();
    } finally {
      cells.release();
    }
    return restore(...args);
  });
  await publisher.saveObjects(sdk.backend);
  expect(readbacks).toBe(1);
  await publisher.publish(sdk.backend);
});
it('waits for actual SDK settlement on abort, then returns in an independent cleanup context', async () => {
  const controller = new AbortController(),
    f = await fixture(undefined, 'maven', undefined, controller.signal),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub),
    save = sdk.backend.saveCache.bind(sdk.backend);
  cleanups.push(() => publisher.close());
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    enter();
    await gate;
    return save(...args);
  });
  const pending = publisher.saveObjects(sdk.backend),
    rejected = expect(pending).rejects.toThrow('SDK abort');
  await entered;
  controller.abort(new Error('SDK abort'));
  expect(await f.store.root.stat('data')).toBeNull();
  resume();
  await rejected;
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('one');
  expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).toBeNull();
  expect(sdk.objects.has(f.pub.generation[11])).toBe(false);
});
it('starts epoch2 under the same keys after an unconfirmed SDK attempt returned safely', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub),
    key = f.pub.choices[0][0] === 'new' ? f.pub.choices[0][3] : '';
  cleanups.push(() => publisher.close());
  const save = vi.spyOn(sdk.backend, 'saveCache').mockResolvedValue(-1);
  await expect(publisher.saveObjects(sdk.backend)).rejects.toThrow('unconfirmed');
  save.mockRestore();
  const markerEpochs: number[] = [];
  vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'relocation-marker') {
      const marker = await f.store.readFixed(f.store.prefix + 'relocation/data.json');
      if (marker) markerEpochs.push(Number(tuple(marker)[4]));
    }
  });
  await publisher.saveObjects(sdk.backend);
  expect(markerEpochs).toContain(2);
  expect(sdk.calls.filter((c) => c.kind === 'save')[0].key).toBe(key);
  await publisher.publish(sdk.backend);
}, 20000);
it('refuses generation publication when a returned source changes after object receipts', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub);
  cleanups.push(() => publisher.close());
  await publisher.saveObjects(sdk.backend);
  await writeFile(f.root + '/data/a', 'bad');
  await expect(publisher.publish(sdk.backend)).rejects.toThrow();
  expect(sdk.objects.has(f.pub.generation[11])).toBe(false);
});

it.each(['body', 'replacement'] as const)(
  'keeps ownership and rejects receipts after SDK-time %s changes',
  async (bad) => {
    const f = await fixture(),
      sdk = await nativeCacheBackend(),
      publisher = MovingBasePublication.open(f.pub),
      save = sdk.backend.saveCache.bind(sdk.backend);
    cleanups.push(() => publisher.close());
    let armed = true;
    vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
      const id = await save(...args);
      if (armed) {
        armed = false;
        if (bad === 'body')
          await writeFile(f.store.root.resolve(f.pub.tree('data').root + '/payload/data/a'), 'bad');
        else await f.files('', { 'data/a': 'replacement' });
      }
      return id;
    });
    await expect(publisher.saveObjects(sdk.backend)).rejects.toThrow();
    expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).not.toBeNull();
    const cells = await f.pub.cells();
    try {
      expect(cells.rows[0][5]).toBeNull();
    } finally {
      cells.release();
    }
    expect(sdk.objects.has(f.pub.generation[11])).toBe(false);
  },
);
it('round trips the moving-source object through native SDK extraction and strong validation', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub);
  cleanups.push(() => publisher.close());
  await publisher.saveObjects(sdk.backend);
  await publisher.publish(sdk.backend);
  for (const row of f.pub.choices)
    if (row[0] === 'new') {
      const restored = await NativeObjectDownload.restore(
        f.store,
        sdk.backend,
        movingObjectRef(row),
        f.pub.options,
        true,
      );
      try {
        expect(restored.object).not.toBeNull();
        await restored.object!.verifyStable(f.pub.options);
      } finally {
        await restored.dispose();
      }
    }
});

it('preserves the primary save failure when resource closure blocks independent return', async () => {
  const f = await fixture(),
    sdk = await nativeCacheBackend(),
    publisher = MovingBasePublication.open(f.pub);
  cleanups.push(() => publisher.close());
  const close = vi
      .spyOn(RelocationEpoch.prototype, 'close')
      .mockRejectedValue(new Error('injected epoch close failure')),
    fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point === 'relocation-outbound-rename') throw new Error('primary save failure');
    });
  let failure: unknown;
  try {
    await publisher.saveObjects(sdk.backend);
  } catch (error) {
    failure = error;
  }
  const messages = (error: unknown): string[] =>
    error instanceof AggregateError
      ? [error.message, ...error.errors.flatMap(messages)]
      : error instanceof Error
        ? [error.message]
        : [];
  expect(messages(failure)).toContain('primary save failure');
  expect(messages(failure)).toContain('injected epoch close failure');
  expect(await f.store.readFixed(f.store.prefix + 'relocation/data.json')).not.toBeNull();
  close.mockRestore();
  fail.mockRestore();
  await publisher.close();
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const recovered = MovingBasePublication.open(pub);
  cleanups.push(() => recovered.close());
  await recovered.recoverSources();
  expect(await readFile(f.root + '/data/a', 'utf8')).toBe('one');
  await f.store.assertNoIntents();
});

it('preserves a recovery failure together with its failing finally-close', async () => {
  const f = await fixture(),
    epoch = await RelocationEpoch.open(f.pub, 'data');
  cleanups.push(() => epoch.close());
  await epoch.evacuate();
  await epoch.close();
  const pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
  cleanups.push(() => pub.dispose());
  const publisher = MovingBasePublication.open(pub);
  cleanups.push(() => publisher.close());
  const close = vi
      .spyOn(RelocationEpoch.prototype, 'close')
      .mockRejectedValue(new Error('recovery close failure')),
    fail = vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point === 'relocation-return-intent') throw new Error('primary recovery failure');
    });
  let failure: unknown;
  try {
    await publisher.recoverSources();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((e) => e.message)).toEqual([
    'primary recovery failure',
    'recovery close failure',
  ]);
  close.mockRestore();
  fail.mockRestore();
  await publisher.close();
  const next = MovingBasePublication.open(pub);
  cleanups.push(() => next.close());
  await next.recoverSources();
  await f.store.assertNoIntents();
});
