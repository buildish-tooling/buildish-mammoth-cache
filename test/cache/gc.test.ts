/*
 * Copyright 2026 The Apache Software Foundation
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

import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectTimestampCacheGarbage } from '../../src/cache/gc';
import type { CacheModel } from '../../src/cache/model';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('collectTimestampCacheGarbage', () => {
  it('deletes only managed files whose access and modification times are both older than the cutoff', async () => {
    const cacheRoot = await createTempDirectory();
    const now = new Date('2026-06-05T12:00:00.000Z');
    const stale = new Date('2026-05-20T12:00:00.000Z');
    const recent = new Date('2026-06-04T12:00:00.000Z');

    await writeTrackedFile(cacheRoot, 'caches/stale.bin', 'stale', stale, stale);
    await writeTrackedFile(cacheRoot, 'caches/recent-atime.bin', 'recent-atime', recent, stale);
    await writeTrackedFile(cacheRoot, 'caches/recent-mtime.bin', 'recent-mtime', stale, recent);
    await writeTrackedFile(cacheRoot, 'caches/ignored.lock', 'lock', stale, stale);

    const result = await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now,
    });

    await expect(readFile(path.join(cacheRoot, 'caches/stale.bin'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(cacheRoot, 'caches/recent-atime.bin'), 'utf8')).resolves.toBe(
      'recent-atime',
    );
    await expect(readFile(path.join(cacheRoot, 'caches/recent-mtime.bin'), 'utf8')).resolves.toBe(
      'recent-mtime',
    );
    await expect(readFile(path.join(cacheRoot, 'caches/ignored.lock'), 'utf8')).resolves.toBe(
      'lock',
    );
    expect(result).toMatchObject({
      mode: 'timestamp',
      scannedFileCount: 3,
      deletedFileCount: 1,
      keptFileCount: 2,
    });
    expect(result.deletedByteCount).toBe(Buffer.byteLength('stale'));
  });

  it('removes empty parent directories without deleting non-empty ancestors', async () => {
    const cacheRoot = await createTempDirectory();
    const stale = new Date('2026-05-20T12:00:00.000Z');

    await writeTrackedFile(cacheRoot, 'caches/deep/path/stale.bin', 'stale', stale, stale);
    await writeTrackedFile(cacheRoot, 'caches/sibling/keep.bin', 'keep', stale, stale);

    await collectTimestampCacheGarbage(createCacheModel(cacheRoot, ['caches/deep/**']), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
    });

    await expect(stat(path.join(cacheRoot, 'caches/deep'))).rejects.toThrow();
    await expect(readFile(path.join(cacheRoot, 'caches/sibling/keep.bin'), 'utf8')).resolves.toBe(
      'keep',
    );
  });

  it('rejects cutoffs below two days', async () => {
    const cacheRoot = await createTempDirectory();

    await expect(
      collectTimestampCacheGarbage(createCacheModel(cacheRoot), { olderThanDays: 1 }),
    ).rejects.toThrow(/greater than or equal to 2/u);
  });

  it('keeps protected paths even when their timestamps are stale', async () => {
    const cacheRoot = await createTempDirectory();
    const stale = new Date('2026-05-20T12:00:00.000Z');

    await writeTrackedFile(cacheRoot, 'caches/from-delta.bin', 'delta', stale, stale);

    const result = await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
      protectedRelativePaths: ['caches/from-delta.bin'],
    });

    await expect(readFile(path.join(cacheRoot, 'caches/from-delta.bin'), 'utf8')).resolves.toBe(
      'delta',
    );
    expect(result.deletedFileCount).toBe(0);
  });

  it('does not delete a symlink that replaced a captured stale file', async () => {
    const cacheRoot = await createTempDirectory();
    const outsideDirectory = await createTempDirectory();
    const stale = new Date('2026-05-20T12:00:00.000Z');
    const targetPath = path.join(outsideDirectory, 'target.txt');
    const linkPath = path.join(cacheRoot, 'caches/replaced.bin');

    await writeTrackedFile(cacheRoot, 'caches/replaced.bin', 'stale', stale, stale);
    await writeFile(targetPath, 'outside', 'utf8');

    const result = await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
      beforeDelete: async () => {
        await unlink(linkPath);
        await symlink(targetPath, linkPath);
      },
    });

    await expect(readFile(linkPath, 'utf8')).resolves.toBe('outside');
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('outside');
    expect(result.deletedFileCount).toBe(0);
  });

  it('restores timestamps for retained files so the GC scan does not refresh atime', async () => {
    const cacheRoot = await createTempDirectory();
    const atime = new Date('2026-06-04T12:00:00.000Z');
    const mtime = new Date('2026-05-20T12:00:00.000Z');
    const setTimes = vi.fn(async () => undefined);

    await writeTrackedFile(cacheRoot, 'caches/retained.bin', 'retained', atime, mtime);

    await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
      setTimes,
    });

    expect(setTimes).toHaveBeenCalledWith(
      path.join(cacheRoot, 'caches/retained.bin'),
      atime,
      mtime,
    );
  });

  it('bounds concurrent retained timestamp restoration work', async () => {
    const cacheRoot = await createTempDirectory();
    const atime = new Date('2026-06-04T12:00:00.000Z');
    const mtime = new Date('2026-05-20T12:00:00.000Z');
    let activeRestores = 0;
    let maxActiveRestores = 0;

    for (let index = 0; index < 80; index += 1) {
      await writeTrackedFile(cacheRoot, `caches/retained-${index}.bin`, 'retained', atime, mtime);
    }

    await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
      beforeRestoreTimestamps: async () => {
        activeRestores += 1;
        maxActiveRestores = Math.max(maxActiveRestores, activeRestores);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRestores -= 1;
      },
    });

    expect(maxActiveRestores).toBeLessThanOrEqual(64);
    expect(maxActiveRestores).toBeGreaterThan(1);
  });

  it('does not restore timestamps through a symlink that replaced a retained file', async () => {
    const cacheRoot = await createTempDirectory();
    const outsideDirectory = await createTempDirectory();
    const atime = new Date('2026-06-04T12:00:00.000Z');
    const mtime = new Date('2026-05-20T12:00:00.000Z');
    const targetPath = path.join(outsideDirectory, 'target.txt');
    const linkPath = path.join(cacheRoot, 'caches/retained.bin');
    const setTimes = vi.fn(async () => undefined);

    await writeTrackedFile(cacheRoot, 'caches/retained.bin', 'retained', atime, mtime);
    await writeFile(targetPath, 'outside', 'utf8');

    await collectTimestampCacheGarbage(createCacheModel(cacheRoot), {
      olderThanDays: 14,
      now: new Date('2026-06-05T12:00:00.000Z'),
      beforeRestoreTimestamps: async () => {
        await unlink(linkPath);
        await symlink(targetPath, linkPath);
      },
      setTimes,
    });

    expect(setTimes).not.toHaveBeenCalled();
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-gc-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeTrackedFile(
  cacheRoot: string,
  relativePath: string,
  contents: string,
  atime: Date,
  mtime: Date,
): Promise<void> {
  const absolutePath = path.join(cacheRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, 'utf8');
  await utimes(absolutePath, atime, mtime);
}

function createCacheModel(cacheRoot: string, includes = ['caches/**']): CacheModel {
  return {
    cacheKey: 'test-cache',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'feedcafe1234abcd',
    buildToolId: 'test',
    cacheRoot,
    partitions: [
      {
        id: 'main',
        displayName: 'Main',
        description: 'Main test partition',
        relativeIncludeGlobs: includes,
        relativeExcludeGlobs: ['**/*.lock'],
        absoluteIncludeGlobs: includes.map((include) => path.join(cacheRoot, include)),
        absoluteExcludeGlobs: [path.join(cacheRoot, '**/*.lock')],
      },
    ],
    includePaths: includes.map((include) => path.join(cacheRoot, include)),
    excludePaths: [path.join(cacheRoot, '**/*.lock')],
  };
}
