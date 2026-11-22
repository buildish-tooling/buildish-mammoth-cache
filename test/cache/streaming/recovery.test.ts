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

import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import type { LifecycleResolver } from '../../../src/build-tool/lifecycle-types';
import { gradleResolver } from './quiescence-fixture';
import { runStreamingPost } from '../../../src/phases/streaming/post';
import { postStreamingBase } from '../../../src/cache/streaming/base-post';
import { STREAMING_INVOCATION_STATE } from '../../../src/phases/streaming/state';
import { JOB_SINGLE_RUN_OWNER_TOKEN_STATE } from '../../../src/guard/job-single-run';
import { encodeInvocationAnchor } from '../../../src/cache/streaming/invocation';
import { mkdtemp, readFile, rm, unlink, mkdir, utimes, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  reconcileInvocation,
  admitBootstrapCandidate,
} from '../../../src/cache/streaming/recovery';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import type { Value } from '../../../src/cache/streaming/encoding';
import { observationFixture, rows } from './observation-fixtures';
import { installFixture } from './install-fixture';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
const assertCurrent = (): undefined => {};
let temporary: string, moving: string;
beforeAll(async () => {
  temporary = await mkdtemp(path.resolve('build/recovery-process-'));
  moving = temporary + '/moving.mjs';
  await build({
    entryPoints: ['test/cache/streaming/moving-process-fixture.ts'],
    outfile: moving,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
  });
  const outputs = await build({
    entryPoints: ['src/cache/streaming/recovery.ts'],
    outdir: 'build/unused-recovery-graph',
    bundle: true,
    write: false,
    splitting: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
  });
  const eager = Object.values(outputs.metafile!.outputs).find(
    (o) => o.entryPoint === 'src/cache/streaming/recovery.ts',
  )!;
  expect(
    Object.keys(eager.inputs).filter((p) =>
      /src\/(?:ci\/github|build-tool\/(?:gradle|maven)\/|phases\/bootstrap|config\/)/.test(p),
    ),
  ).toEqual([]);
});
afterAll(() => rm(temporary, { recursive: true, force: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture(
  tool: 'maven' | 'gradle' = 'maven',
  options: Parameters<typeof observationFixture>[1] = {},
) {
  const f = await observationFixture(tool, options);
  fixtures.push(f);
  return f;
}
async function opened(f: Awaited<ReturnType<typeof installFixture>>) {
  const invocation = await OpenedInvocation.current(f.root, f.budget);
  if (!invocation) throw new Error('Missing fixture invocation');
  return invocation;
}
it('leaves an idle retry intact and abandons before normal completed-owner retirement', async () => {
  const f = await fixture(),
    inspect = vi.fn(),
    resolver = vi.fn(gradleResolver({ inspect }));
  for (let n = 0; n < 16; n++) await f.files('', { ['data/f' + n]: 'body' });
  const before = await f.store.state();
  await reconcileInvocation(await opened(f), 'resume', {
    budget: f.budget,
    assertCurrent,
    lifecycle: resolver,
  });
  expect(await f.store.state()).toEqual(before);
  expect(inspect).not.toHaveBeenCalled();
  expect(resolver).not.toHaveBeenCalled();
  await reconcileInvocation(await opened(f), 'abandon', { budget: f.budget, assertCurrent });
  expect(((await f.store.state()) as unknown[])[14]).toBe('abandoned');
  await reconcileInvocation(await opened(f), 'abandon', { budget: f.budget, assertCurrent });
  const next = await installFixture('maven', { root: f.root, nonce: 'b'.repeat(32) });
  await next.store.initialize(next.bindings, f.store);
  expect(await next.store.root.stat(f.store.prefix.slice(0, -1))).toBeNull();
  expect(await readFile(f.store.root.resolve('data/f15'), 'utf8')).toBe('body');
});
it.each(['install-intent-published', 'install-source-renamed', 'install-intent-retired'])(
  'reconciles install marker or committed-prefix progress after %s',
  async (point) => {
    const f = await fixture();
    const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    state[3]++;
    state[4] = 'prepare-pending';
    await f.store.updateState(state);
    const plan = await freezeInstallPlan(
      f.store,
      [await f.incoming('data', { 'data/a': 'a', 'data/b': 'b' })],
      f.budget,
    );
    let failed = false;
    vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
      if (name === point && !failed) {
        failed = true;
        throw new Error('interrupted');
      }
    });
    await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
    await reconcileInvocation(await opened(f), 'abandon', { budget: f.budget, assertCurrent });
    expect(await readFile(f.store.root.resolve('data/a'), 'utf8')).toBe('a');
    expect(((await f.store.state()) as unknown[])[11]).toBeNull();
    await f.store.assertNoIntents();
  },
);
it('reconciles only the discoverable GC batch, never its unowned future suffix', async () => {
  const f = await fixture();
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
    bindings = f.store.codec.schemas.documents.bindings.parse(
      await f.store.readDocument(state[5], 'bindings'),
    );
  bindings[8][9] = 11;
  state[3]++;
  state[5] = f.store.codec.schemas.ref('bindings').parse(await f.store.writeDocument(bindings));
  await f.store.updateState(state);
  for (let n = 0; n < 6; n++) {
    await f.files('', { ['data/f' + n]: 'old' });
    await utimes(f.store.root.resolve('data/f' + n), 1.234, 1.234);
  }
  await captureObservations(f.store, { budget: f.budget, maxDirectoryEntries: 11 });
  let failed = false;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'gc-target-deleted' && !failed) {
      failed = true;
      throw new Error('interrupted');
    }
  });
  await expect(
    executeGc(f.store, { budget: f.budget, maxDirectoryEntries: 11, batchOperations: 2 }),
  ).rejects.toThrow('interrupted');
  await reconcileInvocation(await opened(f), 'abandon', {
    budget: f.budget,
    maxDirectoryEntries: 7,
    assertCurrent,
  });
  expect(await f.store.root.stat('data/f0')).toBeNull();
  expect(await f.store.root.stat('data/f1')).toBeNull();
  expect(await readFile(f.store.root.resolve('data/f2'), 'utf8')).toBe('old');
  await f.store.assertNoIntents();
});
it.each([
  ['relocation-outbound-rename', 4],
  ['relocation-return-rename', 3],
] as const)(
  'returns all recorded sources backend-free after process exit at %s',
  async (point, nth) => {
    const f = await installFixture('gradle');
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [moving, 'start', f.root, point, String(nth)], {
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const inspect = vi.fn(async () => ({ remaining: false, uncertain: false }));
    await reconcileInvocation(await opened(f), 'resume', {
      budget: f.budget,
      assertCurrent,
      lifecycle: gradleResolver({ inspect }),
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    for (const [name, body] of Object.entries({
      'caches/a': 'a',
      'caches/b': 'b',
      'state/b': 'snapshot',
    }))
      expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
    await f.store.assertNoIntents();
    // No marker: do not reconstruct MovingWindow or inspect processes a second time.
    await reconcileInvocation(await opened(f), 'abandon', {
      budget: f.budget,
      assertCurrent,
      lifecycle: gradleResolver({ inspect }),
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  },
  20_000,
);
it('blocks unknown root-local destructive owners without deleting them', async () => {
  const f = await fixture(),
    name = '.mammoth/v1/' + 'c'.repeat(64) + '/gc-intent.json';
  await f.files('', { [name]: 'unproven' });
  await expect(
    reconcileInvocation(await opened(f), 'abandon', { budget: f.budget, assertCurrent }),
  ).rejects.toThrow('Pending');
  expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe('unproven');
  expect(((await f.store.state()) as unknown[])[4]).not.toBe('completed');
});
it('foreground cancellation still reconciles a committed install prefix using cleanup lifetime', async () => {
  const f = await fixture(),
    state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'prepare-pending';
  await f.store.updateState(state);
  const plan = await freezeInstallPlan(
    f.store,
    [await f.incoming('data', { 'data/a': 'a' })],
    f.budget,
  );
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-intent-retired') throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    reconcileInvocation(await opened(f), 'resume', {
      budget: f.budget,
      assertCurrent,
      signal: controller.signal,
    }),
  ).rejects.toThrow('cancelled');
  expect(((await f.store.state()) as unknown[])[11]).toBeNull();
  await f.store.assertNoIntents();
});
it.each([false, true])(
  'admits sealed revision-zero bootstrap configOnlyHeader=%s without deleting orphans',
  async (configHeader) => {
    const f = await installFixture('maven');
    fixtures.push(f);
    await admitBootstrapCandidate(f.store, { budget: f.budget });
    await mkdir(f.store.root.resolve(f.store.prefix.slice(0, -1)), { recursive: true });
    await expect(admitBootstrapCandidate(f.store, { budget: f.budget })).rejects.toThrow();
    const b = f.bindings,
      spec = { budget: f.budget, partition: null };
    b[6] = await f.store.writeStream(
      'model',
      spec,
      rows([
        ['model-header', 'maven', f.model.tuple[3]],
        ...f.model.partitions.map((p) => ['partition', ...p]),
      ]),
    );
    (b[8] as unknown[])[7] = null;
    b[9] = null;
    b[12] = null;
    b[10] = await f.store.writeStream('producers', spec, rows([]));
    await f.store.makeParents(f.store.prefix + 'install/pending');
    const installParent = (await f.store.root.stat(f.store.prefix + 'install'))!;
    const pending: Value[] = [
      'prepare-selection',
      1,
      'refs/heads/main',
      null,
      ['execution', 1, null, 7, 'enabled', null],
      ['pending'],
      ['pending'],
      null,
      installParent,
      'selected',
    ];
    b[11] = await f.store.writeStream('prepare-sources', spec, rows(configHeader ? [pending] : []));
    await f.store.initialize(b);
    await unlink(f.store.root.resolve('.mammoth/v1/current.json'));
    await f.files('', { [f.store.prefix + 'unreferenced']: 'preserve' });
    await admitBootstrapCandidate(f.store, { budget: f.budget });
    if (process.platform !== 'win32') {
      const mode = f.store.root.binding[6] & 0o777;
      await chmod(f.root, mode ^ 0o020);
      try {
        await expect(admitBootstrapCandidate(f.store, { budget: f.budget })).rejects.toThrow(
          'Bootstrap root',
        );
      } finally {
        await chmod(f.root, mode);
      }
    }
    expect(await readFile(f.store.root.resolve(f.store.prefix + 'unreferenced'), 'utf8')).toBe(
      'preserve',
    );
    await f.store.initialize(b);
    expect(((await f.store.state()) as unknown[])[4]).toBe('prepare-pending');
    if (configHeader) {
      await unlink(f.store.root.resolve('.mammoth/v1/current.json'));
      pending[5] = ['miss'];
      b[11] = await f.store.writeStream('prepare-sources', spec, rows([pending]));
      await f.store.initialize(b);
      await unlink(f.store.root.resolve('.mammoth/v1/current.json'));
      await expect(admitBootstrapCandidate(f.store, { budget: f.budget })).rejects.toThrow(
        'selected inputs',
      );
      expect(await readFile(f.store.root.resolve(f.store.prefix + 'unreferenced'), 'utf8')).toBe(
        'preserve',
      );
    }
  },
);

it('requires fresh absence evidence before returning sources, without executing captured launchers', async () => {
  const f = await installFixture('gradle');
  fixtures.push(f);
  try {
    execFileSync(process.execPath, [moving, 'start', f.root, 'relocation-outbound-rename', '1'], {
      stdio: 'pipe',
    });
  } catch (error) {
    expect((error as { status: unknown }).status).toBe(73);
  }
  const invocation = await opened(f),
    before = await f.store.state();
  await expect(
    reconcileInvocation(invocation, 'abandon', {
      budget: f.budget,
      assertCurrent,
      lifecycle: gradleResolver({ inspect: async () => ({ remaining: true, uncertain: false }) }),
    }),
  ).rejects.toThrow('finished Gradle consumers');
  expect(await f.store.state()).toEqual(before);
  await expect(f.store.assertNoIntents()).rejects.toThrow('relocation');
  await reconcileInvocation(await opened(f), 'resume', {
    budget: f.budget,
    assertCurrent,
    lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: false }) }),
  });
  expect(await readFile(f.store.root.resolve('caches/a'), 'utf8')).toBe('a');
});
it('preserves a conflicting return destination and its discoverable relocation marker', async () => {
  const f = await installFixture('gradle');
  fixtures.push(f);
  try {
    execFileSync(process.execPath, [moving, 'start', f.root, 'relocation-outbound-rename', '1'], {
      stdio: 'pipe',
    });
  } catch (error) {
    expect((error as { status: unknown }).status).toBe(73);
  }
  expect(await f.store.root.stat('caches/a')).toBeNull();
  await f.files('', { 'caches/a': 'conflicting replacement' });
  await expect(
    reconcileInvocation(await opened(f), 'abandon', {
      budget: f.budget,
      assertCurrent,
      lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: false }) }),
    }),
  ).rejects.toThrow();
  expect(await readFile(f.store.root.resolve('caches/a'), 'utf8')).toBe('conflicting replacement');
  await expect(f.store.assertNoIntents()).rejects.toThrow('relocation');
  expect(((await f.store.state()) as unknown[])[4]).not.toBe('completed');
});

