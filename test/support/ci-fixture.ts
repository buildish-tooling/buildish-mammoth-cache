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

import type { CiJobContext } from '../../src/ci';

export function fixtureCi(root: string, jobName = 'worker'): CiJobContext {
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
