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

import { mkdir, writeFile, rm, link, symlink, utimes } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { baseFixture, cleanupBaseFixtures } from './base-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { createMetadataDescriptor } from '../../../src/cache/streaming/metadata-base-records';
import {
  DiscoveredMetadataBase,
  checkMetadataBaseLayout,
  metadataBaseObjectPaths,
} from '../../../src/cache/streaming/metadata-base-source';
import {
  decodePinnedPartitionMetadata,
  encodePinnedPartitionMetadata,
  type NativeMetadataRow,
} from '../../../src/cache/streaming/partition-metadata';
import { WorkerNativeIndex } from '../../../src/cache/streaming/worker-native';
const h = 'a'.repeat(64);
afterEach(cleanupBaseFixtures);
async function fixture(units = 2, tool: 'maven' | 'gradle' = 'maven') {
  const model = resolveModel(
    [
      'model',
      1,
      tool,
      ['.mammoth/**'],
      [
        [
          'data',
          [tool === 'maven' ? 'repository/**' : '**'],
          ['.mammoth/**'],
          'aggregate',
          null,
          'default',
        ],
      ],
    ],
    'metadata-',
    1,
  );
  const f = await baseFixture(model),
    root = f.store.prefix + 'objects/data',
    payload = root + '/payload';
  const descriptor = createMetadataDescriptor(model, [model.family, model.id, 'data', h, h, h]);
  await mkdir(f.store.root.resolve(payload), { recursive: true });
  await writeFile(f.store.root.resolve(root + '/envelope.json'), descriptor.bytes);
  for (let i = 0; i < units; i++) {
    const dir = payload + '/repository/group/unit' + i + '/version';
    await mkdir(f.store.root.resolve(dir), { recursive: true });
    await writeFile(f.store.root.resolve(dir + '/a.jar'), 'abc');
    await writeFile(f.store.root.resolve(dir + '/b.jar'), 'def');
  }
  return { ...f, root, payload, ...descriptor };
}
async function discover(
  f: Awaited<ReturnType<typeof fixture>>,
  observe = async (_row: NativeMetadataRow) => {},
) {
  return DiscoveredMetadataBase.discover(
    f.store,
    f.root,
    f.reference,
    { budget: f.budget },
    observe,
  );
}
it.each([2, 8])(
  'feeds one native discovery for %i units/shared parents with no payload reads or hash/copy work',
  async (units) => {
    const f = await fixture(units),
      before = { ...f.store.root.work },
      rows: NativeMetadataRow[] = [];
    const source = await discover(f, async (row) => {
      rows.push(row);
    });
    const after = f.store.root.work;
    expect(after.nativeWalks - before.nativeWalks).toBe(1);
    expect(after.nativeListings - before.nativeListings).toBe(4 + 2 * units); // one descriptor/payload layout + payload directories
    expect(rows.length).toBe(6 + 6 * units);
    expect(rows.every((row) => row.length === 3)).toBe(true);
    expect(source.summary.slice(3)).toEqual([2 * units, 2 + 2 * units, 6 * units]);
    expect(after.bodyHashCalls - before.bodyHashCalls).toBe(0);
    expect(after.bodyHashBytes - before.bodyHashBytes).toBe(0);
    expect(after.readBytes - before.readBytes).toBe(f.bytes.length); // one bounded descriptor read/binding
    expect(after.writeBytes - before.writeBytes).toBe(0);
    expect(after.renames - before.renames).toBe(0);
    expect(f.budget.retained).toBe(0);
    expect(metadataBaseObjectPaths(f.store, f.root)).toHaveLength(2);
    DiscoveredMetadataBase.assertReceipt(source);
    source.close();
    expect(() => source.pin()).toThrow('active');
  },
);
it('pins the exact pre-overlay materialized ref and original profile, with no per-file handoff', async () => {
  const f = await fixture(),
    source = await discover(f),
    pin = source.pin();
  const bytes = encodePinnedPartitionMetadata(pin),
    invocation = f.store.codec.options.invocation;
  expect(
    decodePinnedPartitionMetadata(bytes, f.model, invocation, ['object', 'data', f.reference]),
  ).toEqual(pin);
  expect(bytes.length).toBeLessThan(2048);
  expect(() =>
    decodePinnedPartitionMetadata(bytes, f.model, 'b'.repeat(64), ['object', 'data', f.reference]),
  ).toThrow('provenance');
  const other = structuredClone(f.reference);
  other[4] = 'b'.repeat(64);
  expect(() =>
    decodePinnedPartitionMetadata(bytes, f.model, invocation, ['object', 'data', other]),
  ).toThrow('materialized');
  expect(() =>
    decodePinnedPartitionMetadata(bytes, f.model, invocation, ['empty', 'data']),
  ).toThrow('materialized');
  const exposed = source.reference;
  exposed[1][3] = 'b'.repeat(64);
  expect(source.reference).toEqual(f.reference);
  await writeFile(f.store.root.resolve(f.payload + '/repository/extra'), 'overlay');
  const changed = await discover(f);
  expect(changed.summary).not.toEqual(pin[9]);
  expect(source.pin()).toEqual(pin);
  source.close();
  changed.close();
});
it('permits valid-looking omission/metadata-preserving rewrites without claiming payload verification', async () => {
  const f = await fixture(),
    file = f.store.root.resolve(f.payload + '/repository/group/unit0/version/a.jar');
  await utimes(file, 1, 1);
  const first = await discover(f);
  await writeFile(file, 'XYZ');
  await utimes(file, 1, 1);
  const rewritten = await discover(f);
  expect(rewritten.summary).toEqual(first.summary);
  await rm(file);
  const omitted = await discover(f);
  expect(omitted.summary).not.toEqual(first.summary);
  first.close();
  rewritten.close();
  omitted.close();
});
it('does not grant an EOF receipt on observer failure, and isolates callback identity mutations', async () => {
  const f = await fixture();
  let rows = 0;
  await expect(
    discover(f, async (row) => {
      if (++rows === 4) throw new Error('sink failed');
      row[2][4] = 'corrupt';
    }),
  ).rejects.toThrow('sink failed');
  expect(f.budget.retained).toBe(0);
  const source = await discover(f, async (row) => {
    row[2][4] = 'corrupt';
  });
  expect(source.summary[3]).toBe(4);
  source.close();
  expect(() =>
    DiscoveredMetadataBase.assertReceipt(Object.create(DiscoveredMetadataBase.prototype)),
  ).toThrow('receipt');
  expect(() =>
    WorkerNativeIndex.assert(Object.create(WorkerNativeIndex.prototype), f.store),
  ).toThrow('Unavailable');
});
it.each(['tree', 'missing', 'hardlink', 'reserved', 'wrong-owner', 'budget'])(
  'rejects unsafe or incompatible source %s without a receipt',
  async (kind) => {
    const f = await fixture(),
      file = f.store.root.resolve(f.payload + '/repository/group/unit0/version/a.jar');
    if (kind === 'tree') await writeFile(f.store.root.resolve(f.root + '/tree.ndjson'), 'old');
    if (kind === 'missing') await rm(f.store.root.resolve(f.root + '/envelope.json'));
    if (kind === 'hardlink') await link(file, f.store.root.resolve(f.payload + '/alias'));
    if (kind === 'reserved') await mkdir(f.store.root.resolve(f.payload + '/.mammoth'));
    if (kind === 'wrong-owner') {
      await writeFile(f.store.root.resolve(f.payload + '/unowned'), 'wrong owner');
    }
    if (kind === 'budget') {
      await expect(
        DiscoveredMetadataBase.discover(
          f.store,
          f.root,
          f.reference,
          {
            budget: new (await import('../../../src/cache/streaming/tree-state')).WorkingBudget(1),
          },
          async () => {},
        ),
      ).rejects.toThrow('budget');
    } else await expect(discover(f)).rejects.toThrow();
    expect(f.budget.retained).toBe(0);
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects payload links without following them',
  async () => {
    const f = await fixture();
    await symlink('repository/group', f.store.root.resolve(f.payload + '/linked'));
    await expect(discover(f)).rejects.toThrow();
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects missing Gradle workspace markers and preserves meaningful empty/synthetic scaffolding distinction', async () => {
  const f = await fixture(0, 'gradle'),
    workspace = f.payload + '/caches/8.0/transforms/' + 'a'.repeat(32);
  await mkdir(f.store.root.resolve(workspace), { recursive: true });
  await expect(discover(f)).rejects.toThrow();
  await writeFile(f.store.root.resolve(workspace + '/metadata.bin'), 'meta');
  await writeFile(f.store.root.resolve(workspace + '/results.bin'), 'result');
  await mkdir(f.store.root.resolve(workspace + '/transformed'));
  const source = await discover(f);
  expect(source.summary.slice(3)).toEqual([2, 4, 10]); // caches/version, workspace and empty transformed
  source.close();
  expect(f.budget.retained).toBe(0);
});
it('rejects missing payload or an extra root member before native discovery', async () => {
  const f = await fixture(0);
  await rm(f.store.root.resolve(f.payload), { recursive: true });
  await expect(checkMetadataBaseLayout(f.store, f.root)).rejects.toThrow();
  expect(f.store.root.work.nativeWalks).toBe(0);
});
