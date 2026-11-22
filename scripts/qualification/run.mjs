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
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  invocation,
  buildFixture,
  saveResult,
  repository,
  lifecycle,
  execute,
  withPhaseProgress,
} from './invocation.mjs';
import { meter, reservation } from './meter.mjs';
import { snapshot } from './observe.mjs';
import { campaignBudget, scaleProfile, admitWork } from './campaign.mjs';
import { diagnoseDarwin } from './darwin-diagnostic.mjs';
import { generate, mutate, verify, capacity } from './fixture.mjs';
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
assert.equal(configuration.route, process.env.Q1_ROUTE);
campaignBudget(configuration.route);
const resuming = configuration.route.startsWith('resume-');
if (configuration.route === 'resume-scale') assert(stage === 'scale' && platform === 'linux');
if (configuration.route === 'resume-graph')
  assert(['worker', 'aggregator', 'consumer'].includes(stage));
if (configuration.route === 'remaining') assert(['scale', 'diagnostic'].includes(stage));
const base = path.resolve('build/q1-work'),
  results = path.resolve('build/q1-results');
await mkdir(base, { recursive: true });
await mkdir(results, { recursive: true });
const exerciseStarted = performance.now(),
  selection = stage === 'scale' ? scaleProfile(configuration, platform) : null,
  observer = await meter(path.join(results, 'observer'));
const records = [];
let load,
  diagnosticDone = false;
const until =
  exerciseStarted + (selection?.workloadMs ?? (stage === 'diagnostic' ? 25 : 50) * 60 * 1000);
