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

import { resolveLifecycle } from '../../../src/build-tool/lifecycle';
import type { LifecycleResolver } from '../../../src/build-tool/lifecycle-types';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ExclusiveWindow } from '../../../src/cache/streaming/quiescence';
import {
  registrationDirectory,
  registrationFailure,
} from '../../../src/build-tool/gradle/registrations';
import type { GradleInstallation } from '../../../src/build-tool/gradle/stop-client';
import {
  H,
  encodeRecord,
  decodeRecord,
  rawSha,
  tuple,
} from '../../../src/cache/streaming/encoding';
import { observationFixture } from './observation-fixtures';
import { quiescenceFixture, gradleResolver } from './quiescence-fixture';
import { PostAttempt } from '../../../src/cache/streaming/lifecycle-attempt';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import {
  gradleDaemonArguments,
  GRADLE_DAEMON_MAIN,
  windowsArguments,
  linuxStartTime,
  inspectGradleDaemons,
} from '../../../src/build-tool/gradle/process-inspection';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture(options: Parameters<typeof observationFixture>[1] = {}) {
  const f = await quiescenceFixture(options);
  cleanup.push(async () => {
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  return f;
}
const options = () => {
  const deps = {
    exitGraceMs: 0,
    assertCurrent: (): undefined => {},
    inspect: vi.fn(async () => ({ remaining: false, uncertain: false })),
    stop: vi.fn(
      async (_installation: GradleInstallation, _signal: AbortSignal, _timeoutMs: number) => {},
    ),
  };
  return { ...deps, lifecycle: gradleResolver(deps) };
};
it('seals actual registrations once, runs compatible clients sequentially and issues a cheap revocable window', async () => {
  const f = await fixture(),
    a = await f.register('8.5');
  await f.register('9.9');
  await f.register('8.5');
  const opened = (await OpenedInvocation.current(f.root, f.budget))!;
  f.store = opened.store;
  const attempt = await PostAttempt.open(opened, {
    budget: f.budget,
    assertCurrent: (): undefined => {},
  });
  cleanup.push(() => attempt.close());
  await f.files('', { 'data/body': 'body' });
  const opts = options();
  let active = 0,
    peak = 0;
  opts.stop.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    expect(await f.store.root.stat('data/body')).not.toBeNull();
    await setTimeout(1);
    active--;
  });
  const moves = vi.spyOn(f.store.root, 'renameAbsent'),
    gate = await ExclusiveWindow.establish(f.store, f.budget, opts);
  expect(gate.status).toBe('ready');
  expect(opts.stop).toHaveBeenCalledTimes(2);
  expect(peak).toBe(1);
  expect(
    moves.mock.calls.every(
      ([from, to]) => from.startsWith(f.store.prefix) && to.startsWith(f.store.prefix),
    ),
  ).toBe(true);
  expect(opts.inspect).toHaveBeenCalledTimes(1);
  expect(opts.stop.mock.calls[0][0]).toMatchObject({ gradleUserHome: f.root, javaHome: a[6] });
  if (gate.status !== 'ready') {
    throw new Error(gate.message);
  }
  cleanup.push(() => gate.window.close());
  const work = { ...f.store.root.work };
  for (let i = 0; i < 1000; i++) {
    gate.window.assertCurrent();
  }
  expect(f.store.root.work).toEqual(work);
  attempt.attachWindow(gate.window);
  const captured = await captureObservations(f.store, {
    attempt,
    budget: f.budget,
    purgeWindow: gate.window.purgeWindow,
    signal: gate.window.signal,
  });
  await captured.index?.dispose();
  gate.window.close();
  expect(() => gate.window.assertCurrent()).toThrow('closed');
});
it.each([
  'failed',
  'candidate',
  'bad-name',
  'bad-json',
  'missing-launcher',
  'stop',
  'remaining',
  'uncertain',
] as const)('rejects %s before observation/move work', async (kind) => {
  const f = await fixture(),
    r = await f.register('8.5'),
    opts = options(),
    initial = await f.store.state();
  if (kind === 'failed') {
    await writeFile(f.store.root.resolve(registrationFailure(f.store)), 'failure');
  }
  if (kind === 'candidate') {
    await writeFile(
      f.store.root.resolve(registrationDirectory(f.store) + '/.registration-candidate'),
      'partial',
    );
  }
  if (kind === 'bad-name') {
    await writeFile(
      f.store.root.resolve(registrationDirectory(f.store) + '/' + '0'.repeat(64) + '.json'),
      encodeRecord(r),
    );
  }
  if (kind === 'bad-json') {
    await writeFile(
      f.store.root.resolve(
        registrationDirectory(f.store) + '/' + H('gradle-installation', r) + '.json',
      ),
      '[]\n',
    );
  }
  if (kind === 'missing-launcher') {
    await import('node:fs/promises').then((fs) =>
      fs.rm(r[3] + '/bin/' + (process.platform === 'win32' ? 'gradle.bat' : 'gradle')),
    );
  }
  if (kind === 'stop') {
    opts.stop.mockRejectedValue(new Error('client nonzero'));
  }
  if (kind === 'remaining') {
    opts.inspect.mockResolvedValue({ remaining: true, uncertain: false });
  }
  if (kind === 'uncertain') {
    opts.inspect.mockResolvedValue({ remaining: false, uncertain: true });
  }
  const result = await ExclusiveWindow.establish(f.store, f.budget, opts);
  expect(result.status).toBe('skipped-not-quiescent');
  expect(await f.store.state()).toEqual(initial);
});
it('awaits a launched client on cancellation before returning, and starts no later client', async () => {
  const f = await fixture();
  await f.register('8.5');
  await f.register('9.9');
  const controller = new AbortController(),
    opts = options();
  let settle!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  opts.stop.mockImplementation(async () => {
    entered();
    await new Promise<void>((r) => {
      settle = r;
    });
  });
  let finished = false;
  const gate = ExclusiveWindow.establish(f.store, f.budget, {
    ...opts,
    signal: controller.signal,
  }).finally(() => {
    finished = true;
  });
  const rejected = expect(gate).rejects.toThrow('cancel fixture');
  await started;
  controller.abort(new Error('cancel fixture'));
  await setTimeout(5);
  expect(finished).toBe(false);
  settle();
  await rejected;
  expect(opts.stop).toHaveBeenCalledTimes(1);
  expect(tuple(await f.store.state())).toHaveLength(8);
});
it('waits client settlement on the overall deadline and fails without a window', async () => {
  const f = await fixture();
  await f.register('8.5');
  const opts = options(),
    deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  let settle!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  opts.stop.mockImplementation(async () => {
    entered();
    await new Promise<void>((r) => {
      settle = r;
    });
  });
  let finished = false;
  const gate = ExclusiveWindow.establish(f.store, f.budget, opts).finally(() => {
    finished = true;
  });
  await started;
  deadline.abort(new DOMException('quiescence deadline', 'TimeoutError'));
  await setTimeout(5);
  expect(finished).toBe(false);
  settle();
  expect((await gate).status).toBe('skipped-not-quiescent');
});
it('re-establishes live evidence on retry rather than trusting persisted quiescence', async () => {
  const f = await fixture();
  await f.register('8.5');
  const opts = options(),
    first = await ExclusiveWindow.establish(f.store, f.budget, opts);
  if (first.status !== 'ready') {
    throw new Error(first.message);
  }
  first.window.close();
  const state = tuple(await f.store.state());
  opts.inspect.mockResolvedValue({ remaining: true, uncertain: false });
  const result = await ExclusiveWindow.establish(f.store, f.budget, opts);
  expect(result.status).toBe('skipped-not-quiescent');
  expect(opts.stop).toHaveBeenCalledTimes(2);
  expect(await f.store.state()).toEqual(state);
});
it.each(['distributed-worker', 'readonly'] as const)('never stops a %s path', async (role) => {
  const f = await fixture(role === 'readonly' ? { access: 'read-only' } : { role }),
    opts = options();
  await expect(ExclusiveWindow.establish(f.store, f.budget, opts)).rejects.toThrow('base role');
  expect(opts.stop).not.toHaveBeenCalled();
});
it('recognizes only the Java main class, not substrings, classpath or property text', () => {
  expect(
    gradleDaemonArguments(['java', '-cp', '/runtime/gradle.jar', GRADLE_DAEMON_MAIN, '9.9']),
  ).toBe('daemon');
  expect(gradleDaemonArguments(['java', '-Dvalue=' + GRADLE_DAEMON_MAIN, 'app.Main'])).toBe(
    'other',
  );
  expect(gradleDaemonArguments(['java', '-cp', GRADLE_DAEMON_MAIN, 'app.Main'])).toBe('uncertain');
  expect(gradleDaemonArguments(['java', 'app.Main', 'prefix' + GRADLE_DAEMON_MAIN])).toBe('other');
  const line =
    '"C:\\Program Files\\Java\\bin\\java.exe" -cp "C:\\Gradle dir\\lib\\a.jar" ' +
    GRADLE_DAEMON_MAIN +
    ' 9.9';
  expect(windowsArguments(line)).toEqual([
    'C:\\Program Files\\Java\\bin\\java.exe',
    '-cp',
    'C:\\Gradle dir\\lib\\a.jar',
    GRADLE_DAEMON_MAIN,
    '9.9',
  ]);
  expect(() => windowsArguments('"unterminated')).toThrow();
  expect(gradleDaemonArguments(['java', '@/cache/daemon.args'])).toBe('uncertain');
  expect(gradleDaemonArguments(['java', '-cp', '@/cache/launcher.args'])).toBe('uncertain');
  expect(
    linuxStartTime('42 (java (worker)) S ' + Array.from({ length: 19 }, (_, i) => i + 1).join(' ')),
  ).toBe('19');
});
it('preserves cancellation even where native process inspection is unsupported', async () => {
  const controller = new AbortController();
  controller.abort(new Error('canceled inspection'));
  await expect(inspectGradleDaemons(controller.signal)).rejects.toThrow('canceled inspection');
});

