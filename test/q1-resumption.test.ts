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
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
import { campaignBudget, scaleProfile, admitWork } from '../scripts/qualification/campaign.mjs';
import { gate } from '../scripts/qualification/gate.mjs';
import { lifecycle, withPhaseProgress, invocation } from '../scripts/qualification/invocation.mjs';
import { diagnosticFailure } from '../scripts/qualification/darwin-diagnostic.mjs';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function workflow(file = 'q1') {
  return parse(readFileSync('.github/workflows/' + file + '.yml', 'utf8'));
}
function selected(
  message: string,
  options: {
    repository?: string;
    branch?: string;
    cancelled?: boolean;
    worker?: string;
    aggregator?: string;
    file?: string;
  } = {},
) {
  return Object.entries(workflow(options.file).jobs)
    .filter(([, value]) => {
      const job = value as { if: string };
      return runInNewContext(job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
        github: {
          repository: options.repository ?? 'snazy/buildish-mammoth-cache',
          ref: options.branch ?? 'refs/heads/cache-metadata-redesign',
          event: { head_commit: { message } },
        },
        needs: {
          worker: { result: options.worker ?? 'success' },
          aggregator: { result: options.aggregator ?? 'success' },
          consumer: { result: 'success' },
          parity: { result: 'success' },
        },
        cancelled: () => options.cancelled ?? false,
        always: () => true,
        contains: (a: string, b: string) => a.includes(b),
      });
    })
    .map(([name]) => name);
}
it('selects exactly one17-minute scale job or nine20-minute graph jobs', () => {
  expect(selected('[Q1 resume-scale]')).toEqual(['scale']);
  expect(selected('[Q1 resume-graph]')).toEqual(['worker', 'aggregator', 'consumer']);
  const w = workflow();
  for (const [route, names] of [
    ['resume-scale', ['scale']],
    ['resume-graph', ['worker', 'aggregator', 'consumer']],
  ] as const) {
    let jobs = 0,
      minutes = 0;
    for (const name of names) {
      const j = w.jobs[name],
        n = j.strategy?.matrix.include.length ?? 1;
      jobs += n;
      minutes += n * j['timeout-minutes'];
    }
    expect([jobs, minutes]).toEqual(campaignBudget(route));
  }
  expect(w.jobs.scale.runs_on ?? w.jobs.scale['runs-on']).toBe('ubuntu-26.04');
  expect(
    w.jobs.scale.steps.find((s: { with?: { stage?: string } }) => s.with?.stage === 'scale')[
      'timeout-minutes'
    ],
  ).toBe(15);
  expect(w.permissions).toEqual({ contents: 'read' });
  expect(w.concurrency['cancel-in-progress']).toBe(false);
  expect(w.on).toEqual({
    push: { branches: ['cache-metadata-redesign'], paths: ['.github/q1-campaign.json'] },
  });
});
it('rejects mixed/legacy/ordinary markers, wrong scope/cancellation and failed graph dependencies', () => {
  for (const text of [
    '',
    'ordinary',
    '[Q1 campaign]',
    '[Q1 remaining]',
    '[Q1 resume-scale] [Q1 resume-graph]',
    '[Q1 resume-scale] [Q1 campaign]',
    '[Q1 resume-graph] [Q1 remaining]',
  ])
    expect(selected(text)).toEqual([]);
  for (const marker of ['[Q1 resume-scale]', '[Q1 resume-graph]']) {
    expect(selected(marker, { repository: 'buildish-tooling/buildish-mammoth-cache' })).toEqual([]);
    expect(selected(marker, { branch: 'refs/heads/main' })).toEqual([]);
    expect(selected(marker, { cancelled: true })).toEqual([]);
  }
  expect(selected('[Q1 resume-graph]', { worker: 'failure', aggregator: 'skipped' })).toEqual([
    'worker',
  ]);
  expect(selected('[Q1 resume-graph]', { aggregator: 'failure' })).toEqual([
    'worker',
    'aggregator',
  ]);
});
it('keeps every setup/build/diagnostic/exercise behind the disabled gate', async () => {
  const dir = await mkdtemp(path.resolve('build/q1-resume-gate-'));
  roots.push(dir);
  const file = path.join(dir, 'config'),
    out = path.join(dir, 'output');
  const config = {
    enabled: false,
    route: 'resume-scale',
    retainedCounts: [100000],
    reservationMiB: 2048,
    maximumQualificationJobs: 1,
    maximumAllocatedJobMinutes: 17,
  };
  await writeFile(file, JSON.stringify(config));
  expect(await gate(file, out, 'resume-scale')).toBe(false);
  expect(await readFile(out, 'utf8')).toBe('enabled=false\n');
  for (const j of Object.values(workflow().jobs) as { steps: { id?: string; if?: string }[] }[]) {
    const at = j.steps.findIndex((s) => s.id === 'campaign');
    expect(at).toBe(1);
    for (const step of j.steps.slice(at + 1))
      expect(step.if).toContain("steps.campaign.outputs.enabled == 'true'");
  }
  await writeFile(file, JSON.stringify({ ...config, maximumQualificationJobs: 9 }));
  await expect(gate(file, out, 'resume-scale')).rejects.toThrow();
  await writeFile(file, JSON.stringify({ ...config, retainedCounts: [1000000] }));
  await expect(gate(file, out, 'resume-scale')).rejects.toThrow();
});
it('admits only Linux100k Maven and rejects another lifecycle/body at the deadline while post still runs', async () => {
  const c = { route: 'resume-scale', retainedCounts: [100000], reservationMiB: 2048 };
  expect(scaleProfile(c, 'linux')).toEqual({
    counts: [100000],
    tools: ['maven'],
    workloadMs: 600000,
  });
  expect(() => scaleProfile(c, 'windows')).toThrow();
  expect(() => scaleProfile({ ...c, retainedCounts: [1000000] }, 'linux')).toThrow();
  const calls: string[] = [];
  await expect(
    lifecycle(
      {
        phase: async (name) => {
          calls.push(name);
        },
      },
      async () => {
        admitWork(10, 10);
      },
    ),
  ).rejects.toThrow('admission deadline');
  expect(calls).toEqual(['main', 'post']);
  expect(() => admitWork(10, 11)).toThrow();
  expect(() => admitWork(10, 9)).not.toThrow();
});
it.each([0, 2])(
  'collects bounded exit telemetry for child exit%i without env/argv or bundle modification',
  async (code) => {
    const dir = await mkdtemp(path.resolve('build/q1-resume-metrics-'));
    roots.push(dir);
    const out = path.join(dir, 'metrics.json'),
      program = path.join(dir, 'program.cjs'),
      bytes = 'process.exitCode=' + code + ';';
    await writeFile(program, bytes);
    const child = spawn(
      process.execPath,
      [
        '--require',
        path.resolve('scripts/qualification/child-metrics.cjs'),
        program,
        'TEST_ARGV_SENTINEL',
      ],
      {
        env: { ...process.env, Q1_NODE_METRICS: out, TEST_VALUE: 'TEST_ENV_SENTINEL' },
        stdio: 'ignore',
      },
    );
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exit).toBe(code);
    const raw = await readFile(out, 'utf8'),
      metrics = JSON.parse(raw);
    expect(metrics.exitCode).toBe(code);
    expect(metrics.resourceUsage.userCPUTime).toBeGreaterThan(0);
    expect(metrics.memoryUsageAtExit.rss).toBeGreaterThan(0);
    expect(raw.length).toBeLessThan(16384);
    expect(raw).not.toContain('TEST_ENV_SENTINEL');
    expect(raw).not.toContain('TEST_ARGV_SENTINEL');
    expect(await readFile(program, 'utf8')).toBe(bytes);
  },
);
it('maps only fixed process-parser classifications, never exception text or process data', () => {
  expect(diagnosticFailure(new Error('Malformed process table record.'))).toBe('malformed-record');
  expect(diagnosticFailure(new Error('TEST_SECRET_SENTINEL argv=/private/path'))).toBe(
    'unclassified-parser-error',
  );
});

