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

import { access } from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCENARIOS = [
  {
    name: 'gradle',
    bundlePathParts: ['dist', 'github', 'gradle', 'main', 'index.cjs'],
    fixturePathParts: ['test', 'fixtures', 'smoke'],
    committedForbiddenPathParts: [
      'test',
      'fixtures',
      'smoke',
      'gradle',
      'wrapper',
      'gradle-wrapper.jar',
    ],
  },
  {
    name: 'maven',
    bundlePathParts: ['dist', 'github', 'maven', 'main', 'index.cjs'],
    fixturePathParts: ['test', 'fixtures', 'smoke', 'maven'],
  },
];

async function main() {
  const repoRoot = process.cwd();
  const runnerOs = normalizeRunnerOs(process.platform);
  const runnerArch = normalizeRunnerArch(process.arch);

  for (const scenario of SCENARIOS) {
    const bundlePath = path.join(repoRoot, ...scenario.bundlePathParts);
    const fixturePath = path.join(repoRoot, ...scenario.fixturePathParts);

    await access(bundlePath).catch(() => {
      throw new Error(
        `Missing bundled action entrypoint at '${bundlePath}'. Run 'make build' first.`,
      );
    });
    await access(fixturePath).catch(() => {
      throw new Error(`Missing smoke fixture directory at '${fixturePath}'.`);
    });

    const buildRoot = path.join(repoRoot, 'build');
    await mkdir(buildRoot, { recursive: true });

    const stagedRoot = await mkdtemp(path.join(buildRoot, `smoke-fixture-${scenario.name}-`));
    const fixtureCopyPath = path.join(stagedRoot, path.basename(fixturePath));
    const homePath = path.join(stagedRoot, 'home');
    const runnerTempPath = path.join(stagedRoot, 'runner-temp');
    const summaryFile = path.join(stagedRoot, 'step-summary.md');

    try {
      await cp(fixturePath, fixtureCopyPath, { recursive: true });
      await mkdir(homePath, { recursive: true });
      await mkdir(runnerTempPath, { recursive: true });
      await writeFile(summaryFile, '', 'utf8');

      const baseDirectory = toPosixPath(path.relative(repoRoot, fixtureCopyPath));
      const exitCode = await runProcess(process.execPath, [bundlePath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: 'true',
          GITHUB_ACTION: '__run',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REF_NAME: 'main',
          GITHUB_REPOSITORY: 'buildish-tooling/buildish',
          GITHUB_WORKFLOW: 'Local Smoke Test',
          GITHUB_JOB: `smoke-${scenario.name}`,
          GITHUB_RUN_ID: '1',
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_WORKSPACE: repoRoot,
          HOME: homePath,
          RUNNER_TEMP: runnerTempPath,
          RUNNER_OS: runnerOs,
          RUNNER_ARCH: runnerArch,
          GITHUB_STEP_SUMMARY: summaryFile,
          'INPUT_BASE-DIRECTORY': baseDirectory,
          ...createScenarioToolHomeEnv(scenario.name, homePath),
        },
      });

      const summary = await readFile(summaryFile, 'utf8').catch(() => '');
      if (summary.trim().length > 0) {
        console.log(`--- ${scenario.name} summary ---`);
        process.stdout.write(summary.endsWith(os.EOL) ? summary : `${summary}${os.EOL}`);
      }

      if (scenario.committedForbiddenPathParts) {
        const committedForbiddenPath = path.join(repoRoot, ...scenario.committedForbiddenPathParts);
        await assertPathDoesNotExist(committedForbiddenPath);
      }

      process.exitCode = exitCode;
      if (exitCode !== 0) {
        return;
      }
    } finally {
      await rm(stagedRoot, { recursive: true, force: true });
    }
  }
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function createScenarioToolHomeEnv(scenarioName, homePath) {
  if (scenarioName === 'gradle') {
    return {
      GRADLE_USER_HOME: path.join(homePath, '.gradle'),
    };
  }
  if (scenarioName === 'maven') {
    return {
      MAVEN_USER_HOME: path.join(homePath, '.m2'),
    };
  }
  throw new Error(`Unsupported smoke-test scenario '${scenarioName}'.`);
}

function normalizeRunnerOs(platform) {
  if (platform === 'darwin') {
    return 'macOS';
  }
  if (platform === 'win32') {
    return 'Windows';
  }
  return 'Linux';
}

function normalizeRunnerArch(arch) {
  if (arch === 'x64') {
    return 'X64';
  }
  if (arch === 'arm64') {
    return 'ARM64';
  }
  return arch.toUpperCase();
}

async function assertPathDoesNotExist(filePath) {
  await access(filePath)
    .then(() => {
      throw new Error(`Smoke test must not modify committed fixtures: '${filePath}'.`);
    })
    .catch((error) => {
      if (
        (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') ||
        error === undefined
      ) {
        return;
      }

      throw error;
    });
}

async function runProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });

  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Process '${command}' terminated by signal ${signal}.`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

await main();
