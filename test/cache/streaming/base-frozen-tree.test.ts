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

import { chmod, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { FrozenBaseTree } from '../../../src/cache/streaming/base-frozen-tree';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { ValidatedBaseObject } from '../../../src/cache/streaming/base-object';
import { decodeRecords, tuple } from '../../../src/cache/streaming/encoding';
import { deriveBaseGroups } from '../../../src/cache/streaming/base-incoming';
import type { ObjectIdentity } from '../../../src/cache/streaming/native-records';
import { observationFixture } from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof observationFixture>>[] = [];
const inputs: LiveBaseInputs[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const i of inputs.splice(0)) await i.dispose();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await observationFixture();
  fixtures.push(f);
  await f.files('', { 'data/a': 'aggregate', 'state/b': 'snapshot' });
  await chmod(f.store.root.resolve('data/a'), 0o600);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  inputs.push(input);
  const identity = (p: string): ObjectIdentity => [
    f.model.family,
    f.model.id,
    p,
    '1'.repeat(64),
    '2'.repeat(64),
    '3'.repeat(64),
  ];
  return { ...f, input, identity };
}
it('renders exact keyed metadata before evacuation without payload copies, hash rereads or a ready SDK receipt', async () => {
  const f = await fixture(),
    reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  const tree = await FrozenBaseTree.render(f.input, 'data', f.identity('data'));
  FrozenBaseTree.assert(tree);
  expect(tree.empty).toBe(false);
  expect(await f.store.root.stat(tree.root + '/payload')).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  expect(() => ValidatedBaseObject.assertReceipt(tree as never)).toThrow();
  const facts = [];
  for await (const item of decodeRecords(f.store.read(tree.tree, 'native-tree')))
    if (tuple(item.value)[0] === 'file') facts.push(item.value);
  expect(tuple(facts[0])[3]).toBe(0o644);
  if (process.platform !== 'win32')
    expect((await f.store.root.stat('data/a'))![6] & 0o777).toBe(0o600);
  const loaded = await FrozenBaseTree.read(f.store, tree.reference, { budget: f.budget });
  expect(loaded.envelope).toEqual(tree.envelope);
  expect((await deriveBaseGroups(f.store, [tree], { budget: f.budget })).groups()).toEqual([
    ['data'],
    ['state'],
  ]);
});
it('renders the committed copied snapshot without requiring it at the SDK stage', async () => {
  const f = await fixture(),
    reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  const tree = await FrozenBaseTree.render(f.input, 'state', f.identity('state'));
  expect(await f.store.root.stat(tree.root + '/payload')).toBeNull();
  expect(await f.store.root.stat(f.input.partitions[1].nativeRoot + '/state/b')).not.toBeNull();
  expect(reads).not.toHaveBeenCalled();
});
it('rejects changed original file evidence during keyed metadata rendering', async () => {
  const f = await fixture();
  await writeFile(f.store.root.resolve('data/a'), 'different');
  await expect(FrozenBaseTree.render(f.input, 'data', f.identity('data'))).rejects.toThrow();
});
it('rejects cold adoption of orphan keyed metadata while allowing original-source same-process reconciliation', async () => {
  const f = await fixture(),
    first = await FrozenBaseTree.render(f.input, 'data', f.identity('data')),
    second = await FrozenBaseTree.render(f.input, 'data', f.identity('data'));
  expect(second.reference).toEqual(first.reference);
  await f.input.dispose();
  inputs.pop();
  const reads = vi.spyOn(NativeReadPhase.prototype, 'read');
  await expect(LiveBaseInputs.capture(f.store, { budget: f.budget })).rejects.toThrow(
    'keyed source metadata',
  );
  expect(reads).not.toHaveBeenCalled();
  expect(f.budget.retained).toBe(0);
});