it('keeps payload growth out of process/registration work and streams sixteen installations sequentially', async () => {
  const costs = [];
  for (const installs of [1, 16]) {
    for (const files of [4, 16]) {
      const f = await fixture();
      for (let n = 0; n < installs; n++) {
        await f.register('version-' + n);
      }
      await f.files(
        '',
        Object.fromEntries(Array.from({ length: files }, (_, n) => ['data/file-' + n, 'body'])),
      );
      const opts = options(),
        resolver = vi.fn(opts.lifecycle),
        reads = vi.spyOn(f.store.root, 'read'),
        streams = vi.spyOn(f.store, 'writeStream'),
        before = { ...f.store.root.work },
        gate = await ExclusiveWindow.establish(f.store, f.budget, { ...opts, lifecycle: resolver });
      if (gate.status !== 'ready') {
        throw new Error(gate.message);
      }
      gate.window.close();
      expect(opts.stop).toHaveBeenCalledTimes(installs);
      expect(opts.inspect).toHaveBeenCalledTimes(1);
      const inventoryIndex = streams.mock.calls.findIndex(
        ([purpose]) => purpose === 'installations',
      );
      const inventory = await streams.mock.results[inventoryIndex].value;
      const inventoryReads = reads.mock.calls.filter(([file]) => file === inventory[2]).length;
      const seals = streams.mock.calls.filter(([purpose]) => purpose === 'installations').length;
      expect(resolver).toHaveBeenCalledExactlyOnceWith('gradle');
      expect(seals).toBe(1);
      expect(inventoryReads).toBe(2);
      const w = f.store.root.work;
      costs.push({
        installs,
        resolutions: resolver.mock.calls.length,
        seals,
        inventoryReads,
        stats: w.stats - before.stats,
        opens: w.opens - before.opens,
      });
    }
  }
  expect(costs[0]).toEqual(costs[1]);
  expect(costs[2]).toEqual(costs[3]);
  process.stdout.write('V5_WINDOW_COST ' + JSON.stringify(costs) + '\n');
}, 30000);

