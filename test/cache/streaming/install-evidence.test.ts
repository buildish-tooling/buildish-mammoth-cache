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

import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnedStore, type Reference } from '../../../src/cache/streaming/owned-store';
import {
  VerifiedIncoming,
  verifyNativeEvidence,
  type IncomingVerification,
} from '../../../src/cache/streaming/install-evidence';
import { walkNative } from '../../../src/cache/streaming/native-walk';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { type Value } from '../../../src/cache/streaming/encoding';
import { localFixtures } from './local-fixtures';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.resolve('build/install-evidence-'));
  roots.push(directory);
  const f = localFixtures(),
    store = await OwnedStore.bind(directory, f.codec),
    budget = new WorkingBudget();
  const nativeRoot = store.prefix + 'install/metadata';
  await mkdir(store.root.resolve(nativeRoot + '/metadata/sub'), { recursive: true });
  for (const file of ['metadata/a', 'metadata/b', 'metadata/sub/a'])
    await writeFile(store.root.resolve(nativeRoot + '/' + file), 'body:' + file);
  async function* records() {
    for await (const event of walkNative(store.root, nativeRoot, { budget, logicalRoot: '' })) {
      if (event.tag === 'directory-close') continue;
      if (event.tag === 'protected-child') throw new Error('Unexpected protected fixture child.');
      if (event.tag === 'directory-open') yield ['directory', event.path, event.identity] as Value;
      else
        yield [
          'file',
          event.path,
          event.identity,
          await store.root.hash(event.nativePath, event.identity),
        ] as Value;
    }
  }
  const evidence = await store.writeStream(
    'native-evidence',
    { budget, partition: 'metadata' },
    records(),
  );
  const input = {
    partition: 'metadata',
    nativeRoot,
    evidence,
    origin: 'worker' as 'worker' | 'trusted-base',
    finishVerification: vi.fn(async (binding: IncomingVerification) => binding),
  };
  return { directory, store, budget, input };
}
it.each(['worker', 'trusted-base'] as const)(
  'joins verified %s staging without rereading native payload bytes',
  async (origin) => {
    const f = await fixture();
    f.input.origin = origin;
    const before = f.store.root.work.readBytes;
    const receipt = await VerifiedIncoming.verify(f.store, f.input, { budget: f.budget });
    expect(f.input.finishVerification).toHaveBeenCalledOnce();
    expect(f.store.root.work.readBytes - before).toBe(f.input.evidence[3]);
    receipt.assertBound(f.store, 'metadata', f.input.evidence, f.input.nativeRoot);
    expect(f.budget.retained).toBe(0);
    expect(() =>
      receipt.assertBound(f.store, 'data', f.input.evidence, f.input.nativeRoot),
    ).toThrow('another operation');
    expect(() =>
      receipt.assertBound(
        f.store,
        'metadata',
        [...f.input.evidence.slice(0, 4), '0'.repeat(64)],
        f.input.nativeRoot,
      ),
    ).toThrow('receipt');
  },
);
it('requires upstream completion and rejects mutation made during verification before granting receipt', async () => {
  const f = await fixture();
  const renames = f.store.root.work.renames;
  f.input.finishVerification.mockRejectedValueOnce(new Error('archive rejected'));
  await expect(VerifiedIncoming.verify(f.store, f.input, { budget: f.budget })).rejects.toThrow(
    'archive rejected',
  );
  expect(f.store.root.work.renames).toBe(renames);
  f.input.finishVerification.mockImplementationOnce(async (binding) => {
    await writeFile(f.store.root.resolve(f.input.nativeRoot + '/metadata/a'), 'changed-body');
    return binding;
  });
  await expect(VerifiedIncoming.verify(f.store, f.input, { budget: f.budget })).rejects.toThrow(
    'identity',
  );
  expect(f.store.root.work.renames).toBe(renames);
  expect(f.budget.retained).toBe(0);
});
it.each(['extra', 'missing', 'wrong-digest'])(
  'rejects %s native/ref membership before acceptance',
  async (kind) => {
    const f = await fixture();
    if (kind === 'extra')
      await writeFile(f.store.root.resolve(f.input.nativeRoot + '/metadata/extra'), 'unexpected');
    if (kind === 'missing') await rm(f.store.root.resolve(f.input.nativeRoot + '/metadata/a'));
    if (kind === 'wrong-digest')
      f.input.evidence = [...f.input.evidence.slice(0, 4), '0'.repeat(64)] as Reference;
    await expect(VerifiedIncoming.verify(f.store, f.input, { budget: f.budget })).rejects.toThrow();
    expect(f.budget.retained).toBe(0);
  },
);
it('refuses retained snapshot sources and cross-operation receipt reuse', async () => {
  const f = await fixture();
  await expect(
    VerifiedIncoming.verify(
      f.store,
      { ...f.input, nativeRoot: f.store.prefix + 'sources/metadata' },
      { budget: f.budget },
    ),
  ).rejects.toThrow('disposable');
  const receipt = await VerifiedIncoming.verify(f.store, f.input, { budget: f.budget });
  const otherStore = await OwnedStore.bind(f.directory, f.store.codec);
  expect(() =>
    receipt.assertBound(otherStore, 'metadata', f.input.evidence, f.input.nativeRoot),
  ).toThrow('another operation');
});
it('checks sealed reference EOF and cancellation while holding only reader frontiers', async () => {
  const f = await fixture();
  await appendFile(f.store.root.resolve(f.input.evidence[2]), 'unexpected');
  await expect(
    verifyNativeEvidence(f.store, f.input.evidence, f.input.nativeRoot, 'metadata', {
      budget: f.budget,
    }),
  ).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
  const controller = new AbortController();
  controller.abort(new Error('cancelled join'));
  await expect(
    VerifiedIncoming.verify(f.store, f.input, { budget: f.budget, signal: controller.signal }),
  ).rejects.toThrow('cancelled join');
  expect(f.budget.retained).toBe(0);
});

it('cancels pending upstream verification without minting a receipt or reading native evidence', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let passedSignal: AbortSignal | undefined;
  const finishVerification = vi.fn((_binding: IncomingVerification, signal: AbortSignal) => {
    passedSignal = signal;
    return new Promise<IncomingVerification>(() => {});
  });
  const reads = f.store.root.work.readBytes;
  const pending = VerifiedIncoming.verify(
    f.store,
    { ...f.input, finishVerification },
    { budget: f.budget, signal: controller.signal },
  );
  controller.abort(new Error('cancel pending verification'));
  await expect(pending).rejects.toThrow('cancel pending verification');
  expect(passedSignal).toBe(controller.signal);
  expect(f.store.root.work.readBytes).toBe(reads);
  expect(f.budget.retained).toBe(0);
});

it('rejects unrelated upstream completion even when the native staging matches', async () => {
  const f = await fixture();
  f.input.finishVerification.mockImplementationOnce(async (binding) => {
    return [
      binding[0],
      binding[1],
      binding[2],
      '0'.repeat(64),
      binding[4],
      binding[5],
      binding[6],
      binding[7],
      binding[8],
      binding[9],
    ];
  });
  const before = f.store.root.work.readBytes;
  await expect(VerifiedIncoming.verify(f.store, f.input, { budget: f.budget })).rejects.toThrow(
    'Upstream verification binding',
  );
  expect(f.store.root.work.readBytes).toBe(before);
});
