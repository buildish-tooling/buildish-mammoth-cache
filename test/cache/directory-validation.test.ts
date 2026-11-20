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
import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectoryValidationBatch } from '../../src/cache/guarded-files';
import * as guarded from '../../src/cache/guarded-files';
import { STAGING_BATCH_SIZE } from '../../src/cache/staged-files';
import { applyCutoffPlan } from '../../src/delta/cutoff-apply';
import { cutoffFixtureModel } from '../support/cutoff-fixture';
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/directory-batch-'));
  roots.push(root);
  return root;
}
it('validates distinct ancestors once, including safe creation and sibling sharing', async () => {
  const root = await fixture();
  const calls = vi.spyOn(fs, 'lstat');
  const batch = new DirectoryValidationBatch(root);
  await batch.verify('data/a/b', true);
  calls.mockClear();
  for (let i = 0; i < 100; i++) await batch.verify('data/a/b', true);
  expect(calls).not.toHaveBeenCalled();
  await batch.verify('data/a/c', true);
  expect(calls.mock.calls.map(([name]) => String(name))).toEqual([
    path.join(root, 'data/a/c'),
    path.join(root, 'data/a/c'),
  ]);
});
it('invalidates recreated subtrees and never shares evidence with retries', async () => {
  const root = await fixture(),
    batch = new DirectoryValidationBatch(root);
  await batch.verify('data/a', true);
  batch.invalidate('data');
  await rm(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data'), 'unsafe');
  await expect(batch.verify('data/a')).rejects.toThrow(/Unsafe directory/);
  await expect(new DirectoryValidationBatch(root).verify('data/a')).rejects.toThrow(
    /Unsafe directory/,
  );
});
it('does not cache missing directories and rejects deep links', async () => {
  const root = await fixture(),
    batch = new DirectoryValidationBatch(root);
  await batch.verify('data/a');
  await mkdir(path.join(root, 'data'));
  await fs.symlink(root, path.join(root, 'data/a'), 'dir');
  await expect(batch.verify('data/a')).rejects.toThrow(/Unsafe directory/);
});
it.each([10, 100])(
  'worker installation of %s sibling files walks ancestors once per phase',
  async (count) => {
    const root = await fixture(),
      source = await fixture();
    await mkdir(path.join(root, 'data/a'), { recursive: true });
    await mkdir(path.join(source, 'payload'));
    const upserts = [];
    for (let i = 0; i < count; i++) {
      await writeFile(path.join(source, `payload/${String(i).padStart(6, '0')}.bin`), 'x');
      upserts.push({
        partitionId: 'data',
        rootDirectory: source,
        entry: {
          relativePath: `data/a/${i}`,
          payloadPath: `payload/${String(i).padStart(6, '0')}.bin`,
          size: 1,
          mode: 0o644,
          mtimeMs: 1700000000000,
          contentSha256: createHash('sha256').update('x').digest('hex'),
        },
      });
    }
    const calls = vi.spyOn(fs, 'lstat');
    await applyCutoffPlan({ upserts, used: [] }, cutoffFixtureModel(root));
    // Preflight, destination staging, commit, cleanup: independent evidence at each boundary.
    expect(
      calls.mock.calls.filter(([name]) => String(name) === path.join(root, 'data/a')),
    ).toHaveLength(3 + 2 * Math.ceil(count / STAGING_BATCH_SIZE));
    expect(
      calls.mock.calls.filter(([name]) => String(name) === path.join(source, 'payload')),
    ).toHaveLength(Math.ceil(count / STAGING_BATCH_SIZE));
  },
);

it.each(['reserved', 'ancestor'])(
  'retained output handles prevent redirected writes after %s substitution',
  async (which) => {
    const root = await fixture(),
      source = await fixture(),
      outside = await fixture();
    await mkdir(path.join(root, 'data/a'), { recursive: true });
    await mkdir(path.join(source, 'payload'));
    const upserts = [];
    for (let i = 0; i < 2; i++) {
      const payloadPath = `payload/${String(i).padStart(6, '0')}.bin`;
      await writeFile(path.join(source, payloadPath), 'x');
      upserts.push({
        partitionId: 'data',
        rootDirectory: source,
        entry: {
          relativePath: `data/a/${i}`,
          payloadPath,
          size: 1,
          mode: 0o644,
          mtimeMs: 1700000000000,
          contentSha256: createHash('sha256').update('x').digest('hex'),
        },
      });
    }
    const original = guarded.copyGuardedFile;
    const copy = vi.spyOn(guarded, 'copyGuardedFile').mockImplementationOnce(async (...args) => {
      const digest = await original(...args);
      const reserved = path.join(root, 'data/a/.mammoth');
      if (which === 'reserved') {
        await fs.rename(reserved, path.join(root, 'old-stage'));
        await fs.symlink(outside, reserved, 'dir');
      } else {
        await fs.rename(path.join(root, 'data/a'), path.join(outside, 'moved'));
        await fs.symlink(path.join(outside, 'moved'), path.join(root, 'data/a'), 'dir');
      }
      return digest;
    });
    await expect(applyCutoffPlan({ upserts, used: [] }, cutoffFixtureModel(root))).rejects.toThrow(
      /Unsafe directory/,
    );
    expect(copy).toHaveBeenCalledTimes(2);
    if (which === 'reserved') expect(await fs.readdir(outside)).toEqual([]);
    else {
      expect(await fs.readdir(path.join(outside, 'moved'))).toEqual(['.mammoth']);
      expect(await fs.readdir(path.join(outside, 'moved/.mammoth'))).toHaveLength(2);
    }
  },
);
