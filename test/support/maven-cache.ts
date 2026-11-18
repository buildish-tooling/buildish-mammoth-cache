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
import { MavenBuildToolAdapter } from '../../src/build-tool/maven/adapter';
import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
} from '../../src/build-tool/maven/config';
import { createCacheModel } from '../../src/cache/model';
import { cutoffFixtureCi, cutoffFixturePolicy } from './cutoff-fixture';
import { createTestRuntimeHost } from './github-test-runtime';
import {
  newCutoffJournal,
  persistCutoffJournal,
  freezeCutoffSelection,
} from '../../src/cache/cutoff-state';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';

export async function mavenFixtureModel(root: string, inputs: Record<string, string> = {}) {
  const ci = cutoffFixtureCi(root);
  const config = normalizeMavenActionConfig(
    readMavenActionInputs(createTestRuntimeHost({ inputs })),
    {
      phase: 'prepare',
      ciContext: ci,
      env: { MAVEN_USER_HOME: root },
    },
  );
  return createCacheModel(config, ci, new MavenBuildToolAdapter(config), {
    captureCommandOutput: async () => 'openjdk version "21.0.12"',
    env: {},
  });
}

export async function mavenFixtureState(
  root: string,
  job = 'worker',
  inputs: Record<string, string> = {},
) {
  const model = await mavenFixtureModel(root, inputs),
    ci = cutoffFixtureCi(root, job);
  const state = newCutoffJournal(
    model,
    { ...cutoffFixturePolicy },
    {
      repository: ci.repository,
      workflowName: ci.workflowName,
      jobName: ci.jobName,
      runId: ci.runId,
      runAttempt: ci.runAttempt,
      sourceRevision: null,
    },
  );
  state.phase = 'build-ready';
  state.cutoff = 0;
  await persistCutoffJournal(state);
  const snapshot = await captureCacheMetadataSnapshot(model);
  await freezeCutoffSelection(
    state,
    selectCutoffActivity(snapshot, 0, Date.now(), 14, false),
    Date.now(),
  );
  return { model, ci, state };
}
