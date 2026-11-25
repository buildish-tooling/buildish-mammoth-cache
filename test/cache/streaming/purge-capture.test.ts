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

import type * as Fs from 'node:fs/promises';
import { lstat, utimes, writeFile, link, symlink, mkdir, rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { captureFixtureObservations as captureObservations } from './observation-fixtures';
import { afterEach, expect, it, vi } from 'vitest';
import { installFixture } from './install-fixture';
import { initializeObservationFixture } from './observation-fixtures';
import { type ObservationCaptureOptions } from '../../../src/cache/streaming/observation-capture';
import { tuple, type Value } from '../../../src/cache/streaming/encoding';
import { PartitionSummaries } from '../../../src/cache/streaming/partition-summaries';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';

const counts = vi.hoisted(() => ({
  root: '',
  stats: 0,
  listings: 0,
  unlinks: 0,
  deny: '',
  crossDevice: '',
  forbidden: '',
  onStat: undefined as ((path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  const watched = (path: unknown) => {
    const p = String(path).replaceAll('\\', '/');
    return counts.root && (p === counts.root || p.startsWith(counts.root + '/data'));
  };
  return {
    ...actual,
    lstat: async (...a: Parameters<typeof actual.lstat>) => {
      if (watched(a[0])) {
        counts.stats++;
      }
      if (counts.forbidden && String(a[0]).startsWith(counts.forbidden)) {
        throw new Error('Unexpected opaque descendant stat');
      }
      const value = await actual.lstat(...a);
      counts.onStat?.(String(a[0]));
      return String(a[0]) === counts.crossDevice
        ? new Proxy(value, {
            get(target, key) {
              const v = Reflect.get(target, key);
              return key === 'dev' ? BigInt(v) + 1n : typeof v === 'function' ? v.bind(target) : v;
            },
          })
        : value;
    },
    opendir: async (...a: Parameters<typeof actual.opendir>) => {
      if (watched(a[0])) {
        counts.listings++;
      }
      if (counts.forbidden && String(a[0]).startsWith(counts.forbidden)) {
        throw new Error('Unexpected opaque descendant listing');
      }
      return actual.opendir(...a);
    },
    unlink: async (...a: Parameters<typeof actual.unlink>) => {
      if (String(a[0]) === counts.deny) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      if (watched(a[0])) {
        counts.unlinks++;
      }
      return actual.unlink(...a);
    },
  };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  counts.root = '';
  counts.deny = '';
  counts.crossDevice = '';
  counts.forbidden = '';
  counts.onStat = undefined;
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture(
  files: Record<string, string>,
  purgeGlobs: readonly string[] = ['data/*.lock'],
  excluded: string[] = [],
) {
  const f = await installFixture('gradle', { purgeGlobs, excluded });
  cleanup.push(async () => {
    await initialized.finish();
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', files);
  for (const p of Object.keys(files)) {
    await utimes(f.store.root.resolve(p), 1.234, 1.234);
  }
  const cutoff = Date.now() + 30;
  const initialized = await initializeObservationFixture(f, undefined, cutoff);
  await setTimeout(Math.max(0, cutoff - Date.now() + 5));
  let active = true;
  const grant: NonNullable<ObservationCaptureOptions['purgeWindow']> = {
    root: f.store.root,
    invocation: f.store.codec.options.invocation,
    assertCurrent() {
      if (!active) {
        throw new Error('window expired');
      }
    },
  };
  return {
    ...initialized,
    grant,
    expire: () => {
      active = false;
    },
  };
}
async function rows(f: Awaited<ReturnType<typeof fixture>>, reference: Value) {
  const result: Value[] = [];
  await f.store.readStream(
    reference,
    'observations',
    { budget: f.budget, partition: null },
    async (v) => {
      result.push(v);
    },
  );
  return result;
}
it('purges before native facts freeze while retaining original file activity and GC decisions', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/runtime.lock': 'lock' }),
    before = (await f.store.root.stat('data'))!,
    outcomes: string[] = [];
  const out = await captureObservations(f.store, {
      budget: f.budget,
      purgeWindow: f.grant,
      onPurge: (p, o) => outcomes.push(p + ':' + o),
    }),
    records = await rows(f, out.reference);
  expect(out.purge).toMatchObject({ status: 'executed', deleted: 1 });
  expect(outcomes).toEqual(['data:deleted']);
  expect(await f.store.root.stat('data/runtime.lock')).toBeNull();
  expect(records.filter((r) => tuple(r)[0] === 'child').map((r) => tuple(r)[1])).not.toContain(
    'runtime.lock',
  );
  const native = records
    .map((r) => tuple(r))
    .find((r) => r[0] === 'dir-open' && r[1] === 'data')![2];
  expect(native).toEqual(await f.store.root.stat('data'));
  expect((native as Value[])[9]).not.toBe(before[9]);
  expect(
    records
      .map((r) => tuple(r))
      .find((r) => r[0] === 'file')!
      .slice(4, 6),
  ).toEqual(['none', 'delete']);
});
it.each(['transform', 'kotlin', 'groovy'] as const)(
  'does not manufacture %s whole-unit activity when unlink crosses the cutoff',
  async (kind) => {
    const hash = 'a'.repeat(32),
      root =
        kind === 'transform'
          ? 'caches/transforms-4/' + hash
          : kind === 'kotlin'
            ? 'caches/9.2.1/kotlin-dsl/scripts/' + hash
            : 'caches/9.2.1/groovy-dsl/' + hash,
      relative =
        kind === 'transform'
          ? ['metadata.bin', 'results.bin', 'transformed/a']
          : kind === 'kotlin'
            ? ['metadata.bin', 'classes/a', 'instrumented/classes/a']
            : ['metadata.bin', 'metadata/metadata.bin', 'classes/a', 'instrumented/a'],
      f = await fixture(
        Object.fromEntries([
          ...relative.map((p) => [root + '/' + p, 'old']),
          [root + '/runtime.lock', 'lock'],
        ]),
        [root + '/runtime.lock'],
      );
    const out = await captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant }),
      records = await rows(f, out.reference),
      units = records.map((r) => tuple(r)).filter((r) => r[0] === 'unit-open');
    expect(units).toHaveLength(1);
    expect(units[0].slice(4, 6)).toEqual(['none', 'delete']);
    expect(out.purge.deleted).toBe(1);
  },
);
it('preserves real changed file activity after purge', async () => {
  const f = await fixture({ 'data/a': 'old', 'data/runtime.lock': 'lock' });
  await writeFile(f.store.root.resolve('data/a'), 'new');
  const out = await captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant });
  expect(
    (await rows(f, out.reference))
      .map((r) => tuple(r))
      .find((r) => r[0] === 'file')!
      .slice(4, 6),
  ).toEqual(['upsert', 'retain']);
});
it('does not delete without a current grant and reports a skipped purge', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/runtime.lock': 'lock' });
  const out = await captureObservations(f.store, { budget: f.budget });
  expect(out.purge.status).toBe('skipped');
  expect(out.purge.deleted).toBe(0);
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
});
it('uses cheap lifetime checks and refuses revoked or unbound windows before unlink', async () => {
  const f = await fixture({ 'data/runtime.lock': 'lock' });
  f.expire();
  await expect(
    captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant }),
  ).rejects.toThrow('expired');
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
  await expect(
    captureObservations(f.store, {
      budget: f.budget,
      purgeWindow: { ...f.grant, invocation: 'other' },
    }),
  ).rejects.toThrow();
});
it.each(['file', 'parent', 'after-unlink', 'revoke', 'unlink-error'] as const)(
  'rejects %s changes/failure without committing capture',
  async (bad) => {
    const f = await fixture({ 'data/a': 'a', 'data/runtime.lock': 'lock' });
    let once = false;
    vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
      if (once) {
        return;
      }
      if (bad === 'after-unlink' && point === 'observation-purge-unlinked') {
        once = true;
        await f.files('', { 'data/unknown': 'unknown' });
      }
      if (point !== 'observation-purge-before-unlink') {
        return;
      }
      if (bad === 'file') {
        once = true;
        await writeFile(f.store.root.resolve('data/runtime.lock'), 'replacement');
      }
      if (bad === 'parent') {
        once = true;
        await rename(f.store.root.resolve('data'), f.store.root.resolve('old-data'));
        await mkdir(f.store.root.resolve('data'));
        await f.files('', { 'data/runtime.lock': 'replacement' });
      }
      if (bad === 'revoke') {
        once = true;
        f.expire();
      }
      if (bad === 'unlink-error') {
        counts.deny = f.store.root.resolve('data/runtime.lock');
      }
    });
    await expect(
      captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant }),
    ).rejects.toThrow();
    expect(((await f.store.state()) as Value[])[4]).toBe('post-active');
  },
);
it('preserves hardlinked candidates and ordinary excluded siblings', async () => {
  const f = await fixture(
    { 'data/a': 'a', 'data/runtime.lock': 'lock', 'data/keep.lock': 'keep' },
    ['data/runtime.lock'],
  );
  await link(f.store.root.resolve('data/runtime.lock'), f.store.root.resolve('alias'));
  const summaries = new PartitionSummaries(f.model, f.budget),
    info = vi.fn();
  cleanup.push(() => summaries.dispose());
  const out = await captureObservations(f.store, {
    budget: f.budget,
    purgeWindow: f.grant,
    summaries,
    onCaptureInfo: info,
  });
  const text = info.mock.calls.flat().join('\n');
  expect(text).toContain('purged=0 files (shared claims credited once), missing=0, unsupported=1');
  expect(text).toContain('Unattributed: observed-excluded=3 files/1 directories');
  expect(out.purge).toMatchObject({ deleted: 0, unsupported: 1 });
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
  expect(await f.store.root.stat('data/keep.lock')).not.toBeNull();
});
it.skipIf(process.platform === 'win32')('never follows a matching symlink', async () => {
  const f = await fixture({ 'data/a': 'a' }, ['data/link.lock']);
  await symlink('a', f.store.root.resolve('data/link.lock'));
  const out = await captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant });
  expect(out.purge).toMatchObject({ deleted: 0, unsupported: 1 });
  expect((await lstat(f.store.root.resolve('data/link.lock'))).isSymbolicLink()).toBe(true);
});
it('keeps opaque hard-pruned scopes opaque under broad rules and reports them', async () => {
  const f = await fixture(
      { 'data/a': 'a', 'data/opaque/a.tmp': 'private' },
      ['**/*.tmp'],
      ['data/opaque/**'],
    ),
    scopes: string[] = [];
  counts.forbidden = f.store.root.resolve('data/opaque') + '/';
  const out = await captureObservations(f.store, {
    budget: f.budget,
    purgeWindow: f.grant,
    onOpaqueScope: (p) => scopes.push(p),
  });
  counts.forbidden = '';
  expect(scopes).toEqual(['data/opaque']);
  expect(out.purge.deleted).toBe(0);
  expect(await f.store.root.stat('data/opaque/a.tmp')).not.toBeNull();
});
it('adds zero native operations for nonmatches and fixed candidate-only work as ordinary files/depth grow', async () => {
  const results = [];
  for (const depth of [0, 6]) {
    for (const n of [4, 16]) {
      for (const match of [false, true]) {
        for (const enabled of [false, true]) {
          const parent = 'data' + '/nested'.repeat(depth),
            files: Record<string, string> = {};
          for (let i = 0; i < n; i++) {
            files[parent + '/f' + i] = 'body';
          }
          if (match) {
            files[parent + '/runtime.lock'] = 'lock';
          }
          const f = await fixture(files, [parent + '/runtime.lock']);
          counts.root = f.root.replaceAll('\\', '/');
          counts.stats = 0;
          counts.listings = 0;
          counts.unlinks = 0;
          const check = vi.spyOn(f.grant, 'assertCurrent');
          const read = vi.spyOn(NativeReadPhase.prototype, 'read');
          await captureObservations(f.store, {
            budget: f.budget,
            ...(enabled ? { purgeWindow: f.grant } : {}),
          });
          expect(read).not.toHaveBeenCalled();
          read.mockRestore();
          expect(check).toHaveBeenCalledTimes(enabled ? (match ? 5 : 3) : 0);
          check.mockRestore();
          results.push({
            depth,
            n,
            match,
            enabled,
            stats: counts.stats,
            listings: counts.listings,
            unlinks: counts.unlinks,
          });
          counts.root = '';
        }
      }
    }
  }
  const added = [];
  for (let i = 0; i < results.length; i += 2) {
    const off = results[i],
      on = results[i + 1];
    expect(on.listings).toBe(off.listings);
    expect(on.unlinks - off.unlinks).toBe(off.match ? 1 : 0);
    const delta = on.stats - off.stats;
    if (!off.match) {
      expect(delta).toBe(0);
    } else {
      added.push(delta);
    }
  }
  expect(new Set(added).size).toBe(1);
  expect(added[0]).toBe(3);
  process.stdout.write('V4D_CAPTURE_COST ' + JSON.stringify(results) + '\n');
}, 30000);