it('matches independent Unicode registration/failure canonical bytes and framed filename', async () => {
  const section = (await readFile('docs/dev/cache-protocol-vectors.md', 'utf8')).split('## G0:')[1];
  for (const kind of ['registration', 'failure']) {
    const part = section.split('### ' + kind)[1].split('### ')[0],
      bytes = part.match(/```text\n([\s\S]*?)```/)![1],
      row = JSON.parse(bytes);
    expect(encodeRecord(row).toString()).toBe(bytes);
    expect(decodeRecord(Buffer.from(bytes))).toEqual(row);
    expect(rawSha(Buffer.from(bytes))).toBe(part.match(/Raw SHA-256: `([a-f0-9]{64})`/)![1]);
    if (kind === 'registration') {
      expect(H('gradle-installation', row) + '.json').toBe(part.match(/Filename: `([^`]+)`/)![1]);
    }
  }
});

it('uses the caller consumer lifetime for Maven without Gradle registration or process shutdown', async () => {
  const f = await observationFixture('maven');
  cleanup.push(async () => {
    await f.finish();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'build-ready';
  await f.store.updateState(state);
  const opts = options(),
    gate = await ExclusiveWindow.establish(f.store, f.budget, opts);
  expect(opts.stop).not.toHaveBeenCalled();
  expect(opts.inspect).not.toHaveBeenCalled();
  if (gate.status !== 'ready') {
    throw new Error(gate.message);
  }
  gate.window.close();
  expect(tuple(await f.store.state())).toHaveLength(8);
});

it.each(['path', 'identity', 'mode'] as const)(
  'rejects frozen root %s mismatch before any stop/process inspection',
  async (kind) => {
    const f = await fixture();
    await f.register('8.5');
    const opts = options(),
      state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
      b = f.store.codec.schemas.documents.bindings.parse(
        await f.store.readDocument(state[5], 'bindings'),
      );
    if (kind === 'path') {
      b[5][0] += '/foreign';
    }
    if (kind === 'identity') {
      b[5][1][4] = String(BigInt(b[5][1][4]) + 1n);
    }
    if (kind === 'mode') {
      b[5][1][6] ^= 0o010;
    }
    state[3]++;
    state[5] = f.store.codec.schemas.ref('bindings').parse(await f.store.writeDocument(b));
    await f.store.updateState(state);
    await expect(ExclusiveWindow.establish(f.store, f.budget, opts)).rejects.toThrow(
      'root binding',
    );
    expect(opts.stop).not.toHaveBeenCalled();
    expect(opts.inspect).not.toHaveBeenCalled();
  },
);
it.skipIf(process.platform === 'win32')(
  'freshly checks root mode before operational commands',
  async () => {
    const f = await fixture();
    await f.register('8.5');
    const opts = options();
    await chmod(f.root, 0o750);
    await expect(ExclusiveWindow.establish(f.store, f.budget, opts)).rejects.toThrow(
      'root binding',
    );
    expect(opts.stop).not.toHaveBeenCalled();
    expect(opts.inspect).not.toHaveBeenCalled();
  },
);
it('bounds exit settlement with a monotonic clock despite backwards wall-clock movement', async () => {
  const f = await fixture();
  await f.register('8.5');
  const opts = options();
  vi.spyOn(Date, 'now').mockReturnValue(1);
  let monotonic = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => ++monotonic);
  opts.inspect.mockImplementation(async () => ({
    remaining: opts.inspect.mock.calls.length <= 3,
    uncertain: false,
  }));
  const gate = await ExclusiveWindow.establish(f.store, f.budget, { ...opts, exitGraceMs: 1 });
  expect(gate.status).toBe('skipped-not-quiescent');
  expect(opts.inspect.mock.calls.length).toBeLessThanOrEqual(2);
});

it.skipIf(process.platform === 'win32').each(['stop', 'inspect'] as const)(
  'rejects root mode drift during awaited %s before quiescence commitment',
  async (phase) => {
    const f = await fixture();
    await f.register('8.5');
    const opts = options(),
      initial = await f.store.state();
    if (phase === 'stop') {
      opts.stop.mockImplementation(async () => {
        await chmod(f.root, 0o750);
      });
    } else {
      opts.inspect.mockImplementation(async () => {
        await chmod(f.root, 0o750);
        return { remaining: false, uncertain: false };
      });
    }
    const gate = await ExclusiveWindow.establish(f.store, f.budget, opts);
    expect(gate.status).toBe('skipped-not-quiescent');
    expect(await f.store.state()).toEqual(initial);
  },
);

it.each(['missing', 'wrong-purpose'] as const)(
  'rejects %s tool inventory before shared state/grant commitment',
  async (kind) => {
    const f = await fixture();
    await f.register('8.5');
    const opts = options();
    const before = await f.store.state();
    const lifecycle: LifecycleResolver = async (tool) => ({
      ...(await resolveLifecycle(tool)),
      quiesce: async () => {
        if (kind === 'missing') {
          return undefined;
        }
        if (kind === 'wrong-purpose') {
          return f.store.codec.schemas.documents['local-state'].parse(before)[5];
        }
        return f.store.writeStream(
          'installations',
          { budget: f.budget, partition: null },
          (async function* () {})(),
        );
      },
    });
    const gate = await ExclusiveWindow.establish(f.store, f.budget, { ...opts, lifecycle });
    expect(gate.status).toBe('skipped-not-quiescent');
    expect(await f.store.state()).toEqual(before);
  },
);
it('rejects a Maven inventory result rather than granting an accidental Gradle proof', async () => {
  const f = await observationFixture('maven');
  cleanup.push(f.close);
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'build-ready';
  await f.store.updateState(state);
  const lifecycle: LifecycleResolver = async (tool) => ({
    ...(await resolveLifecycle(tool)),
    quiesce: async () => state[5],
  });
  const gate = await ExclusiveWindow.establish(f.store, f.budget, { ...options(), lifecycle });
  expect(gate.status).toBe('skipped-not-quiescent');
  expect(await f.store.state()).toEqual(state);
});