it('keeps idle dispatch filesystem work independent of managed directory width', async () => {
  const counts = [];
  for (const width of [4, 16]) {
    const f = await fixture();
    for (let i = 0; i < width; i++) await f.files('', { ['data/f' + i]: 'body' });
    const invocation = await opened(f),
      work = invocation.store.root.work,
      before = { ...work };
    await reconcileInvocation(invocation, 'resume', { budget: f.budget, assertCurrent });
    counts.push(
      Object.fromEntries(
        ['stats', 'opens', 'renames', 'unlinks', 'fileSyncs', 'directorySyncs'].map((k) => {
          const key = k as keyof typeof work;
          return [key, work[key] - before[key]];
        }),
      ),
    );
  }
  expect(counts[0]).toEqual(counts[1]);
  process.stdout.write('V5_RECOVERY_IDLE_COST ' + JSON.stringify(counts) + '\n');
});

it('does not hide a missing GC marker required by a persisted progress hint', async () => {
  const f = await fixture();
  await captureObservations(f.store, { budget: f.budget });
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  const progress = f.store.codec.schemas.documents['gc-progress'].parse(
    await f.store.readDocument(state[10]!, 'gc-progress'),
  );
  progress[5] = f.store.prefix + 'gc-intent.json';
  state[10] = f.store.codec.schemas.ref('gc-progress').parse(await f.store.writeDocument(progress));
  state[3]++;
  await f.store.updateState(state);
  await expect(
    reconcileInvocation(await opened(f), 'abandon', { budget: f.budget, assertCurrent }),
  ).rejects.toThrow('Missing GC intent');
  expect(((await f.store.state()) as unknown[])[4]).toBe('observations-frozen');
});
it('reconciles worker GC without base process shutdown or quiescence authority', async () => {
  const f = await fixture('gradle', { role: 'distributed-worker' });
  for (let i = 0; i < 4; i++) {
    await f.files('', { ['data/f' + i]: 'old' });
    await utimes(f.store.root.resolve('data/f' + i), 1.234, 1.234);
  }
  await captureObservations(f.store, { budget: f.budget });
  let failed = false;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'gc-target-deleted' && !failed) {
      failed = true;
      throw new Error('interrupted');
    }
  });
  await expect(executeGc(f.store, { budget: f.budget, batchOperations: 2 })).rejects.toThrow(
    'interrupted',
  );
  const inspect = vi.fn();
  await reconcileInvocation(await opened(f), 'resume', {
    budget: f.budget,
    assertCurrent,
    lifecycle: gradleResolver({ inspect }),
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(((await f.store.state()) as unknown[])[13]).toBeNull();
  expect(await f.store.root.stat('data/f0')).toBeNull();
  expect(await f.store.root.stat('data/f2')).not.toBeNull();
});

