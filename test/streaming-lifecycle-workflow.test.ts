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

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  id?: string;
  run?: string;
  if?: string;
};
type Job = {
  needs?: string[];
  steps: Step[];
  if?: string;
  outputs?: Record<string, string>;
  'timeout-minutes': number;
};
const workflow = async (tool: string) =>
  parse(await readFile(`.github/workflows/it-reusable-${tool}.yml`, 'utf8')).jobs as Record<
    string,
    Job
  >;

it.each(['gradle', 'maven'])(
  '%s checks real post and exact producer dependencies',
  async (tool) => {
    const jobs = await workflow(tool);
    const prefix = tool === 'maven' ? 'maven_' : '';
    for (const [jobId, job] of Object.entries(jobs)) {
      if (jobId.endsWith('duplicate_invocation_guard') || jobId === 'required_lifecycle') continue;
      const observe = job.steps.findIndex((step) => step.uses?.endsWith('/it-observe'));
      const action = job.steps.findIndex((step) => step.uses === `./actions/github/${tool}`);
      expect(observe).toBeGreaterThanOrEqual(0);
      expect(action).toBeGreaterThan(observe);
      expect(job.steps[observe]!.with!.job).toBe(job.steps[action]!.with!['github-job-name']);
      expect(
        job.steps.slice(0, action).some((step) => step.run?.includes('fixture.mjs empty')),
      ).toBe(true);
      expect(job.steps.some((step) => step.uses?.startsWith('actions/cache'))).toBe(false);
      expect(job['timeout-minutes']).toBe(20);
      if (jobId.includes('pull_request')) {
        expect(job.if).toBe('inputs.run-pr-scenarios');
        expect(job.steps[observe]!.with!.stage).toBe('pr');
        expect(job.steps[action]!.with!['read-only']).toBeUndefined();
      }
    }

    for (const [reader, producer] of [
      ['standalone_reader', 'standalone_round_trip'],
      ['standalone_cross_platform', 'aggregator'],
      ['warm', 'aggregator'],
      ['change', 'aggregator'],
      ['changed_reader', 'change'],
    ]) {
      const readerJob = jobs[prefix + reader]!;
      const producerJob = jobs[prefix + producer]!;
      expect(readerJob.needs).toContain(prefix + producer);
      expect(producerJob.outputs?.attempt).toBe('${{ steps.observer.outputs.attempt }}');
      const receipt = readerJob.steps.find((step) => step.uses?.endsWith('/it-restore-proof'));
      expect(receipt?.with?.attempt).toBe('${{ needs.' + prefix + producer + '.outputs.attempt }}');
      expect(receipt?.with?.prepare).toBe('${{ toJSON(steps.prepare.outputs) }}');
      const restore = readerJob.steps.find((step) => step.id === 'prepare')!;
      expect(receipt?.with?.['read-only']).toBe(String(restore.with?.['read-only'] === true));
      if (reader.includes('reader') || reader === 'standalone_cross_platform') {
        expect(readerJob.steps.some((step) => step.run?.includes('--offline'))).toBe(true);
      }
    }

    const prepare = (id: string) =>
      jobs[prefix + id]!.steps.find((step) => step.id === 'prepare')!.with!;
    expect(jobs[prefix + 'change']!.needs).toContain(prefix + 'warm');
    expect(prepare('change')['github-default-branch']).toBe(
      prepare('aggregator')['github-ref-name'],
    );
    expect(prepare('change')['github-ref-name']).toContain('github.run_attempt');
    expect(prepare('changed_reader')['github-ref-name']).toContain(
      `needs.${prefix}change.outputs.attempt`,
    );
    for (const id of ['warm', 'change', 'changed_reader']) {
      expect(prepare(id)['cache-key-prefix']).toBe(prepare('aggregator')['cache-key-prefix']);
      expect(prepare(id)['cache-partitions']).toBe(prepare('aggregator')['cache-partitions']);
    }
    expect(prepare('standalone_reader')['cache-key-prefix']).toContain(
      `needs.${prefix}standalone_round_trip.outputs.attempt`,
    );
    expect(jobs.required_lifecycle?.needs?.sort()).toEqual(
      Object.keys(jobs)
        .filter((name) => name !== 'required_lifecycle')
        .sort(),
    );
    expect(jobs.required_lifecycle?.if).toBe('always()');
  },
);