it('still settles product post when its initial progress write fails, and preserves both errors', async () => {
  for (const failedWrite of [1, 2])
    for (const postFails of [false, true]) {
      let postWrites = 0;
      const calls: string[] = [];
      const persistenceError = new Error('progress storage unavailable');
      const productError = new Error('product post failed');
      let caught: unknown;
      try {
        await lifecycle(
          { phase: async () => {} },
          async () => {},
          (name) =>
            withPhaseProgress(
              name,
              async () => {
                if (name === 'post' && ++postWrites === failedWrite) throw persistenceError;
              },
              async () => {
                calls.push(name);
                await Promise.resolve();
                if (name === 'post') {
                  calls.push('post-settled');
                  if (postFails) throw productError;
                }
              },
            ),
        );
      } catch (error) {
        caught = error;
      }
      expect(calls).toEqual(['main', 'post', 'post-settled']);
      if (postFails)
        expect((caught as AggregateError).errors).toEqual(
          failedWrite === 1 ? [persistenceError, productError] : [productError, persistenceError],
        );
      else expect(caught).toBe(persistenceError);
    }
});

it('preserves a failed child together with malformed exit telemetry after child settlement', async () => {
  const dir = await mkdtemp(path.resolve('build/q1-resume-bad-metrics-'));
  roots.push(dir);
  const bundleRoot = path.join(dir, 'bundles');
  const bundle = path.join(bundleRoot, 'github/maven/main');
  await mkdir(bundle, { recursive: true });
  await writeFile(
    path.join(bundle, 'index.cjs'),
    "require('node:fs').writeFileSync(process.env.Q1_NODE_METRICS, '{'); process.exitCode=2;",
  );
  const job = await invocation(dir, 'maven', 'bad-telemetry', {}, bundleRoot);
  let caught: unknown;
  try {
    await job.phase('main');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const failures = (caught as AggregateError).errors;
  expect(failures[0].message).toContain('Qualification child failed');
  expect(failures[1]).toBeInstanceOf(SyntaxError);
});
