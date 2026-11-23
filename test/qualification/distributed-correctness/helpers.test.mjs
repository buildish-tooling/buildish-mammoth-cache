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

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { parse } from 'yaml';
import { admit, completion, verifyReuse } from './evidence.mjs';
import { buildArgs, commandEnv, fileCommands, lifecycle, postState } from './invocation.mjs';

test('the outside-discovery recipe uses a guarded Node 24 Action and bounded dependencies', async () => {
  const recipe = parse(await readFile(new URL('./workflow.yml', import.meta.url), 'utf8'));
  const action = parse(await readFile(new URL('./action.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(recipe.on), ['workflow_dispatch']);
  assert.deepEqual(action.runs, { using: 'node24', main: 'run.mjs' });
  assert.equal(recipe.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(recipe.jobs), ['worker', 'aggregator', 'consumer']);
  for (const [stage, job] of Object.entries(recipe.jobs)) {
    assert.match(job.if, /^\$\{\{ false && !cancelled\(\)/u);
    assert.match(job.if, /github\.run_attempt == 1/u);
    assert.match(job.if, /github\.sha == inputs\.reviewed-revision/u);
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.strategy.matrix.include.length, 3);
    assert.equal(job['timeout-minutes'], 20);
    const step = job.steps.find(
      (step) => step.uses === './test/qualification/distributed-correctness',
    );
    assert.equal(step.with.stage, stage);
    assert.equal(step['timeout-minutes'], 15);
  }
  assert.equal(recipe.jobs.aggregator.needs, 'worker');
  assert.equal(recipe.jobs.consumer.needs, 'aggregator');
});

test('only the admitted fresh run, revision and runner platform can execute', () => {
  const revision = 'a'.repeat(40);
  const env = {
    GITHUB_REPOSITORY: 'snazy/buildish-mammoth-cache',
    GITHUB_REF: 'refs/heads/cache-metadata-redesign',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: revision,
    MAMMOTH_GRAPH_REVISION: revision,
    INPUT_STAGE: 'aggregator',
    INPUT_PLATFORM: 'linux',
  };
  assert.deepEqual(admit(env, 'linux'), {
    stage: 'aggregator',
    platform: 'linux',
    run: '123',
    revision,
  });
  for (const patch of [
    { GITHUB_RUN_ATTEMPT: '5' },
    { GITHUB_REPOSITORY: 'somewhere/fork' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_EVENT_NAME: 'push' },
    { MAMMOTH_GRAPH_REVISION: 'b'.repeat(40) },
    { INPUT_PLATFORM: 'windows' },
  ])
    assert.throws(() => admit({ ...env, ...patch }, 'linux'));
});

test('command files preserve multiline state and real service environment without inherited injection', () => {
  assert.deepEqual(postState(fileCommands('owner<<END\r\na=b\r\nc\r\nEND\r\nfixed=yes\r\n')), {
    STATE_owner: 'a=b\nc',
    STATE_fixed: 'yes',
  });
  assert.throws(() => fileCommands('owner<<END\na'), /Unterminated/u);
  assert.deepEqual(
    commandEnv({
      INPUT_STAGE: 'worker',
      STATE_owner: 'old',
      NODE_PATH: 'unexpected',
      Node_Options: '--require unwanted',
      ACTIONS_RUNTIME_TOKEN: 'stub',
      GITHUB_RUN_ID: '123',
    }),
    { ACTIONS_RUNTIME_TOKEN: 'stub', GITHUB_RUN_ID: '123' },
  );
});

test('failed preparation and failed build still settle post, preserving both errors', async () => {
  for (const failed of ['main', 'body']) {
    const calls = [];
    const job = {
      async phase(phase) {
        calls.push(phase);
        if (phase === failed || phase === 'post') throw new Error(phase);
        return { prepared: true };
      },
    };
    await assert.rejects(
      lifecycle(job, async (result) => {
        assert.deepEqual(result, { prepared: true });
        calls.push('body');
        throw new Error('body');
      }),
      (error) => {
        assert.deepEqual(
          error.errors.map((item) => item.message),
          [failed, 'post'],
        );
        return true;
      },
    );
    assert.deepEqual(calls, failed === 'main' ? ['main', 'post'] : ['main', 'body', 'post']);
  }
});

test('Gradle Linux owns complete metadata while other workers contribute independent tasks', () => {
  const tasks = (stage, platform) =>
    buildArgs('gradle', stage, platform, '/home').filter((arg) => arg.startsWith('resolveWorker'));
  const all = ['resolveWorkerA', 'resolveWorkerB', 'resolveWorkerC'];
  assert.deepEqual(tasks('worker', 'linux'), all);
  assert.deepEqual(tasks('worker', 'windows'), ['resolveWorkerB']);
  assert.deepEqual(tasks('worker', 'macos'), ['resolveWorkerC']);
  assert.deepEqual(tasks('aggregator', 'macos'), all);
  assert.deepEqual(tasks('consumer', 'windows'), all);
  for (const tool of ['gradle', 'maven']) {
    assert(buildArgs(tool, 'aggregator', 'linux', '/home').includes('--offline'));
    assert(buildArgs(tool, 'consumer', 'linux', '/home').includes('--offline'));
    assert(!buildArgs(tool, 'worker', 'linux', '/home').includes('--offline'));
  }
});

test('positive outcomes bind a current-lineage reader to its owned generation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'dc-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '1'.repeat(64),
    dir = '.mammoth/v1/' + id;
  const [state, handoff, record] = ['state.json', 'handoff', 'record.json'].map(
    (file) => dir + '/' + file,
  );
  const put = (file, value) => writeFile(path.join(root, file), JSON.stringify(value));
  await mkdir(path.join(root, dir), { recursive: true });
  await put('.mammoth/v1/current.json', ['current', 1, id, state]);
  const ref = (purpose, name) => ['ref', purpose, name, 1, 'digest'];
  const terminal = (row) =>
    put(state, ['local-state', 2, id, 0, 'completed', null, ref('handoff', handoff), row]);
  await terminal(['outcome', 'abandoned', null, null, null]);
  await assert.rejects(completion(root, 'published'));
  await terminal(['outcome', 'worker-uploaded', null, 0, 'receipt']);
  await assert.rejects(completion(root, 'worker-uploaded'));
  await terminal(['outcome', 'worker-uploaded', null, 12, 'receipt']);
  assert.deepEqual(await completion(root, 'worker-uploaded'), {
    outcome: 'worker-uploaded',
    receipt: { id: 12, name: 'receipt' },
  });
  await terminal(['outcome', 'published', 'generation-key', null, null]);
  assert.equal((await completion(root, 'published')).key, 'generation-key');
  await terminal(['outcome', 'read-only', null, null, null]);
  const prepare = {
    'base-cache-restore-status': 'current-lineage-hit',
    'restored-cache-key': 'generation-key',
  };
  const header = [
    'handoff',
    2,
    null,
    null,
    null,
    null,
    null,
    null,
    ['generation-key', ref('generation', record)],
  ];
  const writeHandoff = async (invocation = id) =>
    writeFile(
      path.join(root, handoff),
      [
        ['local-stream', 1, 'handoff', invocation, 'model', 'family', null],
        header,
        ['local-end', 1, 'digest'],
      ]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
    );
  await writeHandoff();
  const entries = [['object', 'q-proof', ['object-ref', 'proof']]];
  await put(record, [
    'generation',
    2,
    'generation-v2',
    null,
    null,
    null,
    null,
    null,
    entries,
    null,
    null,
    'generation-key',
  ]);
  assert.deepEqual(await completion(root, 'read-only', prepare), {
    outcome: 'read-only',
    key: 'generation-key',
    entries,
  });
  await assert.rejects(
    completion(root, 'read-only', { ...prepare, 'restored-cache-key': 'other-key' }),
  );
  await assert.rejects(
    completion(root, 'read-only', {
      ...prepare,
      'base-cache-restore-status': 'fallback-lineage-hit',
    }),
  );
  await writeHandoff('2'.repeat(64));
  await assert.rejects(completion(root, 'read-only', prepare));
  header[8][1][2] = dir + '/../outside.json';
  await writeHandoff();
  await assert.rejects(completion(root, 'read-only', prepare));
});

test('reuse requires exact keys, changed proof reference and surviving unaffected objects', () => {
  const unchanged = ['object', 'q-snapshot', ['object-ref', 'snapshot']];
  const initial = {
    key: 'original',
    entries: [['object', 'q-proof', ['object-ref', 'old']], unchanged],
  };
  const warm = { key: 'original' },
    published = { key: 'changed' };
  const reader = {
    key: 'changed',
    entries: [['object', 'q-proof', ['object-ref', 'new']], unchanged],
  };
  verifyReuse(initial, warm, published, reader);
  assert.throws(() => verifyReuse(initial, published, published, reader), /Warm generation/u);
  assert.throws(() => verifyReuse(initial, warm, published, initial), /Fresh reader/u);
  assert.throws(
    () => verifyReuse(initial, warm, published, { ...reader, entries: initial.entries }),
    /Changed partition/u,
  );
  assert.throws(
    () =>
      verifyReuse(initial, warm, published, {
        ...reader,
        entries: [reader.entries[0], ['empty', 'q-snapshot']],
      }),
    /Unchanged partition/u,
  );
  assert.throws(
    () =>
      verifyReuse({ ...initial, entries: initial.entries.slice(0, 1) }, warm, published, {
        ...reader,
        entries: reader.entries.slice(0, 1),
      }),
    /No non-empty/u,
  );
});
