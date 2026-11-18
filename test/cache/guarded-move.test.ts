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
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { moveGuardedFile, recoverInterruptedMoves } from '../../src/cache/guarded-files';
import { createHash } from 'node:crypto';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each([false, true])(
  'moves verified bytes with cross-filesystem fallback=%s',
  async (crossDevice) => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/guarded-move-'));
    roots.push(root);
    const source = path.join(root, 'source'),
      target = path.join(root, 'target');
    await writeFile(source, 'new bytes');
    await writeFile(target, 'old bytes');
    const original = fs.rename;
    let injected = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (crossDevice && !injected && String(from) === source) {
        injected = true;
        throw Object.assign(new Error('different device'), { code: 'EXDEV' });
      }
      await original(from, to);
    });
    const before = await lstat(source);
    await moveGuardedFile(root, 'source', target, {
      size: 9,
      contentSha256: createHash('sha256').update('new bytes').digest('hex'),
    });
    expect(await readFile(target, 'utf8')).toBe('new bytes');
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    if (!crossDevice) expect((await lstat(target)).ino).toBe(before.ino);
    expect((await fs.readdir(root)).filter((p) => p !== '.mammoth').sort()).toEqual(['target']);
  },
);
it('does not replace the destination if source verification fails', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/guarded-move-'));
  roots.push(root);
  await writeFile(path.join(root, 'source'), 'bad');
  await writeFile(path.join(root, 'target'), 'keep');
  await expect(
    moveGuardedFile(root, 'source', path.join(root, 'target'), {
      size: 3,
      contentSha256: '0'.repeat(64),
    }),
  ).rejects.toThrow(/SHA-256/);
  expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('keep');
});

it('recovers an interrupted cross-device copy before observations without touching the old destination', async () => {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/guarded-move-'));
  roots.push(root);
  const parent = 'data/workspace/.mammoth',
    temporaryRelative = parent + '/restore-move-12345678-1234-1234-1234-123456789abc';
  await mkdir(path.join(root, parent), { recursive: true });
  await writeFile(path.join(root, temporaryRelative), 'partial');
  await writeFile(path.join(root, 'data/workspace/target'), 'original');
  const { writeMetadata } = await import('../../src/cache/metadata-io');
  await writeMetadata(
    root,
    '.mammoth/restore-move-v1.json',
    { temporaryRelative, cleanupDirectory: true },
    16384,
  );
  await recoverInterruptedMoves(root);
  expect(await readFile(path.join(root, 'data/workspace/target'), 'utf8')).toBe('original');
  await expect(lstat(path.join(root, parent))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.join(root, '.mammoth/restore-move-v1.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
