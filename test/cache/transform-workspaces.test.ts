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
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { workspaceSchema } from '../../src/cache/immutable-workspaces';
import { transformFixtureModel, writeTransformWorkspace } from '../support/transform-cache';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/transform-units-'));
  roots.push(root);
  return root;
}
it.each(['transforms-4', '9.8.1/transforms'])(
  'captures complete %s workspaces including real gc.properties outputs',
  async (layout) => {
    const root = await fixture(),
      unit = await writeTransformWorkspace(root, layout);
    const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
    expect(captured.workspaces).toHaveLength(1);
    expect(captured.workspaces![0]!.workspace).toMatchObject({
      kind: 'artifact-transform',
      root: unit,
      emptyDirectories: [unit + '/transformed/empty'],
    });
    expect(captured.workspaces![0]!.workspace.files).toContain(
      unit + '/transformed/nested/gc.properties',
    );
  },
);
it('accepts empty results and empty output directories without requiring a produced filename', async () => {
  const root = await fixture(),
    unit = await writeTransformWorkspace(root, undefined, undefined, undefined, true);
  const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
  expect(captured.workspaces![0]!.workspace.files).toEqual([
    unit + '/metadata.bin',
    unit + '/results.bin',
  ]);
});
it.each(['results.bin', 'metadata.bin', 'transformed'])(
  'skips structurally incomplete workspace missing %s without fallback',
  async (missing) => {
    const root = await fixture(),
      unit = await writeTransformWorkspace(root);
    await rm(path.join(root, unit, missing), { recursive: true });
    const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
    expect(captured.workspaces).toBeUndefined();
    expect(captured.partitions.flatMap((p) => p.entries)).toEqual([]);
    expect(captured.workspaceWarnings).toHaveLength(1);
  },
);
it('skips empty origin metadata and unknown legacy formats and temporary suffixes', async () => {
  const root = await fixture();
  for (const [layout, key] of [
    ['transforms-3', 'a'.repeat(32)],
    ['9.8.1/transforms', 'b'.repeat(32) + '-temporary'],
    ['transforms-4', 'c'.repeat(32)],
  ]) {
    const unit = await writeTransformWorkspace(root, layout, key);
    if (key === 'c'.repeat(32)) await writeFile(path.join(root, unit, 'metadata.bin'), '');
  }
  const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
  expect(captured.workspaces).toBeUndefined();
  expect(captured.partitions.flatMap((p) => p.entries)).toEqual([]);
  expect(captured.workspaceWarnings).toHaveLength(3);
});
it.each([
  'result.lock',
  'configuration-cache/state.bin',
  '.buildish-mammoth-cache/state.bin',
  '.mammoth/data',
  '.MaMmOtH./data',
  '.mammoth /data',
])('skips a whole workspace with mandatory-excluded output %s', async (name) => {
  const root = await fixture(),
    unit = await writeTransformWorkspace(root);
  const file = path.join(root, unit, 'transformed', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'excluded');
  const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
  expect(captured.workspaces).toBeUndefined();
  expect(captured.partitions.flatMap((p) => p.entries)).toEqual([]);
  expect(captured.workspaceWarnings?.join()).toContain('mandatory-excluded');
});
it.each(['.mammoth', '.MAMMOTH.', '.mammoth '])(
  'detects reserved empty directory %s before filtering',
  async (name) => {
    const root = await fixture(),
      unit = await writeTransformWorkspace(root);
    await mkdir(path.join(root, unit, 'transformed', name));
    const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
    expect(captured.workspaces).toBeUndefined();
    expect(captured.partitions.flatMap((p) => p.entries)).toEqual([]);
  },
);
it('rejects partial user selection and split ownership but leaves wholly excluded units unmanaged', async () => {
  const root = await fixture(),
    unit = await writeTransformWorkspace(root);
  await expect(
    captureCacheMetadataSnapshot(
      await transformFixtureModel(root, [
        { id: 'transforms-metadata', excludes: ['**/results.bin'] },
      ]),
    ),
  ).rejects.toThrow(/complete|partial/);
  await expect(
    captureCacheMetadataSnapshot(
      await transformFixtureModel(root, [
        { id: 'transforms-metadata', excludes: ['**/transformed/**'] },
        { id: 'other', includes: [unit + '/transformed/**'] },
      ]),
    ),
  ).rejects.toThrow(/dedicated|ambiguous/);
  const captured = await captureCacheMetadataSnapshot(
    await transformFixtureModel(root, [{ id: 'transforms-metadata', excludes: [unit + '/**'] }]),
  );
  expect(captured.workspaces).toBeUndefined();
  expect(captured.workspaceWarnings).toBeUndefined();
});
it('rejects symlink traversal and malformed transported units', async () => {
  const root = await fixture(),
    unit = await writeTransformWorkspace(root);
  const captured = await captureCacheMetadataSnapshot(await transformFixtureModel(root));
  const workspace = captured.workspaces![0]!.workspace;
  expect(
    workspaceSchema.safeParse({
      ...workspace,
      files: workspace.files.filter((p) => !p.endsWith('/results.bin')),
    }).success,
  ).toBe(false);
  expect(
    workspaceSchema.safeParse({ ...workspace, emptyDirectories: [unit + '/transformed/.mammoth'] })
      .success,
  ).toBe(false);
  await symlink(path.join(root, unit, 'metadata.bin'), path.join(root, unit, 'transformed/link'));
  await expect(captureCacheMetadataSnapshot(await transformFixtureModel(root))).rejects.toThrow(
    /link/,
  );
});
