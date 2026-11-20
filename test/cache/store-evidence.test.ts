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

import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StoreEvidence } from '../../src/cache/store-evidence';
import { DirectoryValidationBatch } from '../../src/cache/guarded-files';
import { fileIdentity } from '../../src/cache/file-identity';
import * as payload from '../../src/util/fs';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
it('shares source ancestor checks within each stable phase and rechecks across boundaries', async () => {
  for (const count of [8, 16]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-evidence-'));
    roots.push(root);
    const parent = path.join(root, 'a/deep/shared');
    await fs.mkdir(parent, { recursive: true });
    const entries = [];
    for (let i = 0; i < count; i++) {
      const name = `a/deep/shared/${i}`;
      await fs.writeFile(path.join(root, name), 'payload');
      entries.push({ name, identity: fileIdentity(await fs.lstat(path.join(root, name))) });
    }
    const evidence = new StoreEvidence();
    const stats = vi.spyOn(fs, 'lstat'),
      hash = vi.spyOn(payload, 'hashStableFileSha256');
    for (let phase = 0; phase < 2; phase++) {
      const directories = new DirectoryValidationBatch(root);
      for (const entry of entries)
        await evidence.hash(root, entry.name, { size: 7 }, entry.identity, directories);
    }
    expect(hash).toHaveBeenCalledTimes(count);
    for (const name of [root, path.join(root, 'a'), path.join(root, 'a/deep'), parent])
      expect(stats.mock.calls.filter(([p]) => p === name)).toHaveLength(2);
    // A new operation rehashes unchanged bytes; proofs cannot be revived by pathname.
    await new StoreEvidence().hash(root, entries[0]!.name, { size: 7 });
    expect(hash).toHaveBeenCalledTimes(count + 1);
    stats.mockRestore();
    hash.mockRestore();
  }
});
it('rejects same-size tampering, replacement and unsafe ancestors after a phase boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-evidence-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'source'));
  const name = 'source/file';
  await fs.writeFile(path.join(root, name), 'payload');
  const evidence = new StoreEvidence();
  await evidence.hash(root, name, { size: 7 });
  await fs.writeFile(path.join(root, name), 'changed');
  await expect(evidence.hash(root, name, { size: 7 })).rejects.toThrow(/source changed/);
  await fs.rm(path.join(root, name));
  await fs.writeFile(path.join(root, name), 'payload');
  await expect(evidence.hash(root, name, { size: 7 })).rejects.toThrow(/source changed/);
  await fs.rename(path.join(root, 'source'), path.join(root, 'original'));
  await fs.symlink(path.join(root, 'original'), path.join(root, 'source'));
  await expect(
    evidence.hash(root, name, { size: 7 }, undefined, new DirectoryValidationBatch(root)),
  ).rejects.toThrow(/Unsafe directory/);
});
