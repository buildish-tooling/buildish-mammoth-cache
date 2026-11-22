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

// Qualification-only production bundle runner. Logical identities are explicit; guards are never removed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
export const repository = process.cwd();
export function fileCommands(text) {
  const lines = text.split(/\r?\n/u),
    result = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const split = line.indexOf('<<');
    if (split >= 0) {
      const key = line.slice(0, split),
        delimiter = line.slice(split + 2),
        body = [];
      while (++i < lines.length && lines[i] !== delimiter) body.push(lines[i]);
      assert(i < lines.length, 'Unterminated command file');
      result[key] = body.join('\n');
    } else {
      const at = line.indexOf('=');
      assert(at > 0, 'Invalid command file row');
      result[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  return result;
}
export async function atomic(file, value) {
  await writeFile(file + '.next', JSON.stringify(value) + '\n');
  await rename(file + '.next', file);
}
export async function execute(command, args, options = {}) {
  const start = performance.now();
  const { started, ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: 'inherit', ...spawnOptions });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ?? code));
  });
  finished.catch(() => {});
  let observationError;
  try {
    await started?.(child.pid);
  } catch (error) {
    observationError = error;
  }
  const code = await finished;
  if (observationError) throw observationError;
  const milliseconds = performance.now() - start;
  try {
    assert.equal(
      code,
      0,
      'Qualification child failed: ' + path.basename(command) + ' (' + code + ')',
    );
  } catch (error) {
    error.qualificationMetrics = { milliseconds };
    throw error;
  }
  return { milliseconds };
}
export function commandEnv(env = process.env) {
  // Keep real SDK credentials/event/job/run/revision. Discard only previous invocation switches.
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => !/^(?:INPUT_|STATE_)/u.test(k) && !['NODE_OPTIONS', 'NODE_PATH'].includes(k),
    ),
  );
}
export async function invocation(
  base,
  tool,
  identity,
  inputs = {},
  bundleRoot = path.join(repository, 'dist'),
) {
  assert(['gradle', 'maven'].includes(tool));
  assert(/^[a-z0-9-]{1,80}$/u.test(identity));
  const dir = path.join(base, identity),
    home = path.join(dir, 'h'),
    workspace = path.join(dir, 'w'),
    temp = path.join(dir, 't');
  // Short temp path independent of the long logical name (GnuPG socket limit).
  const shortTemp = path.join(
    process.env.RUNNER_TEMP ?? base,
    'q',
    createHash('sha256')
      .update(base + ':' + identity)
      .digest('hex')
      .slice(0, 8),
  );
  for (const p of [home, workspace, temp, shortTemp]) await mkdir(p, { recursive: true });
  await cp(path.join(repository, 'test/fixtures/integration', tool + '-project'), workspace, {
    recursive: true,
  });
  const env = {
    ...commandEnv(),
    RUNNER_TEMP: shortTemp,
    GRADLE_USER_HOME: home,
    MAVEN_USER_HOME: home,
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_PATH: path.join(repository, 'actions/github', tool),
  };
  for (const name of ['state', 'output', 'environment', 'summary'])
    await writeFile(path.join(dir, name), '');
  Object.assign(env, {
    GITHUB_STATE: path.join(dir, 'state'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_ENV: path.join(dir, 'environment'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
  });
  const values = {
    'base-directory': '.',
    'github-job-name': identity,
    'read-only': 'false',
    'cache-gc-mode': 'off',
    ...inputs,
  };
  for (const [k, v] of Object.entries(values)) env['INPUT_' + k.toUpperCase()] = String(v);
  const outputs = async () => fileCommands(await readFile(env.GITHUB_OUTPUT, 'utf8'));
  let phaseNumber = 0;
  const phase = async (name, observer) => {
    assert(['main', 'post'].includes(name));
    const state =
      name === 'post'
        ? Object.fromEntries(
            Object.entries(fileCommands(await readFile(env.GITHUB_STATE, 'utf8'))).map(([k, v]) => [
              'STATE_' + k,
              v,
            ]),
          )
        : {};
    const exported = fileCommands(await readFile(env.GITHUB_ENV, 'utf8'));
    const telemetry = path.join(dir, name + '-' + ++phaseNumber + '.metrics.json');
    let result, failure;
    try {
      result = await execute(
        process.execPath,
        [
          '--require',
          path.join(repository, 'scripts/qualification/child-metrics.cjs'),
          path.join(bundleRoot, 'github', tool, name, 'index.cjs'),
        ],
        {
          cwd: workspace,
          env: { ...env, ...exported, ...state, Q1_NODE_METRICS: telemetry },
          started: observer,
        },
      );
    } catch (error) {
      failure = error;
    }
    let nodeMetrics = null;
    try {
      const bytes = await readFile(telemetry);
      assert(bytes.length <= 16384, 'Oversized child telemetry');
      nodeMetrics = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (!failure) throw error;
        const combined = new AggregateError(
          [failure, error],
          'Qualification child and exit telemetry failed',
        );
        combined.qualificationMetrics = { ...failure.qualificationMetrics, nodeMetrics: null };
        throw combined;
      }
    }
    if (failure) {
      failure.qualificationMetrics = { ...failure.qualificationMetrics, ...result, nodeMetrics };
      throw failure;
    }
    return { ...result, nodeMetrics, outputs: await outputs() };
  };
  const completion = async () => {
    const locator = JSON.parse(await readFile(path.join(home, '.mammoth/v1/current.json'), 'utf8'));
    const state = JSON.parse(await readFile(path.join(home, locator[3]), 'utf8'));
    assert.equal(state[4], 'completed');
    assert(
      ['published', 'no-change', 'worker-uploaded', 'read-only'].includes(state[14]),
      'Required lifecycle did not succeed: ' + state[14],
    );
    let generation = null,
      entries = [];
    if (state[8]) {
      const pub = JSON.parse(await readFile(path.join(home, state[8][2]), 'utf8'));
      generation = pub[8];
      const record = JSON.parse(await readFile(path.join(home, pub[7][2]), 'utf8'));
      entries = record[8];
      if (state[14] === 'no-change') {
        const bindings = JSON.parse(await readFile(path.join(home, state[5][2]), 'utf8'));
        generation = bindings[9][1];
      }
    }
    return {
      outcome: state[14],
      entries,
      generation,
      quiescence: state[13] !== null,
      workerReceipt: state[12]?.[3] != null,
    };
  };
  return { tool, identity, dir, home, workspace, env, phase, outputs, completion };
}
export function gradleTasks(stage, identity) {
  if (stage === 'parity-reader') return ['resolveStandalone'];
  // This campaign's designated metadata writer must know every dependency set
  // before its complete snapshot can support the aggregator's offline build.
  if (stage !== 'worker' || identity.includes('-linux-'))
    return ['resolveWorkerA', 'resolveWorkerB', 'resolveWorkerC'];
  const platform = ['windows', 'macos'].findIndex((p) => identity.includes('-' + p + '-'));
  assert(platform >= 0, 'Unknown qualification worker');
  return ['resolveWorker' + ['B', 'C'][platform]];
}
export async function buildFixture(job, stage, observer) {
  const offline = stage !== 'worker' && stage !== 'parity';
  const args =
    job.tool === 'gradle'
      ? [
          '--console=plain',
          ...(['worker', 'consumer', 'parity-reader'].includes(stage) ? ['--no-daemon'] : []),
          ...(offline ? ['--offline'] : []),
          ...gradleTasks(stage, job.identity),
          'test',
          'portable',
        ]
      : [
          '-B',
          '-Dmaven.repo.local=' + job.home + '/repository',
          ...(offline ? ['--offline'] : []),
          '-P',
          stage === 'parity-reader'
            ? 'standalone'
            : stage === 'worker'
              ? 'worker-' +
                ['a', 'b', 'c'][
                  ['linux', 'windows', 'macos'].findIndex((p) =>
                    job.identity.includes('-' + p + '-'),
                  )
                ]
              : 'worker-a,worker-b,worker-c',
          'dependency:resolve',
        ];
  const command =
    job.tool === 'gradle'
      ? process.platform === 'win32'
        ? '.\\gradlew.bat'
        : './gradlew'
      : process.platform === 'win32'
        ? 'mvn.cmd'
        : 'mvn';
  return execute(command, args, {
    cwd: job.workspace,
    env: { ...job.env, ...fileCommands(await readFile(job.env.GITHUB_ENV, 'utf8')) },
    shell: process.platform === 'win32',
    started: observer,
  });
}
export async function saveResult(directory, name, data) {
  await mkdir(directory, { recursive: true });
  const value = {
    ...data,
    head: process.env.Q1_HEAD_SHA ?? null,
    testedRevision: process.env.GITHUB_SHA ?? null,
    physicalJob: process.env.GITHUB_JOB ?? null,
    run: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    image: process.env.ImageVersion ?? null,
    imageOS: process.env.ImageOS ?? null,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
  await atomic(path.join(directory, name + '.json'), value);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Q1 ${name}: ${data.status ?? data.outcome ?? 'recorded'}; details in qualification artifact.\n`,
    );
}

// Progress failures must not suppress an already-owned lifecycle's post attempt.
export async function withPhaseProgress(name, persist, invoke) {
  const errors = [];
  try {
    await persist();
  } catch (error) {
    if (name !== 'post') throw error;
    errors.push(error);
  }
  let result;
  try {
    result = await invoke();
  } catch (error) {
    errors.push(error);
  }
  try {
    await persist();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Phase and progress failed');
  return result;
}

export async function lifecycle(job, body, phase = (name) => job.phase(name)) {
  const errors = [];
  try {
    const prepared = await phase('main');
    await body(prepared);
  } catch (e) {
    errors.push(e);
  }
  // Ordinary JavaScript Actions still finalize after failed prepare/build/verification.
  // The product's state/owner guard decides whether any cleanup is authorized.
  try {
    await phase('post');
  } catch (e) {
    errors.push(e);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Qualification lifecycle and post failed');
}
