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

// Run as a node24 Action so the runner provides authentic SDK context.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { admit, completion, platforms, verifyReuse } from './evidence.mjs';
import { invocation, lifecycle, repository } from './invocation.mjs';

const { stage, platform, run, revision } = admit(process.env, process.platform);
const work = path.join(repository, 'build/distributed-correctness-work');
const results = path.join(repository, 'build/distributed-correctness-results');
await mkdir(work, { recursive: true });
await mkdir(results, { recursive: true });
const until = performance.now() + 10 * 60 * 1000;
const worker = (p, tool) => `dc-worker-${p}-${tool}`;

function inputs(tool) {
  return {
    'cache-key-prefix': `dc-${run}-`,
    'github-ref-name': stage === 'worker' ? 'dc-workers' : `dc-${platform}`,
    'cache-partitions': JSON.stringify([
      ...(tool === 'gradle'
        ? [{ id: 'dependency-metadata', writer: worker('linux', tool) }]
        : [{ id: 'repository', 'conflict-handling': 'choose-worker-directory' }]),
      { id: 'q-proof', includes: ['q-proof/**'] },
      {
        id: 'q-snapshot',
        includes: ['q-snapshot/**'],
        publication: 'single-writer',
        writer: worker('linux', tool),
      },
    ]),
  };
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
function admitWork() {
  assert(performance.now() < until, 'Graph admission deadline elapsed');
}

async function runCase(tool, label, values, outcome, body, afterPost) {
  admitWork();
  const job = await invocation(work, tool, `dc-${label}-${platform}-${tool}`, {
    ...inputs(tool),
    ...values,
  });
  let prepare;
  await lifecycle(job, async (outputs) => {
    admitWork();
    prepare = outputs;
    assert.equal(outputs['read-only'], String(outcome === 'read-only'));
    await body(job, outputs);
  });
  const evidence = await completion(job.home, outcome, prepare);
  await afterPost?.(job);
  return evidence;
}

async function graph(tool) {
  if (stage === 'worker') {
    return runCase(
      tool,
      stage,
      { 'job-mode': 'distributed-worker' },
      'worker-uploaded',
      async (job) => {
        await job.build(stage, platform);
        await seed(job);
      },
      async ({ home }) => {
        assert.equal(
          await readFile(path.join(home, 'q-proof', platform + '.txt'), 'utf8'),
          platform,
        );
        assert.equal(await readFile(path.join(home, 'q-proof/common.txt'), 'utf8'), 'equivalent');
        assert((await stat(path.join(home, 'q-proof', 'empty-' + platform))).isDirectory());
        assert.equal(await readFile(path.join(home, 'q-snapshot/value'), 'utf8'), platform);
      },
    );
  }
  if (stage === 'aggregator') {
    const names = platforms.map((p) => worker(p, tool));
    return runCase(
      tool,
      stage,
      {
        'job-mode': 'distributed-aggregator',
        'dependent-jobs': [names[1], names[0], names[1], names[2]].join(','),
      },
      'published',
      async (job, outputs) => {
        assert.equal(outputs['dependent-delta-artifact-count'], '3');
        await verifyGraph(job);
        await job.build(stage, platform);
      },
      verifyGraph,
    );
  }
  const readOnly = { 'read-only': 'true' };
  const initial = await runCase(tool, 'consumer', readOnly, 'read-only', async (job) => {
    await verifyGraph(job);
    await job.build(stage, platform);
  });
  const warm = await runCase(tool, 'warm', {}, 'no-change', (job) => verifyGraph(job), verifyGraph);
  const changed = await runCase(
    tool,
    'change',
    {},
    'published',
    async (job) => {
      await verifyGraph(job);
      await writeFile(path.join(job.home, 'q-proof', platform + '.txt'), 'modified-' + platform);
    },
    (job) => verifyGraph(job, true),
  );
  const reader = await runCase(tool, 'reader', readOnly, 'read-only', (job) =>
    verifyGraph(job, true),
  );
  verifyReuse(initial, warm, changed, reader);
  return { initial: initial.key, warm: warm.key, published: changed.key, reader: reader.key };
}

const record = {
  revision,
  run,
  attempt: 1,
  platform,
  stage,
  node: process.version,
  architecture: process.arch,
  image: process.env.ImageVersion ?? null,
  bundles: {},
  tools: {},
  status: 'failed',
};
try {
  for (const tool of ['gradle', 'maven'])
    for (const phase of ['main', 'post'])
      record.bundles[tool + '-' + phase] = createHash('sha256')
        .update(await readFile(path.join(repository, 'dist/github', tool, phase, 'index.cjs')))
        .digest('hex');
  for (const tool of ['gradle', 'maven']) record.tools[tool] = await graph(tool);
  record.status = 'passed';
} finally {
  const file = path.join(results, stage + '-' + platform + '.json');
  await writeFile(file + '.next', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  await rename(file + '.next', file);
}