it.each([
  ['gradle', true, false, true],
  ['maven', true, false, false],
  ['maven', false, true, false],
] as const)(
  'rejects skipped or failed selected jobs in %s (%s/%s/%s)',
  async (tool, writable, pr, native) => {
    const jobs = await workflow(tool);
    const names = jobs.required_lifecycle!.needs!;
    const results = Object.fromEntries(
      names.map((name) => [
        name,
        {
          result: (
            name.includes('pull_request')
              ? pr
              : name.endsWith('standalone_cross_platform')
                ? native
                : writable
          )
            ? 'success'
            : 'skipped',
        },
      ]),
    );
    const run = () =>
      spawnSync(process.execPath, ['.github/scripts/it-require-results.mjs', tool], {
        env: {
          ...process.env,
          IT_SCENARIO_RESULTS: JSON.stringify(results),
          IT_RUN_WRITABLE: String(writable),
          IT_RUN_PR: String(pr),
          IT_RUN_NATIVE: String(native),
        },
        encoding: 'utf8',
      });
    expect(run().status).toBe(0);
    for (const name of names) {
      const result = results[name]!;
      const original = result.result;
      result.result = original === 'success' ? 'skipped' : 'success';
      expect(run().stderr).toContain(`Expected ${name} to be ${original}`);
      result.result = 'failure';
      expect(run().status).toBe(1);
      result.result = original;
    }
  },
);

it.each([
  ['pull_request', 'snazy'],
  ['push', 'buildish-tooling'],
])('requires the correct top-level integration checks for %s in %s', async (event, owner) => {
  const jobs = parse(await readFile('.github/workflows/ci.yml', 'utf8')).jobs;
  const names = jobs.required_checks.needs as string[];
  const pr = event === 'pull_request';
  const results = Object.fromEntries(
    names.map((name) => [
      name,
      {
        result:
          name === 'codeql' ||
          (name === 'zizmor' && owner !== 'buildish-tooling') ||
          (name.startsWith('integration-pr') && !pr) ||
          (name.startsWith('integration-trusted') && pr)
            ? 'skipped'
            : 'success',
      },
    ]),
  );
  const run = () =>
    spawnSync(process.execPath, ['.github/scripts/it-require-results.mjs', 'ci'], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY_OWNER: owner,
        IT_SCENARIO_RESULTS: JSON.stringify(results),
      },
      encoding: 'utf8',
    });
  expect(run().status).toBe(0);
  for (const name of [
    'archive-consumer',
    'local-integration-tests',
    `integration-${pr ? 'pr' : 'trusted'}-gradle`,
  ]) {
    results[name]!.result = 'skipped';
    expect(run().stderr).toContain(`Expected ${name} to be success`);
    results[name]!.result = 'success';
  }
});

