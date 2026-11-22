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

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generate, mutate, verify, capacity } from '../scripts/qualification/fixture.mjs';
import {
  gradleTasks,
  fileCommands,
  commandEnv,
  invocation,
  lifecycle,
} from '../scripts/qualification/invocation.mjs';
import { setTimeout } from 'node:timers/promises';
import { meter, reservation } from '../scripts/qualification/meter.mjs';
import {
  treeRss,
  snapshot,
  cgroupDirectories,
  cgroupLimits,
} from '../scripts/qualification/observe.mjs';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const r = await mkdtemp(path.resolve('build/q1-test-'));
  roots.push(r);
  return r;
}
it('generates/verifies changes without changing the total, catches corruption and unknown members', async () => {
  const r = await root();
  await generate(r, 40);
  expect(await verify(r, 40)).toEqual({ files: 40, bytes: 2560 });
  expect(await mutate(r, 40)).toEqual({ modified: 4, deleted: 2, added: 2, untouched: 34 });
  expect(await verify(r, 40, true)).toEqual({ files: 40, bytes: 2560 });
  await writeFile(path.join(r, 'q0/0/0.bin'), 'bad');
  await expect(verify(r, 40, true)).rejects.toThrow();
});
it('preflights physical allocation rather than only 64-byte logical bodies', async () => {
  const c = await capacity(await root(), 40);
  expect(c.estimatedRequired).toBeGreaterThan(40 * 64);
  expect(c.free).toBeGreaterThan(0);
});
it('transports command-file state and preserves real SDK context but removes prior invocation switches', () => {
  expect(fileCommands('owner<<x\nfirst\nsecond\nx\nplain=yes\n')).toEqual({
    owner: 'first\nsecond',
    plain: 'yes',
  });
  expect(() => fileCommands('owner<<x\nunclosed')).toThrow();
  expect(
    commandEnv({
      GITHUB_JOB: 'physical',
      ACTIONS_RUNTIME_TOKEN: 'test-only',
      INPUT_OLD: 'x',
      STATE_OLD: 'y',
      NODE_OPTIONS: 'bad',
    }),
  ).toEqual({ GITHUB_JOB: 'physical', ACTIONS_RUNTIME_TOKEN: 'test-only' });
});
it('counts only the owned process tree and obtains a real bounded OS reading', async () => {
  expect(
    treeRss(
      [
        { pid: 3, parent: 2, rss: 4 },
        { pid: 2, parent: 1, rss: 8 },
        { pid: 9, parent: 8, rss: 100 },
      ],
      1,
    ),
  ).toBe(12);
  const s = await snapshot();
  expect(s.available).toBeGreaterThan(0);
  expect(s.rows.some((r) => r.pid === process.pid)).toBe(true);
});
it('executes production Maven bundles and rejects a duplicate logical prepare after post', async () => {
  const j = await invocation(await root(), 'maven', 'q1-guard', { 'cache-enabled': 'false' });
  Object.assign(j.env, {
    GITHUB_REPOSITORY: 'example/repo',
    GITHUB_WORKFLOW: 'Q1 local guard',
    GITHUB_JOB: 'physical',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'rev',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
  });
  await j.phase('main');
  await j.phase('post');
  await expect(j.phase('main')).rejects.toThrow('Qualification child failed');
}, 20000);

it('calibrates an independent sampler against a real allocation and exited child', async () => {
  const m = await meter(await root());
  const result = await m.close();
  expect(result.samples).toBeGreaterThan(0);
  expect(result.phases['calibration-child'].peakRss).toBeGreaterThanOrEqual(48 * 1024 ** 2);
  expect(result.phases['calibration-exited'].peakRss).toBe(0);
}, 20000);

it('acknowledges touched reservation and fails an expired load instead of claiming headroom', async () => {
  const live = await reservation(8, 3000);
  expect(live.mib).toBe(8);
  live.assertCurrent();
  await live.close();
  const expired = await reservation(8, 150);
  await setTimeout(300);
  expect(() => expired.assertCurrent()).toThrow('Reservation is not live');
  await expect(expired.close()).rejects.toThrow('Reservation is not live');
});

it('resolves current and ancestor cgroups instead of treating the root maximum as effective', () => {
  expect(cgroupDirectories('/runner/job')).toEqual([
    '/sys/fs/cgroup/runner/job',
    '/sys/fs/cgroup/runner',
    '/sys/fs/cgroup',
  ]);
  expect(cgroupDirectories('/runner/job', '/runner')).toEqual([
    '/sys/fs/cgroup/job',
    '/sys/fs/cgroup',
  ]);
  expect(cgroupDirectories('/../../unmapped')).toBeNull();
  expect(cgroupDirectories('/other', '/runner')).toBeNull();
});

it('accepts absent root controls but never hides missing nested limits', async () => {
  const values: Record<string, string> = {
    '/sys/fs/cgroup/job/memory.max': '100',
    '/sys/fs/cgroup/job/memory.current': '60',
  };
  const read = async (file: string) => {
    if (values[file] !== undefined) return values[file];
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  expect(await cgroupLimits(['/sys/fs/cgroup/job', '/sys/fs/cgroup'], read)).toEqual({
    total: 100,
    available: 40,
  });
  await expect(cgroupLimits(['/sys/fs/cgroup/unknown', '/sys/fs/cgroup'], read)).rejects.toThrow(
    'missing',
  );
});

it('attempts post after failed main/build and preserves both primary and cleanup failure', async () => {
  const calls: string[] = [];
  const job = {
    phase: async (name: string) => {
      calls.push(name);
      if (name === 'main') throw new Error('prepare');
    },
  };
  await expect(
    lifecycle(job, async () => {
      throw new Error('must not build');
    }),
  ).rejects.toThrow('prepare');
  expect(calls).toEqual(['main', 'post']);
  const cleanup = {
    phase: async (name: string) => {
      if (name === 'post') throw new Error('post');
    },
  };
  await expect(
    lifecycle(cleanup, async () => {
      throw new Error('build');
    }),
  ).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'build' }),
      expect.objectContaining({ message: 'post' }),
    ],
  });
});

it('authors complete Gradle metadata at the designated writer while retaining other worker dependency sets', () => {
  const all = ['resolveWorkerA', 'resolveWorkerB', 'resolveWorkerC'];
  expect(gradleTasks('worker', 'q1-worker-linux-gradle')).toEqual(all);
  expect(gradleTasks('worker', 'q1-worker-windows-gradle')).toEqual(['resolveWorkerB']);
  expect(gradleTasks('worker', 'q1-worker-macos-gradle')).toEqual(['resolveWorkerC']);
  expect(gradleTasks('aggregator', 'q1-aggregator-linux-gradle')).toEqual(all);
  expect(gradleTasks('consumer', 'q1-consumer-linux-gradle')).toEqual(all);
  expect(gradleTasks('parity-reader', 'q1-parity-reader-gradle')).toEqual(['resolveStandalone']);
});