it.each(['cleanup', 'caller'] as const)(
  'rejects %s lifetime revocation during abandonment pointer commit',
  async (kind) => {
    const f = await fixture(),
      invocation = await opened(f),
      controller = new AbortController();
    let revoked = false;
    const original = invocation.store.updateState.bind(invocation.store);
    vi.spyOn(invocation.store, 'updateState').mockImplementation(async (value) => {
      await original(value);
      revoked = true;
      if (kind === 'cleanup') controller.abort(new Error('cleanup expired'));
    });
    await expect(
      reconcileInvocation(invocation, 'abandon', {
        budget: f.budget,
        cleanupSignal: controller.signal,
        assertCurrent: () => {
          if (kind === 'caller' && revoked) throw new Error('caller revoked');
        },
      }),
    ).rejects.toThrow(kind === 'cleanup' ? 'cleanup expired' : 'caller revoked');
    expect(((await f.store.state()) as unknown[])[14]).toBe('abandoned');
  },
);
it('rejects cancellation at the absent bootstrap-candidate boundary', async () => {
  const f = await installFixture('maven');
  fixtures.push(f);
  const controller = new AbortController();
  const original = f.store.root.stat.bind(f.store.root);
  vi.spyOn(f.store.root, 'stat').mockImplementation(async (name) => {
    const result = await original(name);
    if (name === f.store.prefix.slice(0, -1)) controller.abort(new Error('bootstrap cancelled'));
    return result;
  });
  await expect(
    admitBootstrapCandidate(f.store, { budget: f.budget, signal: controller.signal }),
  ).rejects.toThrow('bootstrap cancelled');
});
it('keeps primary recovery and close failures together and releases the frozen lifetime', async () => {
  const f = await installFixture('gradle');
  fixtures.push(f);
  try {
    execFileSync(process.execPath, [moving, 'start', f.root, 'relocation-outbound-rename', '1'], {
      stdio: 'pipe',
    });
  } catch (error) {
    expect((error as { status: unknown }).status).toBe(73);
  }
  const primary = new Error('primary return failed'),
    cleanup = new Error('close failed');
  vi.spyOn(MovingBasePublication.prototype, 'recoverSources').mockRejectedValue(primary);
  const close = MovingBasePublication.prototype.close;
  vi.spyOn(MovingBasePublication.prototype, 'close').mockImplementation(async function (
    this: MovingBasePublication,
  ) {
    await close.call(this);
    throw cleanup;
  });
  const dispose = vi.spyOn(FrozenMovingPublication.prototype, 'dispose');
  const error = await reconcileInvocation(await opened(f), 'abandon', {
    budget: f.budget,
    assertCurrent,
    lifecycle: gradleResolver({ inspect: async () => ({ remaining: false, uncertain: false }) }),
  }).catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, cleanup]);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.budget.retained).toBe(0);
  await expect(f.store.assertNoIntents()).rejects.toThrow('relocation');
});

