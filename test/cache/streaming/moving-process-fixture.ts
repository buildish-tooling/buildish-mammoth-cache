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

import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc } from '../../../src/cache/streaming/gc-execute';
import { LiveBaseInputs } from '../../../src/cache/streaming/live-base-inputs';
import { FrozenMovingPublication } from '../../../src/cache/streaming/base-moving-publication';
import { MovingBasePublication } from '../../../src/cache/streaming/moving-publication';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { utimes } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { observationFixture, initializeObservationFixture } from './observation-fixtures';
import { installFixture } from './install-fixture';
const [mode, root, point, nthText, fixtureKind] = process.argv.slice(2);
let hit = 0;
const fail = async (name: string) => {
  if (name === point && ++hit === Number(nthText)) process.exit(73);
};
const tool = fixtureKind === 'maven' ? 'maven' : 'gradle';
const purgeRoot = 'caches/transforms-4/' + 'a'.repeat(32),
  purgeGlobs = [purgeRoot + '/*.lock', purgeRoot + '/a.lock'];
const f =
  mode === 'start' && fixtureKind !== 'purge'
    ? await observationFixture(tool, { root, fail })
    : await installFixture(tool, {
        root,
        fail,
        ...(fixtureKind === 'purge' ? { purgeGlobs } : {}),
      });
if (fixtureKind === 'purge') {
  if (mode === 'start') {
    const files = {
      [purgeRoot + '/metadata.bin']: 'm',
      [purgeRoot + '/results.bin']: 'r',
      [purgeRoot + '/transformed/a']: 'payload',
      [purgeRoot + '/a.lock']: 'a-lock',
      [purgeRoot + '/b.lock']: 'b-lock',
    };
    await f.files('', files);
    for (const p of Object.keys(files)) await utimes(f.store.root.resolve(p), 1.234, 1.234);
    const cutoff = Date.now() + 30;
    await initializeObservationFixture(f, undefined, cutoff);
    await setTimeout(Math.max(0, cutoff - Date.now() + 5));
  }
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state()),
    window = {
      root: f.store.root,
      invocation: f.store.codec.options.invocation,
      assertCurrent: (): undefined => {},
    };
  let deleted = 0,
    frozen = false;
  if (state[6]) {
    try {
      await captureObservations(f.store, { budget: f.budget, purgeWindow: window });
      throw new Error('Unexpected recapture');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('quiescent')) throw error;
    }
    frozen = true;
  } else {
    const out = await captureObservations(f.store, { budget: f.budget, purgeWindow: window });
    deleted = out.purge.deleted;
  }
  if (f.budget.retained) throw new Error('Purge process leaked budget.');
  process.stdout.write(JSON.stringify({ deleted, frozen }) + '\n');
  process.exit(0);
}
let pub: FrozenMovingPublication, input: LiveBaseInputs | undefined;
if (mode === 'start') {
  const unit = 'caches/transforms-4/' + 'a'.repeat(32);
  await f.files(
    '',
    tool === 'maven'
      ? {
          'repository/org/a/1/_remote.repositories': 'marker',
          'repository/org/a/1/a.jar': 'a',
          'repository/org/b/1/b.jar': 'b',
        }
      : {
          'caches/a': 'a',
          'caches/b': 'b',
          [unit + '/metadata.bin']: 'm',
          [unit + '/results.bin']: 'r',
          [unit + '/transformed/a']: 'a',
          [unit + '/keep.lock']: 'protected',
          'state/b': 'snapshot',
        },
  );
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget });
  input = await LiveBaseInputs.capture(f.store, { budget: f.budget });
  pub = await FrozenMovingPublication.freeze(input, 'main');
} else pub = await FrozenMovingPublication.resume(f.store, { budget: f.budget });
const publisher = MovingBasePublication.open(pub, { operations: 1 });
// Persistence qualification uses an acknowledging backend double. Installed SDK
// archive/extract + uncertain readback are exercised separately in relocation.test.
const backend: BaseCacheBackend = {
  capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
  isFeatureAvailable: () => true,
  saveCache: async () => 1,
  restoreCache: async () => undefined,
  isMissingPathsError: () => false,
};
try {
  if (mode === 'start') await publisher.saveObjects(backend);
  else if (mode === 'recover') await publisher.recoverSources();
  else throw new Error('Unknown moving process mode.');
} finally {
  await publisher.close();
  pub.dispose();
  await input?.dispose();
}
if (f.budget.retained) throw new Error('Moving process leaked working budget.');
