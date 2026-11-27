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

import path from 'node:path';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { mavenLifecycle } from '../../../src/build-tool/maven/lifecycle';
import { resolveModel } from '../../../src/cache/streaming/model';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import { memoryArtifacts } from './memory-artifact-fixture';
import type { WorkflowArtifactBackend } from '../../../src/delta/backend';
import type { ResolvedModel } from '../../../src/cache/streaming/model';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { MetadataSnapshot } from '../../../src/cache/streaming/metadata-snapshot';
import { WorkerNativeIndex } from '../../../src/cache/streaming/worker-native';
import { NativeRoot } from '../../../src/cache/streaming/native';
import * as observationCapture from '../../../src/cache/streaming/observation-capture';
import { RecoveryGroups } from '../../../src/cache/streaming/native-records';
import { LifecycleHandoff } from '../../../src/cache/streaming/lifecycle-handoff';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { registrationDirectory } from '../../../src/build-tool/gradle/registrations';
import { gradleResolver } from './quiescence-fixture';
import type { Context } from '../../../src/cache/streaming/schema';
const roots: string[] = [];
const gradleLifecycle = gradleResolver({
  inspect: async () => ({ remaining: false, uncertain: false }),
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function directory(label: string) {
  const root = await mkdtemp(path.resolve('build/ls4-' + label + '-'));
  roots.push(root);
  return root;
}
async function backend() {
  const root = await directory('sdk'),
    objects = new Map<string, string>();
  let sequence = 0;
  const saves = vi.fn<BaseCacheBackend['saveCache']>(async (paths, key) => {
    const target = path.join(root, String(++sequence));
    await mkdir(target);
    for (const source of paths) {
      await cp(
        source.replace(/[\\/]$/, ''),
        path.join(target, path.basename(source.replace(/[\\/]$/, ''))),
        { recursive: true, preserveTimestamps: true },
      );
    }
    objects.set(key, target);
    return sequence;
  });
  const api: BaseCacheBackend = {
    capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
    isFeatureAvailable: () => true,
    saveCache: saves,
    restoreCache: async (_paths, key, fallback, options) => {
      const selected = [key, ...(fallback ?? [])]
        .map((prefix) =>
          [...objects.keys()].reverse().find((candidate) => candidate.startsWith(prefix)),
        )
        .find(Boolean);
      if (selected) {
        for (const name of await readdir(objects.get(selected)!)) {
          await cp(
            path.join(objects.get(selected)!, name),
            path.join(options!.archiveRoot!, name),
            { recursive: true, preserveTimestamps: true },
          );
        }
      }
      return selected;
    },
    isMissingPathsError: () => false,
  };
  return { api, saves, objects };
}
async function prepare(
  api: BaseCacheBackend,
  nonce: string,
  config: {
    job?: string;
    role?: 'standalone' | 'distributed-worker' | 'distributed-aggregator';
    order?: string[];
    model?: ResolvedModel;
    artifacts?: WorkflowArtifactBackend;
    currentRef?: string;
    defaultRef?: string;
    gcAgeMs?: number;
    root?: string;
    now?: () => number;
    budget?: WorkingBudget;
    hooks?: () => Promise<void>;
    allowMissingDependentJobs?: boolean;
    onMissingDependentJobs?: (jobs: readonly string[]) => void;
  } = {},
) {
  const root = config.root ?? path.join(await directory('root'), 'home'),
    budget = config.budget ?? new WorkingBudget(),
    hard = ['.mammoth/**'],
    model =
      config.model ??
      resolveModel(
        ['model', 1, 'maven', hard, [['data', ['data/**'], hard, 'aggregate', null, 'default', 0]]],
        'metadata-lifecycle-',
        1,
      ),
    context: Context = [
      'github',
      'example/repo',
      'ci',
      '42',
      config.job ?? 'parent',
      1,
      'rev-1',
      model.tuple[2],
    ];
  const result = await prepareStreaming({
    root,
    model,
    context,
    nonce,
    budget,
    policy: {
      role: config.role ?? 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: config.gcAgeMs ?? null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: config.order ?? [],
    },
    currentRef: config.currentRef ?? 'refs/heads/main',
    defaultRef: config.defaultRef,
    captureTempDirectory: null,
    now: config.now,
    allowMissingDependentJobs: config.allowMissingDependentJobs,
    onMissingDependentJobs: config.onMissingDependentJobs,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    lifecycle: model.tuple[2] === 'gradle' ? gradleLifecycle : undefined,
    saveAnchor() {},
    cacheBackend: async () => api,
    artifactBackend: config.artifacts ? async () => config.artifacts! : undefined,
    provision: async () => {},
    installHooks: async (store) => {
      if (model.tuple[2] === 'gradle' && config.role !== 'distributed-worker') {
        await store.makeParents(registrationDirectory(store) + '/placeholder');
      }
      await config.hooks?.();
    },
    assertCurrent: (): undefined => {},
  });
  return { ...result, root, budget };
}
async function post(f: Awaited<ReturnType<typeof prepare>>, api: BaseCacheBackend) {
  // Fresh bound store/model/codec: only the actual persisted handoff crosses.
  const opened = await OpenedInvocation.open(f.anchor, f.budget);
  expect(opened.store).not.toBe(f.store);
  expect(opened.state).toHaveLength(8);
  expect(opened.bindings).toHaveLength(9);
  return postStreamingBase({
    anchor: f.anchor,
    budget: f.budget,
    cacheBackend: async () => api,
    removeHooks: async () => {},
    lifecycle: f.store.codec.options.model.tuple[2] === 'gradle' ? gradleLifecycle : undefined,
    assertCurrent: (): undefined => {},
  });
}
async function assertNoCatalogue(f: Awaited<ReturnType<typeof prepare>>, completed = false) {
  const files = await readdir(f.store.root.resolve(f.store.prefix + 'files'));
  for (const name of files) {
    const bytes = await readFile(f.store.root.resolve(f.store.prefix + 'files/' + name));
    const first = JSON.parse(bytes.toString().split('\n')[0]);
    if (first[0] === 'local-stream') {
      expect(completed ? ['model', 'handoff'] : ['model', 'activity', 'handoff']).toContain(
        first[2],
      );
    }
  }
  expect(f.budget.retained).toBe(0);
}
it('runs real v2 prepare → fresh post → warm prepare → fresh unchanged post with no base catalogue or recapture', async () => {
  const sdk = await backend(),
    first = await prepare(sdk.api, 'a'.repeat(32));
  expect(first.restoreStatus).toBe('miss');
  await assertNoCatalogue(first);
  await mkdir(first.store.root.resolve('data/shared'), { recursive: true });
  await writeFile(first.store.root.resolve('data/shared/a'), 'body');
  await utimes(first.store.root.resolve('data/shared/a'), 1.234, 1.234);
  expect((await post(first, sdk.api)).outcome).toBe('published');
  await assertNoCatalogue(first);
  const warm = await prepare(sdk.api, 'b'.repeat(32));
  expect(warm.restoreStatus).toBe('current-lineage-hit');
  expect(await readFile(warm.store.root.resolve('data/shared/a'), 'utf8')).toBe('body');
  await assertNoCatalogue(warm);
  const count = sdk.saves.mock.calls.length,
    recapture = vi.spyOn(MetadataPublicationSource, 'capture');
  expect((await post(warm, sdk.api)).outcome).toBe('no-change');
  expect(sdk.saves).toHaveBeenCalledTimes(count);
  expect(recapture).not.toHaveBeenCalled();
  expect(warm.store.root.work.bodyHashCalls).toBe(0);
  await assertNoCatalogue(warm);
});

it('joins actual worker post body production, required archive merge/install and metadata base post without replay state', async () => {
  const sdk = await backend(),
    artifacts = memoryArtifacts();
  const worker = await prepare(sdk.api, 'c'.repeat(32), { job: 'A', role: 'distributed-worker' });
  await mkdir(worker.store.root.resolve('data/shared'), { recursive: true });
  await writeFile(worker.store.root.resolve('data/shared/a'), 'worker-body');
  await utimes(worker.store.root.resolve('data/shared/a'), 1.234, 1.234);
  const uploaded = await postStreamingWorker({
    anchor: worker.anchor,
    budget: worker.budget,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  expect(uploaded.outcome).toBe('worker-uploaded');
  await assertNoCatalogue(worker, true);
  const merged = await prepare(sdk.api, 'd'.repeat(32), {
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
  });
  expect(merged.workerCount).toBe(1);
  expect(await readFile(merged.store.root.resolve('data/shared/a'), 'utf8')).toBe('worker-body');
  await assertNoCatalogue(merged);
  expect((await post(merged, sdk.api)).outcome).toBe('published');
  await assertNoCatalogue(merged, true);
});

function snapshotModel(writer: string | null = 'A') {
  const hard = ['.mammoth/**'];
  return resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['data/**'], hard, 'aggregate', null, 'default', 0],
        ['state', ['state/**'], hard, 'single-writer', writer, 'default', 0],
      ],
    ],
    'snapshot-lifecycle-',
    1,
  );
}
async function buildFiles(f: Awaited<ReturnType<typeof prepare>>, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(f.store.root.resolve(name)), { recursive: true });
    await writeFile(f.store.root.resolve(name), body);
    await utimes(f.store.root.resolve(name), 1.234, 1.234);
  }
}
async function handoff(f: Awaited<ReturnType<typeof prepare>>) {
  const opened = await OpenedInvocation.open(f.anchor, f.budget),
    facts = await LifecycleHandoff.read(opened.store, opened.state[6]!, { budget: f.budget });
  try {
    return { header: structuredClone(facts.header), entries: structuredClone(facts.entries) };
  } finally {
    facts.close();
  }
}
async function seedSnapshots(sdk: Awaited<ReturnType<typeof backend>>) {
  const f = await prepare(sdk.api, '1'.repeat(32), { job: 'A', model: snapshotModel() });
  await buildFiles(f, { 'data/shared/a': 'base-data', 'state/shared/a': 'base-state' });
  expect((await post(f, sdk.api)).outcome).toBe('published');
  await assertNoCatalogue(f, true);
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'))).toEqual([]);
  return f;
}
it('retires successful post snapshot/activity owners and completed diagnostics never reopen their stale refs', async () => {
  const sdk = await backend();
  await seedSnapshots(sdk);
  const f = await prepare(sdk.api, '2'.repeat(32), {
      model: snapshotModel(),
      role: 'distributed-aggregator',
      artifacts: memoryArtifacts().api,
    }),
    data = await handoff(f),
    snapshot = data.entries.find((entry) => entry[1] === 'state')![4]!;
  expect(await readFile(f.store.root.resolve(snapshot[1] + '/state/shared/a'), 'utf8')).toBe(
    'base-state',
  );
  expect((await post(f, sdk.api)).outcome).toBe('no-change');
  expect(await f.store.root.stat(snapshot[1])).toBeNull();
  expect(await f.store.root.stat(data.header[9][2])).toBeNull();
  const admit = vi.spyOn(MetadataSnapshot, 'admit'),
    reads: string[] = [],
    read = NativeRoot.prototype.read;
  const spy = vi.spyOn(NativeRoot.prototype, 'read').mockImplementation(function (
    this: NativeRoot,
    ...args
  ) {
    reads.push(args[0]);
    return read.apply(this, args);
  });
  expect((await post(f, sdk.api)).outcome).toBe('no-change');
  expect(admit).not.toHaveBeenCalled();
  expect(reads).not.toContain(data.header[9][2]);
  expect(reads.some((name) => name.startsWith(snapshot[1]))).toBe(false);
  spy.mockRestore();
  await assertNoCatalogue(f, true);
});
it('treats outgoing availability throws as abandonment and retires only current known snapshot/activity data', async () => {
  const sdk = await backend();
  await seedSnapshots(sdk);
  const f = await prepare(sdk.api, '3'.repeat(32), {
      model: snapshotModel(),
      role: 'distributed-aggregator',
      artifacts: memoryArtifacts().api,
    }),
    data = await handoff(f),
    warnings: string[] = [];
  const admit = vi.spyOn(MetadataSnapshot, 'admit'),
    bad: BaseCacheBackend = {
      ...sdk.api,
      isFeatureAvailable: () => {
        throw new Error('SDK unavailable');
      },
    };
  const result = await postStreamingBase({
    anchor: f.anchor,
    budget: f.budget,
    cacheBackend: async () => bad,
    removeHooks: async () => {},
    assertCurrent: (): undefined => {},
    onWarning: (message) => warnings.push(message),
  });
  expect(result.outcome).toBe('abandoned');
  expect(warnings.join(' ')).toContain('confirmation unavailable');
  expect(admit).not.toHaveBeenCalled();
  expect(await f.store.root.stat(data.header[9][2])).toBeNull();
  expect(await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'))).toEqual([]);
  await assertNoCatalogue(f, true);
});
it.each(['standalone', 'distributed-aggregator'] as const)(
  'retains current snapshot/activity ownership when %s has no safe quiescent window',
  async (role) => {
    const sdk = await backend();
    await seedSnapshots(sdk);
    const f = await prepare(sdk.api, '4'.repeat(32), {
        model: snapshotModel(),
        role,
        artifacts: memoryArtifacts().api,
      }),
      data = await handoff(f);
    const pending = postStreamingBase({
      anchor: f.anchor,
      budget: f.budget,
      cacheBackend: async () => {
        throw new Error('No SDK before window');
      },
      removeHooks: async () => {},
      assertCurrent: (): undefined => {},
      lifecycle: async () => ({
        ...mavenLifecycle,
        quiesce: async () => {
          throw new Error('consumers remain');
        },
      }),
    });
    if (role === 'standalone') {
      const result = await pending;
      expect(result.outcome).toBe('skipped-not-quiescent');
      expect(result.message).toContain(f.store.root.resolve(data.header[9][2]));
    } else {
      await expect(pending).rejects.toThrow(
        'Required base post is not quiescent: consumers remain',
      );
      const snapshot = data.entries.find((entry) => entry[1] === 'state')![4]!;
      expect(await f.store.root.stat(snapshot[1])).not.toBeNull();
      expect(await readFile(f.store.root.resolve(snapshot[1] + '/state/shared/a'), 'utf8')).toBe(
        'base-state',
      );
    }
    expect(await f.store.root.stat(data.header[9][2])).not.toBeNull();
    expect(f.budget.retained).toBe(0);
  },
);
it('keeps actual survivor and copied snapshot indices alive through delayed SDK settlement after foreground cancellation', async () => {
  const sdk = await backend(),
    f = await prepare(sdk.api, '5'.repeat(32), { job: 'A', model: snapshotModel() });
  await buildFiles(f, { 'data/shared/a': 'data', 'state/shared/a': 'snapshot' });
  const controller = new AbortController();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  sdk.saves.mockImplementation(async (paths, key) => {
    if (paths.length === 2 && key.includes('-p-state-')) {
      started();
      await gate;
    }
    return 42;
  });
  let settled = false;
  const posting = postStreamingBase({
    anchor: f.anchor,
    budget: f.budget,
    signal: controller.signal,
    cacheBackend: async () => sdk.api,
    removeHooks: async () => {},
    assertCurrent: (): undefined => {},
  });
  void posting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered;
  controller.abort(new Error('foreground cancelled'));
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(posting).rejects.toThrow(/cancel|abort/i);
  expect(await readFile(f.store.root.resolve('data/shared/a'), 'utf8')).toBe('data');
  const [id] = await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'));
  expect(
    await readFile(
      f.store.root.resolve(f.store.prefix + 'snapshots/' + id + '/state/state/shared/a'),
      'utf8',
    ),
  ).toBe('snapshot');
  expect(f.budget.retained).toBe(0);
});
it('retains original private snapshot payload and conflicting destination after a hard source-return failure', async () => {
  const sdk = await backend(),
    f = await prepare(sdk.api, '6'.repeat(32), { job: 'A', model: snapshotModel() });
  await buildFiles(f, { 'data/shared/a': 'data', 'state/shared/a': 'snapshot' });
  let staged = '',
    privateRoot = '';
  sdk.saves.mockImplementation(async (paths, key) => {
    if (paths.length === 2 && key.includes('-p-state-')) {
      staged = paths[1];
      const [id] = await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'));
      privateRoot = f.store.prefix + 'snapshots/' + id + '/state';
      await mkdir(f.store.root.resolve(privateRoot + '/state'));
      await writeFile(f.store.root.resolve(privateRoot + '/state/foreign'), 'retain');
    }
    return 42;
  });
  await expect(post(f, sdk.api)).rejects.toThrow();
  expect(await readFile(path.join(staged, 'state/shared/a'), 'utf8')).toBe('snapshot');
  expect(await readFile(f.store.root.resolve(privateRoot + '/state/foreign'), 'utf8')).toBe(
    'retain',
  );
  expect((await OpenedInvocation.open(f.anchor, f.budget)).state[4]).toBe('post-active');
  expect(f.budget.retained).toBe(0);
});
it('copies only absent optional fallback, never an unused baseline before a present required snapshot writer', async () => {
  const sdk = await backend();
  await seedSnapshots(sdk);
  const artifacts = memoryArtifacts(),
    model = snapshotModel(),
    worker = await prepare(sdk.api, '7'.repeat(32), {
      model,
      job: 'A',
      role: 'distributed-worker',
    });
  await buildFiles(worker, { 'state/shared/a': 'selected-worker' });
  await postStreamingWorker({
    anchor: worker.anchor,
    budget: worker.budget,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  const copy = vi.spyOn(MetadataSnapshot, 'copy');
  const present = await prepare(sdk.api, '8'.repeat(32), {
    model,
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
  });
  expect(
    copy.mock.calls.filter(([source]) => source instanceof MetadataPublicationSource),
  ).toHaveLength(0);
  expect(copy.mock.calls.filter(([source]) => source instanceof WorkerNativeIndex)).toHaveLength(1);
  expect((await post(present, sdk.api)).outcome).toBe('published');
  await assertNoCatalogue(present, true);
  copy.mockClear();
  const missing = memoryArtifacts();
  const absent = await prepare(sdk.api, '9'.repeat(32), {
    model,
    role: 'distributed-aggregator',
    artifacts: missing.api,
  });
  expect(
    copy.mock.calls.filter(([source]) => source instanceof MetadataPublicationSource),
  ).toHaveLength(1);
  expect(copy.mock.calls.filter(([source]) => source instanceof WorkerNativeIndex)).toHaveLength(0);
  await post(absent, sdk.api);
  await assertNoCatalogue(absent, true);
});

it('falls back to the base snapshot for a listed snapshot writer without an artifact', async () => {
  const sdk = await backend();
  await seedSnapshots(sdk);
  const model = snapshotModel(),
    artifacts = memoryArtifacts();
  await expect(
    prepare(sdk.api, 'b1'.repeat(16), {
      model,
      role: 'distributed-aggregator',
      order: ['A'],
      artifacts: artifacts.api,
    }),
  ).rejects.toThrow('Worker has no artifact at or before the selected attempt: A');
  const copy = vi.spyOn(MetadataSnapshot, 'copy'),
    onMissingDependentJobs = vi.fn();
  const allowed = await prepare(sdk.api, 'b2'.repeat(16), {
    model,
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
    allowMissingDependentJobs: true,
    onMissingDependentJobs,
  });
  expect(onMissingDependentJobs).toHaveBeenCalledWith(['A']);
  expect(
    copy.mock.calls.filter(([source]) => source instanceof MetadataPublicationSource),
  ).toHaveLength(1);
  // The inherited snapshot equals the base, so there is nothing new to publish.
  expect((await post(allowed, sdk.api)).outcome).toBe('no-change');
  await assertNoCatalogue(allowed, true);
  copy.mockRestore();
});

it('explicitly permits same-metadata aggregate worker body rewrites to reuse the old base while still verifying the delta body', async () => {
  const sdk = await backend(),
    seed = await prepare(sdk.api, 'a1'.repeat(16));
  await buildFiles(seed, { 'data/shared/a': 'base' });
  await chmod(seed.store.root.resolve('data/shared/a'), 0o644);
  await utimes(seed.store.root.resolve('data/shared/a'), 1, 1);
  await post(seed, sdk.api);
  const artifacts = memoryArtifacts(),
    worker = await prepare(sdk.api, 'a2'.repeat(16), { job: 'A', role: 'distributed-worker' });
  await writeFile(worker.store.root.resolve('data/shared/a'), 'else');
  await utimes(worker.store.root.resolve('data/shared/a'), 1, 1);
  await postStreamingWorker({
    anchor: worker.anchor,
    budget: worker.budget,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  const merged = await prepare(sdk.api, 'a3'.repeat(16), {
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
  });
  expect(await readFile(merged.store.root.resolve('data/shared/a'), 'utf8')).toBe('else');
  const seedN = (await seed.store.root.stat('data/shared/a'))!,
    mergedN = (await merged.store.root.stat('data/shared/a'))!;
  expect([mergedN[5], mergedN[6] & 0o777, mergedN[8]]).toEqual([
    seedN[5],
    seedN[6] & 0o777,
    seedN[8],
  ]);
  const count = sdk.saves.mock.calls.length;
  expect((await post(merged, sdk.api)).outcome).toBe('no-change');
  expect(sdk.saves).toHaveBeenCalledTimes(count);
  const restored = await prepare(sdk.api, 'a4'.repeat(16));
  expect(await readFile(restored.store.root.resolve('data/shared/a'), 'utf8')).toBe('base');
  await post(restored, sdk.api);
});
it('writes one lineage-only bounded record using exact prior groups with no payload moves/copies or candidate group fold', async () => {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [['data', ['repository/**'], hard, 'aggregate', null, 'default', 0]],
      ],
      'lineage-v2-',
      1,
    ),
    sdk = await backend();
  const seed = await prepare(sdk.api, 'b1'.repeat(16), { model });
  await buildFiles(seed, { 'repository/g/a/1/a.jar': 'base' });
  await post(seed, sdk.api);
  const feature = await prepare(sdk.api, 'b2'.repeat(16), {
    model,
    currentRef: 'refs/heads/feature',
    defaultRef: 'refs/heads/main',
  });
  expect(feature.restoreStatus).toBe('fallback-lineage-hit');
  const before = sdk.saves.mock.calls.length,
    groups = vi.spyOn(RecoveryGroups.prototype, 'observe'),
    copy = vi.spyOn(MetadataSnapshot, 'copy'),
    rename = vi.spyOn(NativeRoot.prototype, 'renameAbsent');
  const outcome = await post(feature, sdk.api);
  expect(outcome.outcome).toBe('published');
  const calls = sdk.saves.mock.calls.slice(before);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toHaveLength(1);
  expect(groups).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  expect(
    rename.mock.calls.some(
      ([from, to]) =>
        from === 'repository' ||
        to === 'repository' ||
        from.includes('/payload/') ||
        to.includes('/payload/'),
    ),
  ).toBe(false);
  await assertNoCatalogue(feature, true);
});
it('publishes actual GC survivors from the original hierarchy without recapture', async () => {
  const sdk = await backend(),
    initial = await prepare(sdk.api, 'c0'.repeat(16));
  await mkdir(initial.root + '/data/shared', { recursive: true });
  for (const name of ['delete', 'used']) {
    await writeFile(initial.root + '/data/shared/' + name, name);
    await utimes(initial.root + '/data/shared/' + name, 1.234, 1.234);
  }
  expect((await post(initial, sdk.api)).outcome).toBe('published');
  const cutoff = Date.now() + 10000;
  const f = await prepare(sdk.api, 'c1'.repeat(16), { gcAgeMs: 60000, now: () => cutoff });
  const root = f.root;
  expect(f.restoreStatus).toBe('current-lineage-hit');
  await utimes(root + '/data/shared/delete', 1.234, 1.234);
  await utimes(root + '/data/shared/used', Math.ceil(cutoff / 1000) + 1, 1.234);
  const capture = vi.spyOn(MetadataPublicationSource, 'capture');
  expect((await post(f, sdk.api)).outcome).toBe('published');
  expect(await f.store.root.stat('data/shared/delete')).toBeNull();
  expect(await readFile(root + '/data/shared/used', 'utf8')).toBe('used');
  expect(capture).not.toHaveBeenCalled();
  await assertNoCatalogue(f, true);
  const reader = await prepare(sdk.api, 'c2'.repeat(16));
  expect(await reader.store.root.stat('data/shared/delete')).toBeNull();
  expect(await readFile(reader.store.root.resolve('data/shared/used'), 'utf8')).toBe('used');
});
it('keeps original activity and actual pre-freeze purge outcomes without a base catalogue', async () => {
  const sdk = await backend(),
    root = await directory('purge-root'),
    hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [['data', ['data/**'], hard, 'aggregate', null, 'default', 0, ['data/purge/**']]],
    ],
    'purge-v2-',
    1,
  );
  await mkdir(root + '/data/purge', { recursive: true });
  await writeFile(root + '/data/purge/old', 'obsolete');
  const f = await prepare(sdk.api, 'c2'.repeat(16), { root, model });
  await writeFile(root + '/data/keep', 'keep');
  const capture = observationCapture.captureObservations;
  let deleted = 0;
  vi.spyOn(observationCapture, 'captureObservations').mockImplementation(async (...args) => {
    const value = await capture(...args);
    deleted = value.purge.deleted;
    return value;
  });
  await post(f, sdk.api);
  expect(await f.store.root.stat('data/purge/old')).toBeNull();
  expect(await readFile(root + '/data/keep', 'utf8')).toBe('keep');
  expect(deleted).toBeGreaterThan(0);
  await assertNoCatalogue(f, true);
});

it.each(['size', 'mtime', 'mode', 'type', 'delete', 'empty-directory'] as const)(
  'publishes an actual post-build %s metadata change against the original restore pin',
  async (change) => {
    const sdk = await backend(),
      seed = await prepare(sdk.api, 'e0'.repeat(16));
    await buildFiles(seed, { 'data/shared/a': 'body' });
    expect((await post(seed, sdk.api)).outcome).toBe('published');
    const warm = await prepare(sdk.api, 'e1'.repeat(16)),
      file = warm.store.root.resolve('data/shared/a');
    if (change === 'size') {
      await writeFile(file, 'longer-body');
    }
    if (change === 'mtime') {
      await utimes(file, 2.345, 2.345);
    }
    if (change === 'mode') {
      await chmod(file, 0o444);
    }
    if (change === 'type') {
      await rm(file);
      await mkdir(file);
      await writeFile(path.join(file, 'child'), 'child');
    }
    if (change === 'delete') {
      await rm(file);
    }
    if (change === 'empty-directory') {
      await mkdir(warm.store.root.resolve('data/shared/empty'));
    }
    const saves = sdk.saves.mock.calls.length;
    expect((await post(warm, sdk.api)).outcome).toBe('published');
    expect(sdk.saves.mock.calls.length).toBeGreaterThan(saves);
    expect(warm.store.root.work.bodyHashBytes).toBe(0);
    await assertNoCatalogue(warm, true);
    const restored = await prepare(sdk.api, 'e2'.repeat(16));
    if (change === 'type') {
      expect(await readFile(restored.store.root.resolve('data/shared/a/child'), 'utf8')).toBe(
        'child',
      );
    }
    if (change === 'delete') {
      expect(await restored.store.root.stat('data/shared/a')).toBeNull();
    }
    if (change === 'empty-directory') {
      expect((await restored.store.root.stat('data/shared/empty'))?.[2]).toBe('directory');
    }
    if (change === 'size') {
      expect(await readFile(restored.store.root.resolve('data/shared/a'), 'utf8')).toBe(
        'longer-body',
      );
    }
    if (change === 'mode') {
      expect((await restored.store.root.stat('data/shared/a'))![6] & 0o200).toBe(0);
    }
    if (change === 'mtime') {
      expect(Number((await restored.store.root.stat('data/shared/a'))![8]) / 1e9).toBeCloseTo(
        2.345,
        6,
      );
    }
    await assertNoCatalogue(restored);
  },
);
it('ignores directory own-clock changes in a real unchanged post', async () => {
  const sdk = await backend(),
    seed = await prepare(sdk.api, 'e3'.repeat(16));
  await buildFiles(seed, { 'data/shared/a': 'body' });
  await post(seed, sdk.api);
  const warm = await prepare(sdk.api, 'e4'.repeat(16)),
    saves = sdk.saves.mock.calls.length;
  await utimes(warm.store.root.resolve('data/shared'), 123, 456);
  expect((await post(warm, sdk.api)).outcome).toBe('no-change');
  expect(sdk.saves).toHaveBeenCalledTimes(saves);
  await assertNoCatalogue(warm, true);
});

it.each([
  ['standalone', 'remote', 'prior'],
  ['standalone', 'remote', 'empty'],
  ['standalone', 'remote', 'miss'],
  ['distributed-aggregator', null, 'prior'],
  ['distributed-aggregator', 'parent', 'prior'],
  ['distributed-aggregator', null, 'empty'],
  ['distributed-aggregator', null, 'miss'],
] as const)(
  'publishes local snapshot changes for %s writer=%s baseline=%s through a fresh post and reader',
  async (role, writer, baseline) => {
    const sdk = await backend(),
      model = snapshotModel(writer);
    if (baseline !== 'miss') {
      const seed = await prepare(sdk.api, 'a4'.repeat(16), { model, job: writer ?? 'parent' });
      if (baseline === 'prior') {
        await buildFiles(seed, {
          'state/shared/change': 'previous',
          'state/shared/delete': 'removed',
        });
      }
      await post(seed, sdk.api);
    }
    const copy = vi.spyOn(MetadataSnapshot, 'copy'),
      admit = vi.spyOn(MetadataSnapshot, 'admit');
    const local = await prepare(sdk.api, 'a5'.repeat(16), { model, role });
    expect(copy).not.toHaveBeenCalled();
    expect((await handoff(local)).entries.find((e) => e[1] === 'state')![4]).toBeNull();
    expect(await local.store.root.stat(local.store.prefix + 'snapshots')).toBeNull();
    await rm(local.store.root.resolve('state/shared/delete'), { force: true });
    await buildFiles(local, { 'state/shared/change': 'local-change', 'state/shared/add': 'added' });
    expect((await post(local, sdk.api)).outcome).toBe('published');
    expect(admit).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledTimes(1);
    const reader = await prepare(sdk.api, 'a6'.repeat(16), { model });
    expect(await readFile(reader.store.root.resolve('state/shared/change'), 'utf8')).toBe(
      'local-change',
    );
    expect(await readFile(reader.store.root.resolve('state/shared/add'), 'utf8')).toBe('added');
    expect(await reader.store.root.stat('state/shared/delete')).toBeNull();
    // A complete local deletion publishes an explicit empty selection.
    await rm(reader.store.root.resolve('state'), { recursive: true });
    expect((await post(reader, sdk.api)).outcome).toBe('published');
    const empty = await prepare(sdk.api, 'a7'.repeat(16), { model });
    expect((await handoff(empty)).entries.find((e) => e[1] === 'state')![2]).toBe('empty');
    expect(await empty.store.root.stat('state')).toBeNull();
  },
);

it('omits an unassigned ordinary worker snapshot while its aggregate contribution is merged', async () => {
  const sdk = await backend(),
    model = snapshotModel(null),
    artifacts = memoryArtifacts();
  const worker = await prepare(sdk.api, 'b4'.repeat(16), {
    model,
    job: 'A',
    role: 'distributed-worker',
  });
  await buildFiles(worker, { 'state/shared/a': 'unassigned', 'data/shared/a': 'worker' });
  await postStreamingWorker({
    anchor: worker.anchor,
    budget: worker.budget,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  const aggregator = await prepare(sdk.api, 'b5'.repeat(16), {
    model,
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
  });
  expect(await readFile(aggregator.store.root.resolve('data/shared/a'), 'utf8')).toBe('worker');
  expect(await aggregator.store.root.stat('state')).toBeNull();
  await post(aggregator, sdk.api);
  const reader = await prepare(sdk.api, 'b6'.repeat(16), { model });
  expect((await handoff(reader)).entries.find((e) => e[1] === 'state')![2]).toBe('empty');
});

it.each(['prior', 'empty', 'miss'] as const)(
  'preserves the remote writer fallback over aggregator changes with a %s baseline',
  async (baseline) => {
    const sdk = await backend(),
      model = snapshotModel();
    if (baseline !== 'miss') {
      const seed = await prepare(sdk.api, 'c4'.repeat(16), { model, job: 'A' });
      if (baseline === 'prior') {
        await buildFiles(seed, { 'state/shared/a': 'base-state' });
      }
      await post(seed, sdk.api);
    }
    const aggregator = await prepare(sdk.api, 'c5'.repeat(16), {
      model,
      role: 'distributed-aggregator',
      artifacts: memoryArtifacts().api,
    });
    await buildFiles(aggregator, {
      'state/shared/a': 'ignored-local-change',
      'state/shared/extra': 'ignored-addition',
    });
    const descriptor = (await handoff(aggregator)).entries.find((e) => e[1] === 'state')![4]!;
    expect(descriptor[4][0]).toBe(baseline === 'prior' ? 'base' : 'empty');
    if (baseline !== 'prior') {
      expect(descriptor[4][1]).toBe(baseline === 'empty' ? 'generation' : 'miss');
    }
    await post(aggregator, sdk.api);
    const reader = await prepare(sdk.api, 'c6'.repeat(16), { model });
    if (baseline === 'prior') {
      expect(await readFile(reader.store.root.resolve('state/shared/a'), 'utf8')).toBe(
        'base-state',
      );
    } else {
      expect((await handoff(reader)).entries.find((e) => e[1] === 'state')![2]).toBe('empty');
    }
    expect(await reader.store.root.stat('state/shared/extra')).toBeNull();
  },
);

it('preserves unchanged Gradle objects through a real worker overlay and fresh writable post', async () => {
  const sdk = await backend(),
    artifacts = memoryArtifacts();
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'gradle',
      hard,
      [
        ['data', ['data/**'], hard, 'aggregate', null, 'default', 0],
        ['stable', ['stable/**'], hard, 'aggregate', null, 'default', 0],
      ],
    ],
    'gradle-overlay-reuse-',
    1,
  );
  const seed = await prepare(sdk.api, 'e1'.repeat(16), { model });
  await buildFiles(seed, { 'data/base': 'base', 'stable/source': 'stable' });
  expect((await post(seed, sdk.api)).outcome).toBe('published');
  const worker = await prepare(sdk.api, 'e2'.repeat(16), {
    model,
    job: 'A',
    role: 'distributed-worker',
  });
  expect(worker.restoreStatus).toBe('current-lineage-hit');
  await buildFiles(worker, { 'data/from-worker': 'worker' });
  expect(
    (
      await postStreamingWorker({
        anchor: worker.anchor,
        budget: worker.budget,
        artifactBackend: async () => artifacts.api,
        assertCurrent: () => undefined,
      })
    ).outcome,
  ).toBe('worker-uploaded');
  const merged = await prepare(sdk.api, 'e3'.repeat(16), {
    model,
    role: 'distributed-aggregator',
    order: ['A'],
    artifacts: artifacts.api,
  });
  expect(merged.workerCount).toBe(1);
  expect(await readFile(merged.store.root.resolve('data/from-worker'), 'utf8')).toBe('worker');
  const publishedCount = sdk.saves.mock.calls.length;
  expect((await post(merged, sdk.api)).outcome).toBe('published');
  expect(sdk.saves).toHaveBeenCalledTimes(publishedCount + 2);
  const consumer = await prepare(sdk.api, 'e4'.repeat(16), { model });
  expect(await readFile(consumer.store.root.resolve('data/from-worker'), 'utf8')).toBe('worker');
  expect(await readFile(consumer.store.root.resolve('stable/source'), 'utf8')).toBe('stable');
  expect((await post(consumer, sdk.api)).outcome).toBe('no-change');
  expect(sdk.saves).toHaveBeenCalledTimes(publishedCount + 2);
});

function dependencyLayerModel(enabled: boolean) {
  const hard = ['.mammoth/**'];
  return resolveModel(
    [
      'model',
      1,
      'gradle',
      hard,
      [
        ['dependencies', ['dependencies/**'], hard, 'aggregate', null, 'default', 1],
        ['other', ['other/**'], hard, 'aggregate', null, 'default', 0],
      ],
      ...(enabled ? ['retain-dependencies'] : []),
    ],
    'dependency-layer-',
    1,
  );
}

it.each([
  { role: 'standalone' as const, enabled: true },
  { role: 'distributed-aggregator' as const, enabled: true },
  { role: 'standalone' as const, enabled: false },
  { role: 'distributed-aggregator' as const, enabled: false },
])(
  'uses frozen publisher retention for $role with layer policy $enabled and zero worker activations',
  async ({ role, enabled }) => {
    const sdk = await backend(),
      model = dependencyLayerModel(enabled);
    const initial = await prepare(sdk.api, 'd0'.repeat(16), { model });
    await buildFiles(initial, {
      'dependencies/shared/old-a.jar': 'inherited-a',
      'dependencies/shared/old-b.jar': 'inherited-b',
      'other/shared/old.jar': 'unrelated',
    });
    const seed = await post(initial, sdk.api);
    expect(seed.outcome).toBe('published');
    const currentRef = role === 'standalone' ? 'refs/heads/main' : 'refs/heads/feature';
    const publisher = await prepare(sdk.api, 'd1'.repeat(16), {
      model,
      role,
      currentRef,
      defaultRef: 'refs/heads/main',
      artifacts: memoryArtifacts().api,
      gcAgeMs: 14 * 86400000,
      now: () => Date.now() + 10000,
    });
    expect(publisher.restoredKey).toBe(seed.key);
    expect(publisher.workerCount).toBe(0);
    expect(publisher.restoreStatus).toBe(
      role === 'standalone' ? 'current-lineage-hit' : 'fallback-lineage-hit',
    );
    // This old local contribution was never in the inherited seed.
    await buildFiles(publisher, { 'dependencies/shared/new-old.jar': 'contribution' });
    const reopened = await OpenedInvocation.open(publisher.anchor, publisher.budget);
    expect(reopened.store).not.toBe(publisher.store);
    expect(reopened.store.codec.options.model.dependencyCacheLayer).toBe(enabled);
    const publication = await post(publisher, sdk.api);
    expect(publication.outcome).toBe('published');
    for (const name of ['old-a.jar', 'old-b.jar', 'new-old.jar']) {
      const stat = await publisher.store.root.stat('dependencies/shared/' + name);
      expect(stat !== null, name).toBe(enabled);
    }
    expect(await publisher.store.root.stat('other/shared/old.jar')).toBeNull();
    const reader = await prepare(sdk.api, 'd2'.repeat(16), { model, currentRef });
    expect(reader.restoredKey).toBe(publication.key);
    expect((await reader.store.root.stat('dependencies/shared/old-a.jar')) !== null).toBe(enabled);
    await assertNoCatalogue(publisher, true);
  },
);

it('keeps protected worker-head GC ordinary while the shared family isolates ordinary-GC generations', async () => {
  const sdk = await backend(),
    ordinary = dependencyLayerModel(false),
    protectedModel = dependencyLayerModel(true);
  expect(ordinary.partitions).toEqual(protectedModel.partitions);
  expect(ordinary.family).not.toBe(protectedModel.family);
  const ordinarySeed = await prepare(sdk.api, 'e0'.repeat(16), { model: ordinary });
  await buildFiles(ordinarySeed, { 'dependencies/shared/old.jar': 'ordinary' });
  await post(ordinarySeed, sdk.api);
  const isolated = await prepare(sdk.api, 'e1'.repeat(16), {
    model: protectedModel,
    role: 'distributed-worker',
    currentRef: 'refs/heads/feature',
    defaultRef: 'refs/heads/main',
  });
  expect(isolated.restoreStatus).toBe('miss');
  expect(await isolated.store.root.stat('dependencies/shared/old.jar')).toBeNull();
  const initial = await prepare(sdk.api, 'e2'.repeat(16), { model: protectedModel });
  await buildFiles(initial, { 'dependencies/shared/old.jar': 'protected' });
  const seed = await post(initial, sdk.api);
  const worker = await prepare(sdk.api, 'e3'.repeat(16), {
    model: protectedModel,
    role: 'distributed-worker',
    gcAgeMs: 14 * 86400000,
    now: () => Date.now() + 10000,
  });
  expect(worker.restoredKey).toBe(seed.key);
  const artifacts = memoryArtifacts();
  const result = await postStreamingWorker({
    anchor: worker.anchor,
    budget: worker.budget,
    artifactBackend: async () => artifacts.api,
    assertCurrent: (): undefined => {},
  });
  expect(result.outcome).toBe('worker-uploaded');
  expect(await worker.store.root.stat('dependencies/shared/old.jar')).toBeNull();
  await assertNoCatalogue(worker, true);
});