it.each(['provider', 'base-core', 'disabled'] as const)(
  'pre-aborted foreground still returns old moved sources via independent %s cleanup',
  async (kind) => {
    const f = await installFixture('gradle');
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [moving, 'start', f.root, 'relocation-outbound-rename', '4'], {
        stdio: 'pipe',
      });
    } catch (e) {
      status = (e as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const owner = await opened(f),
      controller = new AbortController();
    controller.abort(new Error('foreground already cancelled'));
    const cacheBackend = vi.fn(async () => {
        throw new Error('unexpected backend');
      }),
      loadReport = vi.fn(async () => {
        throw new Error('unexpected report');
      }),
      options = {
        budget: f.budget,
        signal: controller.signal,
        cleanupSignal: new AbortController().signal,
        assertCurrent,
        lifecycle: gradleResolver({
          inspect: async () => ({ remaining: false, uncertain: false }),
        }),
      };
    if (kind === 'provider')
      await expect(
        runStreamingPost({
          ...options,
          runtimeHost: {
            getState: (k) =>
              k === JOB_SINGLE_RUN_OWNER_TOKEN_STATE
                ? 'owner'
                : k === STREAMING_INVOCATION_STATE
                  ? encodeInvocationAnchor(owner.anchor)
                  : '',
            saveState: () => {},
            info: () => {},
            warning: () => {},
          },
          cacheBackend,
          artifactBackend: async () => {
            throw new Error('unexpected artifacts');
          },
          removeHooks: async () => [],
          loadReport,
        }),
      ).rejects.toThrow('foreground already cancelled');
    else if (kind === 'base-core')
      await expect(
        postStreamingBase({
          ...options,
          anchor: owner.anchor,
          cacheBackend,
          removeHooks: async () => {},
        }),
      ).rejects.toThrow('foreground already cancelled');
    else {
      const { reconcileDisabledRoot } =
        await import('../../../src/cache/streaming/passive-lifecycle');
      await expect(reconcileDisabledRoot(f.root, options)).rejects.toThrow(
        'foreground already cancelled',
      );
    }
    for (const [name, body] of Object.entries({
      'caches/a': 'a',
      'caches/b': 'b',
      'state/b': 'snapshot',
    }))
      expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
    await owner.store.assertNoIntents();
    expect(cacheBackend).not.toHaveBeenCalled();
    expect(loadReport).not.toHaveBeenCalled();
  },
  20_000,
);

