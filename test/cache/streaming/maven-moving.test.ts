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
import { readFile, rename } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { observationFixture } from './observation-fixtures';
import { cleanupBaseFixtures, nativeCacheBackend } from './base-fixtures';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import {
  FrozenMovingPublication,
  movingObjectRef,
} from '../../../src/cache/streaming/base-moving-publication';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import { NativeObjectDownload } from '../../../src/cache/streaming/base-transport';
import { NativeReadPhase } from '../../../src/cache/streaming/native-read-phase';
import { tuple } from '../../../src/cache/streaming/encoding';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { sameNative, sameRename } from '../../../src/cache/streaming/native';
import { walkNative } from '../../../src/cache/streaming/native-walk';

const counts = vi.hoisted(() => ({ root: '', listings: 0, entries: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const directory = await actual.opendir(...args),
        path = String(args[0]).replaceAll('\\', '/');
      if (
        !counts.root ||
        !(
          path === counts.root ||
          path.startsWith(counts.root + '/') ||
          path.includes('/payload/repository')
        )
      )
        return directory;
      counts.listings++;
      return new Proxy(directory, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === Symbol.asyncIterator)
            return async function* () {
              for await (const entry of target) {
                counts.entries++;
                yield entry;
              }
            };
          if (key === 'read')
            return async (...a: unknown[]) => {
              const entry = await Reflect.apply(value, target, a);
              if (entry) counts.entries++;
              return entry;
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  counts.root = '';
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  await cleanupBaseFixtures();
});
async function fixture(
  files: Record<string, string>,
  options: Parameters<typeof observationFixture>[1] = {},
) {
  const f = await observationFixture('maven', options);
  cleanup.push(async () => {
    expect(f.budget.retained).toBe(0);
    await f.close();
  });
  await f.files('', files);
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  const input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  cleanup.push(() => input.dispose());
  const pub = await FrozenMovingPublication.freeze(input, 'main');
  cleanup.push(() => pub.dispose());
  const publisher = MovingBasePublication.open(pub);
  cleanup.push(() => publisher.close());
  return { ...f, input, pub, publisher };
}
it.each(['clean', 'excluded', 'mixed-aggregate', 'mixed-snapshot'] as const)(
  'round trips Maven %s through native save/return and actual SDK archives',
  async (kind) => {
    const files: Record<string, string> = {
      'repository/org/a/1/_remote.repositories': 'marker',
      'repository/org/a/1/a.jar': 'a',
      'repository/org/b/1/b.jar': 'b',
    };
    if (kind === 'excluded') files['repository/keep.lock'] = 'private';
    if (kind.startsWith('mixed')) files['repository/other/c/1/c.jar'] = 'c';
    const f = await fixture(
        files,
        kind === 'mixed-aggregate'
          ? { repositorySplit: 'aggregate' }
          : kind === 'mixed-snapshot'
            ? { repositorySplit: 'single-writer' }
            : {},
      ),
      sdk = await nativeCacheBackend(),
      originals = new Map(
        await Promise.all(
          Object.keys(files).map(async (p) => [p, (await f.store.root.stat(p))!] as const),
        ),
      ),
      rootNative = (await f.store.root.stat('repository'))!,
      root = f.store.root.resolve('repository'),
      before = vi.mocked(rename).mock.calls.length;
    await f.publisher.saveObjects(sdk.backend);
    if (kind === 'clean')
      expect(
        vi
          .mocked(rename)
          .mock.calls.slice(before)
          .filter(([a, b]) => String(a) === root || String(b) === root),
      ).toHaveLength(2);
    for (const [p, body] of Object.entries(files)) {
      expect(await readFile(f.store.root.resolve(p), 'utf8')).toBe(body);
      expect(sameNative(originals.get(p)!, (await f.store.root.stat(p))!, true)).toBe(true);
    }
    if (kind === 'clean')
      expect(sameRename(rootNative, (await f.store.root.stat('repository'))!)).toBe(true);
    await f.store.assertNoIntents();
    const cells = await f.pub.cells();
    try {
      expect(
        cells.rows.every(
          (c) =>
            c[6] === null &&
            (f.pub.choices.find((choice) => choice[1] === c[1])![0] === 'empty' || c[5] !== null),
        ),
      ).toBe(true);
    } finally {
      cells.release();
    }
    await f.publisher.publish(sdk.backend);
    for (const choice of f.pub.choices)
      if (choice[0] === 'new') {
        const saved = sdk.calls.find((c) => c.kind === 'save' && c.key === choice[3]);
        expect(saved?.paths).toHaveLength(3);
        expect(saved?.members).toHaveLength(3);
        const restored = await NativeObjectDownload.restore(
          f.store,
          sdk.backend,
          movingObjectRef(choice),
          f.pub.options,
          true,
        );
        try {
          expect(restored.object).not.toBeNull();
          const actual = [];
          for await (const event of walkNative(f.store.root, restored.object!.payload, {
            budget: f.budget,
            logicalRoot: '',
          }))
            if (event.tag === 'file') actual.push(event.path);
          const expected = Object.keys(files).filter(
            (p) => !p.endsWith('.lock') && f.model.owner(p)[0] === choice[1],
          );
          expect(actual.sort()).toEqual(expected.sort());
          for (const p of actual)
            expect(
              await readFile(f.store.root.resolve(restored.object!.payload + '/' + p), 'utf8'),
            ).toBe(files[p]);
          await restored.object!.verifyStable(f.pub.options);
        } finally {
          await restored.dispose();
        }
      }
  },
  30000,
);

it('keeps one Maven root and two payload renames as complete coordinate count grows', async () => {
  const results = [];
  for (const coordinates of [4, 16]) {
    const files: Record<string, string> = {};
    for (let i = 0; i < coordinates; i++) {
      const root = 'repository/org/a' + String(i).padStart(3, '0') + '/1/';
      files[root + 'a.jar'] = 'body';
      files[root + '_remote.repositories'] = 'marker';
    }
    const f = await fixture(files),
      choice = f.pub.choices.find((c) => c[1] === 'data')!;
    if (choice[0] !== 'new') throw new Error('Expected coarse test choice.');
    let groups = 0,
      roots = 0;
    for await (const row of f.store.rows(choice[6], 'move-plan', {
      ...f.pub.options,
      partition: 'data',
    })) {
      const r = tuple(row.value);
      if (r[0] === 'move-unit-open') groups++;
      if (r[0] === 'move') roots++;
    }
    expect({ groups, roots }).toEqual({ groups: 1, roots: 1 });
    let extraHashBytes = 0;
    const hash = NativeReadPhase.prototype.hash,
      hashSpy = vi.spyOn(NativeReadPhase.prototype, 'hash').mockImplementation(async function (
        this: NativeReadPhase,
        ...args: Parameters<NativeReadPhase['hash']>
      ) {
        if (args[2] === null) extraHashBytes += Number(args[1][5]);
        return hash.apply(this, args);
      }),
      before = { ...f.store.root.work },
      renameStart = vi.mocked(rename).mock.calls.length,
      source = f.store.root.resolve('repository');
    counts.root = source.replaceAll('\\', '/');
    counts.listings = 0;
    counts.entries = 0;
    // Native lifecycle costs only; real SDK archive/extraction is tested above.
    const backend: BaseCacheBackend = {
      capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
      isFeatureAvailable: () => true,
      saveCache: async () => 1,
      restoreCache: async () => undefined,
      isMissingPathsError: () => false,
    };
    try {
      await f.publisher.saveObjects(backend);
      await f.publisher.publish(backend);
    } finally {
      hashSpy.mockRestore();
      counts.root = '';
    }
    const payloadRenames = vi
        .mocked(rename)
        .mock.calls.slice(renameStart)
        .filter(([a, b]) => String(a) === source || String(b) === source).length,
      work = Object.fromEntries(
        Object.entries(f.store.root.work).map(([key, value]) => [
          key,
          value - before[key as keyof typeof before],
        ]),
      );
    expect(payloadRenames).toBe(2);
    expect(extraHashBytes).toBe(0);
    expect(f.input.work).toEqual({ hashBytes: 10 * coordinates, copyBytes: 0 });
    expect(counts.listings).toBeGreaterThan(0);
    expect(counts.entries).toBeGreaterThan(0);
    results.push({
      coordinates,
      groups,
      roots,
      payloadRenames,
      extraHashBytes,
      sourceCapture: f.input.work,
      listings: counts.listings,
      entries: counts.entries,
      work,
      budgetPeak: f.budget.peakRetained,
    });
  }
  const [small, large] = results;
  expect(large.listings).toBeLessThanOrEqual(4 * small.listings);
  expect(large.entries).toBeLessThanOrEqual(4 * small.entries);
  expect(large.work.stats).toBeLessThanOrEqual(4 * small.work.stats);
  expect(large.work.readBytes).toBeLessThanOrEqual(4 * small.work.readBytes);
  expect(large.work.writeBytes).toBeLessThanOrEqual(4 * small.work.writeBytes);
  process.stdout.write('V4C_COST ' + JSON.stringify(results) + '\n');
}, 60000);
