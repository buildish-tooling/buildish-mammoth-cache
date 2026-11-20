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
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as manifest from '../../src/cache/manifest';
import { captureWorkspaceEvidence } from '../support/gradle-workspace-evidence';
import { kotlinFixtureModel, writeKotlinWorkspace } from '../support/kotlin-cache';
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock('../../src/cache/manifest', async (original) => ({
  ...(await original<typeof manifest>()),
}));
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it.each([2, 4])(
  'inventories once and hashes each selected payload once for %s shared-parent units',
  async (count) => {
    await fs.mkdir('build', { recursive: true });
    root = await fs.mkdtemp(path.resolve('build/workspace-evidence-'));
    for (let i = 0; i < count; i++)
      await writeKotlinWorkspace(root, 'kotlin-script', String(i).repeat(32));
    const model = await kotlinFixtureModel(root);
    const capture = vi.spyOn(manifest, 'captureCacheMetadataSnapshot');
    const reads = vi.spyOn(fs, 'readFile');
    const e = await captureWorkspaceEvidence(model);
    expect(e.units.size).toBe(count);
    expect(capture).toHaveBeenCalledTimes(1);
    const names = [...e.units.values()].flatMap((u) => u.workspace.files);
    for (const name of names)
      expect(reads.mock.calls.filter(([p]) => p === path.join(root, name))).toHaveLength(1);
    expect(
      reads.mock.calls.filter(([p]) => names.some((name) => p === path.join(root, name))),
    ).toHaveLength(names.length);
  },
);
