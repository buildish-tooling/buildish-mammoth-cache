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

import path from 'node:path';
import type { CacheModel } from '../../src/cache/model';
import type { CiJobContext } from '../../src/ci';
import {
  newCutoffJournal,
  persistCutoffJournal,
  freezeCutoffSelection,
  type CutoffPolicy,
} from '../../src/cache/cutoff-state';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { selectCutoffActivity } from '../../src/cache/cutoff-selection';
export function cutoffFixtureModel(root: string): CacheModel {
  const include = path.join(root, 'data/**');
  return {
    cacheRoot: root,
    cacheFamilyKey: 'family-v4',
    currentRefToken: 'main',
    currentRefLineagePrefix: 'family-v4-ref-main-gen-',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'run-1',
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'layout',
    buildToolId: 'test',
    includePaths: [include],
    hardCacheExcludeGlobs: [],
    excludePaths: [],
    partitions: [
      {
        id: 'data',
        displayName: 'Data',
        description: '',
        relativeIncludeGlobs: ['data/**'],
        relativeExcludeGlobs: [],
        absoluteIncludeGlobs: [include],
        absoluteExcludeGlobs: [],
      },
    ],
  };
}
export function cutoffFixtureCi(root: string, jobName = 'worker'): CiJobContext {
  return {
    repository: 'test/repo',
    workflowName: 'CI',
    jobName,
    runId: 1,
    runAttempt: 1,
    sourceRevision: null,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    defaultBranch: 'main',
    eventName: 'push',
    resolvedRefName: 'main',
    isPullRequest: false,
    tempDirectory: root,
    workspace: root,
    actionPath: null,
  };
}
export const cutoffFixturePolicy: CutoffPolicy = {
  jobMode: 'distributed-worker',
  readOnly: false,
  cleanupEnabled: true,
  cacheGcMode: 'timestamp',
  cacheGcOlderThanDays: 14,
  restoreCleanupMode: 'none',
  dependentJobs: [],
  allowDuplicateDependentDeltaPaths: false,
};
export async function cutoffFixtureState(root: string, cutoff = 0) {
  const model = cutoffFixtureModel(root),
    ci = cutoffFixtureCi(root);
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
  state.cutoff = cutoff;
  state.phase = 'build-ready';
  await persistCutoffJournal(state);
  const snap = await captureCacheMetadataSnapshot(model);
  await freezeCutoffSelection(
    state,
    selectCutoffActivity(snap, cutoff, Date.now(), 14, false),
    Date.now(),
  );
  return { state, model, ci };
}
