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
export { completion, verifyReuse } from '../../../.github/actions/it-observe/evidence.mjs';

export const platforms = ['linux', 'windows', 'macos'];

export function admit(env, system) {
  assert.equal(env.GITHUB_REPOSITORY, 'snazy/buildish-mammoth-cache');
  assert.equal(env.GITHUB_REF, 'refs/heads/cache-metadata-redesign');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Only fresh whole-graph runs are admitted');
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/u);
  assert.equal(env.MAMMOTH_GRAPH_REVISION, env.GITHUB_SHA);
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u);
  assert(['worker', 'aggregator', 'consumer'].includes(env.INPUT_STAGE));
  assert.equal({ linux: 'linux', win32: 'windows', darwin: 'macos' }[system], env.INPUT_PLATFORM);
  assert(platforms.includes(env.INPUT_PLATFORM));
  return {
    stage: env.INPUT_STAGE,
    platform: env.INPUT_PLATFORM,
    run: env.GITHUB_RUN_ID,
    revision: env.GITHUB_SHA,
  };
}
