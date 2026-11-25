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
import { writeFile, appendFile, readdir } from 'node:fs/promises';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from './install-plan-fixture';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import { InstallScratch } from '../../../src/cache/streaming/install-scratch';
import type { Value } from '../../../src/cache/streaming/encoding';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture() {
  const f = await installFixture();
  cleanup.push(() => f.close());
  await f.store.initialize(f.bindings);
  return f;
}
it.each([4, 16])(
  'constructs one source/current index and reopens it for %i ordinary units',
  async (n) => {
    const f = await fixture();
    const entries = Object.fromEntries(
      Array.from({ length: n }, (_, i) => ['data/shared/f' + String(i).padStart(3, '0'), 'body']),
    );
    await f.files('', { 'data/shared': null }); // Keep multiple ordinary file units for this reuse slope.
    const input = await f.incoming('data', entries),
      before = f.store.root.work.indexBuilds;
    const frozen = await freezeInstallPlan(f.store, [input], f.budget);
    expect(f.store.root.work.indexBuilds - before).toBe(2);
    frozen.metadata.scratch.releaseReadCache();
    expect(f.budget.retained).toBe(0);
    const walks = f.store.root.work.nativeWalks;
    await executeInstall(f.store, frozen, f.budget);
    expect(f.store.root.work.indexBuilds - before).toBe(2);
    expect(f.store.root.work.nativeWalks - walks).toBe(0); // borrow original current/source indexes
    expect(f.budget.retained).toBe(0);
  },
);
it('rejects a modified parked index before any live operation', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/a': 'body' });
  let path = '';
  const park = InstallScratch.prototype.park;
  vi.spyOn(InstallScratch.prototype, 'park').mockImplementation(async function (
    this: InstallScratch,
  ) {
    await park.call(this);
    path = this.path;
  });
  const frozen = await freezeInstallPlan(f.store, [input], f.budget),
    renames = f.store.root.work.renames;
  await writeFile(f.store.root.resolve(path), 'foreign index');
  await expect(executeInstall(f.store, frozen, f.budget)).rejects.toThrow(
    /scratch.*changed|changed.*scratch/i,
  );
  expect(f.store.root.work.renames).toBe(renames);
  expect(await f.store.root.stat('data')).toBeNull();
  expect(f.budget.retained).toBe(0);
});
it('validates activity streams regardless of caller reference identity', async () => {
  const f = await fixture();
  const ref = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    (async function* (): AsyncGenerator<Value> {
      yield ['dir-open', ''];
      yield ['dir-open', 'data'];
      yield ['used', 'a', 'data'];
      yield ['dir-close', 'data'];
      yield ['dir-close', ''];
    })(),
  );
  const validations = f.store.root.work.metadataValidations;
  for (let i = 0; i < 2; i++) {
    for await (const row of f.store.rows(ref, 'activity', {
      budget: f.budget,
      partition: null,
    })) {
      void row;
    }
  }
  expect(f.store.root.work.metadataValidations).toBe(validations + 2);
  for await (const row of f.store.rows(structuredClone(ref), 'activity', {
    budget: f.budget,
    partition: null,
  })) {
    void row;
  }
  expect(f.store.root.work.metadataValidations).toBe(validations + 3);
  await writeFile(f.store.root.resolve(ref[2]), 'changed bytes');
  await expect(
    (async () => {
      for await (const row of f.store.rows(ref, 'activity', {
        budget: f.budget,
        partition: null,
      })) {
        void row;
      }
    })(),
  ).rejects.toThrow();
  expect(f.budget.retained).toBe(0);
});

it('cancels a genuine completed-reference read while its real beforeAccept callback is pending', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const ref = await f.store.writeStream(
    'activity',
    { budget: f.budget, partition: null },
    (async function* (): AsyncGenerator<Value> {
      yield ['dir-open', ''];
      yield ['dir-close', ''];
    })(),
  );
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const work = (async () => {
    for await (const row of f.store.rows(
      ref,
      'activity',
      { budget: f.budget, partition: null },
      controller.signal,
      async () => {
        entered();
        await new Promise<void>(() => {});
      },
    )) {
      void row;
    }
  })();
  const rejected = expect(work).rejects.toThrow('cancel callback');
  await ready;
  controller.abort(new Error('cancel callback'));
  await rejected;
  expect(f.budget.retained).toBe(0);
});
it.each(['same-size', 'appended-row'])(
  'does not mint writer proof after a %s edit at completion',
  async (kind) => {
    const f = await fixture();
    let altered = false;
    vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (point !== 'immutable-file-written' || altered) {
        return;
      }
      altered = true;
      const folder = f.store.root.resolve(f.store.prefix + 'files');
      const name = (await readdir(folder)).find((n) => n.endsWith('.tmp'))!;
      if (kind === 'appended-row') {
        await appendFile(folder + '/' + name, '["used","z","data"]\n');
      } else {
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(folder + '/' + name);
        const at = bytes.indexOf(Buffer.from('["used","a"'));
        expect(at).toBeGreaterThanOrEqual(0);
        bytes[at + 9] = 'b'.charCodeAt(0);
        await writeFile(folder + '/' + name, bytes);
      }
    });
    await expect(
      f.store.writeStream(
        'activity',
        { budget: f.budget, partition: null },
        (async function* (): AsyncGenerator<Value> {
          yield ['dir-open', ''];
          yield ['dir-open', 'data'];
          yield ['used', 'a', 'data'];
          yield ['dir-close', 'data'];
          yield ['dir-close', ''];
        })(),
      ),
    ).rejects.toThrow('candidate changed');
    expect(altered).toBe(true);
    expect(f.budget.retained).toBe(0);
  },
);
