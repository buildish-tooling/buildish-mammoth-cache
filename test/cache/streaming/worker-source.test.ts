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

import { mkdir, writeFile, rm, readdir, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerSources } from '../../../src/cache/streaming/worker-walk';
import { WorkerSpool, DiskMembership } from '../../../src/cache/streaming/worker-spool';
import { writeWorkerArchive, readWorkerArchive } from '../../../src/cache/streaming/worker-codec';
import { type Value, tuple, Digest } from '../../../src/cache/streaming/encoding';
import { byteSource } from './protocol-fixtures';
import {
  sourceFixture as fixture,
  freezeSources as freeze,
  cleanupSourceFixtures,
} from './worker-source-fixtures';
afterEach(cleanupSourceFixtures);
const signal = () => new AbortController().signal;
it('routes a real frozen tree once, reads selected bodies only during encoding, and guards sealing', async () => {
  const f = await fixture(),
    view = await freeze(f),
    sources = await WorkerSources.create(f.store, view, f.budget);
  expect(sources.work.listings).toBe(2);
  expect(f.store.root.work.readBytes).toBeGreaterThan(0);
  const chunks: Buffer[] = [],
    sink = new Writable({
      write(b, _e, cb) {
        chunks.push(Buffer.from(b));
        cb();
      },
    });
  const readBefore = f.store.root.work.readBytes;
  await writeWorkerArchive(
    sink,
    {
      model: f.model,
      context: f.store.codec.options.context,
      authorizedSnapshots: [],
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      snapshots: [],
      assertStable: (s) => sources.assertStable(s),
    },
    (s) => sources.events(s),
  );
  let bodies = 0;
  await readWorkerArchive(byteSource(Buffer.concat(chunks)), {
    model: f.model,
    context: f.store.codec.options.context,
    authorizedSnapshots: [],
    budget: f.budget,
    membership: await DiskMembership.create(f.store, f.budget),
    async consumeFile({ body }) {
      for await (const b of body) bodies += b.length;
    },
  });
  expect(bodies).toBe(7);
  expect(f.store.root.work.readBytes - readBefore).toBeGreaterThanOrEqual(7);
  await writeFile(path.join(f.root, 'd/new'), 'late');
  await expect(sources.assertStable(signal())).rejects.toThrow('changed');
  await sources.dispose();
  expect(f.budget.retained).toBe(0);
});
it('accepts exactly proved GC removals and rejects missing progress, extra members and retained replacements', async () => {
  const f = await fixture(),
    view = await freeze(f, 'd/b');
  await expect(
    WorkerSources.create(f.store, { ...view, gcProgress: null }, f.budget),
  ).rejects.toThrow('GC progress');
  const sources = await WorkerSources.create(f.store, view, f.budget);
  await sources.dispose();
  await writeFile(path.join(f.root, 'd/new'), 'extra');
  await expect(WorkerSources.create(f.store, view, f.budget)).rejects.toThrow();
  await rm(path.join(f.root, 'd/new'));
  await rename(path.join(f.root, 'd/a'), path.join(f.root, 'old'));
  await writeFile(path.join(f.root, 'd/a'), 'abc');
  await expect(WorkerSources.create(f.store, view, f.budget)).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('seals independent disk membership forks, verifies replay integrity and cleans cancelled work', async () => {
  const f = await fixture(),
    spool = await DiskMembership.create(f.store, f.budget),
    fork = await spool.fork(1, signal());
  await spool.append(['member', 'file', 'a'], signal());
  await fork.append(['member', 'unit', 'd'], signal());
  const replay = await spool.seal(signal()),
    other = await fork.seal(signal());
  const rows: Value[] = [];
  for await (const r of replay()) rows.push(r);
  expect(rows).toEqual([['member', 'file', 'a']]);
  const more: Value[] = [];
  for await (const r of other()) more.push(r);
  expect(more).toEqual([['member', 'unit', 'd']]);
  await expect(spool.append(['member', 'file', 'b'], signal())).rejects.toThrow('sealed');
  await spool.dispose();
  await fork.dispose();
  const raw = await WorkerSpool.create(f.store, f.budget);
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  await expect(raw.append(['x'], aborted.signal)).rejects.toThrow('cancelled');
  await raw.dispose();
  expect(f.budget.retained).toBe(0);
  // All operation-local directories were retired; no file-per-member residue.
  const planning = path.join(f.root, f.store.prefix, 'planning');
  expect(await readdir(planning)).toEqual([]);
  expect(await readFile(path.join(f.root, 'd/a'), 'utf8')).toBe('abc');
});

it('keeps meaningful empty aggregate directories and complete workspace markers', async () => {
  const f = await fixture(),
    unit = 'caches/transforms-4/' + 'a'.repeat(32);
  await mkdir(path.join(f.root, unit, 'transformed'), { recursive: true });
  await mkdir(path.join(f.root, 'empty'));
  await writeFile(path.join(f.root, unit, 'metadata.bin'), 'm');
  await writeFile(path.join(f.root, unit, 'results.bin'), 'r');
  const view = await freeze(f, '', unit),
    sources = await WorkerSources.create(f.store, view, f.budget),
    events = [];
  for await (const e of sources.events(signal())) {
    if (e.type === 'file') for await (const b of e.bytes) void b;
    events.push(e.type === 'dir-open' ? e.path : e.type);
  }
  expect(events).toContain('empty');
  expect(events).toContain(unit + '/transformed');
  expect(events).toContain('unit-open');
  const chunks: Buffer[] = [];
  await writeWorkerArchive(
    new Writable({
      write(b, _e, cb) {
        chunks.push(Buffer.from(b));
        cb();
      },
    }),
    {
      model: f.model,
      context: f.store.codec.options.context,
      authorizedSnapshots: [],
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      snapshots: [],
      assertStable: (s) => sources.assertStable(s),
    },
    (s) => sources.events(s),
  );
  await readWorkerArchive(byteSource(Buffer.concat(chunks)), {
    model: f.model,
    context: f.store.codec.options.context,
    authorizedSnapshots: [],
    budget: f.budget,
    membership: await DiskMembership.create(f.store, f.budget),
    async consumeFile({ body }) {
      for await (const b of body) void b;
    },
  });
  await sources.dispose();
  expect(f.budget.retained).toBe(0);
});
it('accepts deleted workspace with protected survivors and rejects unrelated ancestor changes', async () => {
  const f = await fixture(),
    unit = 'caches/transforms-4/' + 'a'.repeat(32);
  await mkdir(path.join(f.root, unit, 'transformed'), { recursive: true });
  await writeFile(path.join(f.root, unit, 'keep.lock'), 'protected');
  await writeFile(path.join(f.root, unit, 'metadata.bin'), 'm');
  await writeFile(path.join(f.root, unit, 'results.bin'), 'r');
  const view = await freeze(f, 'remove-unit', unit),
    sources = await WorkerSources.create(f.store, view, f.budget);
  for await (const e of sources.events(signal())) {
    expect(e.type).not.toBe('unit-open');
    if (e.type === 'file') for await (const b of e.bytes) void b;
  }
  await sources.dispose();
  await rm(path.join(f.root, unit), { recursive: true });
  await expect(WorkerSources.create(f.store, view, f.budget)).rejects.toThrow('Protected child');
  expect(f.budget.retained).toBe(0);
  await mkdir(path.join(f.root, unit), { recursive: true });
  await writeFile(path.join(f.root, unit, 'new.lock'), 'unexpected');
  await expect(WorkerSources.create(f.store, view, f.budget)).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});

it('emits complete snapshot empty leaves in a channel after aggregate and usage', async () => {
  const f = await fixture(true);
  await mkdir(path.join(f.root, 'empty'));
  const view = await freeze(f),
    sources = await WorkerSources.create(f.store, view, f.budget),
    chunks: Buffer[] = [];
  expect(sources.snapshots).toEqual(['data']);
  await writeWorkerArchive(
    new Writable({
      write(b, _e, cb) {
        chunks.push(Buffer.from(b));
        cb();
      },
    }),
    {
      model: f.model,
      context: f.store.codec.options.context,
      authorizedSnapshots: ['data'],
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      snapshots: sources.snapshots,
      assertStable: (s) => sources.assertStable(s),
    },
    (s) => sources.events(s),
  );
  const opens: Value[] = [];
  await readWorkerArchive(byteSource(Buffer.concat(chunks)), {
    model: f.model,
    context: f.store.codec.options.context,
    authorizedSnapshots: ['data'],
    budget: f.budget,
    membership: await DiskMembership.create(f.store, f.budget),
    async consumeFile({ body }) {
      for await (const b of body) void b;
    },
    async event(v) {
      const r = tuple(v);
      if (r[0] === 'dir-open') opens.push(v);
    },
  });
  expect(opens).toContainEqual(['dir-open', 2, 'empty']);
  await sources.dispose();
  expect(f.budget.retained).toBe(0);
});
it('checks Maven nontransient excluded siblings against the complete physical projection', async () => {
  const f = await fixture(false, 'maven');
  await mkdir(path.join(f.root, 'repository/g/a/1'), { recursive: true });
  await writeFile(path.join(f.root, 'repository/g/a/1/a.jar'), 'jar');
  await writeFile(path.join(f.root, 'repository/g/a/1/x.lock'), 'transient');
  const view = await freeze(f, '', 'repository/g/a/1'),
    sources = await WorkerSources.create(
      f.store,
      { ...view, prune: (p) => p.endsWith('.lock') },
      f.budget,
    );
  await sources.dispose();
  // The same frozen child must not be hidden by a new broader prune projection.
  await expect(
    WorkerSources.create(
      f.store,
      { ...view, prune: (p) => p.endsWith('.jar') || p.endsWith('.lock') },
      f.budget,
    ),
  ).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});
it('rejects an ancestor touch unrelated to an immediate planned removal', async () => {
  const f = await fixture(),
    view = await freeze(f, 'd/b');
  const { utimes } = await import('node:fs/promises');
  await utimes(f.root, new Date(100000), new Date(100000));
  await expect(WorkerSources.create(f.store, view, f.budget)).rejects.toThrow(
    'Unexplained directory',
  );
  expect(f.budget.retained).toBe(0);
});

it('reuses canonical scratch bytes for spool digests and rejects altered replay', async () => {
  const f = await fixture(),
    spool = await WorkerSpool.create(f.store, f.budget),
    update = vi.spyOn(Digest.prototype, 'update');
  try {
    for (const name of ['a', 'b', 'c']) await spool.append(['row', name], signal());
    spool.seal(signal());
    for await (const r of spool.rows(signal())) void r;
    expect(update).not.toHaveBeenCalled();
  } finally {
    update.mockRestore();
  }
  const planning = path.join(f.root, f.store.prefix, 'planning'),
    [dir] = await readdir(planning),
    file = path.join(planning, dir, 'scratch.ndjson');
  await writeFile(file, (await readFile(file, 'utf8')).replace('"b"', '"z"'));
  await expect(
    (async () => {
      for await (const r of spool.rows(signal())) void r;
    })(),
  ).rejects.toThrow('Changed worker spool');
  await spool.dispose();
  expect(f.budget.retained).toBe(0);
});

it('pins source reference tuples before awaits and exposes immutable snapshot declarations', async () => {
  const f = await fixture(true),
    view = await freeze(f),
    original = [...view.observations];
  const pending = WorkerSources.create(f.store, view, f.budget);
  view.observations[4] = 'f'.repeat(64);
  const sources = await pending;
  expect(sources.snapshots).toEqual(['data']);
  expect(Object.isFrozen(sources.snapshots)).toBe(true);
  const rows = [];
  for await (const e of sources.events(signal())) {
    if (e.type === 'file') for await (const b of e.bytes) void b;
    rows.push(e.type);
  }
  expect(rows.filter((t) => t === 'channel-open')).toHaveLength(3);
  expect(original[4]).not.toBe(view.observations[4]);
  await sources.dispose();
  expect(f.budget.retained).toBe(0);
});

it.each(['0-excluded.jar', 'z-excluded.jar'])(
  'rejects frozen excluded Maven sibling %s before and after the last managed file',
  async (name) => {
    const f = await fixture(false, 'maven'),
      unit = 'repository/g/a/1';
    await mkdir(path.join(f.root, unit), { recursive: true });
    await writeFile(path.join(f.root, unit, 'a.jar'), 'jar');
    await writeFile(path.join(f.root, unit, name), 'excluded');
    const view = await freeze(f, '', unit);
    await expect(
      WorkerSources.create(
        f.store,
        { ...view, prune: (p) => p.endsWith('-excluded.jar') },
        f.budget,
      ),
    ).rejects.toThrow('Incomplete Maven');
    expect(f.budget.retained).toBe(0);
  },
);

it('honors cancellation during terminal source cleanup and stability barriers', async () => {
  const f = await fixture(),
    view = await freeze(f),
    controller = new AbortController();
  let sealed = false;
  const seal = WorkerSpool.prototype.seal,
    sealSpy = vi.spyOn(WorkerSpool.prototype, 'seal').mockImplementation(function (
      this: WorkerSpool,
      s,
    ) {
      seal.call(this, s);
      sealed = true;
    });
  const sync = f.store.root.syncDirectory.bind(f.store.root),
    syncSpy = vi.spyOn(f.store.root, 'syncDirectory').mockImplementation(async (p) => {
      const synced = await sync(p);
      if (sealed) controller.abort(new Error('terminal abort'));
      return synced;
    });
  try {
    await expect(WorkerSources.create(f.store, view, f.budget, controller.signal)).rejects.toThrow(
      'terminal abort',
    );
  } finally {
    sealSpy.mockRestore();
    syncSpy.mockRestore();
  }
  const sources = await WorkerSources.create(f.store, view, f.budget),
    final = new AbortController(),
    verify = f.store.root.verifyRoot.bind(f.store.root),
    verifySpy = vi.spyOn(f.store.root, 'verifyRoot').mockImplementation(async () => {
      await verify();
      final.abort(new Error('final root abort'));
    });
  try {
    await expect(sources.assertStable(final.signal)).rejects.toThrow('final root abort');
  } finally {
    verifySpy.mockRestore();
    await sources.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
