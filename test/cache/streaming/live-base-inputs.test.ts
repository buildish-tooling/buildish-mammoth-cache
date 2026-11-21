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

import { chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LiveBaseInputs,
  LiveNativeView,
  LocalBaseSnapshot,
} from '../../../src/cache/streaming/live-base-inputs';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { tuple } from '../../../src/cache/streaming/encoding';
import { observationFixture } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', {
    'data/retained': 'aggregate',
    'data/remove': 'old',
    'state/private': 'snapshot',
  });
  await chmod(f.store.root.resolve('state/private'), 0o600);
  await utimes(f.store.root.resolve('data/remove'), 1.234, 1.234);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  return f;
}
it('hashes retained aggregate once and copy/hashes a genuine selected snapshot before committing sources', async () => {
  const f = await fixture(),
    start = f.store.root.work.readBytes - f.store.root.work.scratchReadBytes;
  const reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  try {
    LiveBaseInputs.assert(input);
    expect(reads.mock.calls.map((call) => call[0]).sort()).toEqual([
      'data/retained',
      'state/private',
    ]);
    expect(input.work).toEqual({ hashBytes: 9, copyBytes: 8 });
    const source = input.partitions.find((p) => p.partition === 'state')!;
    expect(source.nativeRoot).toMatch(/snapshots/);
    expect(source.nativeRoot).not.toBe('');
    expect(await readFile(f.store.root.resolve(source.nativeRoot + '/state/private'), 'utf8')).toBe(
      'snapshot',
    );
    expect(await readFile(f.store.root.resolve('state/private'), 'utf8')).toBe('snapshot');
    expect(await f.store.root.stat('data/remove')).toBeNull();
    expect(
      f.store.root.work.readBytes - f.store.root.work.scratchReadBytes - start,
    ).toBeGreaterThanOrEqual(17);
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    expect(state[4]).toBe('gc-complete');
    expect(state[8]).toBeNull();
    expect(state[7]).toEqual(input.postSources);
    const tags: string[] = [];
    for await (const row of f.store.rows(source.evidence, 'native-evidence', {
      budget: f.budget,
      partition: 'state',
    }))
      tags.push(String(tuple(row.value)[0]));
    expect(tags.filter((t) => t === 'file')).toHaveLength(1);
  } finally {
    await input.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('rejects forged views and copy proofs rather than using serialized tuples as hash provenance', () => {
  expect(() => LiveNativeView.assert({} as never, {} as never)).toThrow();
  expect(() => LocalBaseSnapshot.assert({} as never, {} as never)).toThrow();
});
it('reuses exact committed post sources on reload without copying them again', async () => {
  const f = await fixture(),
    first = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  const post = first.postSources,
    root = first.partitions[1].nativeRoot;
  await first.dispose();
  const store = await OwnedStore.bind(f.root, f.store.codec),
    next = await LiveBaseInputs.capture(store, { budget: f.budget });
  try {
    expect(next.postSources).toEqual(post);
    expect(next.partitions[1].nativeRoot).toBe(root);
    expect(next.work.copyBytes).toBe(0);
  } finally {
    await next.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('preserves meaningful empty directories and seals root-only empty snapshots', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', {});
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  try {
    expect(input.work).toEqual({ hashBytes: 0, copyBytes: 0 });
    const state = input.partitions[1];
    let facts = 0;
    for await (const row of f.store.rows(state.evidence, 'native-evidence', {
      budget: f.budget,
      partition: 'state',
    }))
      if (tuple(row.value)[0] === 'directory') facts++;
    expect(facts).toBe(1);
  } finally {
    await input.dispose();
  }
  expect(f.budget.retained).toBe(0);
});

it('preserves meaningful empty directories in both live aggregate and copied snapshots', async () => {
  const f = await observationFixture();
  fixtures.push(f);
  for (const path of ['data/empty', 'state/empty'])
    await mkdir(f.store.root.resolve(path), { recursive: true });
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  try {
    const paths: string[] = [];
    for await (const row of f.store.rows(input.partitions[0].evidence, 'native-evidence', {
      budget: f.budget,
      partition: 'data',
    }))
      if (tuple(row.value)[0] === 'directory') paths.push(String(tuple(row.value)[1]));
    expect(paths).toEqual(['', 'data', 'data/empty']);
    expect((await f.store.root.stat(input.partitions[1].nativeRoot + '/state/empty'))?.[2]).toBe(
      'directory',
    );
  } finally {
    await input.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('keeps a committed post source on pointer failure and resumes it instead of recapturing', async () => {
  const f = await fixture();
  let failed = false;
  const store = await OwnedStore.bind(f.root, f.store.codec, async (name) => {
    if (name === 'post-sources-pointer' && !failed) {
      failed = true;
      throw new Error('pointer interruption');
    }
  });
  await expect(LiveBaseInputs.capture(store, { budget: f.budget })).rejects.toThrow(
    'pointer interruption',
  );
  expect(f.budget.retained).toBe(0);
  const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    committed = state[7];
  const input = await LiveBaseInputs.capture(await OwnedStore.bind(f.root, f.store.codec), {
    budget: f.budget,
  });
  try {
    expect(input.postSources).toEqual(committed);
    expect(input.work.copyBytes).toBe(0);
  } finally {
    await input.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('rejects changes to retained live or committed copied sources without making a new decision', async () => {
  const f = await fixture(),
    first = await LiveBaseInputs.capture(f.store, { budget: f.budget }),
    root = first.partitions[1].nativeRoot;
  await first.dispose();
  await writeFile(f.store.root.resolve(root + '/state/private'), 'modified');
  await expect(LiveBaseInputs.capture(f.store, { budget: f.budget })).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
  const g = await fixture();
  await writeFile(g.store.root.resolve('data/retained'), 'different');
  await expect(LiveBaseInputs.capture(g.store, { budget: g.budget })).rejects.toThrow();
  expect(g.budget.retained).toBe(0);
});
it('performs no source body read when cancelled before capture', async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  controller.abort();
  await expect(
    LiveBaseInputs.capture(f.store, { budget: f.budget, signal: controller.signal }),
  ).rejects.toThrow();
  expect(reads).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});

it('rejects a partial Maven coordinate before any current body hash or copy', async () => {
  const f = await observationFixture('maven', { excluded: ['**/excluded.jar'] });
  fixtures.push(f);
  await f.files('', {
    'repository/a/_remote.repositories': 'marker',
    'repository/a/owned.jar': 'owned',
    'repository/a/excluded.jar': 'excluded',
  });
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  await expect(LiveBaseInputs.capture(f.store, { budget: f.budget })).rejects.toThrow(
    'Incomplete Maven',
  );
  expect(reads).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});

it.each(['path', 'identity', 'mode'] as const)(
  'rejects mismatched persisted root %s before a source body read',
  async (change) => {
    const f = await fixture(),
      state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
      b = f.store.codec.schemas.documents.bindings.parse(
        await f.store.readDocument(state[5], 'bindings'),
      );
    if (change === 'path') b[5][0] += '-moved';
    else if (change === 'identity') b[5][1][4] = String(BigInt(b[5][1][4]) + 1n);
    else b[5][1][6] ^= 0o100;
    state[3]++;
    state[5] = f.store.codec.schemas.ref('bindings').parse(await f.store.writeDocument(b));
    await f.store.updateState(state);
    const reads = vi.spyOn(NativeReadPhase.prototype, 'read');
    await expect(LiveBaseInputs.capture(f.store, { budget: f.budget })).rejects.toThrow(
      'root binding changed',
    );
    expect(reads).not.toHaveBeenCalled();
    expect(f.budget.retained).toBe(0);
  },
);
it('resolves fresh Gradle quiescence and installation refs before any retained-source body work', async () => {
  const f = await observationFixture('gradle');
  fixtures.push(f);
  await f.files('', { 'data/a': 'aggregate', 'state/b': 'snapshot' });
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
    q = f.store.codec.schemas.documents.quiescence.parse(
      await f.store.readDocument(state[13]!, 'quiescence'),
    );
  await writeFile(f.store.root.resolve(q[3][2]), 'corrupt');
  const reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  await expect(LiveBaseInputs.capture(f.store, { budget: f.budget })).rejects.toThrow();
  expect(reads).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});

it('rechecks directory N after awaited descendants and rejects a late unknown child without relisting', async () => {
  const f = await fixture(),
    view = await LiveNativeView.capture(f.store, { budget: f.budget }),
    original = LiveNativeView.prototype.rows;
  let inserted = false;
  vi.spyOn(LiveNativeView.prototype, 'rows').mockImplementation(async function* (
    this: LiveNativeView,
    signal,
  ) {
    for await (const v of original.call(this, signal)) {
      yield v;
      if (this === view && tuple(v)[0] === 'file' && tuple(v)[1] === 'data/retained' && !inserted) {
        inserted = true;
        await writeFile(f.store.root.resolve('data/late'), 'unknown');
      }
    }
  });
  try {
    await expect(view.assertStable()).rejects.toThrow('retained live source changed');
    expect(inserted).toBe(true);
  } finally {
    await view.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
