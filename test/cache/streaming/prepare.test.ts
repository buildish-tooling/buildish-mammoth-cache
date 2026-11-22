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

import { chmod, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './install-fixture';
import {
  prepareStreaming,
  type StreamingPrepareRequest,
} from '../../../src/cache/streaming/prepare';
import { resolveModel, type ResolvedModel } from '../../../src/cache/streaming/model';
import { OpenedInvocation, decodeInvocationAnchor } from '../../../src/cache/streaming/invocation';
import { ExclusiveWindow } from '../../../src/cache/streaming/quiescence';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { PrepareFacts } from '../../../src/cache/streaming/prepare-state';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import {
  nativeCacheBackend,
  baseFixture,
  preparedBase,
  seedBaseGeneration,
  cleanupBaseFixtures,
} from './base-fixtures';
import { memoryArtifacts } from './memory-artifact-fixture';
import {
  sourceFixture,
  freezeRetainedSources,
  cleanupSourceFixtures,
} from './worker-source-fixtures';
import {
  freezeWorkerArtifact,
  uploadWorkerArtifact,
} from '../../../src/cache/streaming/worker-service';
import * as workerMerge from '../../../src/cache/streaming/worker-merge';
import { NativeObjectSave } from '../../../src/cache/streaming/base-transport';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
  await cleanupBaseFixtures();
  await cleanupSourceFixtures();
});
async function fixture(overrides: Partial<StreamingPrepareRequest> = {}, model?: ResolvedModel) {
  const f = await installFixture('maven', { model });
  fixtures.push(f);
  let saved = '';
  const backend: BaseCacheBackend = {
    capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
    isFeatureAvailable: () => true,
    restoreCache: vi.fn(async () => undefined),
    saveCache: vi.fn(async () => 1),
    isMissingPathsError: () => false,
  };
  const provision = vi.fn(async () => {}),
    hooks = vi.fn(async () => {});
  const request: StreamingPrepareRequest = {
    root: f.root,
    model: f.model,
    context: f.store.codec.options.context,
    nonce: String(f.bindings[4]),
    budget: f.budget,
    policy: {
      role: 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: [],
    },
    currentRef: 'refs/heads/main',
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    saveAnchor: (raw) => {
      saved = raw;
    },
    cacheBackend: async () => backend,
    provision,
    installHooks: hooks,
    assertCurrent: (): undefined => {},
    ...overrides,
  };
  return { ...f, request, backend, provision, hooks, saved: () => saved };
}
it('prepares a genuine cold invocation, clears stale snapshots, preserves ordinary data and freezes cutoff last', async () => {
  const order: string[] = [],
    f = await fixture({
      now: () => 42,
      provision: async () => {
        order.push('provision');
      },
      installHooks: async (store) => {
        const state = store.codec.schemas.documents['local-state'].parse(await store.state());
        const b = store.codec.schemas.documents.bindings.parse(
          await store.readDocument(state[5], 'bindings'),
        );
        expect(state[4]).toBe('prepare-pending');
        expect(b[8][7]).toBeNull();
        order.push('hooks');
      },
    });
  await f.files('', { 'data/keep': 'ordinary', 'state/stale': 'must-clear' });
  const ready = await prepareStreaming(f.request);
  expect(order).toEqual(['provision', 'hooks']);
  expect(ready.cutoff).toBe(42);
  expect(ready.restoredKey).toBeNull();
  expect(ready.workerCount).toBe(0);
  expect(await f.store.root.stat('state/stale')).toBeNull();
  expect(await readFile(f.store.root.resolve('data/keep'), 'utf8')).toBe('ordinary');
  const anchor = decodeInvocationAnchor(f.saved());
  expect(anchor[0]).toBe('streaming-lifecycle');
  const reopened = await OpenedInvocation.open(ready.anchor, f.budget);
  expect(reopened.state[4]).toBe('build-ready');
  const facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.selection![5]).toEqual(['miss']);
    expect(facts.selection![6]).toEqual(['selected', []]);
    expect(facts.selection![9]).toBe('workers-installed');
    expect(facts.sources).toHaveLength(1);
  } finally {
    facts.close();
  }
  const window = await ExclusiveWindow.establish(ready.store, f.budget, {
    assertCurrent: (): undefined => {},
  });
  if (window.status !== 'ready') throw new Error(window.message);
  try {
    await captureObservations(ready.store, {
      budget: f.budget,
      signal: window.window.signal,
      purgeWindow: window.window.purgeWindow,
    });
  } finally {
    window.window.close();
  }
  expect(((await ready.store.state()) as unknown[])[4]).toBe('observations-frozen');
  expect(f.budget.retained).toBe(0);
});
it('retry after a hook failure uses frozen miss/GC cutoff without rediscovery or moving final cutoff', async () => {
  let now = 1000000,
    fail = true;
  const f = await fixture({ now: () => now });
  const request = {
    ...f.request,
    policy: { ...f.request.policy, gcAgeMs: 1000 },
    installHooks: async () => {
      if (fail) throw new Error('hook failed');
    },
  };
  await expect(prepareStreaming(request)).rejects.toThrow('hook failed');
  let facts = await PrepareFacts.open((await OpenedInvocation.current(f.root, f.budget))!.store, {
    budget: f.budget,
  });
  try {
    expect(facts.bindings[8][6]).toBe(999000);
    expect(facts.bindings[8][7]).toBeNull();
    expect(facts.selection![9]).toBe('workers-installed');
  } finally {
    facts.close();
  }
  expect(f.backend.restoreCache).toHaveBeenCalledTimes(1);
  fail = false;
  now = 2000000;
  const ready = await prepareStreaming(request);
  expect(ready.cutoff).toBe(2000000);
  expect(f.backend.restoreCache).toHaveBeenCalledTimes(1);
  facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.bindings[8][6]).toBe(999000);
  } finally {
    facts.close();
  }
  now = 3000000;
  expect((await prepareStreaming(request)).cutoff).toBe(2000000);
  expect(f.backend.restoreCache).toHaveBeenCalledTimes(1);
  await expect(
    prepareStreaming({ ...request, policy: { ...request.policy, gcAgeMs: 2000 } }),
  ).rejects.toThrow('execution configuration');
});
it('uses real native SDK archives for accepted base restore and retains independent snapshot authority', async () => {
  const f = await fixture(),
    source = await baseFixture(f.model),
    sdk = await nativeCacheBackend();
  const data = await preparedBase(source, { 'data/new': 'from-base' }, 'data'),
    state = await preparedBase(source, { 'state/new': 'snapshot' }, 'state');
  await NativeObjectSave.save(sdk.backend, data, { budget: source.budget });
  await NativeObjectSave.save(sdk.backend, state, { budget: source.budget });
  const generation = await seedBaseGeneration(source, sdk, [
    ['object', 'data', data.reference],
    ['object', 'state', state.reference],
  ]);
  await f.files('', { 'data/old': 'prune', 'state/old': 'replace' });
  const ready = await prepareStreaming({
    ...f.request,
    cacheBackend: async () => sdk.backend,
    currentRef: 'refs/heads/feature',
    defaultRef: 'refs/heads/main',
    policy: { ...f.request.policy, restoreCleanup: 'prune-managed' },
  });
  expect(ready.restoredKey).toBe(generation[11]);
  expect(await readFile(f.store.root.resolve('data/new'), 'utf8')).toBe('from-base');
  expect(await readFile(f.store.root.resolve('state/new'), 'utf8')).toBe('snapshot');
  expect(await f.store.root.stat('data/old')).toBeNull();
  expect(await f.store.root.stat('state/old')).toBeNull();
  const facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.sources).toHaveLength(1);
    expect(facts.sources[0][4]).not.toContain('/install/');
    expect(
      await readFile(ready.store.root.resolve(facts.sources[0][4] + '/state/new'), 'utf8'),
    ).toBe('snapshot');
  } finally {
    facts.close();
  }
  expect(source.budget.retained).toBe(0);
  expect(sdk.calls.filter((c) => c.kind === 'restore').every((c) => c.paths.length <= 3)).toBe(
    true,
  );
});

