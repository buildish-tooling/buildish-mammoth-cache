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
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
import { metadataFixture, type MetadataFixture } from './base-publication-fixtures';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { cleanupBaseFixtures } from './base-fixtures';
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
const metadataFixtures: MetadataFixture[] = [];
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
  for (const f of metadataFixtures.splice(0)) {
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
  const handoff = await LifecycleHandoff.read(ready.store, reopened.state[6]!, {
    budget: f.budget,
  });
  try {
    expect(handoff.entries.map((entry) => entry[2])).toEqual(['miss', 'miss']);
    expect(handoff.header[10]).toBe(42);
    expect(handoff.header[11]).toBe(0);
  } finally {
    handoff.close();
  }
  expect(f.budget.retained).toBe(0);
});
it('rejects a failed main on retry before rediscovery or hooks and retains original activity cutoff', async () => {
  let now = 1000000;
  const f = await fixture({ now: () => now });
  const installHooks = vi.fn(async () => {
    throw new Error('hook failed');
  });
  const request = { ...f.request, policy: { ...f.request.policy, gcAgeMs: 1000 }, installHooks };
  await expect(prepareStreaming(request)).rejects.toThrow('hook failed');
  const opened = (await OpenedInvocation.current(f.root, f.budget))!;
  expect(opened.bindings[8][6]).toBe(999000);
  expect(opened.bindings[8][7]).toBeNull();
  expect(opened.state[4]).toBe('prepare-failed');
  expect(opened.state[6]).toBeNull();
  now = 2000000;
  await expect(prepareStreaming(request)).rejects.toThrow('fresh dedicated root');
  expect(installHooks).toHaveBeenCalledTimes(1);
  expect(f.backend.restoreCache).toHaveBeenCalledTimes(1);
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
    try {
      await uploadWorkerArtifact(service.api, archive);
    } finally {
      await source.finish();
    }
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
  const opened = await OpenedInvocation.open(ready.anchor, f.budget),
    handoff = await LifecycleHandoff.read(ready.store, opened.state[6]!, { budget: f.budget });
  try {
    expect(opened.bindings[8][10]).toEqual(['B', 'A']);
    expect(handoff.header[11]).toBe(2);
    const snapshot = handoff.entries.find((entry) => entry[1] === 'state')![4]!;
    expect(snapshot[4][0]).toBe('worker');
    expect(await readFile(ready.store.root.resolve(snapshot[1] + '/state/from-A'), 'utf8')).toBe(
      'complete snapshot',
    );
  } finally {
    handoff.close();
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
  'rejects failed-main retry with equivalent ordinary order %j → %j',
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
    await expect(
      prepareStreaming({
        ...retry,
        policy: { ...retry.policy, ordinaryOrder: equivalent },
      }),
    ).rejects.toThrow('fresh dedicated root');
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
    opened = await OpenedInvocation.open(ready.anchor, f.budget);
  try {
    expect(opened.bindings[8][10]).toEqual(['A']);
    expect(ready.workerCount).toBe(1);
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.download.mock.calls.map(([id]) => id)).toEqual([1]);
    expect(await readFile(ready.store.root.resolve('state/from-A'), 'utf8')).toBe(
      'complete snapshot',
    );
  } finally {
    expect(f.budget.retained).toBe(0);
  }
});
it('keeps a snapshot-only writer outside the deduplicated ordinary order', async () => {
  const f = await fixture(),
    { service, request } = await workerArtifacts(f),
    ready = await prepareStreaming({
      ...request,
      policy: { ...request.policy, ordinaryOrder: ['B', 'B'] },
    }),
    opened = await OpenedInvocation.open(ready.anchor, f.budget);
  try {
    expect(opened.bindings[8][10]).toEqual(['B']);
    expect(ready.workerCount).toBe(2);
    expect(service.download.mock.calls.map(([id]) => id)).toEqual([2, 1]);
    expect(await ready.store.root.stat('data/only-A')).toBeNull();
    expect(await readFile(ready.store.root.resolve('data/only-B'), 'utf8')).toBe('B');
    expect(await readFile(ready.store.root.resolve('state/from-A'), 'utf8')).toBe(
      'complete snapshot',
    );
  } finally {
    expect(f.budget.retained).toBe(0);
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
      expect(((await f.store.state()) as unknown[])[4]).toBe('prepare-failed');
    } finally {
      await chmod(f.root, mode);
    }
  },
);

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

it('reports fresh feature unavailability and rejects a second prepare without backend access', async () => {
  const f = await fixture();
  const available = vi.spyOn(f.backend, 'isFeatureAvailable').mockReturnValue(false),
    backend = vi.fn(async () => f.backend),
    request = { ...f.request, cacheBackend: backend };
  expect((await prepareStreaming(request)).restoreStatus).toBe('feature-unavailable');
  expect(available).toHaveBeenCalledTimes(1);
  backend.mockClear();
  available.mockClear();
  await expect(prepareStreaming(request)).rejects.toThrow('fresh dedicated root');
  expect(backend).not.toHaveBeenCalled();
  expect(available).not.toHaveBeenCalled();
});

