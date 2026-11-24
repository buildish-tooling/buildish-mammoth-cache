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
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { entrypointBundles, entrypointJob } from '../support/streaming-entrypoint';
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.resolve('build/entry-scenarios-'));
  await entrypointBundles(root);
}, 30000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const inputs = { 'cache-partitions': JSON.stringify([{ id: 'data', includes: ['data/**'] }]) };
it.each(['maven', 'gradle'] as const)(
  'actual %s delegates restore current/default lineage and identify missing partitions',
  async (tool) => {
    const cold = await entrypointJob(root, tool, 'cold', inputs);
    await cold.run('main');
    await cold.write('data/a', 'saved');
    await cold.run('post');
    for (const ref of ['main', 'feature']) {
      const warm = await entrypointJob(
        root,
        tool,
        'warm-' + ref,
        { ...inputs, 'github-ref-name': ref },
        cold.store,
      );
      await warm.run('main');
      expect((await warm.outputs())['base-cache-restore-status']).toBe(
        ref === 'main' ? 'current-lineage-hit' : 'fallback-lineage-hit',
      );
      expect(await readFile(warm.home + '/data/a', 'utf8')).toBe('saved');
      expect((await warm.outputs())['restored-cache-key']).toBeTruthy();
    }
    const files = await readdir(cold.store + '/cache');
    for (const file of files.filter((file) => file.endsWith('.json'))) {
      const value = JSON.parse(await readFile(cold.store + '/cache/' + file, 'utf8'));
      if (value.key.includes('-p-data-')) await rm(cold.store + '/cache/' + file);
    }
    const partial = await entrypointJob(root, tool, 'partial', inputs, cold.store);
    await partial.run('main');
    expect((await partial.outputs())['base-cache-restore-status']).toBe(
      'current-lineage-partial-hit',
    );
    await expect(readFile(partial.home + '/data/a')).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
it.each(['maven', 'gradle'] as const)(
  'actual %s workers merge once in B,A order and only A supplies its complete snapshot',
  async (tool) => {
    const partition = {
      'cache-partitions': JSON.stringify([
        { id: 'data', includes: ['data/**'] },
        { id: 'snapshot', includes: ['snapshot/**'], publication: 'single-writer', writer: 'A' },
      ]),
    };
    const a = await entrypointJob(root, tool, 'A', {
      ...partition,
      'job-mode': 'distributed-worker',
    });
    await a.run('main');
    await a.write('data/a', 'A');
    await a.write('snapshot/value', 'A');
    await a.run('post');
    const b = await entrypointJob(
      root,
      tool,
      'B',
      { ...partition, 'job-mode': 'distributed-worker' },
      a.store,
    );
    await b.run('main');
    await b.write('data/b', 'B');
    await b.write('snapshot/value', 'must-not-win');
    await b.run('post');
    const aggregator = await entrypointJob(
      root,
      tool,
      'aggregate',
      { ...partition, 'job-mode': 'distributed-aggregator', 'dependent-jobs': 'B,A,B' },
      a.store,
    );
    await aggregator.run('main');
    expect(await aggregator.outputs()).toMatchObject({
      'dependent-delta-status': 'applied',
      'dependent-delta-artifact-count': '2',
    });
    expect(
      (await aggregator.trace())
        .filter(([name]) => name === 'artifact-download')
        .map(([, id]) => id),
    ).toEqual([2, 1]);
    for (const [file, body] of Object.entries({
      'data/a': 'A',
      'data/b': 'B',
      'snapshot/value': 'A',
    }))
      expect(await readFile(aggregator.home + '/' + file, 'utf8')).toBe(body);
    await aggregator.run('post');
    const consumer = await entrypointJob(root, tool, 'consumer', partition, a.store);
    await consumer.run('main');
    expect(await readFile(consumer.home + '/snapshot/value', 'utf8')).toBe('A');
    expect((await a.trace()).filter(([name]) => name === 'process-inspection')).toHaveLength(
      tool === 'gradle' ? 1 : 0,
    );
    expect((await b.trace()).filter(([name]) => name === 'process-inspection')).toHaveLength(
      tool === 'gradle' ? 1 : 0,
    );
  },
  40000,
);
it.each(['maven', 'gradle'] as const)(
  'actual %s unavailable status and config/direct-input precedence use normal normalization',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'config', {
      ...inputs,
      'config-file': 'cache.json',
      'read-only': 'true',
    });
    await writeFile(
      j.workspace + '/cache.json',
      JSON.stringify({ 'cache-enabled': true, 'read-only': false }),
    );
    await j.run('main', { MAMMOTH_TEST_UNAVAILABLE: '1' });
    expect(await j.outputs()).toMatchObject({
      'read-only': 'true',
      'base-cache-restore-status': 'feature-unavailable',
    });
    await j.run('post', {
      'INPUT_CONFIG-FILE': '/poison/new-config',
      GITHUB_EVENT_PATH: '/poison/new-event',
    });
    expect((await j.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
  },
);
it.each(['maven', 'gradle'] as const)(
  'actual %s owning failed prepare keeps failure state without report/publication',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'failed', inputs);
    await expect(j.run('main', { MAMMOTH_TEST_FAIL_RESTORE: '1' })).rejects.toThrow(
      'Fixture restore failed',
    );
    await j.clearTrace();
    await writeFile(j.job + '/summary', '');
    await j.run('post');
    const locator = JSON.parse(await readFile(j.home + '/.mammoth/v1/current.json', 'utf8')),
      state = JSON.parse(await readFile(j.home + '/' + locator[3], 'utf8'));
    expect(state[4]).toBe('prepare-failed');
    expect(await readFile(j.job + '/summary', 'utf8')).toBe('');
    expect((await j.trace()).filter(([name]) => name !== 'native-work')).toEqual([]);
  },
);
it.each(['maven', 'gradle'] as const)(
  'actual %s enabled/disabled main rejects unfinished legacy intent before provisioning',
  async (tool) => {
    for (const enabled of ['true', 'false']) {
      const j = await entrypointJob(root, tool, 'legacy-' + enabled, {
        ...inputs,
        'cache-enabled': enabled,
      });
      await j.write('.mammoth/restore-move-v1.json', 'preserve');
      await expect(j.run('main')).rejects.toThrow('legacy destructive intent');
      expect(await readFile(j.home + '/.mammoth/restore-move-v1.json', 'utf8')).toBe('preserve');
      expect((await j.trace()).filter(([name]) => name !== 'native-work')).toEqual([]);
    }
  },
);
it.each(['maven', 'gradle'] as const)(
  'new opposite-tool disabled delegate rejects interrupted OLD %s sources before provisioning',
  async (oldTool) => {
    const old = await entrypointJob(root, oldTool, 'old', inputs);
    await old.run('main');
    await old.write('data/body', 'owned');
    await expect(old.run('post', { MAMMOTH_TEST_EXIT_SAVE: '1' })).rejects.toThrow();
    await expect(readFile(old.home + '/data/body')).rejects.toMatchObject({ code: 'ENOENT' });
    const tool = oldTool === 'maven' ? 'gradle' : 'maven',
      next = await entrypointJob(root, tool, 'next', { 'cache-enabled': 'false' });
    await expect(
      next.run('main', { GRADLE_USER_HOME: old.home, MAVEN_USER_HOME: old.home }),
    ).rejects.toThrow('fresh dedicated root');
    await expect(readFile(old.home + '/data/body')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await next.trace()).filter(([name]) => name !== 'native-work')).toEqual([]);
    const locator = JSON.parse(await readFile(old.home + '/.mammoth/v1/current.json', 'utf8')),
      state = JSON.parse(await readFile(old.home + '/' + locator[3], 'utf8'));
    expect(state[7]).toBeNull();
  },
  30000,
);
it('counts real delegated metadata work across shared directories without multiplying setup', async () => {
  const costs: Record<string, number>[] = [];
  for (const width of [4, 16]) {
    const j = await entrypointJob(root, 'maven', 'cost', inputs);
    await j.run('main');
    await j.clearTrace();
    for (let n = 0; n < width; n++) await j.write('data/shared/f' + n, 'body');
    await j.run('post');
    const work = (await j.trace()).find(([name]) => name === 'native-work')?.[1] as Record<
      string,
      number
    >;
    expect(work.stats).toBeGreaterThan(0);
    expect(work.opens).toBeGreaterThan(0);
    costs.push({ width, ...work });
  }
  expect(costs[1].stats).toBeLessThan(costs[0].stats * 4);
  expect(costs[1].opens).toBeLessThan(costs[0].opens * 4);
  process.stdout.write('V7_DELEGATE_COST ' + JSON.stringify(costs) + '\n');
}, 30000);