it('refuses a cross-device candidate before unlink', async () => {
  const f = await fixture({ 'data/runtime.lock': 'lock' });
  counts.crossDevice = f.store.root.resolve('data/runtime.lock');
  await expect(
    captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant }),
  ).rejects.toThrow('Cross-device');
  counts.crossDevice = '';
  expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
});
it('treats an already absent candidate as an executed no-op without extra discovery', async () => {
  const f = await fixture({ 'data/a': 'a' });
  const out = await captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant });
  expect(out.purge).toMatchObject({ status: 'executed', deleted: 0, missing: 0 });
});

it.each(['abort', 'revoke'] as const)(
  'does not unlink after %s during the final awaited candidate stat',
  async (kind) => {
    const f = await fixture({ 'data/runtime.lock': 'lock' }),
      controller = new AbortController();
    let seen = 0;
    counts.onStat = (p) => {
      if (p === f.store.root.resolve('data/runtime.lock') && ++seen === 2) {
        if (kind === 'abort') {
          controller.abort(new Error('last stat abort'));
        } else {
          f.expire();
        }
      }
    };
    await expect(
      captureObservations(f.store, {
        budget: f.budget,
        purgeWindow: f.grant,
        signal: controller.signal,
      }),
    ).rejects.toThrow(kind === 'abort' ? 'last stat abort' : 'expired');
    counts.onStat = undefined;
    expect(seen).toBe(2);
    expect(await f.store.root.stat('data/runtime.lock')).not.toBeNull();
    expect(((await f.store.state()) as Value[])[4]).toBe('post-active');
  },
);
it('rejects an expired window at final acceptance while preserving a committed observation', async () => {
  const f = await fixture({ 'data/a': 'a', 'data/runtime.lock': 'lock' });
  vi.spyOn(f.store, 'fail').mockImplementation(async (point) => {
    if (point === 'observations-pointer') {
      f.expire();
    }
  });
  await expect(
    captureObservations(f.store, { budget: f.budget, purgeWindow: f.grant }),
  ).rejects.toThrow('expired');
  expect(((await f.store.state()) as Value[])[6]).not.toBeNull();
  expect(await f.store.root.stat('data/runtime.lock')).toBeNull();
  await f.finish();
  expect(f.budget.retained).toBe(0);
});
