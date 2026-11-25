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

import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveModel, type ResolvedModel } from '../../../src/cache/streaming/model';
import { compareName } from '../../../src/cache/streaming/tree-state';
import type { Value } from '../../../src/cache/streaming/encoding';
import { installFixture } from './install-fixture';
import {
  initializeObservationFixture,
  captureFixtureObservations,
  executeFixtureGc,
} from './observation-fixtures';
const fixtures: Awaited<ReturnType<typeof installFixture>>[] = [];
export async function cleanupSourceFixtures() {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
}
export async function sourceFixture(
  snapshot = false,
  tool: 'gradle' | 'maven' = 'gradle',
  override?: ResolvedModel,
  job = 'A',
) {
  const hard = ['.mammoth/**', '**/*.lock', '**/*-excluded.jar'],
    model =
      override ??
      resolveModel(
        [
          'model',
          1,
          tool,
          hard,
          [
            [
              'data',
              ['**'],
              hard,
              snapshot ? 'single-writer' : 'aggregate',
              snapshot ? 'A' : null,
              'default',
              0,
            ],
          ],
        ],
        'v2-',
        1,
      ),
    f = await installFixture(tool, { model, role: 'distributed-worker', job });
  const source = Object.assign(f, { finish: async () => {} });
  fixtures.push(source);
  await mkdir(path.join(f.root, 'd'));
  await writeFile(path.join(f.root, 'd/a'), 'abc');
  await writeFile(path.join(f.root, 'd/b'), 'defg');
  return source;
}
/** Test data records actual build activity; production capture and actual GC mint the source owner. */
export async function freezeSources(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  remove = '',
  unitRoot = '',
) {
  async function* activity(p: string): AsyncGenerator<Value> {
    const values: Value[] = [];
    const entries = (await readdir(f.store.root.resolve(p), { withFileTypes: true })).sort(
      (a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || compareName(a.name, b.name),
    );
    for (const e of entries) {
      if (e.name === '.mammoth' || e.name.endsWith('.lock') || e.name.endsWith('-excluded.jar')) {
        continue;
      }
      const logical = p ? p + '/' + e.name : e.name;
      if (remove === 'remove-unit' && logical === unitRoot) {
        continue;
      }
      if (e.isDirectory()) {
        for await (const row of activity(logical)) {
          values.push(row);
        }
      } else if (
        logical !== remove &&
        !(remove === 'remove-unit' && (logical === unitRoot || logical.startsWith(unitRoot + '/')))
      ) {
        values.push(['upsert', e.name, f.model.owner(logical)[0]]);
      }
    }
    if (values.length || !p) {
      yield ['dir-open', p];
      yield* values;
      yield ['dir-close', p];
    }
  }
  const imported: Value[] = [];
  if (remove) {
    for await (const row of activity('')) {
      imported.push(row);
    }
  } else {
    imported.push(['dir-open', ''], ['dir-close', '']);
  }
  const initialized = await initializeObservationFixture(
    f,
    imported,
    remove ? Date.now() + 600000 : 0,
  );
  const captured = await captureFixtureObservations(initialized.store, {
    budget: f.budget,
    retainIndex: true,
  });
  const result = await executeFixtureGc(initialized.store, { budget: f.budget });
  if (!captured.index) {
    throw new Error('Missing original capture');
  }
  return { survivors: result.owner };
}
export async function freezeRetainedSources(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  _units: readonly string[] = [],
  _snapshots: readonly string[] = [],
) {
  return freezeSources(f);
}
