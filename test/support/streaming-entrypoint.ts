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

import { mkdtemp, mkdir, readFile, writeFile, appendFile, cp, utimes } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

export function fileCommands(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/),
    values: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const n = lines[i].indexOf('<<');
    if (n < 0) continue;
    const key = lines[i].slice(0, n),
      delimiter = lines[i].slice(n + 2),
      body = [];
    while (++i < lines.length && lines[i] !== delimiter) body.push(lines[i]);
    if (i === lines.length) throw new Error('Unterminated file command');
    values[key] = body.join('\n');
  }
  return values;
}
export async function entrypointBundles(root: string, native = false) {
  const builds = [];
  for (const tool of ['gradle', 'maven'])
    for (const phase of ['main', 'post']) {
      const outfile = root + '/' + tool + '-' + phase + '.cjs';
      const result = await build({
        entryPoints: ['src/ci/github/' + tool + '/' + phase + '.ts'],
        outfile,
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        metafile: true,
        alias: {
          '@actions/cache': path.resolve('test/support/entrypoint-sdk.ts'),
          '@actions/artifact': path.resolve('test/support/entrypoint-sdk.ts'),
        },
        plugins: native
          ? []
          : [
              {
                name: 'controlled-native-observation',
                setup(b) {
                  b.onResolve({ filter: /native$/ }, (args) => {
                    if (
                      path.resolve(args.importer) ===
                      path.resolve('test/support/entrypoint-native-work.ts')
                    )
                      return undefined;
                    return path.resolve(args.resolveDir, args.path) ===
                      path.resolve('src/cache/streaming/native')
                      ? { path: path.resolve('test/support/entrypoint-native-work.ts') }
                      : undefined;
                  });
                  b.onResolve({ filter: /^\.\/wrapper\/download$/ }, () => ({
                    path: path.resolve('test/support/entrypoint-wrapper.ts'),
                  }));
                  b.onResolve({ filter: /^\.\/process-inspection$/ }, (args) =>
                    path.dirname(args.importer) === path.resolve('src/build-tool/gradle')
                      ? { path: path.resolve('test/support/entrypoint-process-evidence.ts') }
                      : undefined,
                  );
                },
              },
            ],
        logLevel: 'silent',
      });
      builds.push({ tool, phase, outfile, inputs: Object.keys(result.metafile!.inputs) });
    }
  return builds;
}
export async function entrypointJob(
  root: string,
  tool: string,
  name: string,
  inputs: Record<string, string> = {},
  store?: string,
) {
  const job = await mkdtemp(root + '/job-'),
    workspace = job + '/workspace',
    home = job + '/home',
    temp = job + '/temp';
  store ??= job + '/service';
  for (const dir of [workspace, home, temp, store]) await mkdir(dir, { recursive: true });
  for (const file of ['state', 'output', 'env', 'summary', 'trace'])
    await writeFile(job + '/' + file, '');
  if (tool === 'gradle')
    await cp(path.resolve('test/fixtures/smoke/gradle'), workspace + '/gradle', {
      recursive: true,
    });
  const event = job + '/event.json';
  await writeFile(event, JSON.stringify({ repository: { default_branch: 'main' } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_ACTION: 'mammoth',
    GITHUB_SERVER_URL: 'https://github.com',
    ACTIONS_CACHE_SERVICE_V2: '1',
    GITHUB_ACTION_PATH: process.cwd() + '/actions/github/' + tool,
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_WORKFLOW: 'Entrypoint test',
    GITHUB_JOB: name,
    GITHUB_RUN_ID: '7001',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'rev',
    GITHUB_WORKSPACE: workspace,
    GITHUB_STATE: job + '/state',
    GITHUB_OUTPUT: job + '/output',
    GITHUB_ENV: job + '/env',
    GITHUB_STEP_SUMMARY: job + '/summary',
    RUNNER_TEMP: temp,
    GRADLE_USER_HOME: home,
    MAVEN_USER_HOME: home,
    MAMMOTH_TEST_STORE: store,
    MAMMOTH_TEST_TRACE: job + '/trace',
    'INPUT_PROCESS-ALL-WRAPPER-FILES': 'true',
    'INPUT_CACHE-GC-MODE': 'off',
    'INPUT_GITHUB-JOB-NAME': name,
    'INPUT_GITHUB-REF-NAME': 'main',
    'INPUT_GITHUB-DEFAULT-BRANCH': 'main',
  };
  // Avoid inheriting the surrounding runner's unrelated Action state/input switches.
  for (const key of Object.keys(env))
    if (
      /^(?:STATE_|INPUT_)/.test(key) &&
      !(
        key in
        {
          'INPUT_PROCESS-ALL-WRAPPER-FILES': 1,
          'INPUT_CACHE-GC-MODE': 1,
          'INPUT_GITHUB-JOB-NAME': 1,
          'INPUT_GITHUB-REF-NAME': 1,
          'INPUT_GITHUB-DEFAULT-BRANCH': 1,
        }
      )
    )
      delete env[key];
  for (const [key, value] of Object.entries(inputs)) env['INPUT_' + key.toUpperCase()] = value;
  async function run(phase: string, overrides: NodeJS.ProcessEnv = {}, delegateTool = tool) {
    const state =
      phase === 'post'
        ? Object.fromEntries(
            Object.entries(fileCommands(await readFile(job + '/state', 'utf8'))).map(
              ([key, value]) => ['STATE_' + key, value],
            ),
          )
        : {};
    return promisify(execFile)(
      process.execPath,
      [root + '/' + delegateTool + '-' + phase + '.cjs'],
      {
        cwd: workspace,
        env: { ...env, ...state, ...overrides },
        timeout: 60000,
        maxBuffer: 2 ** 20,
      },
    ).catch((error) => {
      throw new Error(error.message + '\n' + error.stdout + '\n' + error.stderr, { cause: error });
    });
  }
  return {
    job,
    workspace,
    home,
    temp,
    env,
    run,
    store,
    outputs: async () => fileCommands(await readFile(job + '/output', 'utf8')),
    state: async () => fileCommands(await readFile(job + '/state', 'utf8')),
    trace: async () =>
      (await readFile(job + '/trace', 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row) as [string, unknown]),
    clearTrace: () => writeFile(job + '/trace', ''),
    write: async (name: string, body: string) => {
      await mkdir(path.dirname(home + '/' + name), { recursive: true });
      await writeFile(home + '/' + name, body);
      // The SDK double copies native files, so avoid fractional-copy timestamp drift on NTFS.
      const seconds = Math.ceil(Date.now() / 1000);
      await utimes(home + '/' + name, seconds, seconds);
    },
    addState: async (key: string, value: string) =>
      appendFile(job + '/state', key + '<<TESTSTATE\n' + value + '\nTESTSTATE\n'),
  };
}
