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

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
let directory: string, bundle: string;
const roots: string[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('build/prepare-process-'));
  bundle = directory + '/fixture.mjs';
  await build({
    entryPoints: ['test/cache/streaming/prepare-process-fixture.ts'],
    outfile: bundle,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  });
});
afterAll(async () => {
  for (const root of [directory, ...roots]) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(path.resolve('build/prepare-root-'));
  roots.push(value);
  return value;
}
function run(mode: string, root: string, point = 'unused') {
  return execFileSync(process.execPath, [bundle, mode, root, point], {
    stdio: 'pipe',
    timeout: 15000,
  });
}
function crash(mode: string, root: string, point: string) {
  let status: unknown;
  try {
    run(mode, root, point);
  } catch (error) {
    status = (error as { status: unknown }).status;
    if (status !== 73) process.stderr.write(String((error as { stderr?: Buffer }).stderr ?? error));
  }
  expect(status).toBe(73);
}
it.each(['prepare-base-installed', 'prepare-workers-installed', 'prepare-ready'])(
  'rejects interrupted main re-entry at %s without adopting old operation state',
  async (point) => {
    const value = await root();
    crash('start', value, point);
    expect(() => run('retry', value)).toThrow();
    const budget = new WorkingBudget(),
      opened = await OpenedInvocation.current(value, budget);
    expect(opened?.state[4]).toBe(point === 'prepare-ready' ? 'build-ready' : 'prepare-pending');
    expect(opened?.state).toHaveLength(8);
    expect(opened?.bindings).toHaveLength(9);
    expect(budget.retained).toBe(0);
  },
);
it('runs successful local-v2 main and post in distinct actual OS processes', async () => {
  const value = await root();
  run('success', value);
  await writeFile(value + '/data/keep', 'ordinary');
  const budget = new WorkingBudget(),
    prepared = await OpenedInvocation.current(value, budget);
  expect(prepared?.state[4]).toBe('build-ready');
  run('post', value);
  const completed = await OpenedInvocation.current(value, budget);
  expect(completed?.state[4]).toBe('completed');
  expect(completed?.state[7]?.[1]).toBe('published');
  expect(await readFile(value + '/data/keep', 'utf8')).toBe('ordinary');
  expect(budget.retained).toBe(0);
});
it('rejects actual interrupted post after SDK source evacuation without replaying publication', async () => {
  const value = await root();
  run('success', value);
  await writeFile(value + '/data/keep', 'ordinary');
  crash('post-crash', value, 'unused');
  const budget = new WorkingBudget(),
    interrupted = await OpenedInvocation.current(value, budget);
  expect(interrupted?.state[4]).toBe('post-active');
  expect(() => run('post', value)).toThrow();
  expect(budget.retained).toBe(0);
});
