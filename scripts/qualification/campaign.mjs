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
import { performance } from 'node:perf_hooks';
const budgets = {
  full: [15, 430],
  remaining: [4, 210],
  'resume-scale': [1, 17],
  'resume-graph': [9, 180],
};
export function campaignBudget(route) {
  assert(Object.hasOwn(budgets, route), 'Unknown qualification route');
  return [...budgets[route]];
}
export function scaleProfile(config, platform) {
  assert.equal(config.reservationMiB, 2048);
  if (config.route === 'resume-scale') {
    assert.equal(platform, 'linux');
    assert.deepEqual(config.retainedCounts, [100000]);
    return { counts: [100000], tools: ['maven'], workloadMs: 10 * 60 * 1000 };
  }
  assert(['full', 'remaining'].includes(config.route));
  assert.deepEqual(config.retainedCounts, [100000, 1000000]);
  return {
    counts: [...config.retainedCounts],
    tools: ['maven', 'gradle'],
    workloadMs: 50 * 60 * 1000,
  };
}
export function admitWork(deadline, now = performance.now()) {
  assert(
    Number.isFinite(deadline) && now < deadline,
    'Qualification workload admission deadline reached',
  );
}