async function progress() {
  if (resuming)
    await saveResult(results, 'progress-' + stage + '-' + platform, {
      status: 'in-progress',
      records,
    });
}
async function measured(label, task) {
  const start = performance.now(),
    cpu = process.cpuUsage();
  await observer.phase(label, process.pid);
  try {
    return await task();
  } finally {
    records.push({
      kind: 'harness-work',
      label,
      milliseconds: performance.now() - start,
      cpu: process.cpuUsage(cpu),
    });
    await observer.phase('between', 0);
    await progress();
  }
}
const worker = (p, t) => `q1-worker-${p}-${t}`;
function inputs(tool, group = 'graph') {
  return {
    'cache-key-prefix': `q1-${configuration.id}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${group}-`,
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
      ...[0, 1, 2, 3].map((p) => ({ id: 'q' + p, includes: ['q' + p + '/**'] })),
    ]),
  };
}
async function phase(job, name) {
  if (resuming && name !== 'post') admitWork(until);
  records.push({ kind: 'phase-start', logicalInvocation: job.identity, name, at: Date.now() });
  return withPhaseProgress(name, progress, async () => {
    const errors = [];
    let result;
    try {
      load?.assertCurrent();
    } catch (e) {
      if (name !== 'post') throw e;
      errors.push(e);
    }
    try {
      result = await job.phase(name, (pid) => observer.phase(job.identity + '-' + name, pid));
    } catch (e) {
      result = e.qualificationMetrics;
      errors.push(e);
      if (
        resuming &&
        platform === 'macos' &&
        job.tool === 'gradle' &&
        name === 'post' &&
        !diagnosticDone
      ) {
        diagnosticDone = true;
        try {
          records.push({ kind: 'later-process-classification', ...(await diagnoseDarwin()) });
        } catch {
          records.push({
            kind: 'later-process-classification',
            classification: 'diagnostic-unavailable',
          });
        }
      }
    }
    try {
      await observer.phase('between', 0);
      load?.assertCurrent();
    } catch (e) {
      errors.push(e);
    }
    records.push({
      logicalInvocation: job.identity,
      phase: name,
      ...result,
      status: errors.length ? 'failed' : 'passed',
    });
    if (resuming && !result?.nodeMetrics)
      records.push({
        kind: 'qualification-gap',
        logicalInvocation: job.identity,
        reason: 'Node exit telemetry unavailable',
      });
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Phase and measurement failed');
    return result;
  });
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
async function parityReaders() {
  const source =
    configuration.route === 'remaining'
      ? configuration.paritySource
      : {
          runId: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          revision: process.env.GITHUB_SHA,
        };
  assert(
    /^[0-9]+$/u.test(source.runId) &&
      /^[1-9][0-9]*$/u.test(source.attempt) &&
      /^[a-f0-9]{40}$/u.test(source.revision),
  );
  records.push({
    case: 'ordinary-parity-source',
    ...source,
    method:
      'Explicit prior successful normal Action generations; authentic new reader context, no worker artifact reuse',
  });
  for (const tool of ['gradle', 'maven']) {
    const job = await invocation(base, tool, `q1-parity-reader-${tool}`, {
      'read-only': 'true',
      'cache-key-prefix': `q1-parity-${source.runId}-${source.attempt}-`,
      'cache-partitions': JSON.stringify([{ id: 'q-proof', includes: ['q-proof/**'] }]),
    });
    await lifecycle(
      job,
      async (prepared) => {
        assert.equal(prepared.outputs['base-cache-restore-status'], 'current-lineage-hit');
        assert.equal(
          await readFile(path.join(job.home, 'q-proof/parity.txt'), 'utf8'),
          'ordinary-' + tool,
        );
        assert(prepared.outputs['restored-cache-key']);
        records.push({
          case: 'ordinary-parity-restored',
          tool,
          source,
          key: prepared.outputs['restored-cache-key'],
        });
        // Ordinary parity producers resolved the standalone profile, not worker profiles.
        await buildFixture(job, 'parity-reader', (pid) =>
          observer.phase(job.identity + '-build', pid),
        );
      },
      (name) => phase(job, name),
    );
    records.push({ logicalInvocation: job.identity, ...(await job.completion()) });
  }
}
async function scale() {
  assert(selection);
  const memory = await snapshot();
  try {
    load = await reservation();
  } catch (e) {
    records.push({
      kind: 'qualification-gap',
      reason: 'Reservation/effective-headroom preflight refused',
      error: e.name,
      available: memory.available,
    });
    return;
  }
  let primary;
  try {
    outer: for (const count of selection.counts)
      for (const tool of selection.tools) {
        if (performance.now() > until) {
          records.push({
            kind: 'qualification-gap',
            tool,
            count,
            reason: 'Reserved cleanup deadline reached',
          });
          break outer;
        }
        const space = await capacity(base, count);
        if (space.free < space.estimatedRequired) {
          records.push({
            kind: 'qualification-gap',
            tool,
            count,
            reason: 'Physical allocation preflight',
            ...space,
          });
          continue;
        }
        const config = {
          ...inputs(tool, 'scale-' + count),
          'github-ref-name': `q1-scale-${platform}-${tool}`,
        };
        const seed = await invocation(base, tool, `q1-scale-${count}-seed-${tool}`, config);
        let baseline;
        await lifecycle(
          seed,
          async (prepared) => {
            assert.equal(prepared.outputs['base-cache-restore-status'], 'miss');
            if (resuming) admitWork(until);
            await measured(`fixture-${count}-${tool}`, () => generate(seed.home, count));
          },
          (name) => phase(seed, name),
        );
        baseline = await seed.completion();
        assert.equal(baseline.outcome, 'published');
        await measured('seed-source-oracle', () => verify(seed.home, count));
        records.push({ tool, count, case: 'seed', ...baseline, sourceReturn: 'confirmed' });
        await progress();
        await measured('seed-retirement', () => rm(seed.dir, { recursive: true }));
        for (const kind of ['warm', 'change', 'reader']) {
          if (performance.now() > until) {
            records.push({
              kind: 'qualification-gap',
              tool,
              count,
              reason: 'Reserved cleanup deadline reached before ' + kind,
            });
            break outer;
          }
          const job = await invocation(base, tool, `q1-scale-${count}-${kind}-${tool}`, {
            ...config,
            ...(kind === 'reader' ? { 'read-only': 'true' } : {}),
          });
          await lifecycle(
            job,
            async (prepared) => {
              assert.equal(prepared.outputs['base-cache-restore-status'], 'current-lineage-hit');
              if (resuming) admitWork(until);
              await measured(kind + '-restore-oracle', () =>
                verify(job.home, count, kind === 'reader'),
              );
              if (kind === 'change') {
                if (resuming) admitWork(until);
                records.push({
                  tool,
                  count,
                  changes: await measured('mutation', () => mutate(job.home, count)),
                });
              }
            },
            (name) => phase(job, name),
          );
          const done = await job.completion();
          assert.equal(
            done.outcome,
            kind === 'reader' ? 'read-only' : kind === 'warm' ? 'no-change' : 'published',
          );
          if (kind === 'warm') assert.equal(done.generation, baseline.generation);
          if (kind === 'change')
            for (const entry of baseline.entries)
              if (entry[1] !== 'q0')
                assert.deepEqual(
                  done.entries.find((e) => e[1] === entry[1]),
                  entry,
                );
          await measured(kind + '-source-oracle', () => verify(job.home, count, kind !== 'warm'));
          records.push({
            tool,
            count,
            case: kind,
            ...done,
            sourceReturn: kind === 'reader' ? 'not-applicable' : 'confirmed',
          });
          await progress();
          // Only completed, verified task-owned roots are retired; preserve failure evidence.
          await measured(kind + '-retirement', () => rm(job.dir, { recursive: true }));
        }
        if (resuming)
          assert.deepEqual(
            records
              .filter((r) => r.tool === tool && r.count === count && r.case)
              .map((r) => r.case),
            ['seed', 'warm', 'change', 'reader'],
          );
        const metrics = JSON.parse(await readFile(observer.output, 'utf8'));
        const margin = Math.max(1024 ** 3, metrics.total * 0.15);
        if (
          metrics.minAvailable < margin ||
          (metrics.pagingDelta &&
            (metrics.pagingDelta.input !== 0 || metrics.pagingDelta.output !== 0)) ||
          !metrics.effectiveLimitKnown ||
          metrics.missing.length
        ) {
          records.push({
            kind: 'qualification-gap',
            tool,
            count,
            reason: 'Headroom, paging or required observability',
            scope:
              'Cumulative job-wide conservative bound including calibration, generation, oracle and previous cases; not isolated cache-phase peak',
            pagingDelta: metrics.pagingDelta,
            margin,
            observed: metrics.minAvailable,
            missing: metrics.missing,
          });
          if (
            metrics.minAvailable < margin ||
            !metrics.effectiveLimitKnown ||
            (metrics.pagingDelta &&
              (metrics.pagingDelta.input !== 0 || metrics.pagingDelta.output !== 0))
          )
            break outer;
        }
      }
  } catch (e) {
    primary = e;
  } finally {
    const active = load;
    load = undefined;
    try {
      await active.close();
    } catch (e) {
      primary = primary
        ? new AggregateError([primary, e], 'Scale case and reservation cleanup failed')
        : e;
    }
  }
  if (primary) throw primary;
}

function byteBlock(index) {
  const block = Buffer.alloc(65536);
  let state = index + 1;
  for (let n = 32768; n < 65536; n += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    block.writeUInt32LE(state >>> 0, n);
  }
  return block;
}
async function byteCase(small) {
  const job = await invocation(base, 'maven', 'q1-bytes-' + (small ? 'small' : 'large'), {
    ...inputs('maven', 'bytes-' + small),
    'github-ref-name': 'q1-bytes',
  });
  const directory = path.join(job.home, 'q0');
  await lifecycle(
    job,
    async () => {
      await mkdir(directory, { recursive: true });
      if (small)
        for (let i = 0; i < 8192; i++)
          await writeFile(path.join(directory, i + '.bin'), byteBlock(i));
      else {
        const file = await open(path.join(directory, 'large.bin'), 'wx');
        try {
          for (let i = 0; i < 8192; i++) await file.writeFile(byteBlock(i));
        } finally {
          await file.close();
        }
      }
    },
    (name) => phase(job, name),
  );
  assert.equal((await job.completion()).outcome, 'published');
  const reader = await invocation(base, 'maven', 'q1-bytes-reader-' + small, {
    ...inputs('maven', 'bytes-' + small),
    'github-ref-name': 'q1-bytes',
    'read-only': 'true',
  });
  await lifecycle(
    reader,
    async (prepared) => {
      assert.equal(prepared.outputs['base-cache-restore-status'], 'current-lineage-hit');
      if (small)
        for (let i = 0; i < 8192; i++)
          assert.deepEqual(await readFile(path.join(reader.home, 'q0', i + '.bin')), byteBlock(i));
      else {
        const file = await open(path.join(reader.home, 'q0/large.bin'), 'r');
        try {
          const bytes = Buffer.alloc(65536);
          for (let i = 0; i < 8192; i++) {
            let got = 0;
            while (got < bytes.length) {
              const read = await file.read(bytes, got, bytes.length - got, i * 65536 + got);
              assert(read.bytesRead > 0);
              got += read.bytesRead;
            }
            assert.deepEqual(bytes, byteBlock(i));
          }
          assert.equal((await file.stat()).size, 512 * 1024 ** 2);
        } finally {
          await file.close();
        }
      }
    },
    (name) => phase(reader, name),
  );
  records.push({
    case: 'B',
    small,
    logicalBytes: 512 * 1024 ** 2,
    files: small ? 8192 : 1,
    outcome: 'restored-verified',
  });
  await rm(job.dir, { recursive: true });
  await rm(reader.dir, { recursive: true });
}
async function diagnostics() {
  await execute(process.execPath, [
    'node_modules/esbuild/bin/esbuild',
    'test/qualification/q1-diagnostics.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--outfile=build/q1-diagnostics.cjs',
  ]);
  const tests = [
    'test/cache/streaming/native-records.test.ts',
    'test/cache/streaming/relocation-adjustment-counts.test.ts',
    'test/cache/streaming/relocation-depth.test.ts',
    'test/cache/streaming/relocation.test.ts',
    'test/cache/streaming/moving-process.test.ts',
    'test/cache/streaming/gc-execute.test.ts',
  ];
  // Existing source-matched failure coverage is not a new hosted fault matrix.
  for (const args of [
    ['width'],
    ...[2, 4, 16].flatMap((k) => ['disjoint', 'overlap'].map((s) => ['merge', String(k), s])),
  ]) {
    if (performance.now() > until) {
      records.push({ kind: 'qualification-gap', case: args, reason: 'Diagnostic deadline' });
      return;
    }
    await execute(process.execPath, ['build/q1-diagnostics.cjs', ...args], {
      started: (pid) => observer.phase('diagnostic-' + args.join('-'), pid),
    });
  }
  await execute(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'test/qualification/vitest.config.ts'],
    { started: (pid) => observer.phase('diagnostic-metadata', pid) },
  );
  // Run the actual existing vector/return regressions; skip nonexistent optional paths explicitly, not silently.
  await execute(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--project', 'unit', ...tests],
    { started: (pid) => observer.phase('diagnostic-regressions', pid) },
  );
  for (const small of [false, true]) {
    if (performance.now() > until) {
      records.push({ kind: 'qualification-gap', case: 'B', reason: 'Diagnostic deadline' });
      return;
    }
    await byteCase(small);
  }
  await legacyComparison();
}

