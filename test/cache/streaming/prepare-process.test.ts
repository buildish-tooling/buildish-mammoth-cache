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
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
let directory: string, bundle: string;
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
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
afterAll(() => rm(directory, { recursive: true, force: true }));
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
function crash(root: string, point: string) {
  let status: unknown;
  try {
    execFileSync(process.execPath, [bundle, 'start', root, point], { stdio: 'pipe' });
  } catch (error) {
    status = (error as { status: unknown }).status;
    if (status !== 73) process.stderr.write(String((error as { stderr?: Buffer }).stderr ?? error));
  }
  expect(status).toBe(73);
}
it.each([
  'install-intent-published',
  'prepare-base-installed',
  'prepare-workers-installed',
  'prepare-ready',
])('cold retries actual composed prepare after process exit at %s', async (point) => {
  const f = await installFixture('maven');
  fixtures.push(f);
  crash(f.root, point);
  execFileSync(process.execPath, [bundle, 'retry', f.root, 'unused'], { stdio: 'pipe' });
  const opened = await OpenedInvocation.current(f.root, f.budget);
  expect(opened?.state[4]).toBe('build-ready');
  expect(opened?.bindings[8][7]).toBe(12345);
  expect(await readFile(f.store.root.resolve('data/keep'), 'utf8')).toBe('ordinary');
  expect(await f.store.root.stat('state/stale')).toBeNull();
  await opened!.store.assertNoIntents();
});
it('reconciles an old active install and retires its completed owner before any new provision/backend callback', async () => {
  const f = await installFixture('maven');
  fixtures.push(f);
  crash(f.root, 'install-intent-published');
  const order: string[] = [];
  const ready = await prepareStreaming({
    root: f.root,
    model: f.model,
    context: f.store.codec.options.context,
    nonce: 'b'.repeat(32),
    budget: f.budget,
    policy: {
      role: 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: [],
    },
    currentRef: 'refs/heads/main',
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    saveAnchor: () => {},
    cacheBackend: async () => {
      order.push('backend');
      return {
        capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
        isFeatureAvailable: () => true,
        restoreCache: async () => undefined,
        saveCache: async () => 1,
        isMissingPathsError: () => false,
      };
    },
    provision: async () => {
      expect(await f.store.root.stat('state/stale')).toBeNull();
      expect(await f.store.root.stat(f.store.prefix.slice(0, -1))).toBeNull();
      order.push('provision');
    },
    installHooks: async () => {
      order.push('hooks');
    },
    assertCurrent: (): undefined => {},
  });
  expect(order).toEqual(['provision', 'backend', 'hooks']);
  expect(ready.store.codec.options.invocation).not.toBe(f.store.codec.options.invocation);
});
