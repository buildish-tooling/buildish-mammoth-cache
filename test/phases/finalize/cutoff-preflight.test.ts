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

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { entrypointBundles, entrypointJob } from '../../support/streaming-entrypoint';
import { afterEach, it, expect, vi } from 'vitest';
import { cutoffJob } from '../../support/cutoff-job';
import { runGuardedCutoffPost } from '../../../src/phases/finalize/preflight';
import {
  consumeCutoffPreflight,
  preflightCutoffLifecycle,
  readCutoffLifecycle,
} from '../../../src/phases/cutoff-lifecycle';
import {
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
  JOB_SINGLE_RUN_DUPLICATE_STATE,
  JOB_PREPARE_FAILED_STATE,
} from '../../../src/guard/job-single-run';

const roots: string[] = [];
async function root() {
  const p = await mkdtemp(path.join(os.tmpdir(), 'cutoff-post-'));
  roots.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it.each(['missing', 'duplicate', 'failed'])(
  'guards %s before lifecycle access or deferred imports',
  async (mode) => {
    const cb = vi.fn();
    await runGuardedCutoffPost(
      {
        info: () => {},
        getState: (key) => {
          if (key === JOB_SINGLE_RUN_OWNER_TOKEN_STATE) return mode === 'missing' ? '' : 'owner';
          if (key === JOB_SINGLE_RUN_DUPLICATE_STATE)
            return mode === 'duplicate' ? 'true' : 'false';
          if (key === JOB_PREPARE_FAILED_STATE) return mode === 'failed' ? 'true' : 'false';
          throw new Error('unguarded lifecycle read');
        },
      },
      cb,
    );
    expect(cb).not.toHaveBeenCalled();
  },
);
it('issues one-use receipts bound to CI state and freezes before callback reads', async () => {
  const job = await cutoffJob(await root());
  await job.prepare();
  await mkdir(path.join(job.home, 'data'));
  await writeFile(path.join(job.home, 'data/a'), 'bytes');
  job.state.set(JOB_SINGLE_RUN_OWNER_TOKEN_STATE, 'owner');
  await runGuardedCutoffPost(job.deps.runtimeHost, async (pre) => {
    expect(pre.journal?.phase).toBe('observations-frozen');
    await readFile(path.join(job.home, 'data/a'));
    expect(consumeCutoffPreflight(pre, job.deps.runtimeHost.getState)).toBe(pre);
    expect(() => consumeCutoffPreflight(pre, job.deps.runtimeHost.getState)).toThrow(/receipt/);
  });
  const forged = { record: readCutoffLifecycle(job.deps.runtimeHost.getState), journal: null };
  expect(() => consumeCutoffPreflight(forged, job.deps.runtimeHost.getState)).toThrow(/receipt/);
  const real = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  job.state.clear();
  expect(() => consumeCutoffPreflight(real, job.deps.runtimeHost.getState)).toThrow();
});
// Actual delegates now consume streaming ownership, not the retained legacy preflight helper.
it.each([
  { tool: 'gradle', readOnly: false },
  { tool: 'maven', readOnly: false },
  { tool: 'gradle', readOnly: true },
  { tool: 'maven', readOnly: true },
])(
  'built $tool post uses frozen streaming state without config/event reconstruction (readOnly=$readOnly)',
  async ({ tool, readOnly }) => {
    const r = await root();
    await entrypointBundles(r);
    const job = await entrypointJob(r, tool, 'post', {
      'read-only': String(readOnly),
      'cache-partitions': JSON.stringify([{ id: 'data', includes: ['data/**'] }]),
    });
    await job.run('main');
    await job.write('data/a', 'body');
    await job.run('post', {
      GITHUB_EVENT_PATH: '/missing/poison-event',
      'INPUT_CONFIG-FILE': '/missing/poison-config',
    });
    const locator = JSON.parse(await readFile(job.home + '/.mammoth/v1/current.json', 'utf8'));
    const state = JSON.parse(await readFile(job.home + '/' + locator[3], 'utf8'));
    expect(state).toHaveLength(8);
    expect(state.slice(0, 2)).toEqual(['local-state', 2]);
    expect(state[4]).toBe('completed');
    expect(state[7]).toEqual([
      'outcome',
      readOnly ? 'read-only' : 'published',
      readOnly ? null : expect.any(String),
      null,
      null,
    ]);
    expect((await job.trace()).some(([name]) => name === 'cache-save')).toBe(!readOnly);
    await job.clearTrace();
    const skip = await job.run('post', {
      ['STATE_' + JOB_SINGLE_RUN_OWNER_TOKEN_STATE]: '',
      GITHUB_EVENT_PATH: '/missing/poison',
    });
    expect(skip.stdout).toContain('Skipping finalize');
    expect(await job.trace()).toEqual([]);
  },
  30000,
);