async function workerArtifacts(
  f: Awaited<ReturnType<typeof fixture>>,
  jobs: readonly string[] = ['A', 'B'],
  different = false,
  prefix = 'data',
) {
  const service = memoryArtifacts();
  for (const job of jobs) {
    const source = await sourceFixture(false, 'maven', f.model, job);
    await rm(source.store.root.resolve('d'), { recursive: true, force: true });
    await mkdir(source.store.root.resolve(prefix), { recursive: true });
    await writeFile(source.store.root.resolve(prefix + '/only-' + job), job);
    await writeFile(source.store.root.resolve(prefix + '/shared'), different ? job : 'equivalent');
    if (job === 'A') {
      await mkdir(source.store.root.resolve('state'));
      await writeFile(source.store.root.resolve('state/from-A'), 'complete snapshot');
    }
    const view = await freezeRetainedSources(
        source,
        prefix.startsWith('repository/') ? [prefix] : [],
        job === 'A' ? ['state'] : [],
      ),
      archive = await freezeWorkerArtifact(service.api, source.store, view, source.budget);
    await uploadWorkerArtifact(service.api, archive);
    expect(source.budget.retained).toBe(0);
  }
  const context = [...f.request.context] as typeof f.request.context;
  context[4] = 'parent';
  const request = {
    ...f.request,
    context,
    artifactBackend: async () => service.api,
    policy: {
      ...f.request.policy,
      role: 'distributed-aggregator' as const,
      ordinaryOrder: [...jobs].reverse(),
    },
  };
  return { service, request };
}
it('composes two real worker archives in configured order, installing complete snapshot authority', async () => {
  const f = await fixture(),
    { service, request } = await workerArtifacts(f);
  await f.files('', { 'data/local': 'keep local aggregate', 'state/stale': 'old' });
  const warnings = vi.fn(),
    ready = await prepareStreaming({
      ...request,
      policy: { ...request.policy, ordinaryOrder: ['B', 'A', 'B'] },
      onWorkerWarnings: warnings,
    });
  expect(warnings).toHaveBeenCalledWith({ count: 0, details: [] });
  for (const [name, body] of Object.entries({
    'data/only-A': 'A',
    'data/only-B': 'B',
    'data/shared': 'equivalent',
    'data/local': 'keep local aggregate',
    'state/from-A': 'complete snapshot',
  }))
    expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
  expect(await f.store.root.stat('state/stale')).toBeNull();
  expect(ready.workerCount).toBe(2);
  expect(service.list).toHaveBeenCalledTimes(1);
  expect(service.download.mock.calls.map(([id]) => id)).toEqual([2, 1]);
  const facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.bindings[8][10]).toEqual(['B', 'A']);
    expect(facts.selection![6][0]).toBe('selected');
    expect(
      (facts.selection![6] as ['selected', Array<unknown[]>])[1].map((r) => (r[4] as string[])[4]),
    ).toEqual(['B', 'A']);
    expect(facts.producers.map((p) => p[3][4])).toEqual(['A', 'B']);
    expect(facts.sources[0][1]).toBe('worker-writer');
    expect(
      await readFile(ready.store.root.resolve(facts.sources[0][4] + '/state/from-A'), 'utf8'),
    ).toBe('complete snapshot');
  } finally {
    facts.close();
  }
});
it.each([
  [
    ['B', 'A', 'B'],
    ['B', 'A'],
  ],
  [
    ['B', 'A'],
    ['B', 'A', 'B'],
  ],
])(
  'retry with equivalent ordinary order %j → %j preserves frozen selection',
  async (initial, equivalent) => {
    const f = await fixture(),
      { service, request } = await workerArtifacts(f);
    let fail = true;
    const retry = {
      ...request,
      policy: { ...request.policy, ordinaryOrder: initial },
      installHooks: async () => {
        if (fail) throw new Error('hook failed');
      },
    };
    await expect(prepareStreaming(retry)).rejects.toThrow('hook failed');
    await f.files('', { 'data/only-A': 'later local change' });
    fail = false;
    await prepareStreaming({
      ...retry,
      policy: { ...retry.policy, ordinaryOrder: equivalent },
    });
    expect(await readFile(f.store.root.resolve('data/only-A'), 'utf8')).toBe('later local change');
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.download).toHaveBeenCalledTimes(2);
  },
);
it('admits seventeen repetitions of one ordinary producer as a single request', async () => {
  const f = await fixture(),
    { service, request } = await workerArtifacts(f, ['A']),
    ready = await prepareStreaming({
      ...request,
      policy: { ...request.policy, ordinaryOrder: Array(17).fill('A') },
    }),
    facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.bindings[8][10]).toEqual(['A']);
    expect(ready.workerCount).toBe(1);
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.download.mock.calls.map(([id]) => id)).toEqual([1]);
    expect(await readFile(ready.store.root.resolve('state/from-A'), 'utf8')).toBe(
      'complete snapshot',
    );
  } finally {
    facts.close();
  }
});
it('keeps a snapshot-only writer outside the deduplicated ordinary order', async () => {
  const f = await fixture(),
    { service, request } = await workerArtifacts(f),
    ready = await prepareStreaming({
      ...request,
      policy: { ...request.policy, ordinaryOrder: ['B', 'B'] },
    }),
    facts = await PrepareFacts.open(ready.store, { budget: f.budget });
  try {
    expect(facts.bindings[8][10]).toEqual(['B']);
    expect(ready.workerCount).toBe(2);
    expect(service.download.mock.calls.map(([id]) => id)).toEqual([2, 1]);
    expect(await ready.store.root.stat('data/only-A')).toBeNull();
    expect(await readFile(ready.store.root.resolve('data/only-B'), 'utf8')).toBe('B');
    expect(await readFile(ready.store.root.resolve('state/from-A'), 'utf8')).toBe(
      'complete snapshot',
    );
  } finally {
    facts.close();
  }
});
it('rejects seventeen distinct ordinary producers before provisioning or backend work', async () => {
  const f = await fixture(),
    backend = vi.fn(f.request.cacheBackend);
  await expect(
    prepareStreaming({
      ...f.request,
      policy: {
        ...f.request.policy,
        role: 'distributed-aggregator',
        ordinaryOrder: Array.from({ length: 17 }, (_, i) => 'job-' + i),
      },
      cacheBackend: backend,
    }),
  ).rejects.toThrow(/producer admission exceeded/i);
  expect(f.provision).not.toHaveBeenCalled();
  expect(f.hooks).not.toHaveBeenCalled();
  expect(backend).not.toHaveBeenCalled();
});
it('counts an additional snapshot-only writer toward the total producer limit', async () => {
  const f = await fixture(),
    service = memoryArtifacts(),
    context = [...f.request.context] as typeof f.request.context;
  context[4] = 'parent';
  await expect(
    prepareStreaming({
      ...f.request,
      context,
      artifactBackend: async () => service.api,
      policy: {
        ...f.request.policy,
        role: 'distributed-aggregator',
        ordinaryOrder: Array.from({ length: 16 }, (_, i) => 'job-' + i),
      },
    }),
  ).rejects.toThrow('Invalid prepare producer requests');
  expect(service.list).not.toHaveBeenCalled();
  expect(service.download).not.toHaveBeenCalled();
  expect(f.hooks).not.toHaveBeenCalled();
});
it('distinguishes missing required artifacts from a valid committed empty optional selection', async () => {
  const f = await fixture(),
    service = memoryArtifacts(),
    context = [...f.request.context] as typeof f.request.context;
  context[4] = 'parent';
  const request = {
    ...f.request,
    context,
    artifactBackend: async () => service.api,
    policy: { ...f.request.policy, role: 'distributed-aggregator' as const, ordinaryOrder: [] },
  };
  const ready = await prepareStreaming(request);
  expect(ready.workerCount).toBe(0);
  expect(service.list).toHaveBeenCalledTimes(1);
  const other = await fixture(),
    otherContext = [...other.request.context] as typeof other.request.context;
  otherContext[4] = 'other-parent';
  await expect(
    prepareStreaming({
      ...other.request,
      context: otherContext,
      artifactBackend: async () => service.api,
      policy: { ...other.request.policy, role: 'distributed-aggregator', ordinaryOrder: ['A'] },
    }),
  ).rejects.toThrow('no artifact');
  expect(other.hooks).not.toHaveBeenCalled();
});

