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

import { beforeAll, afterAll, afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { installFixture } from './install-fixture';
let directory: string, bundle: string;
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('build/moving-process-'));
  bundle = path.join(directory, 'fixture.mjs');
  await build({
    entryPoints: ['test/cache/streaming/moving-process-fixture.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
it.each([
  ['relocation-marker', 1],
  ['relocation-outbound-rename', 4],
  ['relocation-outbound-evidence', 1],
  ['relocation-outbound-cursor', 2],
  ['relocation-return-rename', 3],
  ['relocation-return-evidence', 2],
  ['relocation-stage-directory-removed', 2],
  ['moving-adjustment-pointer', 1],
  ['moving-relocation-retired', 1],
  ['moving-object-receipt', 1],
] as const)(
  'recovers independent process exit at %s/%i with fixed publication and live sources',
  async (point, nth) => {
    const f = await installFixture('gradle');
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [bundle, 'start', f.root, point, String(nth)], {
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const before = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    execFileSync(process.execPath, [bundle, 'recover', f.root, 'unused', '1'], { stdio: 'pipe' });
    const after = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    expect(after[6]).toEqual(before[6]);
    expect(after[8]).toEqual(before[8]);
    await f.store.assertNoIntents();
    for (const [name, body] of Object.entries({
      'caches/a': 'a',
      'caches/b': 'b',
      'state/b': 'snapshot',
      ['caches/transforms-4/' + 'a'.repeat(32) + '/metadata.bin']: 'm',
      ['caches/transforms-4/' + 'a'.repeat(32) + '/results.bin']: 'r',
      ['caches/transforms-4/' + 'a'.repeat(32) + '/transformed/a']: 'a',
      ['caches/transforms-4/' + 'a'.repeat(32) + '/keep.lock']: 'protected',
    }))
      expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
  },
  30000,
);
