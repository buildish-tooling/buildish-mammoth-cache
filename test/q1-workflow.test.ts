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
        maximumQualificationJobs: 15,
        maximumAllocatedJobMinutes: 430,
      }),
    );
    expect(await gate(config, output)).toBe(false);
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
