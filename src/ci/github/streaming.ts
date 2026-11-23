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

import { resolveLifecycle } from '../../build-tool/lifecycle';
import type { StreamingPostDependencies } from '../../phases/streaming/post';
import type { StreamingPrepareDependencies } from '../../phases/streaming/prepare';

// Protocol: docs/dev/cache-lifecycle-protocol.md#provider-composition-and-activation-boundary.
/** Deferred real adapters for the streaming Action composition. No SDK loads at module import. */
export function gitHubStreamingFactories(
  root?: string,
): Pick<StreamingPrepareDependencies, 'cacheBackend' | 'artifactBackend'> &
  Pick<StreamingPostDependencies, 'cacheBackend' | 'removeHooks' | 'loadReport' | 'reportSink'> {
  return {
    cacheBackend: async (operationRoot: string | undefined = root) => {
      const { createGitHubBaseCacheBackend } = await import('./cache');
      return createGitHubBaseCacheBackend(undefined, operationRoot);
    },
    artifactBackend: async () => {
      const { createGitHubWorkflowArtifactBackend } = await import('./artifacts');
      return createGitHubWorkflowArtifactBackend();
    },
    removeHooks: async (root, tool) => {
      return (await resolveLifecycle(tool)).removeKnownHooks(root);
    },
    loadReport: async (tool, tempDirectory) => {
      if (tool !== 'gradle')
        return { anyBuildFailed: false, warnings: [], summaryLines: [], logLines: [], builds: [] };
      const { loadGradleBuildReport, buildReportFromGradleReport } =
        await import('../../build-tool/gradle/build-results');
      return buildReportFromGradleReport(await loadGradleBuildReport({ tempDirectory }));
    },
    reportSink: async () => {
      const { createGitHubReportSink } = await import('./report-sink');
      return createGitHubReportSink({ env: process.env });
    },
  };
}
