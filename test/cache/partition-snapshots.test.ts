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

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as glob from '@actions/glob';
import { cutoffFixtureModel } from '../support/cutoff-fixture';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import {
  stagePartitionSnapshot,
  readPartitionSnapshot,
  restorePartitionSnapshot,
  clearSnapshotFiles,
  verifySnapshotTransport,
  PARTITION_SNAPSHOT_DIRECTORY,
} from '../../src/cache/partition-snapshots';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/partition-snapshots-'));
  roots.push(root);
  const initial = cutoffFixtureModel(root);
  const model = {
    ...initial,
    partitions: initial.partitions.map((p) => ({
      ...p,
      publication: 'single-writer' as const,
      relativeExcludeGlobs: ['data/excluded.bin'],
      absoluteExcludeGlobs: [path.join(root, 'data/excluded.bin')],
    })),
  };
  await mkdir(path.join(root, 'data'));
  return { root, model };
}
async function capture(model: ReturnType<typeof cutoffFixtureModel>) {
  const snapshot = await captureCacheMetadataSnapshot(model);
  return stagePartitionSnapshot(
    model,
    'data',
    model.cacheRoot,
    snapshot.partitions[0]!.entries.map((e) => ({
      relativePath: e.relativePath,
      sourcePath: e.relativePath,
      size: e.size,
      mode: e.identity.mode & 0o777,
      mtimeMs: Math.trunc(e.mtimeMs),
      identity: e.identity,
    })),
  );
}
describe('complete partition snapshot transport', () => {
  it('rejects ambiguous deletion even for an empty replacement', async () => {
    const { root, model } = await fixture();
    const empty = await capture(model);
    await writeFile(path.join(root, 'data/overlap.bin'), 'keep');
    const overlapping = {
      ...model,
      partitions: [
        ...model.partitions,
        { ...model.partitions[0]!, id: 'other', publication: 'aggregate' as const },
      ],
    };
    await expect(restorePartitionSnapshot(overlapping, empty)).rejects.toThrow(/ambiguous/);
    expect(await readFile(path.join(root, 'data/overlap.bin'), 'utf8')).toBe('keep');
  });
  it('rejects partial transport rather than treating a missing manifest as absence', async () => {
    const { root, model } = await fixture();
    const directory = path.join(root, PARTITION_SNAPSHOT_DIRECTORY, 'data/payload');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '000001.bin'), 'orphan');
    await expect(readPartitionSnapshot(model, 'data')).rejects.toThrow(/missing its manifest/);
  });
  it('replaces membership, preserves explicit exclusions, and represents empty distinctly from absent', async () => {
    const { root, model } = await fixture();
    expect(await readPartitionSnapshot(model, 'data')).toBeNull();
    await writeFile(path.join(root, 'data/old.bin'), 'old');
    await writeFile(path.join(root, 'data/excluded.bin'), 'user excluded');
    const first = await capture(model);
    await writeFile(path.join(root, 'data/extra.bin'), 'extra');
    await writeFile(path.join(root, 'data/old.bin'), 'changed');
    await restorePartitionSnapshot(model, first);
    expect(await readdir(path.join(root, 'data'))).toEqual(
      expect.arrayContaining(['old.bin', 'excluded.bin']),
    );
    expect(await readFile(path.join(root, 'data/old.bin'), 'utf8')).toBe('old');
    await expect(readFile(path.join(root, 'data/extra.bin'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'data/excluded.bin'), 'utf8')).toBe('user excluded');
    await clearSnapshotFiles(model);
    const empty = await capture(model);
    expect(empty.manifest.files).toEqual([]);
    expect(empty.contentDigest).not.toBe(first.contentDigest);
    await writeFile(path.join(root, 'data/new.bin'), 'new');
    await restorePartitionSnapshot(model, empty);
    expect(await readdir(path.join(root, 'data'))).toContain('excluded.bin');
    await expect(readFile(path.join(root, 'data/new.bin'))).rejects.toThrow();
  });
  it('rejects corrupted payload and undeclared membership before changing live files', async () => {
    const { root, model } = await fixture();
    await writeFile(path.join(root, 'data/index.bin'), 'index');
    const snapshot = await capture(model);
    await writeFile(
      path.join(snapshot.rootDirectory, snapshot.manifest.files[0]!.payloadPath),
      'wrong',
    );
    await expect(restorePartitionSnapshot(model, snapshot)).rejects.toThrow(/SHA-256/);
    expect(await readFile(path.join(root, 'data/index.bin'), 'utf8')).toBe('index');
    await capture(model);
    await writeFile(path.join(snapshot.rootDirectory, 'extra.bin'), 'extra');
    await expect(verifySnapshotTransport(model)).rejects.toThrow(/membership/);
  });
  it('archives only fixed transport globs and restores them at another absolute root', async () => {
    const { root, model } = await fixture();
    await writeFile(path.join(root, 'data/index.bin'), 'selected');
    const snapshot = await capture(model);
    await writeFile(path.join(root, 'data/index.bin'), 'nonwriter local changes');
    await mkdir(path.join(root, '.mammoth/cutoff-state-v1'), { recursive: true });
    await writeFile(path.join(root, '.mammoth/cutoff-state-v1/private.json'), 'never archive');
    const patterns = [
      path.join(root, PARTITION_SNAPSHOT_DIRECTORY, 'data/snapshot.json'),
      path.join(root, PARTITION_SNAPSHOT_DIRECTORY, 'data/payload/*.bin'),
      `!${root}/**/`,
    ];
    const files = await (
      await glob.create(patterns.join('\n'), {
        followSymbolicLinks: false,
        implicitDescendants: false,
      })
    ).glob();
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(relative).toHaveLength(2);
    expect(relative.every((f) => f.startsWith(PARTITION_SNAPSHOT_DIRECTORY + '/data/'))).toBe(true);
    const archive = await packCacheFiles(root, relative, path.join(root, 'archive'));
    const destination = await fixture();
    await unpackCacheFiles(destination.root, archive);
    const restored = await readPartitionSnapshot(destination.model, 'data');
    expect(restored?.digest).toBe(snapshot.digest);
    await restorePartitionSnapshot(destination.model, restored!);
    expect(await readFile(path.join(destination.root, 'data/index.bin'), 'utf8')).toBe('selected');
    expect([
      path.join(root, PARTITION_SNAPSHOT_DIRECTORY, 'data/snapshot.json'),
      path.join(root, PARTITION_SNAPSHOT_DIRECTORY, 'data/payload/*.bin'),
      `!${root}/**/`,
    ]).toEqual(patterns);
  });
});