it('requires the intended producer identity and generation before running the fixture', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/it-evidence-'));
  try {
    const directory = path.join(root, 'mammoth-it-evidence');
    await mkdir(directory);
    const key = 'mammoth-g-' + 'a'.repeat(64) + '-d-' + 'b'.repeat(64);
    const execution = {
      repository: 'example/repo',
      revision: 'c'.repeat(40),
      run: '123',
      attempt: 1,
      tool: 'gradle',
      job: 'aggregator',
    };
    const record = { version: 1, execution, outcome: 'published', key };
    const write = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(record));
    const prepare = {
      'base-cache-restore-status': 'fallback-lineage-hit',
      'dependent-delta-artifact-count': '0',
      'dependent-delta-status': 'not-configured',
      'job-mode': 'standalone',
      'read-only': 'false',
      'restored-cache-key': key,
    };
    const run = () =>
      spawnSync(
        process.execPath,
        ['.github/scripts/it-cache-fixture.mjs', 'exact', 'gradle', 'aggregator'],
        {
          env: {
            ...process.env,
            GITHUB_REPOSITORY: 'example/repo',
            GITHUB_SHA: 'c'.repeat(40),
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '2',
            IT_PRODUCER_ATTEMPT: '1',
            IT_EXPECTED_RESTORE: 'fallback-lineage-hit',
            IT_EXPECTED_READ_ONLY: 'false',
            IT_PREPARE: JSON.stringify(prepare),
            RUNNER_TEMP: root,
          },
          encoding: 'utf8',
        },
      );
    await write();
    expect(run().status).toBe(0);
    prepare['restored-cache-key'] += '-differs';
    expect(run().stderr).toContain('Restored a different generation');
    prepare['restored-cache-key'] = key;
    prepare['base-cache-restore-status'] = 'fallback-lineage-partial-hit';
    expect(run().status).toBe(1);
    prepare['base-cache-restore-status'] = 'fallback-lineage-hit';
    execution.attempt = 2;
    await write();
    expect(run().stderr).toContain('Wrong producer identity');
    execution.attempt = 1;
    record.outcome = 'skipped-not-quiescent';
    await write();
    expect(run().stderr).toContain('Producer did not confirm publication');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('observes the invocation bound to this job and rejects unsuccessful automatic post', async () => {
  await mkdir('build', { recursive: true });
  const home = await mkdtemp(path.resolve('build/it-observer-'));
  try {
    const invocation = 'a'.repeat(64);
    const directory = '.mammoth/v1/' + invocation;
    const parent = path.join(home, directory);
    await mkdir(parent, { recursive: true });
    const put = (relative: string, value: unknown) =>
      writeFile(path.join(home, relative), JSON.stringify(value));
    const repo = 'example/repo';
    const workflow = 'CI';
    const job = 'pull_request_worker';
    const sha = 'b'.repeat(40);
    const bindings = directory + '/bindings.json';
    const state = directory + '/state.json';
    const summary = path.join(home, 'summary.md');
    const store = (phase: string, outcome: string) =>
      put(state, [
        'local-state',
        2,
        invocation,
        null,
        phase,
        ['ref', 'bindings', bindings, 0, 'digest'],
        null,
        ['outcome', outcome, null, null, null],
      ]);

    await put('.mammoth/v1/current.json', ['current', 1, invocation, state]);
    await put(bindings, [
      'bindings',
      2,
      invocation,
      ['github', repo, workflow, '123', job, 2, sha, 'gradle'],
    ]);
    const run = () =>
      spawnSync(process.execPath, ['.github/actions/it-observe/observe.mjs'], {
        env: {
          ...process.env,
          STATE_observer: JSON.stringify({ tool: 'gradle', job, stage: 'pr' }),
          GITHUB_REPOSITORY: repo,
          GITHUB_SHA: sha,
          GITHUB_WORKFLOW: workflow,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_STEP_SUMMARY: summary,
          GRADLE_USER_HOME: home,
        },
        encoding: 'utf8',
      });
    await writeFile(summary, '');
    await store('completed', 'read-only');
    expect(run().status).toBe(0);
    expect(await readFile(summary, 'utf8')).toContain('"outcome": "read-only"');
    await store('completed', 'skipped-not-quiescent');
    expect(run().stderr).toContain('Unexpected completion outcome: skipped-not-quiescent');
    await store('build-ready', 'read-only');
    expect(run().status).toBe(1);
    await store('completed', 'read-only');
    await put(bindings, [
      'bindings',
      2,
      invocation,
      ['github', repo, workflow, '123', job, 1, sha, 'gradle'],
    ]);
    expect(run().status).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
