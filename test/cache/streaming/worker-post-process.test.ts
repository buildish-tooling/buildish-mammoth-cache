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

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import { installFixture } from './install-fixture';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
let directory: string, bundle: string;
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('build/worker-post-process-'));
  bundle = directory + '/fixture.mjs';
  await build({
    entryPoints: ['test/cache/streaming/worker-post-process-fixture.ts'],
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
afterAll(() => rm(directory, { recursive: true, force: true }));
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});

it.each(['upload-opened', 'upload-written'])(
  'rejects an interrupted worker post after process exit at %s without changing retained payload',
  async (point) => {
    const f = await installFixture('maven');
    fixtures.push(f);
    const sink = directory + '/' + point + '.tar.gz';
    let status: unknown;
    try {
      execFileSync(process.execPath, [bundle, 'start', f.root, sink, point], { stdio: 'pipe' });
    } catch (error) {
      status = (error as { status: unknown }).status;
      if (status !== 73) process.stderr.write(String((error as { stderr?: Buffer }).stderr));
    }
    expect(status).toBe(73);
    const opened = (await OpenedInvocation.current(f.root, f.budget))!,
      state = opened.store.codec.schemas.documents['local-state'].parse(await opened.store.state());
    expect(state[4]).toBe('post-active');
    expect(state).toHaveLength(8);
    expect(state[7]).toBeNull();
    const packagePath = await readFile(sink + '.package-path', 'utf8'),
      body = await readFile(packagePath),
      before = await readFile(opened.store.root.resolve(opened.store.prefix + 'state.json'));
    expect(() =>
      execFileSync(process.execPath, [bundle, 'retry', f.root, sink, 'unused'], { stdio: 'pipe' }),
    ).toThrow();
    expect(await readFile(opened.store.root.resolve(opened.store.prefix + 'state.json'))).toEqual(
      before,
    );
    expect(await readFile(packagePath)).toEqual(body);
  },
);
it('reads a completed worker terminal in a later process without another upload', async () => {
  const f = await installFixture('maven');
  fixtures.push(f);
  const sink = directory + '/completed.tar.gz';
  let status: unknown;
  try {
    execFileSync(process.execPath, [bundle, 'start', f.root, sink, 'terminal-completed'], {
      stdio: 'pipe',
    });
  } catch (error) {
    status = (error as { status: unknown }).status;
  }
  expect(status).toBe(73);
  const opened = (await OpenedInvocation.current(f.root, f.budget))!;
  expect(opened.state[7]?.[1]).toBe('worker-uploaded');
  const before = await readFile(sink);
  execFileSync(process.execPath, [bundle, 'retry', f.root, sink, 'unused'], { stdio: 'pipe' });
  expect(await readFile(sink)).toEqual(before);
  const packagePath = await readFile(sink + '.package-path', 'utf8');
  await expect(readFile(packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
});
