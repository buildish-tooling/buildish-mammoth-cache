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
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { readCutoffLifecycle } from '../../src/phases/cutoff-lifecycle';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { cutoffJob } from './cutoff-job';
import { CutoffArtifacts } from './cutoff-artifacts';
import { ImmutableCacheBackend } from './immutable-cache-backend';

export async function gradleCacheJobs(prefix: string, overrides: object[] = []) {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/' + prefix));
  const backend = new ImmutableCacheBackend(path.join(root, 'archives'));
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  async function job(name: string, mode = 'standalone', dependencies = '') {
    const j = await cutoffJob(path.join(root, name), {
      name,
      cacheBackend: backend,
      artifactBackend: artifacts,
      inputs: {
        'job-mode': mode,
        'dependent-jobs': dependencies,
        'cache-gc-mode': 'off',
        'cache-partitions': JSON.stringify(overrides),
      },
    });
    const gradle = new GradleBuildToolAdapter(
      normalizeGradleActionConfig(readGradleActionInputs(j.deps.runtimeHost), {
        phase: 'prepare',
        ciContext: j.ci,
        env: { GRADLE_USER_HOME: j.home },
      }),
    );
    j.adapter.getBuildToolId = () => 'gradle';
    j.adapter.getBuiltInPartitionPresets = () =>
      gradle
        .getBuiltInPartitionPresets()
        .filter((p) => ['transforms-metadata', 'build-cache'].includes(p.id));
    j.adapter.getHardCacheExcludeGlobs = () => gradle.getHardCacheExcludeGlobs();
    return j;
  }
  return { root, backend, artifacts, job };
}
export async function snapshotGradleJob(
  j: Awaited<ReturnType<Awaited<ReturnType<typeof gradleCacheJobs>>['job']>>,
) {
  const state = readCutoffLifecycle(j.deps.runtimeHost.getState);
  if (!state.cacheEnabled) throw new Error('Expected active Gradle cache');
  return captureCacheMetadataSnapshot(state.model);
}