it.each(['gradle', 'maven'] as const)(
  'new opposite-tool prepare returns interrupted OLD %s sources with only OLD lifecycle selection',
  async (oldTool) => {
    const f = await installFixture(oldTool);
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(
        process.execPath,
        [moving, 'start', f.root, 'relocation-outbound-rename', '1', oldTool],
        { stdio: 'pipe' },
      );
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const nextTool = oldTool === 'gradle' ? 'maven' : 'gradle',
      next = await installFixture(nextTool, { root: f.root, nonce: 'b'.repeat(32) }),
      cleanup = new AbortController().signal,
      foreground = new AbortController(),
      inspect = vi.fn(async (signal: AbortSignal) => {
        expect(signal).toBe(cleanup);
        return { remaining: false, uncertain: false };
      }),
      stop = vi.fn(async () => {
        throw new Error('Recovery must never stop launchers');
      }),
      resolver = vi.fn<LifecycleResolver>(async (tool) => {
        expect(tool).toBe(oldTool);
        return await gradleResolver({ inspect, stop })(tool);
      }),
      backend = vi.fn(async (): Promise<never> => {
        throw new Error('No backend before cleanup');
      });
    foreground.abort(new Error('new foreground cancelled'));
    await expect(
      prepareStreaming({
        root: f.root,
        model: next.model,
        context: next.store.codec.options.context,
        nonce: String(next.bindings[4]),
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
        saveAnchor: () => {},
        cacheBackend: backend,
        provision: backend,
        installHooks: backend,
        assertCurrent,
        signal: foreground.signal,
        cleanupSignal: cleanup,
        lifecycle: resolver,
      }),
    ).rejects.toThrow('new foreground cancelled');
    expect(resolver).toHaveBeenCalledExactlyOnceWith(oldTool);
    expect(inspect).toHaveBeenCalledTimes(oldTool === 'gradle' ? 1 : 0);
    expect(stop).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
    for (const [name, body] of Object.entries(
      oldTool === 'gradle'
        ? { 'caches/a': 'a', 'caches/b': 'b', 'state/b': 'snapshot' }
        : {
            'repository/org/a/1/_remote.repositories': 'marker',
            'repository/org/a/1/a.jar': 'a',
            'repository/org/b/1/b.jar': 'b',
          },
    ))
      expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
    await (await opened(f)).store.assertNoIntents();
  },
  20000,
);
