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
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { mavenFixtureModel, mavenFixtureState } from '../support/maven-cache';
import { cutoffFixtureCi } from '../support/cutoff-fixture';
import { createTestRuntimeHost } from '../support/github-test-runtime';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import { createCacheModel, createCachePartitions } from '../../src/cache/model';
import {
  cutoffModelSchema,
  loadCutoffJournal,
  cutoffJournalPath,
} from '../../src/cache/cutoff-state';
import { parseCachePartitionsInput } from '../../src/config/shared';

const policy = 'choose-worker-directory' as const;
const input = (partitions: unknown[]) => ({ 'cache-partitions': JSON.stringify(partitions) });

it('preserves literal default fingerprints and persisted partition shapes', async () => {
  const original = await mavenFixtureModel('/cache');
  const explicit = await mavenFixtureModel(
    '/cache',
    input([{ id: 'repository', 'conflict-handling': 'default' }]),
  );
  expect(original.partitionFingerprint).toBe('0a94673ddf6ac6cb');
  expect(explicit).toEqual(original);
  const ci = cutoffFixtureCi('/cache');
  const config = normalizeGradleActionConfig(
    readGradleActionInputs(createTestRuntimeHost({ inputs: {} })),
    { phase: 'prepare', ciContext: ci, env: { GRADLE_USER_HOME: '/cache' } },
  );
  const gradle = await createCacheModel(config, ci, new GradleBuildToolAdapter(config));
  expect(gradle.partitionFingerprint).toBe('26b980584b0bb24e');
  const noPurgeConfig = {
      ...config,
      cachePartitions: gradle.partitions.map(({ id }) => ({ id, purgeableGlobs: [] })),
    },
    noPurge = await createCacheModel(noPurgeConfig, ci, new GradleBuildToolAdapter(noPurgeConfig));
  expect(noPurge.partitionFingerprint).toBe('691842db2b4a565e');
  for (const model of [original, explicit, gradle, noPurge]) {
    expect(cutoffModelSchema.parse(model)).toEqual(model);
    for (const partition of model.partitions)
      if (
        partition.id === 'groovy-dsl' ||
        partition.id === 'kotlin-dsl' ||
        partition.id === 'transforms-metadata'
      )
        expect(partition.conflictHandling).toBe('choose-worker-directory');
      else if (partition.id === 'build-cache')
        expect(partition.conflictHandling).toBe('choose-worker-entry');
      else expect(partition).not.toHaveProperty('conflictHandling');
  }
});

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
  expect(createCachePartitions('/cache', [], [preset])[0]?.conflictHandling).toBe(policy);
  expect(
    createCachePartitions(
      '/cache',
      [{ id: 'repository', conflictHandling: 'default' }],
      [preset],
    )[0],
  ).not.toHaveProperty('conflictHandling');
});

it.each([null, 12, [], {}, 'newest'])('rejects invalid conflict-handling %j', (value) => {
  expect(() =>
    parseCachePartitionsInput(JSON.stringify([{ id: 'repository', 'conflict-handling': value }])),
  ).toThrow(/conflict-handling/);
});

it('isolates opt-in families and validates persisted policy constraints', async () => {
  const strict = await mavenFixtureModel('/cache');
  const model = await mavenFixtureModel(
    '/cache',
    input([{ id: 'repository', 'conflict-handling': policy }]),
  );
  expect(model.partitionFingerprint).not.toBe(strict.partitionFingerprint);
  expect(model.cacheFamilyKey).not.toBe(strict.cacheFamilyKey);
  expect(model.partitions[0]?.conflictHandling).toBe(policy);
  expect(cutoffModelSchema.parse(model)).toEqual(model);
  expect(() => cutoffModelSchema.parse({ ...model, buildToolId: 'gradle' })).toThrow(
    /aggregate Maven/,
  );
  for (const change of [
    { publication: 'single-writer' },
    { conflictHandling: 'newest' },
    { relativeIncludeGlobs: ['wrapper/**'], absoluteIncludeGlobs: ['/cache/wrapper/**'] },
  ]) {
    expect(() =>
      cutoffModelSchema.parse({
        ...model,
        partitions: model.partitions.map((p, i) => (i === 0 ? { ...p, ...change } : p)),
      }),
    ).toThrow();
  }
});

it('rejects unsupported configured partitions and Gradle usage', async () => {
  for (const partition of [
    { id: 'repository', publication: 'single-writer' },
    { id: 'wrapper-dists' },
    { id: 'custom', includes: ['repository/**', 'wrapper/**'] },
  ])
    await expect(
      mavenFixtureModel('/cache', input([{ ...partition, 'conflict-handling': policy }])),
    ).rejects.toThrow(/aggregate Maven/);
  const ci = cutoffFixtureCi('/cache');
  const config = normalizeGradleActionConfig(
    readGradleActionInputs(
      createTestRuntimeHost({
        inputs: input([{ id: 'custom', includes: ['repository/**'], 'conflict-handling': policy }]),
      }),
    ),
    { phase: 'prepare', ciContext: ci, env: {} },
  );
  await expect(createCacheModel(config, ci, new GradleBuildToolAdapter(config))).rejects.toThrow(
    /aggregate Maven/,
  );
});

it('persists and reloads the effective opt-in policy in a real journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'partition-policy-'));
  try {
    const { state, model } = await mavenFixtureState(
      root,
      'worker',
      input([{ id: 'repository', 'conflict-handling': policy }]),
    );
    expect(await loadCutoffJournal(model, cutoffJournalPath(state.invocation))).toEqual(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('limits per-entry selection to aggregate Gradle build-cache prefixes and preserves strict overrides', async () => {
  const ci = cutoffFixtureCi('/cache');
  const modelFor = async (partitions: object[]) => {
    const config = normalizeGradleActionConfig(
      readGradleActionInputs(createTestRuntimeHost({ inputs: input(partitions) })),
      { phase: 'prepare', ciContext: ci, env: { GRADLE_USER_HOME: '/cache' } },
    );
    return createCacheModel(config, ci, new GradleBuildToolAdapter(config));
  };
  for (const includes of [['caches/build-cache-*/**'], ['caches/build-cache-1/**']]) {
    const model = await modelFor([
      { id: 'custom', includes, 'conflict-handling': 'choose-worker-entry' },
    ]);
    expect(cutoffModelSchema.parse(model)).toEqual(model);
    expect(model.cacheFamilyKey).toContain('-v8-');
    expect(
      model.fallbackRefLineagePrefixes.every((p) => p.includes('-v8-') && !p.includes('-v7-')),
    ).toBe(true);
  }
  for (const definition of [
    { id: 'custom', includes: ['caches/**'] },
    { id: 'custom', includes: ['caches/build-cache-*/**', 'other/**'] },
    { id: 'build-cache', publication: 'single-writer' },
  ])
    await expect(
      modelFor([{ ...definition, 'conflict-handling': 'choose-worker-entry' }]),
    ).rejects.toThrow(/conflict policy/);
  const defaults = await modelFor([]),
    strict = await modelFor([
      { id: 'kotlin-dsl', 'conflict-handling': 'default' },
      { id: 'build-cache', 'conflict-handling': 'default' },
    ]);
  expect(defaults.cacheFamilyKey).not.toBe(strict.cacheFamilyKey);
  for (const id of ['kotlin-dsl', 'build-cache'])
    expect(strict.partitions.find((p) => p.id === id)).not.toHaveProperty('conflictHandling');
});