async function seeded(
  f: Awaited<ReturnType<typeof fixture>>,
  payloads: Record<string, Record<string, string | null>>,
) {
  const source = await metadataFixture(f.model);
  metadataFixtures.push(source);
  return { source, ...(await source.seed(payloads)) };
}
it('restores v2 native objects with exact fallback lineage and independent selected snapshot ownership', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['data', ['data/**'], hard, 'aggregate', null, 'default'],
          ['state', ['state/**'], hard, 'single-writer', 'B', 'default'],
        ],
      ],
      'snapshot-prepare-',
      1,
    );
  const f = await fixture({}, model),
    { source, generation } = await seeded(f, {
      data: { 'data/new': 'base' },
      state: { 'state/new': 'snapshot' },
    });
  await f.files('', { 'data/old': 'prune', 'state/old': 'replace' });
  const ready = await prepareStreaming({
    ...f.request,
    cacheBackend: async () => source.api,
    currentRef: 'refs/heads/feature',
    defaultRef: 'refs/heads/main',
    policy: { ...f.request.policy, restoreCleanup: 'prune-managed' },
  });
  expect(ready.restoreStatus).toBe('fallback-lineage-hit');
  expect(ready.restoredKey).toBe(generation[11]);
  expect(await readFile(f.store.root.resolve('data/new'), 'utf8')).toBe('base');
  expect(await f.store.root.stat('data/old')).toBeNull();
  expect(await f.store.root.stat('state/old')).toBeNull();
  const opened = await OpenedInvocation.open(ready.anchor, f.budget),
    handoff = await LifecycleHandoff.read(ready.store, opened.state[6]!, { budget: f.budget });
  try {
    const snapshot = handoff.entries.find((entry) => entry[1] === 'state')![4]!;
    expect(snapshot[1]).toContain('/snapshots/');
    expect(snapshot[4][0]).toBe('base');
    expect(await readFile(f.store.root.resolve(snapshot[1] + '/state/new'), 'utf8')).toBe(
      'snapshot',
    );
  } finally {
    handoff.close();
  }
});
it.each([false, true])(
  'refuses interrupted-main retry without reselecting base availability, initiallyAvailable=%s',
  async (available) => {
    const f = await fixture(),
      { source, entries } = await seeded(f, {
        data: { 'data/new': 'base' },
        state: { 'state/new': 'snapshot' },
      }),
      entry = entries[0];
    if (entry[0] !== 'object') throw new Error('object');
    const saved = source.objects.get(entry[2][2])!;
    if (!available) source.objects.delete(entry[2][2]);
    const request = {
      ...f.request,
      cacheBackend: async () => source.api,
      fail: async (name: string) => {
        if (name === 'prepare-base-installed') throw new Error('install interrupted');
      },
    };
    await expect(prepareStreaming(request)).rejects.toThrow('install interrupted');
    const opened = (await OpenedInvocation.current(f.root, f.budget))!;
    expect(opened.state[4]).toBe('prepare-failed');
    expect(opened.state[6]).toBeNull();
    const restores = source.restore.mock.calls.length;
    if (available) source.objects.delete(entry[2][2]);
    else source.objects.set(entry[2][2], saved);
    await expect(prepareStreaming(request)).rejects.toThrow('fresh dedicated root');
    expect(source.restore).toHaveBeenCalledTimes(restores);
  },
);
it('checks caller lifetime after awaited v2 base acquisition before live installation', async () => {
  const f = await fixture(),
    { source } = await seeded(f, {
      data: { 'data/new': 'base' },
      state: { 'state/new': 'snapshot' },
    });
  let revoked = false;
  const restore = source.api.restoreCache;
  const api: BaseCacheBackend = {
    ...source.api,
    restoreCache: async (...args) => {
      const result = await restore(...args);
      if (args[0].some((p) => p.replaceAll('\\', '/').includes('/payload'))) revoked = true;
      return result;
    },
  };
  await f.files('', { 'data/old': 'old', 'state/stale': 'untouched' });
  await expect(
    prepareStreaming({
      ...f.request,
      cacheBackend: async () => api,
      assertCurrent: () => {
        if (revoked) throw new Error('base lifetime revoked');
      },
    }),
  ).rejects.toThrow();
  expect(revoked).toBe(true);
  expect(await f.store.root.stat('data/new')).toBeNull();
  expect(await readFile(f.store.root.resolve('state/stale'), 'utf8')).toBe('untouched');
});
it('rejects lifetime revocation after the actual durable ready commit', async () => {
  const f = await fixture();
  let revoked = false;
  await expect(
    prepareStreaming({
      ...f.request,
      fail: async (name) => {
        if (name === 'prepare-ready') revoked = true;
      },
      assertCurrent: () => {
        if (revoked) throw new Error('ready lifetime revoked');
      },
    }),
  ).rejects.toThrow('ready lifetime revoked');
  expect(revoked).toBe(true);
  expect(((await f.store.state()) as unknown[])[4]).toBe('prepare-failed');
});
it.each(['cold', 'empty', 'mixed'] as const)(
  'classifies v2 %s base without reporting all-cold generation as a hit',
  async (kind) => {
    const f = await fixture(),
      { source, generation, entries } = await seeded(
        f,
        kind === 'empty' ? {} : { data: { 'data/a': 'a' }, state: { 'state/a': 'a' } },
      );
    for (const entry of entries)
      if (entry[0] === 'object' && (kind === 'cold' || (kind === 'mixed' && entry[1] === 'data')))
        source.objects.delete(entry[2][2]);
    const ready = await prepareStreaming({ ...f.request, cacheBackend: async () => source.api });
    expect(ready.restoreStatus).toBe(
      kind === 'cold'
        ? 'miss'
        : kind === 'mixed'
          ? 'current-lineage-partial-hit'
          : 'current-lineage-hit',
    );
    expect(ready.restoredKey).toBe(kind === 'cold' ? null : generation[11]);
  },
);
