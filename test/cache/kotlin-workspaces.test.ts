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
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureCacheMetadataSnapshot,
  createManagedCachePathMatcher,
} from '../../src/cache/manifest';
import { captureImmutableWorkspaces, workspaceSchema } from '../../src/cache/immutable-workspaces';
import { kotlinFixtureModel, writeKotlinWorkspace } from '../support/kotlin-cache';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('builds the partition selected-path index once for multiple complete workspaces', async () => {
  const root = await fixture();
  await writeKotlinWorkspace(root);
  await writeKotlinWorkspace(root, 'kotlin-accessor-jars');
  await writeKotlinWorkspace(root, 'kotlin-plugin-spec-accessors');
  const model = await kotlinFixtureModel(root);
  const snapshot = await captureCacheMetadataSnapshot(model);
  const partitions = snapshot.partitions.map((p) => ({ ...p, entries: [...p.entries] }));
  // Count full entry iterations for index construction, independent of workspace count.
  const indexBuilds = partitions.map((p) => vi.spyOn(p.entries, Symbol.iterator));
  const captured = await captureImmutableWorkspaces(
    model,
    partitions,
    createManagedCachePathMatcher(model),
  );
  expect(captured).toEqual(snapshot.workspaces);
  for (const build of indexBuilds) expect(build).toHaveBeenCalledTimes(1);
});
async function fixture() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/kotlin-units-'));
  roots.push(root);
  return root;
}
it.each([
  'kotlin-script',
  'kotlin-accessor-jars',
  'kotlin-accessor-directories',
  'kotlin-plugin-spec-accessors',
] as const)('captures complete %s units and preserves ordinary members', async (kind) => {
  const root = await fixture(),
    unit = await writeKotlinWorkspace(root, kind, undefined, undefined, true);
  const ordinary = [
    'caches/9.8.1/generated-gradle-jars/gradle-api.jar',
    'caches/9.8.1/scripts/old/classes/Legacy.class',
  ];
  for (const name of ordinary) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'ordinary');
  }
  const snapshot = await captureCacheMetadataSnapshot(await kotlinFixtureModel(root));
  expect(snapshot.workspaces).toHaveLength(1);
  expect(snapshot.workspaces![0]!.workspace).toMatchObject({ kind, root: unit });
  expect(snapshot.partitions.flatMap((p) => p.entries.map((e) => e.relativePath))).toEqual(
    expect.arrayContaining(ordinary),
  );
  if (kind !== 'kotlin-accessor-jars')
    expect(snapshot.workspaces![0]!.workspace.emptyDirectories.length).toBeGreaterThan(0);
  expect(
    workspaceSchema.safeParse({ ...snapshot.workspaces![0]!.workspace, kind: 'groovy' }).success,
  ).toBe(false);
});
it('skips incomplete, unknown and transient modern trees without individual-file fallback', async () => {
  const root = await fixture();
  const good = await writeKotlinWorkspace(root);
  const incomplete = await writeKotlinWorkspace(root, 'kotlin-script', 'b'.repeat(32));
  await rm(path.join(root, incomplete, 'instrumented'), { recursive: true });
  for (const name of ['accessors/' + 'c'.repeat(32) + '-unknown/data', 'other/data']) {
    const p = path.join(root, 'caches/9.8.1/kotlin-dsl', name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'unknown');
  }
  const snapshot = await captureCacheMetadataSnapshot(await kotlinFixtureModel(root));
  expect(snapshot.workspaces!.map((u) => u.workspace.root)).toEqual([good]);
  expect(
    snapshot.partitions
      .flatMap((p) => p.entries)
      .every((e) => e.relativePath.startsWith(good + '/')),
  ).toBe(true);
  expect(snapshot.workspaceWarnings!.length).toBeGreaterThan(0);
});
it('rejects partial ownership and no-follow violations', async () => {
  const root = await fixture();
  const unit = await writeKotlinWorkspace(root);
  await expect(
    captureCacheMetadataSnapshot(
      await kotlinFixtureModel(root, [{ id: 'kotlin-dsl', excludes: ['**/metadata.bin'] }]),
    ),
  ).rejects.toThrow(/complete|partial/);
  await symlink(path.join(root, unit, 'metadata.bin'), path.join(root, unit, 'unexpected-link'));
  await expect(captureCacheMetadataSnapshot(await kotlinFixtureModel(root))).rejects.toThrow(
    /link/,
  );
});
