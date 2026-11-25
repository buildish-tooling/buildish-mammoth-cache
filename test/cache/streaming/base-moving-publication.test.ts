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

import { readFile, readdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { metadataFixture, h, type MetadataFixture } from './base-publication-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
const fixtures: MetadataFixture[] = [],
  sources: MetadataPublicationSource[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const source of sources.splice(0)) {
    await source.dispose();
  }
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function source(f: MetadataFixture) {
  const result = await MetadataPublicationSource.capture(f.store, '', { budget: f.budget });
  sources.push(result);
  return result;
}
const request = { lineage: h, writer: h, decision: h };
it('splits shared parent geometry by owner while leaving excluded bookkeeping at its original location', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'maven',
        hard,
        [
          ['a', ['shared/**/a'], hard, 'aggregate', null, 'default', 0],
          ['b', ['shared/**/b'], hard, 'aggregate', null, 'default', 0],
        ],
      ],
      'mixed-publication-',
      1,
    ),
    f = await metadataFixture(model);
  fixtures.push(f);
  await f.files(f.root, {
    'shared/unit/a': 'A',
    'shared/unit/b': 'B',
    'shared/unit/keep.lock': 'retained',
  });
  const input = await source(f),
    save = f.save.getMockImplementation()!;
  f.save.mockImplementation(async (...args) => {
    expect(await readFile(f.root + '/shared/unit/keep.lock', 'utf8')).toBe('retained');
    if (args[0].length === 2) {
      const descriptor = JSON.parse(await readFile(args[0][0], 'utf8'));
      expect(await readdir(args[2]!.archiveRoot! + '/payload/shared/unit')).toEqual([
        descriptor[3][2],
      ]);
    }
    return save(...args);
  });
  expect((await publishMetadataBase(input, f.api, request)).outcome).toBe('published');
  expect(await readFile(f.root + '/shared/unit/a', 'utf8')).toBe('A');
  expect(await readFile(f.root + '/shared/unit/b', 'utf8')).toBe('B');
  expect(await readFile(f.root + '/shared/unit/keep.lock', 'utf8')).toBe('retained');
});
it('moves a clean Maven repository as one native directory despite multiple coordinates and descendant files', async () => {
  const f = await metadataFixture();
  fixtures.push(f);
  await f.files(f.root, {
    'repository/org/a/1/a.jar': 'a',
    'repository/org/b/1/b.jar': 'b',
    'repository/org/b/1/empty': null,
  });
  const input = await source(f),
    rename = vi.spyOn(f.store.root, 'renameAbsent');
  expect((await publishMetadataBase(input, f.api, request)).outcome).toBe('published');
  expect(rename).toHaveBeenCalledTimes(2);
  expect(rename.mock.calls[0][0]).toBe('repository');
  expect(rename.mock.calls[1][1]).toBe('repository');
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.store.root.work.bodyHashBytes).toBe(0);
});
it('publishes a meaningful empty subtree as native payload rather than a declared empty partition', async () => {
  const f = await metadataFixture();
  fixtures.push(f);
  await f.files(f.root, { 'data/empty/child': null });
  const result = await publishMetadataBase(await source(f), f.api, request);
  if (result.outcome !== 'published') {
    throw new Error('fixture');
  }
  expect(result.generation[8][0][0]).toBe('object');
  expect(result.generation[8][1]).toEqual(['empty', 'state']);
  expect(await readdir(f.root + '/data/empty')).toEqual(['child']);
});

it('keeps a protected Gradle workspace split complete in the payload while its excluded lock stays live', async () => {
  const hard = ['.mammoth/**', '**/*.lock'],
    model = resolveModel(
      [
        'model',
        1,
        'gradle',
        hard,
        [['data', ['caches/**'], hard, 'aggregate', null, 'default', 0]],
      ],
      'workspace-publication-',
      1,
    );
  const f = await metadataFixture(model);
  fixtures.push(f);
  const workspace = 'caches/transforms-4/' + 'a'.repeat(32);
  await f.files(f.root, {
    [workspace + '/metadata.bin']: 'metadata',
    [workspace + '/results.bin']: 'results',
    [workspace + '/transformed/a']: 'body',
    [workspace + '/keep.lock']: 'retained',
  });
  const input = await source(f),
    save = f.save.getMockImplementation()!;
  f.save.mockImplementation(async (...args) => {
    if (args[0].length === 2) {
      expect(await readFile(f.root + '/' + workspace + '/keep.lock', 'utf8')).toBe('retained');
      expect(await readdir(args[2]!.archiveRoot! + '/payload/' + workspace)).toEqual([
        'metadata.bin',
        'results.bin',
        'transformed',
      ]);
    }
    return save(...args);
  });
  expect((await publishMetadataBase(input, f.api, request)).outcome).toBe('published');
  expect(await readFile(f.root + '/' + workspace + '/transformed/a', 'utf8')).toBe('body');
  expect(await readFile(f.root + '/' + workspace + '/keep.lock', 'utf8')).toBe('retained');
});
