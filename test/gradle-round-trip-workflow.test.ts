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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';
import { parse } from 'yaml';

import { OpenedInvocation } from '../src/cache/streaming/invocation';
import { LifecycleHandoff } from '../src/cache/streaming/lifecycle-handoff';
import { prepareStreaming } from '../src/cache/streaming/prepare';
import { composedFixture } from './cache/streaming/composed-fixture';
import { packCacheFiles, unpackCacheFiles } from './support/archive-round-trip';

it('wipes the archived Gradle subtrees while preserving the pending local-v2 post handoff', async () => {
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
    const fixture = await composedFixture({}, undefined, { root: gradleHome }, 'gradle');
    const prepared = await prepareStreaming(fixture.request);
    const pending = await OpenedInvocation.open(prepared.anchor, fixture.budget);
    const state = pending.state;
    expect(state[4]).toBe('build-ready');
    const handoff = state[6]!;
    const invocationRoot = pending.store.root;
    const before = await readFile(invocationRoot.resolve(handoff[2]));
    for (const subtree of ['caches', 'wrapper']) {
      await mkdir(path.join(gradleHome, subtree), { recursive: true });
      await writeFile(path.join(gradleHome, subtree, 'fixture.bin'), subtree);
    }
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
      const reopened = await OpenedInvocation.open(prepared.anchor, fixture.budget);
      expect(reopened.state).toEqual(state);
      expect(await readFile(invocationRoot.resolve(handoff[2]))).toEqual(before);
      const facts = await LifecycleHandoff.read(reopened.store, handoff, {
        budget: fixture.budget,
      });
      expect(facts.header[10]).toBe(prepared.cutoff);
      facts.close();
      expect(fixture.budget.retained).toBe(0);
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
