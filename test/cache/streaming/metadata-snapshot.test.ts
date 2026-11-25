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

import { chmod, readFile, utimes, writeFile, readdir, rename, mkdir } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './install-fixture';
import { resolveModel } from '../../../src/cache/streaming/model';
import { MetadataSnapshot } from '../../../src/cache/streaming/metadata-snapshot';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { sameNative, type NativeIdentity } from '../../../src/cache/streaming/native';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const hard = ['.mammoth/**'];
  const model = resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [['state', ['state/**'], hard, 'single-writer', 'A', 'default', 0]],
    ],
    'snapshot-',
    1,
  );
  const f = await installFixture('maven', { model });
  fixtures.push(f);
  await f.store.initialize(f.bindings);
  await f.files('', { 'state/shared/a': 'body', 'state/shared/b': 'other' });
  await chmod(f.store.root.resolve('state/shared/a'), 0o755);
  await utimes(f.store.root.resolve('state/shared/a'), 1.234, 1.234);
  const source = await MetadataPublicationSource.capture(f.store, '', { budget: f.budget });
  return { ...f, source };
}
it('copies from the original selected hierarchy with own output identities and no hash/native discovery pass', async () => {
  const f = await fixture();
  let snapshot: MetadataSnapshot | undefined, output: MetadataPublicationSource | undefined;
  try {
    const before = { ...f.store.root.work };
    snapshot = await MetadataSnapshot.copy(
      f.source,
      'state',
      ['local', f.store.codec.options.invocation],
      { budget: f.budget },
    );
    expect(f.store.root.work.nativeWalks).toBe(before.nativeWalks);
    expect(f.store.root.work.bodyHashCalls).toBe(before.bodyHashCalls);
    expect(f.store.root.work.indexBuilds - before.indexBuilds).toBe(1);
    const descriptor = snapshot.sourceDescriptor();
    const original = (await f.store.root.stat('state/shared/a'))!,
      copied = (await f.store.root.stat(snapshot.nativeRoot + '/state/shared/a'))!;
    expect(copied[4]).not.toBe(original[4]);
    if (process.platform !== 'win32') {
      expect(copied[6] & 0o777).toBe(0o755);
    }
    expect(
      await readFile(f.store.root.resolve(snapshot.nativeRoot + '/state/shared/a'), 'utf8'),
    ).toBe('body');
    expect(descriptor[3]).toEqual(await f.store.root.stat(snapshot.nativeRoot));
    output = await MetadataPublicationSource.snapshot(snapshot);
    expect(f.store.root.work.nativeWalks).toBe(before.nativeWalks);
    expect(output.summary('state')[3]).toBe(2);
    async function checkOutput(offset: number): Promise<void> {
      const lease = await snapshot!.node(offset);
      try {
        const path = lease.node[2]
          ? snapshot!.nativeRoot + '/' + lease.node[2]
          : snapshot!.nativeRoot;
        expect(
          sameNative(lease.node[3] as NativeIdentity, (await f.store.root.stat(path))!, true),
        ).toBe(true);
        expect(lease.node[4]).toBeNull();
        for await (const edge of snapshot!.children(lease.node)) {
          await checkOutput(edge[2]);
        }
      } finally {
        lease.release();
      }
    }
    await checkOutput(snapshot.index);
    await expect(snapshot.dispose()).rejects.toThrow('still borrowed');
    await output.dispose();
    output = undefined;
    await snapshot.dispose();
    snapshot = undefined;
    const reopened = await OwnedStore.bind(f.root, f.store.codec),
      walks = reopened.root.work.nativeWalks;
    const admitted = await MetadataSnapshot.admit(reopened, descriptor, { budget: f.budget });
    try {
      expect(reopened.root.work.nativeWalks - walks).toBe(1);
      await admitted.verify(new AbortController().signal);
    } finally {
      await admitted.dispose();
    }
  } finally {
    await output?.dispose();
    await snapshot?.dispose();
    await f.source.dispose();
  }
});
it('rejects source mutation before copy and revokes disposed snapshots rather than reconstructing index authority', async () => {
  const f = await fixture();
  try {
    await writeFile(f.store.root.resolve('state/shared/a'), 'drift');
    await expect(
      MetadataSnapshot.copy(f.source, 'state', ['local', f.store.codec.options.invocation], {
        budget: f.budget,
      }),
    ).rejects.toThrow('changed');
    expect(await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'))).toEqual([]);
    const empty = await MetadataSnapshot.empty(f.store, 'state', ['empty', 'miss'], {
      budget: f.budget,
    });
    const descriptor = empty.sourceDescriptor();
    await empty.dispose();
    expect(() => empty.assertBound(f.store, 'state')).toThrow('Unavailable');
    const fake = Object.create(MetadataSnapshot.prototype) as MetadataSnapshot;
    expect(() => MetadataSnapshot.assertReceipt(fake, f.store, 'state')).toThrow('Unavailable');
    await writeFile(f.store.root.resolve(descriptor[1] + '/changed'), 'drift');
    await expect(MetadataSnapshot.admit(f.store, descriptor, { budget: f.budget })).rejects.toThrow(
      'root/parent changed',
    );
  } finally {
    await f.source.dispose();
  }
});

it('publishes and returns nonempty copied directory roots using their final output identities', async () => {
  const f = await fixture();
  const snapshot = await MetadataSnapshot.copy(
    f.source,
    'state',
    ['local', f.store.codec.options.invocation],
    { budget: f.budget },
  );
  let output: MetadataPublicationSource | undefined;
  try {
    output = await MetadataPublicationSource.snapshot(snapshot);
    const saves: string[][] = [];
    const backend: BaseCacheBackend = {
      capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
      isFeatureAvailable: () => true,
      saveCache: async (paths) => {
        saves.push(paths);
        return 1;
      },
      restoreCache: async () => {
        throw new Error('No readback');
      },
      isMissingPathsError: () => false,
    };
    const result = await publishMetadataBase(output, backend, {
      lineage: 'a'.repeat(64),
      writer: 'b'.repeat(64),
      decision: 'c'.repeat(64),
    });
    expect(result.outcome).toBe('published');
    expect(saves).toHaveLength(2);
    expect(
      await readFile(f.store.root.resolve(snapshot.nativeRoot + '/state/shared/a'), 'utf8'),
    ).toBe('body');
  } finally {
    await output?.dispose();
    await snapshot.dispose();
    await f.source.dispose();
  }
});
it('retains a replaced snapshot container when failed-copy ownership becomes ambiguous', async () => {
  const f = await fixture();
  const node = MetadataPublicationSource.prototype.node;
  let replaced = '';
  vi.spyOn(MetadataPublicationSource.prototype, 'node').mockImplementation(async function (
    this: MetadataPublicationSource,
    ...args
  ) {
    if (this === f.source && !replaced) {
      const [id] = await readdir(f.store.root.resolve(f.store.prefix + 'snapshots'));
      replaced = f.store.prefix + 'snapshots/' + id;
      await rename(f.store.root.resolve(replaced), f.store.root.resolve(replaced + '-original'));
      await mkdir(f.store.root.resolve(replaced));
      await writeFile(f.store.root.resolve(replaced + '/foreign'), 'retain');
      throw new Error('stop copied output');
    }
    return node.apply(this, args);
  });
  try {
    await expect(
      MetadataSnapshot.copy(f.source, 'state', ['local', f.store.codec.options.invocation], {
        budget: f.budget,
      }),
    ).rejects.toThrow();
    expect(await readFile(f.store.root.resolve(replaced + '/foreign'), 'utf8')).toBe('retain');
  } finally {
    vi.restoreAllMocks();
    await f.source.dispose();
  }
});
