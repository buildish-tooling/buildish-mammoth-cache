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

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { validateDistribution } from '../scripts/validate-distribution.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const smokeScript = path.resolve('scripts/smoke-test.mjs');
const rootFiles = ['LICENSE', 'NOTICE', 'legal/github/LICENSE', 'legal/github/NOTICE'];

async function writeTreeFile(root: string, file: string, contents: string): Promise<void> {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function createDistribution(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mammoth-distribution-test-'));
  temporaryDirectories.push(root);
  for (const file of rootFiles) await writeTreeFile(root, file, 'Legal fixture\n');
  for (const tool of ['gradle', 'maven']) {
    await writeTreeFile(root, `actions/github/${tool}/action.yml`, descriptor(tool));
    await writeTreeFile(root, `dist/github/${tool}/main/index.cjs`, mainBundle);
    await writeTreeFile(root, `dist/github/${tool}/post/index.cjs`, postBundle);
  }
  return root;
}

function descriptor(tool: string, main = `../../../dist/github/${tool}/main/index.cjs`): string {
  return `runs:\n  using: node24\n  main: ${main}\n  post: ../../../dist/github/${tool}/post/index.cjs\n`;
}

// Exercise the same command-file transport as Actions, including multiline state.
const mainBundle = `
const fs = require('node:fs');
if (process.env.GITHUB_TOKEN || process.env.INPUT_CALLER || process.env.STATE_caller ||
    process.env.NODE_PATH || process.env.NODE_OPTIONS) throw new Error('Caller environment leaked');
if (fs.existsSync(require('node:path').join(process.env.GITHUB_ACTION_PATH, '..', '..', '..', 'node_modules')))
  throw new Error('Distribution contains source dependencies');
fs.writeFileSync('main-ran.txt', 'yes');
fs.appendFileSync(process.env.GITHUB_STATE, 'owner<<END\\nfirst\\nsecond\\nEND\\n');
fs.appendFileSync(process.env.GITHUB_ENV, 'SMOKE_TRANSFER=ok\\n');
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'read-only=true\\njob-mode=standalone\\n');
fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, 'Prepare completed');
`;
const postBundle = `
const fs = require('node:fs');
if (process.env.STATE_owner !== 'first\\nsecond' || process.env.SMOKE_TRANSFER !== 'ok' ||
    fs.readFileSync('main-ran.txt', 'utf8') !== 'yes') throw new Error('Main/post handoff lost');
fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, 'Finalize completed');
`;

async function runSmoke(root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return await execFileAsync(process.execPath, [smokeScript, '--distribution-root', root], {
    env: { ...process.env, ...extraEnv },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Action distribution validation', () => {
  it('uses only the supplied tree and finds all four descriptor-declared entrypoints', async () => {
    const root = await createDistribution();
    const result = await validateDistribution(root);
    expect(result.actions).toEqual([
      {
        name: 'gradle',
        main: 'dist/github/gradle/main/index.cjs',
        post: 'dist/github/gradle/post/index.cjs',
      },
      {
        name: 'maven',
        main: 'dist/github/maven/main/index.cjs',
        post: 'dist/github/maven/post/index.cjs',
      },
    ]);
    expect(result.files).toHaveLength(10);
  });

  it.each(['gradle', 'maven'])(
    'rejects missing %s post bundles even when local build outputs exist',
    async (tool) => {
      const root = await createDistribution();
      await rm(path.join(root, `dist/github/${tool}/post/index.cjs`));
      await expect(validateDistribution(root)).rejects.toThrow(
        `Missing distribution file: dist/github/${tool}/post/index.cjs`,
      );
    },
  );

  it.each(rootFiles)('rejects missing required legal material: %s', async (file) => {
    const root = await createDistribution();
    await rm(path.join(root, file));
    await expect(validateDistribution(root)).rejects.toThrow(`Missing distribution file: ${file}`);
  });

  it('rejects empty legal material', async () => {
    const root = await createDistribution();
    await writeTreeFile(root, 'legal/github/LICENSE', ' \n');
    await expect(validateDistribution(root)).rejects.toThrow('Distribution legal file is empty');
  });

  it.each(['/tmp/entry.cjs', 'C:/entry.cjs', '../../../../entry.cjs', '../../../src/entry.cjs'])(
    'rejects invalid entrypoint path %s',
    async (entrypoint) => {
      const root = await createDistribution();
      await writeTreeFile(
        root,
        'actions/github/gradle/action.yml',
        descriptor('gradle', entrypoint),
      );
      await expect(validateDistribution(root)).rejects.toThrow(
        /relative bundle path|resolve inside dist/u,
      );
    },
  );

  it('rejects a bundle symlink escaping the distribution', async () => {
    const root = await createDistribution();
    const outside = await createDistribution();
    const bundle = path.join(root, 'dist/github/gradle/main/index.cjs');
    await rm(bundle);
    await symlink(path.join(outside, 'dist/github/gradle/main/index.cjs'), bundle);
    await expect(validateDistribution(root)).rejects.toThrow('resolves outside the supplied tree');
  });

  it('rejects a descriptor that aliases main and post to one file', async () => {
    const root = await createDistribution();
    await writeTreeFile(
      root,
      'actions/github/gradle/action.yml',
      descriptor('gradle', '../../../dist/github/gradle/post/index.cjs'),
    );
    await expect(validateDistribution(root)).rejects.toThrow('must name a distinct bundle');
  });

  it('rejects unsupported Action runtimes', async () => {
    const root = await createDistribution();
    await writeTreeFile(
      root,
      'actions/github/gradle/action.yml',
      descriptor('gradle').replace('node24', 'node20'),
    );
    await expect(validateDistribution(root)).rejects.toThrow('expected runs.using to be node24');
  });

  it('rejects directories in place of executable bundles', async () => {
    const root = await createDistribution();
    const bundle = path.join(root, 'dist/github/gradle/main/index.cjs');
    await rm(bundle);
    await mkdir(bundle);
    await expect(validateDistribution(root)).rejects.toThrow('non-empty regular file');
  });
});

describe('isolated distribution smoke test', () => {
  it.each([false, true])(
    'rejects project-local temporary directories (symlink: %s)',
    async (useSymlink) => {
      const root = await createDistribution();
      const buildRoot = path.resolve('build');
      await mkdir(buildRoot, { recursive: true });
      const localTemp = await mkdtemp(path.join(buildRoot, 'distribution-temp-test-'));
      temporaryDirectories.push(localTemp);
      let selectedTemp = localTemp;
      if (useSymlink) {
        selectedTemp = path.join(root, 'linked-temp');
        await symlink(localTemp, selectedTemp, 'junction');
      }
      await writeTreeFile(root, 'dist/github/gradle/main/index.cjs', "require('yaml');\n");
      await expect(
        runSmoke(root, { TMPDIR: selectedTemp, TEMP: selectedTemp, TMP: selectedTemp }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          'Temporary directory must be outside the source and distribution trees',
        ),
      });
    },
  );

  it('preserves the documented Windows GPG executable selector', async () => {
    const root = await createDistribution();
    const gpgCommand = String.raw`C:\Program Files\GnuPG\bin\gpg.exe`;
    await writeTreeFile(
      root,
      'dist/github/gradle/main/index.cjs',
      `if (process.env.BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND !== ${JSON.stringify(gpgCommand)}) throw new Error('GPG selector lost');\n${mainBundle}`,
    );
    await expect(
      runSmoke(root, { BUILDISH_MAMMOTH_CACHE_GRADLE_GPG_COMMAND: gpgCommand }),
    ).resolves.toHaveProperty('stdout', expect.stringContaining('Verified gradle:'));
  });

  it('executes all main/post entrypoints, forwards command files, and removes caller credentials/overrides', async () => {
    const root = await createDistribution();
    const before = await readFile(path.join(root, 'dist/github/gradle/main/index.cjs'), 'utf8');
    const result = await runSmoke(root, {
      GITHUB_TOKEN: 'synthetic-test-token',
      INPUT_CALLER: 'unexpected',
      STATE_caller: 'unexpected',
      NODE_PATH: path.resolve('node_modules'),
      NODE_OPTIONS: '--stack-trace-limit=50',
    });
    expect(result.stdout).toContain('Verified gradle:');
    expect(result.stdout).toContain('Verified maven:');
    expect(await readFile(path.join(root, 'dist/github/gradle/main/index.cjs'), 'utf8')).toBe(
      before,
    );
    await expect(readFile(path.join(root, 'main-ran.txt'))).rejects.toThrow();
  });

  it('rejects an unbundled dependency instead of finding it in source node_modules', async () => {
    const root = await createDistribution();
    await writeTreeFile(root, 'dist/github/gradle/main/index.cjs', "require('yaml');\n");
    await expect(runSmoke(root)).rejects.toMatchObject({
      stderr: expect.stringContaining("Cannot find module 'yaml'"),
    });
  });

  it('rejects a post phase that exits successfully without doing any work', async () => {
    const root = await createDistribution();
    await writeTreeFile(root, 'dist/github/maven/post/index.cjs', '// no-op\n');
    await expect(runSmoke(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('maven post did not produce a job summary'),
    });
  });

  it('propagates a failing post entrypoint', async () => {
    const root = await createDistribution();
    await writeTreeFile(root, 'dist/github/maven/post/index.cjs', 'process.exit(23);\n');
    await expect(runSmoke(root)).rejects.toMatchObject({
      stderr: expect.stringContaining('failed (23)'),
    });
  });
});