it('validates a late worker seal before clearing/installing any live base or snapshot content', async () => {
  const f = await fixture(),
    { service, request } = await workerArtifacts(f, ['A']);
  const value = [...service.objects.values()][0],
    tar = gunzipSync(value.bytes);
  // Keep valid TAR framing and gzip transport while changing the final completion digest.
  const ascii = tar.toString('utf8'),
    matches = [...ascii.matchAll(/[a-f0-9]{64}/g)];
  const last = matches.at(-1)!;
  expect(last).toBeDefined();
  const offset = last.index!;
  tar[offset] = tar[offset] === 0x61 ? 0x62 : 0x61;
  value.bytes = gzipSync(tar);
  value.artifact = {
    ...value.artifact,
    size: value.bytes.length,
    digest: 'sha256:' + createHash('sha256').update(value.bytes).digest('hex'),
  };
  await f.files('', { 'data/live': 'ordinary', 'state/stale': 'untouched on invalid worker' });
  await expect(prepareStreaming(request)).rejects.toThrow();
  expect(await readFile(f.store.root.resolve('state/stale'), 'utf8')).toBe(
    'untouched on invalid worker',
  );
  expect(await f.store.root.stat('data/only-A')).toBeNull();
  expect(f.hooks).not.toHaveBeenCalled();
  await expect(prepareStreaming(request)).rejects.toThrow();
  expect(service.list).toHaveBeenCalledTimes(1);
  expect(service.download).toHaveBeenCalledTimes(1);
});
it('blocks incompatible prior destructive state before provisioning or backend construction', async () => {
  const f = await fixture(),
    cache = vi.fn(f.request.cacheBackend);
  await f.files('', { '.mammoth/restore-move-v1.json': 'legacy pending' });
  await expect(prepareStreaming({ ...f.request, cacheBackend: cache })).rejects.toThrow(
    'legacy destructive intent',
  );
  expect(f.provision).not.toHaveBeenCalled();
  expect(cache).not.toHaveBeenCalled();
  expect(f.hooks).not.toHaveBeenCalled();
  expect(await readFile(f.store.root.resolve('.mammoth/restore-move-v1.json'), 'utf8')).toBe(
    'legacy pending',
  );
});
it('restores read-only without discovering dependent artifacts', async () => {
  const f = await fixture(),
    artifacts = vi.fn(async () => memoryArtifacts().api);
  await f.files('', { 'state/stale': 'stale' });
  const ready = await prepareStreaming({
    ...f.request,
    policy: {
      ...f.request.policy,
      access: 'read-only',
      role: 'distributed-aggregator',
      ordinaryOrder: ['A'],
    },
    artifactBackend: artifacts,
  });
  expect(ready.workerCount).toBe(0);
  expect(artifacts).not.toHaveBeenCalled();
  expect(await f.store.root.stat('state/stale')).toBeNull();
});

