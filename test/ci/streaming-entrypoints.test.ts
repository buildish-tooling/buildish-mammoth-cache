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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { entrypointBundles, entrypointJob } from '../support/streaming-entrypoint';
import { STREAMING_INVOCATION_STATE } from '../../src/phases/streaming/state';
import {
  JOB_SINGLE_RUN_OWNER_TOKEN_STATE,
  JOB_SINGLE_RUN_DUPLICATE_STATE,
} from '../../src/guard/job-single-run';
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.resolve('build/entrypoints-'));
  await entrypointBundles(root);
}, 30000);
afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});
const toolInputs = { 'cache-partitions': JSON.stringify([{ id: 'data', includes: ['data/**'] }]) };
it.each(['maven', 'gradle'] as const)(
  'actual %s main/post keeps normalized outputs, streaming handoff, summaries and one owner',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'standalone', toolInputs);
    await j.run('main');
    expect((await j.state())[STREAMING_INVOCATION_STATE]).toContain('streaming-lifecycle');
    expect((await j.state())[JOB_SINGLE_RUN_OWNER_TOKEN_STATE]).toBeTruthy();
    if (tool === 'gradle') {
      expect(await j.outputs()).toMatchObject({
        'wrapper-count': '1',
        'gradle-versions': '8.5',
        'wrapper-reused-count': '1',
      });
    }
    expect(await j.outputs()).toMatchObject({
      'base-cache-restore-status': 'miss',
      'job-mode': 'standalone',
      'read-only': 'false',
    });
    expect(await readFile(j.job + '/summary', 'utf8')).toContain('Mammoth cache prepare');
    await j.write('data/a', 'body');
    await j.run('post');
    expect((await j.trace()).filter(([name]) => name === 'process-inspection')).toHaveLength(
      tool === 'gradle' ? 2 : 0,
    );
    expect((await j.trace()).some(([name]) => name === 'cache-save')).toBe(true);
    expect(await readFile(j.home + '/data/a', 'utf8')).toBe('body');
    expect(await readFile(j.job + '/summary', 'utf8')).toContain('Mammoth cache post');
    await expect(j.run('main')).rejects.toThrow();
    expect((await j.state())[JOB_SINGLE_RUN_DUPLICATE_STATE]).toBe('true');
  },
  30000,
);
it.each(['maven', 'gradle'] as const)(
  'actual %s disabled and read-only preserve useful summaries without post inspection or upload work',
  async (tool) => {
    for (const mode of ['disabled', 'read-only']) {
      const j = await entrypointJob(root, tool, mode, {
        ...toolInputs,
        ...(mode === 'disabled' ? { 'cache-enabled': 'false' } : { 'read-only': 'true' }),
      });
      if (mode === 'disabled') {
        await j.write('data/keep', 'keep');
      }
      await j.run('main', { MAMMOTH_TEST_PROCESS: mode === 'disabled' ? 'remaining' : 'clean' });
      expect((await j.trace()).filter(([name]) => name === 'process-inspection')).toHaveLength(
        tool === 'gradle' && mode === 'read-only' ? 1 : 0,
      );
      await j.clearTrace();
      if (mode === 'read-only') {
        await j.write('data/keep', 'keep');
      }
      await j.run('post', {
        'INPUT_CONFIG-FILE': '/missing/config',
        GITHUB_EVENT_PATH: '/missing/event.json',
      });
      expect(
        (await j.trace()).filter(([name]) =>
          ['process-inspection', 'cache-save', 'artifact-upload'].includes(name),
        ),
      ).toEqual([]);
      expect(await readFile(j.job + '/summary', 'utf8')).toContain('Mammoth cache post');
      expect(await readFile(j.home + '/data/keep', 'utf8')).toBe('keep');
    }
  },
  30000,
);
it.each(['maven', 'gradle'] as const)(
  'actual built %s post guards missing/duplicate ownership before poisoned config/event/SDK',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'guard', toolInputs);
    for (const mode of ['missing', 'duplicate']) {
      const result = await j.run('post', {
        ['STATE_' + JOB_SINGLE_RUN_OWNER_TOKEN_STATE]: mode === 'missing' ? '' : 'owner',
        ['STATE_' + JOB_SINGLE_RUN_DUPLICATE_STATE]: mode === 'duplicate' ? 'true' : '',
        GITHUB_EVENT_PATH: '/missing/poison.json',
        'INPUT_CONFIG-FILE': '/missing/poison.yaml',
        ['STATE_' + STREAMING_INVOCATION_STATE]: 'poison',
      });
      expect(result.stdout).toContain('Skipping finalize');
      expect(await j.trace()).toEqual([]);
    }
    await expect(
      j.run('post', {
        ['STATE_' + JOB_SINGLE_RUN_OWNER_TOKEN_STATE]: 'owner',
        ['STATE_' + STREAMING_INVOCATION_STATE]: '',
      }),
    ).rejects.toThrow();
  },
);
it.each(['remaining', 'uncertain'] as const)(
  'actual Gradle controller denies %s evidence before capture/purge/save',
  async (evidence) => {
    const j = await entrypointJob(root, 'gradle', 'denied', toolInputs);
    await j.run('main');
    await j.write('data/body', 'untouched');
    await j.clearTrace();
    const result = await j.run('post', { MAMMOTH_TEST_PROCESS: evidence });
    expect(result.stdout).toContain('Cache save skipped');
    expect((await j.trace()).some(([name]) => name === 'process-inspection')).toBe(true);
    expect((await j.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
    expect(await readFile(j.home + '/data/body', 'utf8')).toBe('untouched');
  },
  20000,
);
