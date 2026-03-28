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

import type { InputProvider } from '../../config/types';
import { getPublicActionInput, type ActionBuildTool } from '../../config/public-contract';

/** Direct GitHub provider inputs that are intentionally excluded from repository config files. */
export interface GitHubPlatformActionInputs {
  readonly githubTokenInput: string;
  readonly githubJobCheckRunId: string;
  readonly githubEventNameInput: string;
  readonly githubJobNameInput: string;
  readonly githubRefNameInput: string;
  readonly githubDefaultBranchInput: string;
}

/** Reads GitHub provider inputs through names validated by the canonical action contract. */
export function readGitHubPlatformActionInputs(
  inputProvider: InputProvider,
  buildTool: ActionBuildTool,
): GitHubPlatformActionInputs {
  const read = (name: string): string =>
    inputProvider.getInput(getPublicActionInput(buildTool, name).name, {
      trimWhitespace: true,
    });

  return {
    githubTokenInput: read('github-token'),
    githubJobCheckRunId: read('github-job-check-run-id'),
    githubEventNameInput: read('github-event-name'),
    githubJobNameInput: read('github-job-name'),
    githubRefNameInput: read('github-ref-name'),
    githubDefaultBranchInput: read('github-default-branch'),
  };
}