it.each(['maven', 'gradle'] as const)(
  'actual %s warns once for unavailable standalone and abandoned aggregation saves',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'unavailable-writable', inputs),
      unavailable = { MAMMOTH_TEST_UNAVAILABLE: '1' };
    await j.run('main', unavailable);
    expect((await j.outputs())['base-cache-restore-status']).toBe('feature-unavailable');
    await j.write('data/a', 'preserve');
    const post = await j.run('post', unavailable);
    expect(post.stdout).toContain('Cache save skipped: cache backend is unavailable.');
    expect(post.stdout.match(/::warning::Cache save skipped/g)).toHaveLength(1);
    expect(await readFile(j.home + '/data/a', 'utf8')).toBe('preserve');
    expect((await j.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
    const locator = JSON.parse(await readFile(j.home + '/.mammoth/v1/current.json', 'utf8')),
      state = JSON.parse(await readFile(j.home + '/' + locator[3], 'utf8'));
    expect(state[4]).toBe('completed');
    expect(state[7][1]).toBe('feature-unavailable');
    expect(state).toHaveLength(8);
    expect(state[7].slice(2)).toEqual([null, null, null]);
    expect(await readFile(j.job + '/summary', 'utf8')).toContain('Outcome: feature-unavailable.');
    await j.run('post');
    expect((await j.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
    const required = await entrypointJob(root, tool, 'required-unavailable', {
      ...inputs,
      'job-mode': 'distributed-aggregator',
    });
    await required.run('main');
    await required.write('data/a', 'required');
    const abandoned = await required.run('post', unavailable);
    expect(abandoned.stdout).toContain(
      'Cache publication abandoned: outgoing cache confirmation unavailable.',
    );
    expect(abandoned.stdout.match(/::warning::Cache publication abandoned/g)).toHaveLength(1);
    expect(await readFile(required.job + '/summary', 'utf8')).toContain('Outcome: abandoned.');
    expect(await readFile(required.home + '/data/a', 'utf8')).toBe('required');
    expect((await required.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
  },
  30000,
);

it.each(['standalone', 'distributed-worker'] as const)(
  'actual Gradle %s skips unknown local workspaces while transporting valid content',
  async (role) => {
    const j = await entrypointJob(root, 'gradle', 'unknown-layout', {
      ...inputs,
      'job-mode': role,
    });
    await j.run('main');
    const unknown = 'caches/transforms-3/' + 'a'.repeat(32) + '/transformed/body.jar';
    await j.write('data/a', 'valid-content');
    await j.write(unknown, 'keep-unknown-local');
    const post = await j.run('post');
    expect(post.stdout).toContain('Omitted 1 Gradle file outside a supported workspace');
    expect(post.stdout).toContain(unknown);
    expect(post.stdout).toContain('Mammoth capture summary (complete)');
    expect(post.stdout).toContain('captured=1 files/13 logical bytes');
    expect(await readFile(j.home + '/' + unknown, 'utf8')).toBe('keep-unknown-local');
    expect(await readFile(j.home + '/data/a', 'utf8')).toBe('valid-content');
    expect(
      (await j.trace()).filter(
        ([name]) => name === (role === 'standalone' ? 'cache-save' : 'artifact-upload'),
      ).length,
    ).toBeGreaterThan(0);
    const consumer = await entrypointJob(
      root,
      'gradle',
      'known-consumer',
      {
        ...inputs,
        ...(role === 'distributed-worker'
          ? { 'job-mode': 'distributed-aggregator', 'dependent-jobs': 'unknown-layout' }
          : {}),
      },
      j.store,
    );
    await consumer.run('main');
    expect(await readFile(consumer.home + '/data/a', 'utf8')).toBe('valid-content');
    await expect(readFile(consumer.home + '/' + unknown)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);

it.each(['maven', 'gradle'] as const)(
  'actual %s gates V1 outgoing before publication and warns once without a receipt',
  async (tool) => {
    const j = await entrypointJob(root, tool, 'v1-outgoing', inputs);
    await j.run('main');
    await j.write('data/a', 'preserve');
    const post = await j.run('post', { ACTIONS_CACHE_SERVICE_V2: '' });
    expect(post.stdout).toContain('outcome: abandoned');
    expect(
      post.stdout.match(
        /::warning::(?:Base cache save unavailable|Cache publication abandoned|Cache publication skipped)/g,
      ),
    ).toHaveLength(1);
    expect((await j.trace()).filter(([name]) => name === 'cache-save')).toEqual([]);
    expect(await readFile(j.home + '/data/a', 'utf8')).toBe('preserve');
    const locator = JSON.parse(await readFile(j.home + '/.mammoth/v1/current.json', 'utf8')),
      state = JSON.parse(await readFile(j.home + '/' + locator[3], 'utf8'));
    expect(state[7][1]).toBe('abandoned');
    expect(state).toHaveLength(8);
    expect(state[4]).toBe('completed');
  },
);
it.each(['maven', 'gradle'] as const)(
  'actual %s worker abandons lost/null/thrown outgoing responses without salvage or success receipts',
  async (tool) => {
    for (const outcome of ['throw', 'null', 'lost']) {
      const j = await entrypointJob(root, tool, 'unconfirmed-' + outcome, {
        ...inputs,
        'job-mode': 'distributed-worker',
      });
      await j.run('main');
      await j.write('data/a', 'body');
      const post = await j.run('post', { MAMMOTH_TEST_UPLOAD_OUTCOME: outcome });
      expect(post.stdout).toContain('outcome: abandoned');
      expect(post.stdout.match(/::warning::Raw worker upload unconfirmed/g)).toHaveLength(1);
      const trace = await j.trace();
      expect(trace.filter(([name]) => name === 'artifact-upload')).toHaveLength(1);
      expect(
        trace.filter(([name]) =>
          ['artifact-get', 'artifact-list', 'artifact-download'].includes(name),
        ),
      ).toEqual([]);
      const locator = JSON.parse(await readFile(j.home + '/.mammoth/v1/current.json', 'utf8')),
        state = JSON.parse(await readFile(j.home + '/' + locator[3], 'utf8'));
      expect(state[7][1]).toBe('abandoned');
      expect(state[7].slice(2)).toEqual([null, null, null]);
      const files = await readdir(j.home + '/.mammoth/v1/' + state[2] + '/archives');
      expect(files.length).toBeGreaterThan(0);
      expect(await readFile(j.job + '/summary', 'utf8')).toContain('Outcome: abandoned.');
      await j.run('post');
      expect((await j.trace()).filter(([name]) => name === 'artifact-upload')).toHaveLength(1);
    }
  },
  30000,
);
it.each(['maven', 'gradle'] as const)(
  'actual %s wrappers fail local return and package errors instead of reporting abandonment',
  async (tool) => {
    const base = await entrypointJob(root, tool, 'occupied-return', inputs);
    await base.run('main');
    await base.write('data/a', 'body');
    await expect(base.run('post', { MAMMOTH_TEST_OCCUPY_RETURN: '1' })).rejects.toThrow(
      '::error::',
    );
    expect((await base.trace()).filter(([name]) => name === 'cache-save')).toHaveLength(1);
    const worker = await entrypointJob(root, tool, 'changed-package', {
      ...inputs,
      'job-mode': 'distributed-worker',
    });
    await worker.run('main');
    await worker.write('data/a', 'body');
    await expect(worker.run('post', { MAMMOTH_TEST_MUTATE_PACKAGE: '1' })).rejects.toThrow(
      '::error::',
    );
    expect((await worker.trace()).filter(([name]) => name === 'artifact-upload')).toHaveLength(1);
    expect(await readFile(worker.job + '/summary', 'utf8')).not.toContain(
      'Outcome: worker-uploaded.',
    );
  },
  30000,
);

it.each(['maven', 'gradle'] as const)(
  'actual %s post enforces the directory limit frozen by main',
  async (tool) => {
    const job = await entrypointJob(root, tool, 'directory-limit', {
      ...inputs,
      'cache-max-directory-entries': '4',
    });
    await job.run('main');
    for (let n = 0; n < 5; n++) await job.write('data/shared/' + n, 'retained');
    await expect(job.run('post', { 'INPUT_CACHE-MAX-DIRECTORY-ENTRIES': '100' })).rejects.toThrow(
      /during native walk at "data\/shared" \(cache-max-directory-entries=4\)/u,
    );
    expect(await readFile(path.join(job.home, 'data/shared/4'), 'utf8')).toBe('retained');
    expect((await job.trace()).some(([event]) => event === 'cache-save')).toBe(false);
  },
);

it('actual read-only prepare preserves a prewarmed home without querying a seeded backend', async () => {
  const writer = await entrypointJob(root, 'maven', 'seed', inputs);
  await writer.run('main');
  await writer.write('data/base', 'cached');
  await writer.run('post');

  const reader = await entrypointJob(
    root,
    'maven',
    'prewarmed',
    { ...inputs, 'read-only': 'true' },
    writer.store,
  );
  await reader.write('data/prewarmed', 'keep');
  await expect(reader.run('main')).rejects.toThrow('Managed cache path "data/prewarmed"');
  await reader.run('post');
  expect(await readFile(reader.home + '/data/prewarmed', 'utf8')).toBe('keep');
  await expect(readFile(reader.home + '/data/base')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await reader.trace()).filter(([name]) => name !== 'native-work')).toEqual([]);
});

it.each(['remaining', 'uncertain'] as const)(
  'actual Gradle prepare rejects %s process evidence even when cache is unavailable',
  async (evidence) => {
    const j = await entrypointJob(root, 'gradle', 'process-' + evidence, inputs);
    await expect(
      j.run('main', {
        MAMMOTH_TEST_PROCESS: evidence,
        MAMMOTH_TEST_UNAVAILABLE: '1',
      }),
    ).rejects.toThrow(evidence === 'remaining' ? 'A running Gradle daemon' : 'Could not establish');
    await j.run('post');
    expect((await j.trace()).filter(([name]) => name !== 'native-work')).toEqual([
      ['process-inspection', null],
    ]);
  },
);
