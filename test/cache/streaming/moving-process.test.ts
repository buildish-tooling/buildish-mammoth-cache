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
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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

it.each([
  'relocation-outbound-rename',
  'relocation-outbound-cursor',
  'relocation-return-rename',
  'moving-adjustment-pointer',
] as const)(
  'returns the same Maven coarse root after process exit at %s',
  async (point) => {
    const f = await installFixture('maven');
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [bundle, 'start', f.root, point, '1', 'maven'], {
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const before = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    execFileSync(process.execPath, [bundle, 'recover', f.root, 'unused', '1', 'maven'], {
      stdio: 'pipe',
    });
    const after = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    expect(after[6]).toEqual(before[6]);
    expect(after[8]).toEqual(before[8]);
    await f.store.assertNoIntents();
    expect(await readFile(f.store.root.resolve('repository/org/a/1/a.jar'), 'utf8')).toBe('a');
    expect(await readFile(f.store.root.resolve('repository/org/b/1/b.jar'), 'utf8')).toBe('b');
    expect(
      await readFile(f.store.root.resolve('repository/org/a/1/_remote.repositories'), 'utf8'),
    ).toBe('marker');
  },
  30000,
);

it.each(['observation-purge-unlinked', 'observations-candidate', 'observations-pointer'] as const)(
  'retries purge conservatively after actual process exit at %s',
  async (point) => {
    const unit = 'caches/transforms-4/' + 'a'.repeat(32),
      purgeGlobs = [unit + '/*.lock', unit + '/a.lock'],
      f = await installFixture('gradle', { purgeGlobs });
    fixtures.push(f);
    let status: unknown;
    try {
      execFileSync(process.execPath, [bundle, 'start', f.root, point, '1', 'purge'], {
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status: unknown }).status;
    }
    expect(status).toBe(73);
    const before = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    if (point === 'observations-pointer')
      await writeFile(f.store.root.resolve(unit + '/a.lock'), 'new-after-commit');
    const result = JSON.parse(
      execFileSync(process.execPath, [bundle, 'recover', f.root, 'unused', '1', 'purge'], {
        encoding: 'utf8',
      }).trim(),
    ) as { deleted: number; frozen: boolean };
    const after = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
    expect(after[5]).toEqual(before[5]);
    expect(after[6]).not.toBeNull();
    if (point === 'observations-pointer') {
      expect(after[6]).toEqual(before[6]);
      expect(result).toEqual({ deleted: 0, frozen: true });
      expect(await readFile(f.store.root.resolve(unit + '/a.lock'), 'utf8')).toBe(
        'new-after-commit',
      );
    } else {
      expect(result).toEqual({
        deleted: point === 'observation-purge-unlinked' ? 1 : 0,
        frozen: false,
      });
      const units: unknown[] = [];
      await f.store.readStream(
        after[6]!,
        'observations',
        { budget: f.budget, partition: null },
        async (row) => {
          if (Array.isArray(row) && row[0] === 'unit-open') units.push(row);
        },
      );
      expect(units).toHaveLength(1);
      expect((units[0] as unknown[]).slice(4, 6)).toEqual(['upsert', 'retain']);
      expect(await f.store.root.stat(unit + '/a.lock')).toBeNull();
      expect(await f.store.root.stat(unit + '/b.lock')).toBeNull();
    }
    expect(await readFile(f.store.root.resolve(unit + '/transformed/a'), 'utf8')).toBe('payload');
    await f.store.assertNoIntents();
    expect(f.budget.retained).toBe(0);
  },
  30000,
);