it('binds cached snapshot ownership to the current model policy', async () => {
  const { root, model } = await fixture();
  await writeFile(path.join(root, 'data/index.bin'), 'selected');
  await capture(model);
  const snapshot = (await readPartitionSnapshot(model, 'data'))!;
  await writeFile(path.join(root, 'data/index.bin'), 'keep excluded');
  const changed = {
    ...model,
    partitions: model.partitions.map((p) => ({
      ...p,
      relativeExcludeGlobs: [...p.relativeExcludeGlobs, 'data/index.bin'],
    })),
  };
  await expect(restorePartitionSnapshot(changed, snapshot)).rejects.toThrow(/outside/);
  expect(await readFile(path.join(root, 'data/index.bin'), 'utf8')).toBe('keep excluded');
});
it('rechecks snapshot directory evidence without rediscovering transport members', async () => {
  const { root, model } = await fixture();
  await writeFile(path.join(root, 'data/index.bin'), 'selected');
  await capture(model);
  const snapshot = (await readPartitionSnapshot(model, 'data'))!;
  await writeFile(path.join(root, 'data/index.bin'), 'keep live');
  await writeFile(path.join(snapshot.rootDirectory, 'payload/extra.bin'), 'undeclared');
  await expect(restorePartitionSnapshot(model, snapshot)).rejects.toThrow(/directory changed/);
  expect(await readFile(path.join(root, 'data/index.bin'), 'utf8')).toBe('keep live');
});
