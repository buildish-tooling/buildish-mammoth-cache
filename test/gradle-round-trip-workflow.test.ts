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

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  cutoffJournalPath,
  loadCutoffJournal,
  newCutoffJournal,
  persistCutoffJournal,
} from '../src/cache/cutoff-state';
import { snapshotRecord } from '../src/cache/snapshot-lifecycle';
import { readPartitionSnapshot, stagePartitionSnapshot } from '../src/cache/partition-snapshots';
import { packCacheFiles, unpackCacheFiles } from './support/archive-round-trip';
import { cutoffFixtureModel, cutoffFixturePolicy } from './support/cutoff-fixture';

it('wipes the archived Gradle subtrees while preserving the pending post lifecycle and snapshot transport', async () => {
  const workflow = parse(await readFile('.github/workflows/it-reusable-gradle.yml', 'utf8')) as {
    jobs: {
      standalone_round_trip: { steps: { uses?: string; run?: string; with?: { path: string } }[] };
    };
  };
  const steps = workflow.jobs.standalone_round_trip.steps;
  const saveIndex = steps.findIndex((step) => step.uses?.startsWith('actions/cache/save@'));
  expect(saveIndex).toBeGreaterThanOrEqual(0);
  const savedPaths = steps[saveIndex]!.with!.path.trim().split('\n');
  const restore = steps.find((step) => step.uses?.startsWith('actions/cache/restore@'));
  expect(restore?.with?.path.trim().split('\n')).toEqual(savedPaths);
  expect(savedPaths).toEqual(['~/.gradle/caches', '~/.gradle/wrapper']);
  const wipe = steps[saveIndex + 1]!.run;
  expect(wipe).toBeDefined();

  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/gradle-round-trip-'));
  try {
    const home = path.join(root, 'home');
    const gradleHome = path.join(home, '.gradle');
    await mkdir(gradleHome, { recursive: true });
    const initial = cutoffFixtureModel(gradleHome);
    const includePaths = [path.join(gradleHome, 'caches/**')];
    const model = {
      ...initial,
      includePaths,
      partitions: initial.partitions.map((partition) => ({
        ...partition,
        publication: 'single-writer' as const,
        relativeIncludeGlobs: ['caches/**'],
        absoluteIncludeGlobs: includePaths,
      })),
    };
    const journal = newCutoffJournal(
      model,
      { ...cutoffFixturePolicy, jobMode: 'standalone' },
      {
        repository: 'test/repo',
        workflowName: 'CI',
        jobName: 'standalone_round_trip',
        runId: 1,
        runAttempt: 1,
        sourceRevision: null,
      },
    );
    journal.phase = 'build-ready';
    journal.cutoff = Date.now();
    for (const subtree of ['caches', 'wrapper']) {
      await mkdir(path.join(gradleHome, subtree), { recursive: true });
      await writeFile(path.join(gradleHome, subtree, 'fixture.bin'), subtree);
    }
    const source = 'caches/fixture.bin';
    const sourceStat = await stat(path.join(gradleHome, source));
    const snapshot = await stagePartitionSnapshot(model, 'data', gradleHome, [
      {
        relativePath: source,
        sourcePath: source,
        size: sourceStat.size,
        mode: sourceStat.mode & 0o777,
        mtimeMs: Math.trunc(sourceStat.mtimeMs),
      },
    ]);
    journal.partitionSnapshots = [snapshotRecord(snapshot, null, 'seed')];
    await persistCutoffJournal(journal);
    const archive = await packCacheFiles(
      home,
      savedPaths.map((entry) => entry.replace('~/', '')),
      path.join(root, 'archive'),
    );
    execFileSync('bash', ['-euo', 'pipefail', '-c', wipe!], {
      env: { ...process.env, HOME: home },
    });
    for (const subtree of ['caches', 'wrapper']) {
      await expect(readFile(path.join(gradleHome, subtree, 'fixture.bin'))).rejects.toThrow();
    }
    const assertPendingState = async () => {
      expect(await loadCutoffJournal(model, cutoffJournalPath(journal.invocation))).toEqual(
        journal,
      );
      expect(await readPartitionSnapshot(model, 'data')).toEqual(snapshot);
    };
    await assertPendingState();
    await unpackCacheFiles(home, archive);
    for (const subtree of ['caches', 'wrapper']) {
      expect(await readFile(path.join(gradleHome, subtree, 'fixture.bin'), 'utf8')).toBe(subtree);
    }
    await assertPendingState();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
