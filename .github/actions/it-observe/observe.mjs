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
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as core from '@actions/core';
import artifacts from '@actions/artifact';
import { assertDependency } from '../../scripts/it-cache-dependencies.mjs';
import {
  cacheHome,
  completion,
  evidenceLimit,
  execution,
  producerEvidence,
  readBounded,
  verifyChanged,
} from './evidence.mjs';

const state = core.getState('observer');
if (!state) {
  core.setOutput('attempt', process.env.GITHUB_RUN_ATTEMPT);
  core.saveState('observer', {
    tool: core.getInput('tool', { required: true }),
    job: core.getInput('job', { required: true }),
    stage: core.getInput('stage', { required: true }),
    producerAttempt: core.getInput('producer-attempt'),
  });
} else {
  await observe(JSON.parse(state));
}

async function observe({ tool, job, stage, producerAttempt }) {
  const identity = execution(tool, job);
  const home = cacheHome(tool);
  const expected = {
    seed: 'published',
    worker: 'worker-uploaded',
    aggregator: identity.attempt === 1 ? 'published' : ['published', 'no-change'],
    warm: 'no-change',
    change: 'published',
    reader: 'read-only',
    changed: 'read-only',
    pr: 'read-only',
  }[stage];
  assert(expected, 'Unknown lifecycle stage');
  const evidence = await completion(
    home,
    expected,
    undefined,
    ['change', 'reader', 'changed'].includes(stage),
    identity,
  );
  if (['worker', 'aggregator', 'warm', 'change'].includes(stage)) {
    const worker = stage === 'worker' ? 'worker_' + job.at(-1) : 'worker_a';
    const source = path.join(home, 'it-portability', worker, '-leading-dash.txt');
    const bytes = worker + '\nleading hyphen\n' + (stage === 'change' ? 'changed\n' : '');
    assert.equal(await readBounded(source, 256), bytes, 'Post did not return fixture source');
    await assertDependency(tool, home, worker);
  }
  if (stage === 'seed') await assertDependency(tool, home, 'standalone');
  if (stage === 'changed') {
    assert(producerAttempt, 'Missing change producer attempt');
    const changed = await producerEvidence(tool, 'change', producerAttempt);
    assert(changed.prior, 'Change evidence lacks original generation');
    verifyChanged(changed.prior, changed, evidence, 'it-portability');
  }
  const { outcome, key, receipt } = evidence;
  const summary = { execution: identity, stage, outcome, key, receipt };
  await core.summary
    .addHeading('Mammoth lifecycle evidence', 2)
    .addCodeBlock(JSON.stringify(summary, null, 2), 'json')
    .write();

  if (['seed', 'aggregator', 'change'].includes(stage)) {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Evidence uploads require a trusted push');
    const record = JSON.stringify({ version: 1, ...summary, prior: evidence.prior });
    assert(Buffer.byteLength(record) <= evidenceLimit);
    const dir = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'mammoth-it-receipt-'));
    try {
      const file = path.join(dir, 'evidence.json');
      await writeFile(file, record);
      const name = `mammoth-it-${tool}-${job}-a${identity.attempt}`;
      const result = await artifacts.uploadArtifact(name, [file], dir, { retentionDays: 7 });
      assert(Number.isSafeInteger(result.id) && result.id > 0, 'Unconfirmed evidence upload');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
