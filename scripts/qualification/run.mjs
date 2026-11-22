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

// CI-only JavaScript Action: runner supplies authentic SDK runtime credentials to this process.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { invocation, buildFixture, saveResult, repository, lifecycle } from './invocation.mjs';
import { meter } from './meter.mjs';
const platforms = ['linux', 'windows', 'macos'];
const stage = process.env.INPUT_STAGE,
  platform = process.env.INPUT_PLATFORM;
assert(platforms.includes(platform));
assert(process.env.GITHUB_REPOSITORY === 'snazy/buildish-mammoth-cache');
assert(
  process.env.GITHUB_EVENT_NAME === 'push' &&
    process.env.GITHUB_REF === 'refs/heads/cache-metadata-redesign',
);
const configuration = JSON.parse(await readFile('.github/q1-campaign.json', 'utf8'));
assert(configuration.enabled === true && /^[a-z0-9-]+$/u.test(configuration.id));
const base = path.resolve('build/q1-work'),
  results = path.resolve('build/q1-results');
await mkdir(base, { recursive: true });
await mkdir(results, { recursive: true });
const observer = await meter(path.join(results, 'observer'));
const records = [];
const worker = (p, t) => `q1-worker-${p}-${t}`;
function inputs(tool, group = 'graph') {
  return {
    'cache-key-prefix': `q1-${configuration.id}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${group}-`,
    'cache-partitions': JSON.stringify([
      ...(tool === 'gradle' ? [{ id: 'dependency-metadata', writer: worker('linux', tool) }] : []),
      { id: 'q-proof', includes: ['q-proof/**'] },
      {
        id: 'q-snapshot',
        includes: ['q-snapshot/**'],
        publication: 'single-writer',
        writer: worker('linux', tool),
      },
      ...[0, 1, 2, 3].map((p) => ({ id: 'q' + p, includes: ['q' + p + '/**'] })),
    ]),
  };
}
async function phase(job, name) {
  const result = await job.phase(name, (pid) => observer.phase(job.identity + '-' + name, pid));
  await observer.phase('between', 0);
  records.push({ logicalInvocation: job.identity, phase: name, ...result });
  return result;
}
async function seed(job) {
  const proof = path.join(job.home, 'q-proof');
  await mkdir(path.join(proof, 'empty-' + platform), { recursive: true });
  await writeFile(path.join(proof, platform + '.txt'), platform);
  await writeFile(path.join(proof, 'common.txt'), 'equivalent');
  await mkdir(path.join(job.home, 'q-snapshot'), { recursive: true });
  await writeFile(path.join(job.home, 'q-snapshot/value'), platform);
  if (platform !== 'windows') {
    await writeFile(path.join(proof, platform + '.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(proof, platform + '.sh'), 0o755);
  }
}
async function verifyGraph(job, changed = false) {
  for (const p of platforms) {
    assert.equal(
      await readFile(path.join(job.home, 'q-proof', p + '.txt'), 'utf8'),
      changed && p === platform ? 'modified-' + p : p,
    );
    assert((await stat(path.join(job.home, 'q-proof', 'empty-' + p))).isDirectory());
    if (p !== 'windows' && process.platform !== 'win32')
      assert.equal((await stat(path.join(job.home, 'q-proof', p + '.sh'))).mode & 0o111, 0o111);
  }
  assert.equal(await readFile(path.join(job.home, 'q-proof/common.txt'), 'utf8'), 'equivalent');
  assert.equal(await readFile(path.join(job.home, 'q-snapshot/value'), 'utf8'), 'linux');
}
async function graph() {
  for (const tool of ['gradle', 'maven']) {
    const role =
      stage === 'worker'
        ? 'distributed-worker'
        : stage === 'aggregator'
          ? 'distributed-aggregator'
          : 'standalone';
    const names = platforms.map((p) => worker(p, tool));
    const job = await invocation(base, tool, `q1-${stage}-${platform}-${tool}`, {
      ...inputs(tool),
      'job-mode': role,
      'github-ref-name': stage === 'worker' ? 'q1-workers' : `q1-${platform}`,
      ...(stage === 'aggregator'
        ? { 'dependent-jobs': [names[1], names[0], names[1], names[2]].join(',') }
        : {}),
      ...(stage === 'consumer' ? { 'read-only': 'true' } : {}),
    });
    await lifecycle(
      job,
      async (prepare) => {
        assert.equal(prepare.outputs['read-only'], stage === 'consumer' ? 'true' : 'false');
        if (stage === 'consumer')
          assert.equal(prepare.outputs['base-cache-restore-status'], 'current-lineage-hit');
        if (stage === 'aggregator')
          assert.equal(prepare.outputs['dependent-delta-artifact-count'], '3');
        if (stage !== 'worker') await verifyGraph(job);
        await buildFixture(job, stage, (pid) => observer.phase(job.identity + '-build', pid));
        if (stage === 'worker') await seed(job);
      },
      (name) => phase(job, name),
    );
    const completed = await job.completion();
    assert.equal(
      completed.outcome,
      stage === 'worker' ? 'worker-uploaded' : stage === 'consumer' ? 'read-only' : 'published',
    );
    if (stage === 'worker') {
      assert(completed.workerReceipt);
      await seedCheck(job);
    }
    if (stage === 'aggregator') {
      assert(completed.generation);
      if (tool === 'gradle') assert(completed.quiescence);
      await verifyGraph(job);
    }
    records.push({ logicalInvocation: job.identity, ...completed });
    if (stage === 'consumer') {
      const configuration = { ...inputs(tool), 'github-ref-name': `q1-${platform}` };
      const warm = await invocation(base, tool, `q1-warm-${platform}-${tool}`, configuration);
      await lifecycle(
        warm,
        async () => verifyGraph(warm),
        (name) => phase(warm, name),
      );
      const baseline = await warm.completion();
      assert.equal(baseline.outcome, 'no-change');
      const change = await invocation(base, tool, `q1-change-${platform}-${tool}`, configuration);
      await lifecycle(
        change,
        async () => {
          await verifyGraph(change);
          await writeFile(
            path.join(change.home, 'q-proof', platform + '.txt'),
            'modified-' + platform,
          );
        },
        (name) => phase(change, name),
      );
      const changed = await change.completion();
      assert.equal(changed.outcome, 'published');
      for (const e of baseline.entries)
        if (e[1] !== 'q-proof')
          assert.deepEqual(
            changed.entries.find((r) => r[1] === e[1]),
            e,
            'Unchanged partition was not reused',
          );
      const reader = await invocation(base, tool, `q1-reuse-${platform}-${tool}`, {
        ...configuration,
        'read-only': 'true',
      });
      await lifecycle(
        reader,
        async () => verifyGraph(reader, true),
        (name) => phase(reader, name),
      );
      await reader.completion();
      records.push(
        { logicalInvocation: warm.identity, ...baseline },
        { logicalInvocation: change.identity, ...changed },
      );
    }
  }
}
async function seedCheck(job) {
  assert.equal(await readFile(path.join(job.home, 'q-proof', platform + '.txt'), 'utf8'), platform);
}
let failure;
try {
  const hashes = {};
  for (const t of ['gradle', 'maven'])
    for (const p of ['main', 'post'])
      hashes[t + '-' + p] = createHash('sha256')
        .update(await readFile(path.join(repository, 'dist/github', t, p, 'index.cjs')))
        .digest('hex');
  await saveResult(results, 'identity', {
    status: 'started',
    stage,
    platform,
    bundleHashes: hashes,
    repository: process.env.GITHUB_REPOSITORY,
    configuration,
    logicalIdentityIsolation: true,
  });
  if (['worker', 'aggregator', 'consumer'].includes(stage)) await graph();
  else throw new Error('Unsupported qualification stage: ' + stage);
} catch (e) {
  failure = e;
  process.exitCode = 1;
} finally {
  let metrics;
  try {
    metrics = await observer.close();
  } catch (e) {
    failure = failure ? new AggregateError([failure, e], 'Case and sampler cleanup failed') : e;
    process.exitCode = 1;
  }
  try {
    await saveResult(results, stage + '-' + platform, {
      status: failure ? 'failed' : 'passed',
      error: failure ? { name: failure.name, details: 'See redacted failed-step log' } : null,
      records,
      metrics,
    });
  } catch (e) {
    failure = failure ? new AggregateError([failure, e], 'Case and result write failed') : e;
    process.exitCode = 1;
  }
}
if (failure) throw failure;