async function legacyComparison() {
  const old = path.resolve('build/q1-legacy/dist');
  const job = await invocation(
    base,
    'maven',
    'q1-old-release-comparison',
    inputs('maven', 'old-release'),
    old,
  );
  let error;
  const start = performance.now();
  try {
    await lifecycle(
      job,
      async () => {
        await generate(job.home, 100000);
      },
      (name) => phase(job, name),
    );
  } catch (e) {
    error = e;
  }
  records.push({
    case: 'old-release-comparison',
    release: 'v0.2.2',
    files: 100000,
    milliseconds: performance.now() - start,
    completed: !error,
    limitation: error
      ? { name: error.name, details: 'See redacted job log; do not derive successful throughput' }
      : null,
  });
  // Legacy failure/recovery namespace is preserved, not adopted by the new lifecycle.
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
    measurementLimits: [
      'External sampler peaks are sampled bounds including generation/oracle unless a named phase is selected',
      'Node child CPU/resourceUsage and memoryUsage-at-exit are process-only; full native-child CPU and Node peak heap/external remain unavailable',
      '10-minute resumption cutoff admits lifecycles/main/body only; in-flight bundles can start SDK calls; timeout source return is UNKNOWN',
      'statfs samples filesystem allocation and coexistence, not per-file logical inventory',
      'System paging is conservative; attribution not proven and Windows paging I/O missing',
    ],
  });
  if (['worker', 'aggregator', 'consumer'].includes(stage)) await graph();
  else if (stage === 'scale') await scale();
  else if (stage === 'diagnostic') {
    await parityReaders();
    await diagnostics();
  } else throw new Error('Unsupported qualification stage: ' + stage);
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
      status: failure
        ? 'failed'
        : records.some((r) => r.kind === 'qualification-gap')
          ? 'not-qualified'
          : 'passed',
      error: failure ? { name: failure.name, details: 'See redacted failed-step log' } : null,
      records,
      metrics,
    });
  } catch (e) {
    failure = failure ? new AggregateError([failure, e], 'Case and result write failed') : e;
    process.exitCode = 1;
  }
}
if (records.some((r) => r.kind === 'qualification-gap')) process.exitCode = 1;
if (failure) throw failure;
