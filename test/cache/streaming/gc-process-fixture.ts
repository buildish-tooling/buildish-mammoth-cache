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

import { utimes } from 'node:fs/promises';
import { observationFixture } from './observation-fixtures';
import { installFixture } from './install-fixture';
import { captureObservations } from '../../../src/cache/streaming/observation-capture';
import { executeGc, recoverGc } from '../../../src/cache/streaming/gc-execute';
const [mode, root, point, nthText] = process.argv.slice(2);
let count = 0;
const fail = async (name: string) => {
  if (name === point && ++count === Number(nthText)) process.exit(73);
};
const f =
  mode === 'start'
    ? await observationFixture('maven', { root, fail })
    : await installFixture('maven', { root, fail });
if (mode === 'start') {
  for (let n = 0; n < 6; n++) {
    const path = 'data/f' + n;
    await f.files('', { [path]: 'x' });
    await utimes(f.store.root.resolve(path), 1.234, 1.234);
  }
  await captureObservations(f.store, { budget: f.budget });
  await executeGc(f.store, { budget: f.budget, batchOperations: 2 });
} else if (mode === 'recover') await recoverGc(f.store, { budget: f.budget });
else if (mode === 'continue') await executeGc(f.store, { budget: f.budget, batchOperations: 3 });
else throw new Error('Unknown GC process mode.');
if (f.budget.retained) throw new Error('GC process leaked working budget.');