it.each([false, true])(
  'rejects accepted base availability drift on retry, initiallyAvailable=%s',
  async (available) => {
    const hard = ['.mammoth/**'],
      model = resolveModel(
        ['model', 1, 'maven', hard, [['data', ['data/**'], hard, 'single-writer', 'A', 'default']]],
        'frozen-availability-',
        1,
      );
    const f = await fixture({}, model),
      source = await baseFixture(model),
      sdk = await nativeCacheBackend(),
      object = await preparedBase(source, { 'data/new': 'selected' }, 'data');
    await NativeObjectSave.save(sdk.backend, object, { budget: source.budget });
    const saved = sdk.objects.get(object.reference[2])!;
    expect(saved).toBeDefined();
    await seedBaseGeneration(source, sdk, [['object', 'data', object.reference]]);
    if (!available) sdk.objects.delete(object.reference[2]);
    await f.files('', { 'data/old': 'old' });
    let first = true;
    const request = {
      ...f.request,
      cacheBackend: async () => sdk.backend,
      fail: async (name: string) => {
        if (name === 'install-intent-published' && first) {
          first = false;
          throw new Error('install interrupted');
        }
      },
    };
    await expect(prepareStreaming(request)).rejects.toThrow('install interrupted');
    const current = (await OpenedInvocation.current(f.root, f.budget))!,
      facts = await PrepareFacts.open(current.store, { budget: f.budget });
    try {
      expect(facts.selection![7]).toEqual(available ? [] : ['data']);
      expect(facts.selection![9]).toBe('selected');
      expect(facts.state[11]).toBeNull();
    } finally {
      facts.close();
    }
    const read = async (name: string) =>
      (await f.store.root.stat(name)) ? readFile(f.store.root.resolve(name), 'utf8') : null;
    const before = [await read('data/new'), await read('data/old')];
    if (available) sdk.objects.delete(object.reference[2]);
    else sdk.objects.set(object.reference[2], saved);
    await expect(prepareStreaming(request)).rejects.toThrow('base availability');
    expect([await read('data/new'), await read('data/old')]).toEqual(before);
    expect(
      sdk.calls.filter(
        (c) => c.kind === 'restore' && c.paths.some((p) => p.endsWith('record.json')),
      ),
    ).toHaveLength(1);
    expect(source.budget.retained).toBe(0);
  },
);

