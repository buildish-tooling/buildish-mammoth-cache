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

import { chmod, mkdir, readFile, rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareStateFixture } from './prepare-state-fixture';
import { PrepareFacts } from '../../../src/cache/streaming/prepare-state';
import { clearPrepareInstall } from '../../../src/cache/streaming/owned-retirement';
import { executeInstall } from '../../../src/cache/streaming/install-execute';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import { OpenedInvocation } from '../../../src/cache/streaming/invocation';
const fixtures: Awaited<ReturnType<typeof prepareStateFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
async function fixture() {
  const f = await prepareStateFixture();
  fixtures.push(f);
  return f;
}
it('cold discards unclaimed/consumed private staging under its bound parent, preserving snapshots/Qs/live data', async () => {
  const f = await fixture();
  await f.files('', {
    [f.store.prefix + 'install/data/data/a']: 'unused',
    [f.store.prefix + 'install/state/state/old']: 'consumed-copy',
    [f.store.prefix + 'snapshots/keep']: 'authority',
    [f.store.prefix + 'files/keep']: 'immutable',
    'data/live': 'live',
  });
  const reopened = await OpenedInvocation.current(f.root, f.budget);
  expect(reopened).not.toBeNull();
  const facts = await PrepareFacts.open(reopened!.store, { budget: f.budget });
  try {
    await clearPrepareInstall(facts);
  } finally {
    facts.close();
  }
  expect(await f.store.root.stat(f.store.prefix + 'install/data')).toBeNull();
  expect(await f.store.root.stat(f.store.prefix + 'install/state')).toBeNull();
  for (const [name, body] of [
    [f.store.prefix + 'snapshots/keep', 'authority'],
    [f.store.prefix + 'files/keep', 'immutable'],
    ['data/live', 'live'],
  ])
    expect(await readFile(f.store.root.resolve(name), 'utf8')).toBe(body);
  const next = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await clearPrepareInstall(next);
  } finally {
    next.close();
  }
});
it('rejects replacement of the install container without adopting its current identity', async () => {
  const f = await fixture(),
    root = f.store.prefix + 'install';
  await f.files('', { [root + '/data/original']: 'original' });
  await rename(f.store.root.resolve(root), f.store.root.resolve(f.store.prefix + 'old-install'));
  await mkdir(f.store.root.resolve(root));
  await f.files('', { [root + '/data/replacement']: 'replacement' });
  const facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await expect(clearPrepareInstall(facts)).rejects.toThrow('container replaced');
  } finally {
    facts.close();
  }
  expect(await readFile(f.store.root.resolve(root + '/data/replacement'), 'utf8')).toBe(
    'replacement',
  );
  expect(
    await readFile(f.store.root.resolve(f.store.prefix + 'old-install/data/original'), 'utf8'),
  ).toBe('original');
});
it('preserves unknown partition children and rejects fabricated disposal receipts', async () => {
  const f = await fixture();
  await f.files('', { [f.store.prefix + 'install/unknown/file']: 'unknown' });
  const facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await expect(clearPrepareInstall(facts)).rejects.toThrow('Unknown');
  } finally {
    facts.close();
  }
  expect(
    await readFile(f.store.root.resolve(f.store.prefix + 'install/unknown/file'), 'utf8'),
  ).toBe('unknown');
  await expect(clearPrepareInstall(Object.create(PrepareFacts.prototype))).rejects.toThrow(
    'Unavailable prepare',
  );
});
it.skipIf(process.platform === 'win32')(
  'rejects actual install-parent mode drift using stable identity rather than cached mode',
  async () => {
    const f = await fixture(),
      root = f.store.root.resolve(f.store.prefix + 'install'),
      mode = f.selection[8][6] & 0o777;
    await f.files('', { [f.store.prefix + 'install/data/a']: 'copy' });
    await chmod(root, mode ^ 0o020);
    const facts = await PrepareFacts.open(f.store, { budget: f.budget });
    try {
      await expect(clearPrepareInstall(facts)).rejects.toThrow('container replaced');
    } finally {
      facts.close();
      await chmod(root, mode);
    }
    expect(await readFile(f.store.root.resolve(f.store.prefix + 'install/data/a'), 'utf8')).toBe(
      'copy',
    );
  },
);
it('refuses disposal while an install owns a discoverable live batch', async () => {
  const f = await fixture(),
    input = await f.incoming('data', { 'data/a': 'a' }, 'trusted-base'),
    plan = await freezeInstallPlan(f.store, [input], f.budget);
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'install-intent-published') throw new Error('interrupted');
  });
  await expect(executeInstall(f.store, plan, f.budget)).rejects.toThrow('interrupted');
  const facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await expect(clearPrepareInstall(facts)).rejects.toThrow('idle prepare');
  } finally {
    facts.close();
  }
  expect(await f.store.root.stat(f.store.prefix + 'install/data/data/a')).not.toBeNull();
  await expect(f.store.assertNoIntents()).rejects.toThrow('destructive intent');
});
it('retries interrupted private disposal under the same stable parent without an install receipt', async () => {
  const f = await fixture(),
    controller = new AbortController();
  await f.files('', {
    [f.store.prefix + 'install/data/a']: 'a',
    [f.store.prefix + 'install/data/b']: 'b',
    'data/live': 'keep',
  });
  const before = f.store.root.work.unlinks;
  vi.spyOn(f.store, 'fail').mockImplementation(async (name) => {
    if (name === 'prepare-install-member-retired') controller.abort(new Error('cancelled'));
  });
  let facts = await PrepareFacts.open(f.store, { budget: f.budget, signal: controller.signal });
  try {
    await expect(clearPrepareInstall(facts)).rejects.toThrow('cancelled');
  } finally {
    facts.close();
  }
  expect(f.store.root.work.unlinks - before).toBe(1);
  vi.restoreAllMocks();
  facts = await PrepareFacts.open(f.store, { budget: f.budget });
  try {
    await clearPrepareInstall(facts);
  } finally {
    facts.close();
  }
  expect(await f.store.root.stat(f.store.prefix + 'install/data')).toBeNull();
  expect(await readFile(f.store.root.resolve('data/live'), 'utf8')).toBe('keep');
});
it('adds no managed-root traversal as live payload width grows4/16', async () => {
  const counts = [];
  for (const width of [4, 16]) {
    const f = await fixture();
    for (let n = 0; n < width; n++) await f.files('', { ['data/f' + n]: 'live' });
    await f.files('', {
      [f.store.prefix + 'install/data/a']: 'a',
      [f.store.prefix + 'install/data/b']: 'b',
    });
    const facts = await PrepareFacts.open(f.store, { budget: f.budget }),
      before = { ...f.store.root.work };
    try {
      await clearPrepareInstall(facts);
    } finally {
      facts.close();
    }
    counts.push(
      Object.fromEntries(
        ['stats', 'opens', 'unlinks', 'directorySyncs'].map((k) => {
          const key = k as keyof typeof before;
          return [key, f.store.root.work[key] - before[key]];
        }),
      ),
    );
  }
  expect(counts[0]).toEqual(counts[1]);
  process.stdout.write('V5_INSTALL_STAGING_COST ' + JSON.stringify(counts) + '\n');
});
