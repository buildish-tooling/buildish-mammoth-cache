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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import { workspaceSchema } from '../../src/cache/immutable-workspaces';
import { groovyFixtureModel, writeGroovyWorkspace } from '../support/groovy-cache';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/groovy-unit-'));
  roots.push(root);
  return root;
}

it('enables complete Groovy units by default and records empty outputs without payload placeholders', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root, undefined, undefined, true);
  const model = await groovyFixtureModel(root),
    snapshot = await captureCacheMetadataSnapshot(model);
  expect(model.partitions.map((p) => [p.id, p.conflictHandling])).toEqual([
    ['groovy-dsl', 'choose-worker-directory'],
  ]);
  expect(snapshot.workspaces).toHaveLength(1);
  expect(snapshot.workspaces![0]!.workspace.emptyDirectories).toContain(
    unit + '/instrumented/proj',
  );
  expect(snapshot.partitions[0]!.entries.map((e) => e.relativePath)).toEqual([
    unit + '/metadata.bin',
    unit + '/metadata/metadata.bin',
  ]);
});
it('omits incomplete and temporary roots while preserving complete units', async () => {
  const root = await fixture(),
    good = await writeGroovyWorkspace(root);
  const incomplete = await writeGroovyWorkspace(root, 'b'.repeat(32));
  await rm(path.join(root, incomplete, 'metadata.bin'));
  await writeGroovyWorkspace(root, 'c'.repeat(32) + '-temporary');
  const snapshot = await captureCacheMetadataSnapshot(await groovyFixtureModel(root));
  expect(snapshot.workspaces!.map((w) => w.workspace.root)).toEqual([good]);
  expect(snapshot.workspaceWarnings?.join(' ')).toContain('structurally incomplete');
  expect(snapshot.partitions[0]!.entries.every((e) => e.relativePath.startsWith(good + '/'))).toBe(
    true,
  );
});
it('rejects excluding metadata from a structurally complete workspace', async () => {
  const root = await fixture();
  await writeGroovyWorkspace(root);
  await expect(
    captureCacheMetadataSnapshot(
      await groovyFixtureModel(root, [{ id: 'groovy-dsl', excludes: ['**/metadata.bin'] }]),
    ),
  ).rejects.toThrow(/partial|complete/);
});
it('rejects split ownership and links rather than publishing an incomplete view', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  await expect(
    captureCacheMetadataSnapshot(
      await groovyFixtureModel(root, [
        { id: 'groovy-dsl', excludes: ['**/classes/**'] },
        { id: 'classes', includes: ['caches/*/groovy-dsl/*/classes/**'] },
      ]),
    ),
  ).rejects.toThrow(/ownership/);
  await symlink(path.join(root, unit, 'metadata.bin'), path.join(root, unit, 'metadata/link'));
  await expect(captureCacheMetadataSnapshot(await groovyFixtureModel(root))).rejects.toThrow(
    /symbolic|link/,
  );
});
it('retains structural grouping with strict conflict handling and allows disabling the preset', async () => {
  const root = await fixture();
  await writeGroovyWorkspace(root);
  const strict = await groovyFixtureModel(root, [
    { id: 'groovy-dsl', 'conflict-handling': 'default' },
  ]);
  expect(strict.partitions[0]!.conflictHandling).toBeUndefined();
  expect((await captureCacheMetadataSnapshot(strict)).workspaces).toHaveLength(1);
  expect((await groovyFixtureModel(root, [{ id: 'groovy-dsl', includes: [] }])).partitions).toEqual(
    [],
  );
  await expect(
    groovyFixtureModel(root, [{ id: 'groovy-dsl', publication: 'single-writer' }]),
  ).rejects.toThrow(/aggregate/);
});
it('keeps cleanup and lock bookkeeping out of complete workspace membership', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  await writeFile(path.join(root, unit, 'x.lock'), 'pid');
  await writeFile(path.join(root, unit, 'gc.properties'), 'local');
  const result = await captureCacheMetadataSnapshot(await groovyFixtureModel(root));
  expect(result.workspaces![0]!.workspace.files).not.toContain(unit + '/x.lock');
  expect(result.workspaces![0]!.workspace.files).not.toContain(unit + '/gc.properties');
});
it.each(['../escape', 'classes/proj/Script.class', 'instrumented', 'metadata.bin'])(
  'rejects invalid directory membership %s',
  async (member) => {
    const root = await fixture();
    await writeGroovyWorkspace(root);
    const unit = (await captureCacheMetadataSnapshot(await groovyFixtureModel(root)))
      .workspaces![0]!.workspace;
    expect(
      workspaceSchema.safeParse({ ...unit, emptyDirectories: [unit.root + '/' + member] }).success,
    ).toBe(false);
  },
);

it('does not accept files in place of required output directories', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  for (const name of ['classes', 'instrumented']) {
    await rm(path.join(root, unit, name), { recursive: true });
    await writeFile(path.join(root, unit, name), 'not a directory');
  }
  expect(
    (await captureCacheMetadataSnapshot(await groovyFixtureModel(root))).workspaces,
  ).toBeUndefined();
  expect(
    workspaceSchema.safeParse({
      root: unit,
      files: [
        unit + '/classes',
        unit + '/instrumented',
        unit + '/metadata.bin',
        unit + '/metadata/metadata.bin',
      ].sort((a, b) => a.localeCompare(b)),
      emptyDirectories: [],
    }).success,
  ).toBe(false);
});
it('does not reintroduce bookkeeping when preset excludes are replaced', async () => {
  const root = await fixture(),
    unit = await writeGroovyWorkspace(root);
  await writeFile(path.join(root, unit, 'gc.properties'), 'local');
  const snapshot = await captureCacheMetadataSnapshot(
    await groovyFixtureModel(root, [{ id: 'groovy-dsl', excludes: [] }]),
  );
  expect(snapshot.partitions[0]!.entries.map((e) => e.relativePath)).toEqual(
    snapshot.workspaces![0]!.workspace.files,
  );
});
