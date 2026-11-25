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
import { expect, it } from 'vitest';
import { createCachePartitions } from '../../src/cache/model';
import { resolveCacheModel } from '../../src/cache/streaming/model';
import { parseCachePartitionsInput } from '../../src/config/shared';
import { MavenBuildToolAdapter } from '../../src/build-tool/maven/adapter';
import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
} from '../../src/build-tool/maven/config';
import { fixtureCi } from '../support/ci-fixture';

const policy = 'choose-worker-directory' as const;
function model(tool: 'gradle' | 'maven', entries: unknown[]) {
  const inputs = JSON.stringify(entries);
  const config = normalizeMavenActionConfig(
    readMavenActionInputs({
      getInput: (key) => (key === 'cache-partitions' ? inputs : ''),
    }),
    { phase: 'prepare', ciContext: fixtureCi('/cache'), env: { MAVEN_USER_HOME: '/cache' } },
  );
  const adapter = new MavenBuildToolAdapter(config);
  const hardCacheExcludeGlobs = adapter.getHardCacheExcludeGlobs();
  return resolveCacheModel(
    {
      buildToolId: tool,
      hardCacheExcludeGlobs,
      partitions: createCachePartitions(
        parseCachePartitionsInput(inputs),
        adapter.getBuiltInPartitionPresets(),
        hardCacheExcludeGlobs,
      ),
    },
    'policy-',
    8,
  );
}

it('inherits preset policy and lets explicit default clear it', () => {
  const preset = {
    id: 'repository',
    displayName: 'Repository',
    description: '',
    defaultEnabled: true,
    relativeIncludeGlobs: ['repository/**'],
    relativeExcludeGlobs: [],
    conflictHandling: policy,
  };
  expect(createCachePartitions([], [preset])[0]?.conflictHandling).toBe(policy);
  expect(
    createCachePartitions([{ id: 'repository', conflictHandling: 'default' }], [preset])[0],
  ).not.toHaveProperty('conflictHandling');
});

it.each([null, 12, [], {}, 'newest'])('rejects invalid conflict-handling %j', (value) => {
  expect(() =>
    parseCachePartitionsInput(JSON.stringify([{ id: 'repository', 'conflict-handling': value }])),
  ).toThrow(/conflict-handling/);
});

it('uses the same family for explicit default and separates explicit directory selection', () => {
  const strict = model('maven', []);
  expect(model('maven', [{ id: 'repository', 'conflict-handling': 'default' }]).family).toBe(
    strict.family,
  );
  const options = [{ id: 'repository', 'conflict-handling': policy }];
  const chosen = model('maven', options);
  expect(chosen.family).not.toBe(strict.family);
  expect(chosen.partitions[0][5]).toBe(policy);
  expect(() => model('gradle', options)).toThrow(/aggregate Maven/u);
  for (const override of [{ publication: 'single-writer' }, { includes: ['wrapper/**'] }]) {
    expect(() => model('maven', [{ ...options[0], ...override }])).toThrow();
  }
});
