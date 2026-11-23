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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));

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
export function commandEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/^(?:INPUT_|STATE_)/iu.test(key) && !/^NODE_(?:OPTIONS|PATH)$/iu.test(key),
    ),
  );
}

async function execute(command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ?? exitCode));
  });
  assert.equal(code, 0, 'Correctness child failed: ' + path.basename(command) + ' (' + code + ')');
}

export async function invocation(base, tool, identity, inputs) {
  assert(['gradle', 'maven'].includes(tool));
  assert(/^[a-z0-9-]{1,80}$/u.test(identity));
  const directory = path.join(base, identity),
    home = path.join(directory, 'h'),
    workspace = path.join(directory, 'w');
  // A short isolated temp path leaves room for GnuPG socket names.
  const temp = path.join(
    process.env.RUNNER_TEMP ?? base,
    'dc',
    createHash('sha256').update(directory).digest('hex').slice(0, 8),
  );
  await mkdir(directory);
  for (const p of [home, workspace, temp]) await mkdir(p, { recursive: true });
  await cp(path.join(repository, 'test/fixtures/integration', tool + '-project'), workspace, {
    recursive: true,
  });
  const env = {
    ...commandEnv(),
    RUNNER_TEMP: temp,
    GRADLE_USER_HOME: home,
    MAVEN_USER_HOME: home,
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_PATH: path.join(repository, 'actions/github', tool),
    GITHUB_STATE: path.join(directory, 'state'),
    GITHUB_OUTPUT: path.join(directory, 'output'),
    GITHUB_ENV: path.join(directory, 'environment'),
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
  };
  for (const file of [env.GITHUB_STATE, env.GITHUB_OUTPUT, env.GITHUB_ENV, env.GITHUB_STEP_SUMMARY])
    await writeFile(file, '', { flag: 'wx' });
  const values = {
    'base-directory': '.',
    'github-job-name': identity,
    'read-only': 'false',
    'cache-gc-mode': 'off',
    ...inputs,
  };
  for (const [key, value] of Object.entries(values)) env['INPUT_' + key.toUpperCase()] = value;
  const readCommands = async (file) => fileCommands(await readFile(file, 'utf8'));
  return {
    tool,
    home,
    workspace,
    async phase(name) {
      assert(['main', 'post'].includes(name));
      const state = name === 'post' ? postState(await readCommands(env.GITHUB_STATE)) : {};
      await execute(
        process.execPath,
        [path.join(repository, 'dist/github', tool, name, 'index.cjs')],
        {
          cwd: workspace,
          env: { ...env, ...commandEnv(await readCommands(env.GITHUB_ENV)), ...state },
        },
      );
      return readCommands(env.GITHUB_OUTPUT);
    },
    async build(stage, platform) {
      const command =
        tool === 'gradle'
          ? process.platform === 'win32'
            ? '.\\gradlew.bat'
            : './gradlew'
          : process.platform === 'win32'
            ? 'mvn.cmd'
            : 'mvn';
      await execute(command, buildArgs(tool, stage, platform, home), {
        cwd: workspace,
        env: { ...env, ...commandEnv(await readCommands(env.GITHUB_ENV)) },
        shell: process.platform === 'win32',
      });
    },
  };
}

export function postState(state) {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => ['STATE_' + key, value]));
}

const workerProfiles = { linux: 'a', windows: 'b', macos: 'c' };
export function buildArgs(tool, stage, platform, home) {
  const profile = workerProfiles[platform];
  assert(profile && ['worker', 'aggregator', 'consumer'].includes(stage));
  const worker = stage === 'worker';
  if (tool === 'gradle') {
    // The selected Linux writer's complete metadata must resolve all three sets offline.
    const tasks = worker && platform !== 'linux' ? [profile.toUpperCase()] : ['A', 'B', 'C'];
    return [
      '--console=plain',
      ...(stage === 'aggregator' ? [] : ['--no-daemon']),
      ...(worker ? [] : ['--offline']),
      ...tasks.map((name) => 'resolveWorker' + name),
      'test',
      'portable',
    ];
  }
  assert.equal(tool, 'maven');
  return [
    '-B',
    '-Dmaven.repo.local=' + home + '/repository',
    ...(worker ? [] : ['--offline']),
    '-P',
    worker ? 'worker-' + profile : 'worker-a,worker-b,worker-c',
    'dependency:resolve',
  ];
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
  if (errors.length) throw new AggregateError(errors, 'Correctness lifecycle and post failed');
}
