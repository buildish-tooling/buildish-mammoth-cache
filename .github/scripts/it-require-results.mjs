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
import process from 'node:process';

const [workflow] = process.argv.slice(2);
const env = process.env;
const results = JSON.parse(env.IT_SCENARIO_RESULTS);
const selected = new Map();

if (workflow === 'ci') {
  assert(['pull_request', 'push'].includes(env.GITHUB_EVENT_NAME));
  const pr = env.GITHUB_EVENT_NAME === 'pull_request';
  for (const job of [
    'archive-consumer',
    'check',
    'smoke-test-gradle',
    'smoke-test-maven',
    'local-integration-tests',
  ])
    selected.set(job, true);
  selected.set('codeql', false);
  selected.set('zizmor', env.GITHUB_REPOSITORY_OWNER === 'buildish-tooling');
  for (const tool of ['gradle', 'maven']) {
    selected.set(`integration-pr-${tool}`, pr);
    selected.set(`integration-trusted-${tool}`, !pr);
  }
} else {
  assert(['gradle', 'maven'].includes(workflow));
  const writable = env.IT_RUN_WRITABLE === 'true';
  const pr = env.IT_RUN_PR === 'true';
  const native = env.IT_RUN_NATIVE === 'true';
  assert(writable !== pr && (!native || writable), 'Unexpected lifecycle routing');
  for (const job of [
    'standalone_round_trip',
    'standalone_reader',
    'workers',
    'aggregator',
    'warm',
    'change',
    'changed_reader',
    'duplicate_invocation_guard',
  ])
    selected.set(job, writable);
  selected.set('standalone_cross_platform', native);
  selected.set('pull_request_worker', pr);
  selected.set('pull_request_read_only', pr);
}

const prefix = workflow === 'maven' ? 'maven_' : '';
for (const [job, enabled] of selected) {
  const expected = enabled ? 'success' : 'skipped';
  assert.equal(
    results[prefix + job]?.result,
    expected,
    `Expected ${prefix + job} to be ${expected}`,
  );
}
process.stdout.write('All selected jobs succeeded and inactive jobs were skipped.\n');