it.each([false, true])(
  'rejects lifetime revocation during the last ready-state read, retry=%s',
  async (retry) => {
    const f = await fixture();
    if (retry) await prepareStreaming(f.request);
    let revoked = false;
    const open = PrepareFacts.open;
    vi.spyOn(PrepareFacts, 'open').mockImplementation(async (...args) => {
      const facts = await open(...args);
      if (facts.state[4] === 'build-ready') revoked = true;
      return facts;
    });
    await expect(
      prepareStreaming({
        ...f.request,
        assertCurrent: () => {
          if (revoked) throw new Error('ready lifetime revoked');
        },
      }),
    ).rejects.toThrow();
    expect(revoked).toBe(true);
    expect(((await f.store.state()) as unknown[])[4]).toBe('build-ready');
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects actual root mode drift after the durable ready commit',
  async () => {
    const f = await fixture(),
      mode = f.store.root.binding[6] & 0o777;
    let changed = false;
    try {
      await expect(
        prepareStreaming({
          ...f.request,
          fail: async (name) => {
            if (name === 'prepare-ready') {
              changed = true;
              await chmod(f.root, mode ^ 0o020);
            }
          },
        }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(((await f.store.state()) as unknown[])[4]).toBe('build-ready');
    } finally {
      await chmod(f.root, mode);
    }
  },
);
it('checks the caller lifetime after awaited base acquisition before any live install', async () => {
  const f = await fixture(),
    source = await baseFixture(f.model),
    sdk = await nativeCacheBackend(),
    object = await preparedBase(source, { 'data/new': 'base' }, 'data');
  await NativeObjectSave.save(sdk.backend, object, { budget: source.budget });
  await seedBaseGeneration(source, sdk, [
    ['object', 'data', object.reference],
    ['empty', 'state'],
  ]);
  let revoked = false;
  const backend: BaseCacheBackend = {
    ...sdk.backend,
    restoreCache: async (...args) => {
      const result = await sdk.backend.restoreCache(...args);
      if (args[0].some((p) => p.replaceAll('\\', '/').includes('/payload'))) revoked = true;
      return result;
    },
  };
  await f.files('', { 'data/old': 'old', 'state/stale': 'stale' });
  await expect(
    prepareStreaming({
      ...f.request,
      cacheBackend: async () => backend,
      assertCurrent: () => {
        if (revoked) throw new Error('base lifetime revoked');
      },
    }),
  ).rejects.toThrow();
  expect(revoked).toBe(true);
  expect(await f.store.root.stat('data/new')).toBeNull();
  expect(await readFile(f.store.root.resolve('data/old'), 'utf8')).toBe('old');
  expect(await readFile(f.store.root.resolve('state/stale'), 'utf8')).toBe('stale');
});
it('checks the caller lifetime after complete worker merge before the first base install', async () => {
  const f = await fixture(),
    { request } = await workerArtifacts(f);
  let revoked = false;
  const merge = workerMerge.mergeWorkerArchives;
  vi.spyOn(workerMerge, 'mergeWorkerArchives').mockImplementation(async (...args) => {
    const result = await merge(...args);
    revoked = true;
    return result;
  });
  await f.files('', { 'state/stale': 'stale' });
  await expect(
    prepareStreaming({
      ...request,
      assertCurrent: () => {
        if (revoked) throw new Error('merge lifetime revoked');
      },
    }),
  ).rejects.toThrow();
  expect(revoked).toBe(true);
  expect(await f.store.root.stat('data/only-A')).toBeNull();
  expect(await readFile(f.store.root.resolve('state/stale'), 'utf8')).toBe('stale');
});

it('preserves bounded differing-contribution diagnostics from the real worker merge', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['repository/**'], hard, 'aggregate', null, 'choose-worker-directory'],
          ['state', ['state/**'], hard, 'single-writer', 'A', 'default'],
        ],
      ],
      'install-fixture-',
      1,
    ),
    f = await fixture({}, model),
    { request } = await workerArtifacts(f, ['A', 'B'], true, 'repository/org/example/lib/1'),
    warnings = vi.fn();
  await prepareStreaming({ ...request, onWorkerWarnings: warnings });
  expect(warnings).toHaveBeenCalledTimes(1);
  expect(warnings.mock.calls[0][0]).toEqual({
    count: 1,
    details: ['Selected complete worker unit at repository/org/example/lib/1'],
  });
  expect(await readFile(f.store.root.resolve('repository/org/example/lib/1/shared'), 'utf8')).toBe(
    'A',
  );
  expect(await f.store.root.stat('repository/org/example/lib/1/only-B')).toBeNull();
});
