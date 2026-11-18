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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
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
it.each([
  { tool: 'gradle', readOnly: false },
  { tool: 'maven', readOnly: false },
  { tool: 'gradle', readOnly: true },
  { tool: 'maven', readOnly: true },
])(
  'built $tool post validates before SDK event reads (readOnly=$readOnly) and skips missing ownership',
  async ({ tool, readOnly }) => {
    const r = await root(),
      job = await cutoffJob(r, { inputs: { 'read-only': String(readOnly) } });
    await job.prepare();
    const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
    if (!record.cacheEnabled) throw new Error('enabled');
    const out = path.join(r, 'post.cjs'),
      trace = path.join(r, 'trace.cjs'),
      event = path.join(job.home, 'data/event.json');
    await mkdir(path.dirname(event));
    await writeFile(event, '{}');
    await build({
      entryPoints: [`src/ci/github/${tool}/post.ts`],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      alias: {
        '@azure/storage-common': path.resolve(
          'node_modules/@azure/storage-common/dist/commonjs/index.js',
        ),
      },
      outfile: out,
      logLevel: 'silent',
    });
    const journal = path.join(
      job.home,
      '.mammoth/cutoff-state-v2',
      `journal-${record.invocation}.json`,
    );
    await writeFile(
      trace,
      String.raw`
    const fs=require('node:fs'); const original=fs.readFileSync;
    fs.readFileSync=function(p,...args){
      if(String(p)===process.env.GITHUB_EVENT_PATH){
        const j=JSON.parse(original(process.env.TEST_JOURNAL,'utf8'));
        if(j.phase!==process.env.TEST_EXPECT_PHASE) throw new Error('EARLY_EVENT_READ');
        process.stdout.write('EVENT_AFTER_FREEZE\n'); throw new Error('STOP_AFTER_EVENT');
      }
      return original.call(this,p,...args);
    };
  `,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_EVENT_PATH: event,
      TEST_JOURNAL: journal,
      TEST_EXPECT_PHASE: readOnly ? 'build-ready' : 'observations-frozen',
    };
    for (const [key, value] of job.state) env[`STATE_${key}`] = value;
    env[`STATE_${JOB_SINGLE_RUN_OWNER_TOKEN_STATE}`] = 'owner';
    const result = await promisify(execFile)(process.execPath, ['--require', trace, out], {
      env,
    }).catch((e) => e);
    expect(result.stdout + result.stderr).toContain('EVENT_AFTER_FREEZE');
    expect(result.stdout + result.stderr).not.toContain('EARLY_EVENT_READ');
    delete env[`STATE_${JOB_SINGLE_RUN_OWNER_TOKEN_STATE}`];
    const skip = await promisify(execFile)(process.execPath, ['--require', trace, out], { env });
    expect(skip.stdout).toContain('Skipping finalize');
    expect(skip.stdout).not.toContain('EVENT_AFTER_FREEZE');
  },
  30000,
);
