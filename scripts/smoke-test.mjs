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

import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateDistribution } from './validate-distribution.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--distribution-root')) {
    throw new Error('Usage: node scripts/smoke-test.mjs [--distribution-root <tree>]');
  }
  const distribution = await validateDistribution(path.resolve(argv[1] ?? repoRoot));
  const stagedRoot = await createStagingRoot(distribution.root);
  try {
    const actionRoot = path.join(stagedRoot, 'action');
    for (const file of distribution.files) {
      const destination = path.join(actionRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(distribution.root, file), destination, { dereference: true });
    }

    for (const action of distribution.actions) {
      await runScenario(actionRoot, action, stagedRoot);
    }
    console.log('Distribution verified: Gradle and Maven main/post bundles executed in isolation.');
  } finally {
    await rm(stagedRoot, { recursive: true, force: true });
  }
}

async function createStagingRoot(distributionRoot) {
  // TMPDIR/TEMP can point inside a checkout, including through a symlink.
  const temporaryRoot = await realpath(os.tmpdir());
  for (const tree of [await realpath(repoRoot), distributionRoot]) {
    const relative = path.relative(tree, temporaryRoot);
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ) {
      throw new Error('Temporary directory must be outside the source and distribution trees.');
    }
  }
  // --no-global-search-paths does not disable normal CommonJS ancestor lookup.
  for (let directory = temporaryRoot; ; directory = path.dirname(directory)) {
    const modules = path.join(directory, 'node_modules');
    const exists = await stat(modules)
      .then(() => true)
      .catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    if (exists) {
      throw new Error(
        `Temporary directory permits dependency lookup from ${modules}; choose an isolated temporary directory.`,
      );
    }
    if (path.dirname(directory) === directory) break;
  }
  // Leave room for GnuPG's Unix socket names in the isolated fixture.
  return await mkdtemp(path.join(temporaryRoot, 'mammoth-'));
}

async function runScenario(actionRoot, action, stagedRoot) {
  const scenarioRoot = path.join(stagedRoot, action.name);
  const workspace = path.join(scenarioRoot, 'workspace');
  const homePath = path.join(scenarioRoot, 'home');
  const runnerTemp = path.join(scenarioRoot, 'runner-temp');
  const fixture = path.join(repoRoot, 'test', 'fixtures', 'smoke');
  await cp(action.name === 'maven' ? path.join(fixture, 'maven') : fixture, workspace, {
    recursive: true,
  });
  await mkdir(homePath, { recursive: true });
  await mkdir(runnerTemp, { recursive: true });

  const summaryFile = path.join(scenarioRoot, 'summary.md');
  const stateFile = path.join(scenarioRoot, 'state.txt');
  const outputFile = path.join(scenarioRoot, 'output.txt');
  const envFile = path.join(scenarioRoot, 'env.txt');
  for (const file of [summaryFile, stateFile, outputFile, envFile]) {
    await writeFile(file, '', 'utf8');
  }

  // Do not pass caller credentials, action inputs/state, or Node module overrides.
  const inherited = Object.fromEntries(
    [
      'PATH',
      'Path',
      'SystemRoot',
      'SYSTEMROOT',
      'ComSpec',
      'PATHEXT',
      'JAVA_HOME',
      'BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND',
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  const env = {
    ...inherited,
    CI: 'true',
    GITHUB_ACTION: '__run',
    GITHUB_ACTION_PATH: path.join(actionRoot, 'actions', 'github', action.name),
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: 'buildish-tooling/buildish-mammoth-cache',
    GITHUB_WORKFLOW: 'Local Distribution Check',
    GITHUB_JOB: `smoke-${action.name}`,
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    GITHUB_WORKSPACE: workspace,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_STATE: stateFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_ENV: envFile,
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: path.join(homePath, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homePath, 'AppData', 'Local'),
    XDG_CACHE_HOME: path.join(homePath, '.cache'),
    TMPDIR: runnerTemp,
    TEMP: runnerTemp,
    TMP: runnerTemp,
    RUNNER_TEMP: runnerTemp,
    RUNNER_OS:
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    RUNNER_ARCH: process.arch === 'x64' ? 'X64' : process.arch.toUpperCase(),
    GRADLE_USER_HOME: path.join(homePath, '.gradle'),
    MAVEN_USER_HOME: path.join(homePath, '.m2'),
    'INPUT_BASE-DIRECTORY': '.',
    'INPUT_CACHE-ENABLED': 'false',
    'INPUT_READ-ONLY': 'true',
  };

  await runBundle(path.join(actionRoot, action.main), workspace, env);
  await requireSummary(summaryFile, `${action.name} main`);
  const outputs = parseFileCommands(await readFile(outputFile, 'utf8'));
  if (outputs['read-only'] !== 'true' || outputs['job-mode'] !== 'standalone') {
    throw new Error(`${action.name} main did not emit the expected public outputs.`);
  }

  const state = Object.fromEntries(
    Object.entries(parseFileCommands(await readFile(stateFile, 'utf8'))).map(([key, value]) => [
      `STATE_${key}`,
      value,
    ]),
  );
  await writeFile(summaryFile, '', 'utf8');
  await runBundle(path.join(actionRoot, action.post), workspace, {
    ...env,
    ...parseFileCommands(await readFile(envFile, 'utf8')),
    ...state,
  });
  // A post bundle which silently skips because state was lost is not success.
  await requireSummary(summaryFile, `${action.name} post`);
  console.log(`Verified ${action.name}: ${action.main} and ${action.post}`);
}

async function requireSummary(file, phase) {
  if ((await readFile(file, 'utf8')).trim().length === 0) {
    throw new Error(`${phase} did not produce a job summary.`);
  }
}

function parseFileCommands(contents) {
  const lines = contents.split(/\r?\n/u);
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const equals = line.indexOf('=');
    const marker = line.indexOf('<<');
    if (equals > 0 && (marker < 0 || equals < marker)) {
      values[line.slice(0, equals)] = line.slice(equals + 1);
    } else if (marker > 0) {
      const delimiter = line.slice(marker + 2);
      const start = index + 1;
      while (index + 1 < lines.length && lines[index + 1] !== delimiter) index += 1;
      if (!delimiter || index + 1 >= lines.length) {
        throw new Error('Unterminated GitHub file command in distribution smoke test.');
      }
      values[line.slice(0, marker)] = lines.slice(start, index + 1).join('\n');
      index += 1;
    } else {
      throw new Error('Malformed GitHub file command in distribution smoke test.');
    }
  }
  return values;
}

async function runBundle(bundle, cwd, env) {
  const child = spawn(process.execPath, ['--no-global-search-paths', bundle], {
    cwd,
    env,
    stdio: 'inherit',
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`Distribution bundle ${bundle} failed (${signal ?? code}).`));
      } else {
        resolve();
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
