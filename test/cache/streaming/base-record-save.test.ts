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

import { writeFile, readFile, mkdir, utimes } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { FrozenBasePublication } from '../../../src/cache/streaming/base-publication';
import { PreparedBaseSource, createBasePayload } from '../../../src/cache/streaming/base-object';
import { NativeObjectSave } from '../../../src/cache/streaming/base-transport';
import {
  PinnedBaseGeneration,
  ProvisionalBaseSet,
} from '../../../src/cache/streaming/base-generation';
import {
  acceptBaseGeneration,
  installBaseGeneration,
} from '../../../src/cache/streaming/base-incoming';
import { resolveModel } from '../../../src/cache/streaming/model';
import { encodeRecord, type Value } from '../../../src/cache/streaming/encoding';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import {
  cleanupBaseFixtures,
  nativeCacheBackend,
  baseFixture,
  preparedBase,
  seedBaseGeneration,
} from './base-fixtures';
import {
  publicationFixture,
  restartPublisher,
  initializePublisher,
} from './base-publication-fixtures';
import { initializeCompleteFixture } from './worker-complete-fixtures';
afterEach(() => {
  vi.restoreAllMocks();
  return cleanupBaseFixtures();
});
async function setup() {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    p = await FrozenBasePublication.freeze(
      f.store,
      'refs/heads/main',
      [{ kind: 'new', source: f.source }],
      { budget: f.budget },
    );
  return { f, sdk, p };
}
it('does not publish before completed source gates or with a missing object receipt', async () => {
  const { f, sdk, p } = await setup();
  try {
    await expect(p.publish(sdk.backend)).rejects.toThrow('completed source gates');
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    state[3]++;
    state[4] = 'sources-returned';
    await f.store.updateState(state);
    await expect(p.publish(sdk.backend)).rejects.toThrow('unconfirmed object');
    expect(sdk.calls).toEqual([]);
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it('rechecks actual final sources after successful object save before exposing a record', async () => {
  const { f, sdk, p } = await setup();
  try {
    await p.saveObjects(sdk.backend);
    await writeFile(f.store.root.resolve(f.payload + '/a'), 'bad');
    await expect(p.publish(sdk.backend)).rejects.toThrow();
    expect(sdk.objects.has(p.generation[11])).toBe(false);
    expect(sdk.calls.filter((c) => c.kind === 'save')).toHaveLength(1);
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it.each(['before', 'after', 'unknown'])(
  'publishes record last and reconciles response loss %s with the frozen key',
  async (when) => {
    const { f, sdk, p } = await setup();
    await p.saveObjects(sdk.backend);
    const save = sdk.backend.saveCache.bind(sdk.backend);
    let first = true;
    vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        if (when !== 'before') await save(...args);
        if (when === 'unknown') return -1;
        throw new Error('lost record response');
      }
      return save(...args);
    });
    try {
      if (when === 'before') await expect(p.publish(sdk.backend)).rejects.toThrow('unconfirmed');
      const expectedKey = p.generation[11],
        expectedObjects = p.generation[8];
      p.dispose();
      const resumed = await FrozenBasePublication.resume(await restartPublisher(f.store), {
        budget: f.budget,
      });
      try {
        await resumed.saveObjects(sdk.backend);
        await resumed.publish(sdk.backend);
        expect(resumed.generation[11]).toBe(expectedKey);
        expect(resumed.generation[8]).toEqual(expectedObjects);
        expect(((await f.store.state()) as Value[])[4]).toBe('record-saved');
        const saves = sdk.calls.filter((c) => c.kind === 'save');
        expect(saves[0].paths).toHaveLength(3);
        expect(saves.slice(1).every((c) => c.key === expectedKey && c.paths.length === 1)).toBe(
          true,
        );
        expect(sdk.calls.some((c) => c.kind === 'lookup')).toBe(false);
        const count = sdk.calls.length;
        await resumed.publish(sdk.backend);
        await resumed.saveObjects(sdk.backend);
        expect(sdk.calls).toHaveLength(count);
      } finally {
        resumed.dispose();
      }
    } finally {
      p.dispose();
      await f.source.dispose();
    }
    expect(f.budget.retained).toBe(0);
  },
);
it('blocks a malformed immutable record readback and never substitutes a new retry key', async () => {
  const { f, sdk, p } = await setup();
  await p.saveObjects(sdk.backend);
  const save = sdk.backend.saveCache.bind(sdk.backend);
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    await writeFile(f.store.root.resolve(p.record[2]), '[]\n');
    return save(...args);
  });
  try {
    await expect(p.publish(sdk.backend)).rejects.toThrow();
    await expect(p.publish(sdk.backend)).rejects.toThrow();
    expect(((await f.store.state()) as Value[])[4]).toBe('final-source-barrier');
    expect(new Set(sdk.calls.filter((c) => c.paths.length === 1).map((c) => c.key))).toEqual(
      new Set([p.generation[11]]),
    );
  } finally {
    p.dispose();
    await f.source.dispose();
  }
});
it('waits for record SDK settlement during cancellation and resumes the same committed record', async () => {
  const f = await publicationFixture(),
    sdk = await nativeCacheBackend(),
    abort = new AbortController(),
    p = await FrozenBasePublication.freeze(
      f.store,
      'refs/heads/main',
      [{ kind: 'new', source: f.source }],
      { budget: f.budget, signal: abort.signal },
    );
  await p.saveObjects(sdk.backend);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    }),
    save = sdk.backend.saveCache.bind(sdk.backend);
  vi.spyOn(sdk.backend, 'saveCache').mockImplementation(async (...args) => {
    entered();
    await wait;
    return save(...args);
  });
  const task = p.publish(sdk.backend);
  await started;
  abort.abort(new Error('record cancel'));
  expect(() => p.dispose()).toThrow('active');
  release();
  await expect(task).rejects.toThrow('record cancel');
  p.dispose();
  const next = await FrozenBasePublication.resume(await restartPublisher(f.store), {
    budget: f.budget,
  });
  try {
    await next.publish(sdk.backend);
    expect(((await f.store.state()) as Value[])[4]).toBe('record-saved');
  } finally {
    next.dispose();
    await f.source.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
it('round-trips mixed new/reuse/empty with connected Maven units and an inherited snapshot through actual SDK and V4a', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['jars', ['**/*.jar'], hard, 'aggregate', null, 'default'],
          ['poms', ['**/*.pom'], hard, 'aggregate', null, 'default'],
          ['gone', ['**/*.old'], hard, 'aggregate', null, 'default'],
          ['state', ['state/**'], hard, 'single-writer', null, 'default'],
        ],
      ],
      'mixed-',
      1,
    ),
    f = await baseFixture(model),
    sdk = await nativeCacheBackend(),
    jars = await preparedBase(f, { 'repository/g/a/1/a.jar': 'jar' }, 'jars'),
    gone = await preparedBase(f, { 'gone.old': 'old' }, 'gone'),
    state = await preparedBase(f, { 'state/a': 'snapshot' }, 'state');
  for (const object of [jars, gone, state])
    await NativeObjectSave.save(sdk.backend, object, { budget: f.budget });
  const baseline = await seedBaseGeneration(f, sdk, [
      ['object', 'jars', jars.reference],
      ['empty', 'poms'],
      ['object', 'gone', gone.reference],
      ['object', 'state', state.reference],
    ]),
    baselineQ = await f.store.write(
      'generation',
      (async function* () {
        yield encodeRecord(baseline);
      })(),
    ),
    inherited: Value = [
      'snapshot-source',
      ['state', 'baseline', ['baseline', state.reference[2]], state.evidence, state.payload],
    ],
    payload = await createBasePayload(f.store, 'poms');
  await mkdir(f.store.root.resolve(payload + '/repository/g/a/1'), { recursive: true });
  await writeFile(f.store.root.resolve(payload + '/repository/g/a/1/a.pom'), 'pom', {
    mode: 0o644,
  });
  await utimes(f.store.root.resolve(payload + '/repository/g/a/1/a.pom'), 1.234, 1.234);
  const source = await PreparedBaseSource.capture(f.store, 'poms', { budget: f.budget });
  await initializePublisher(f, [inherited], ['baseline', baseline[11], baselineQ], [inherited]);
  sdk.calls.length = 0;
  const p = await FrozenBasePublication.freeze(
    f.store,
    'refs/heads/main',
    [
      { kind: 'reuse', object: jars },
      { kind: 'new', source },
      { kind: 'empty', partition: 'gone' },
      { kind: 'reuse', object: state },
    ],
    { budget: f.budget },
  );
  try {
    expect(p.generation[9]).toEqual([['jars', 'poms'], ['gone'], ['state']]);
    await p.saveObjects(sdk.backend);
    await p.publish(sdk.backend);
    expect(sdk.calls.filter((c) => c.kind === 'save').map((c) => c.paths.length)).toEqual([3, 1]);
    const target = await baseFixture(model),
      bodyHashes = vi.spyOn(NativeReadPhase.prototype, 'hash');
    await initializeCompleteFixture({ ...target, context: target.store.codec.options.context }, []);
    const pin = (await PinnedBaseGeneration.discover(
        target.store,
        sdk.backend,
        { currentRef: 'refs/heads/main' },
        { budget: target.budget },
      ))!,
      set = await ProvisionalBaseSet.acquire(pin, sdk.backend, { budget: target.budget });
    try {
      const reads = vi.spyOn(NativeReadPhase.prototype, 'read'),
        result = await acceptBaseGeneration(target.store, set, { budget: target.budget });
      expect(reads.mock.calls.length).toBeGreaterThan(0); // selected independent snapshot copy only
      expect(result.snapshotCopyBytes).toBe(8);
      expect(result.snapshots).toHaveLength(1);
      expect(result.cold).toEqual([]);
      await installBaseGeneration(target.store, result, { budget: target.budget });
      expect(await readFile(target.store.root.resolve('repository/g/a/1/a.jar'), 'utf8')).toBe(
        'jar',
      );
      expect(await readFile(target.store.root.resolve('repository/g/a/1/a.pom'), 'utf8')).toBe(
        'pom',
      );
      expect(await readFile(target.store.root.resolve('state/a'), 'utf8')).toBe('snapshot');
      expect(await target.store.root.stat('gone.old')).toBe(null);
      expect(bodyHashes).not.toHaveBeenCalled();
    } finally {
      await set.dispose();
      await pin.dispose();
    }
    expect(target.budget.retained).toBe(0);
  } finally {
    p.dispose();
    await source.dispose();
  }
  expect(f.budget.retained).toBe(0);
}, 30000);

it('resumes after record service confirmation but before durable record-saved state', async () => {
  const { f, sdk, p } = await setup();
  await p.saveObjects(sdk.backend);
  const update = f.store.updateState.bind(f.store);
  let fail = true;
  vi.spyOn(f.store, 'updateState').mockImplementation(async (state) => {
    if ((state as Value[])[4] === 'record-saved' && fail) {
      fail = false;
      throw new Error('pointer interrupted');
    }
    return update(state);
  });
  await expect(p.publish(sdk.backend)).rejects.toThrow('pointer interrupted');
  expect(sdk.objects.has(p.generation[11])).toBe(true);
  const key = p.generation[11];
  p.dispose();
  const next = await FrozenBasePublication.resume(await restartPublisher(f.store), {
    budget: f.budget,
  });
  try {
    await next.publish(sdk.backend);
    expect(next.generation[11]).toBe(key);
  } finally {
    next.dispose();
    await f.source.dispose();
  }
  expect(f.budget.retained).toBe(0);
});
