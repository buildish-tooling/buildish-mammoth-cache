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

import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { gate } from '../scripts/qualification/gate.mjs';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
it('keeps Q1 execution deliberate and in the real fork push scope with non-cancelling ownership', () => {
  const workflow = parse(readFileSync('.github/workflows/q1.yml', 'utf8'));
  expect(Object.keys(workflow.on)).toEqual(['push']);
  expect(workflow.on.push).toEqual({
    branches: ['cache-metadata-redesign'],
    paths: ['.github/q1-campaign.json'],
  });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  let jobs = 0,
    minutes = 0;
  for (const job of Object.values(workflow.jobs) as {
    strategy?: { matrix: { include?: unknown[]; tool?: unknown[] } };
    'timeout-minutes': number;
  }[]) {
    const count = job.strategy?.matrix.include?.length ?? job.strategy?.matrix.tool?.length ?? 1;
    jobs += count;
    minutes += count * job['timeout-minutes'];
  }
  expect(jobs).toBe(15);
  expect(minutes).toBe(430);
  for (const job of Object.values(workflow.jobs)) {
    const condition = String((job as { if: string }).if);
    expect(condition).toContain("github.repository == 'snazy/buildish-mammoth-cache'");
    expect(condition).toContain('[Q1 campaign]');
  }
});
it('uses a CI JavaScript Action for real SDK context without registering another post', () => {
  const action = parse(readFileSync('.github/actions/q1/action.yml', 'utf8'));
  expect(action.runs).toEqual({ using: 'node24', main: '../../../scripts/qualification/run.mjs' });
});

it('a disabled campaign emits false before every tool/action/build even with a deliberate commit marker', async () => {
  const root = await mkdtemp(path.resolve('build/q1-gate-'));
  try {
    const config = path.join(root, 'case.json'),
      output = path.join(root, 'output');
    await writeFile(
      config,
      JSON.stringify({
        enabled: false,
        route: 'full',
        maximumQualificationJobs: 15,
        maximumAllocatedJobMinutes: 430,
      }),
    );
    expect(await gate(config, output, 'full')).toBe(false);
    expect(await readFile(output, 'utf8')).toBe('enabled=false\n');
    const workflow = parse(readFileSync('.github/workflows/q1.yml', 'utf8'));
    for (const job of Object.values(workflow.jobs)) {
      const steps = (job as { steps: { id?: string; if?: string }[] }).steps;
      const marker = steps.findIndex((s) => s.id === 'campaign');
      expect(marker).toBeGreaterThan(0);
      for (const step of steps.slice(marker + 1))
        expect(step.if).toContain("steps.campaign.outputs.enabled == 'true'");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('selects only the four independent remaining jobs and rejects mixed markers', () => {
  const w = parse(readFileSync('.github/workflows/q1.yml', 'utf8'));
  const select = (
    message: string,
    repository = 'snazy/buildish-mammoth-cache',
    cancelled = false,
  ) =>
    Object.entries(w.jobs)
      .filter(([, job]) =>
        runInNewContext((job as { if: string }).if, {
          github: { repository, event: { head_commit: { message } } },
          needs: { consumer: { result: 'failure' }, parity: { result: 'failure' } },
          always: () => true,
          cancelled: () => cancelled,
          contains: (a: string, b: string) => a.includes(b),
        }),
      )
      .map(([name]) => name);
  expect(select('[Q1 remaining]')).toEqual(['scale', 'diagnostic']);
  expect(select('[Q1 remaining] [Q1 campaign]')).toEqual([]);
  expect(select('ordinary change')).toEqual([]);
  expect(select('[Q1 remaining]', 'unrelated/repository')).toEqual([]);
  expect(select('[Q1 remaining]', 'snazy/buildish-mammoth-cache', true)).toEqual([]);
  const jobs = select('[Q1 remaining]').map((name) => w.jobs[name]);
  expect(jobs.reduce((n, j) => n + (j.strategy?.matrix.include.length ?? 1), 0)).toBe(4);
  expect(
    jobs.reduce((n, j) => n + (j.strategy?.matrix.include.length ?? 1) * j['timeout-minutes'], 0),
  ).toBe(210);
});

it('admits only a matching explicit remaining route and its bounded allocation', async () => {
  const root = await mkdtemp(path.resolve('build/q1-remaining-gate-'));
  try {
    const file = path.join(root, 'config'),
      output = path.join(root, 'output');
    const config = {
      enabled: true,
      route: 'remaining',
      maximumQualificationJobs: 4,
      maximumAllocatedJobMinutes: 210,
    };
    await writeFile(file, JSON.stringify(config));
    expect(await gate(file, output, 'remaining')).toBe(true);
    await expect(gate(file, output, 'full')).rejects.toThrow('route mismatch');
    await writeFile(file, JSON.stringify({ ...config, maximumQualificationJobs: 15 }));
    await expect(gate(file, output, 'remaining')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
