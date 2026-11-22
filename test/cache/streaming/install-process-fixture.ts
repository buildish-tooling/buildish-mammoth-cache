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

import { mixedDirectoryModel, mixedDirectoryInputs } from './mixed-directory-fixture';
import { installFixture } from './install-fixture';
import { freezeInstallPlan } from '../../../src/cache/streaming/install-plan';
import { executeInstall, recoverInstall } from '../../../src/cache/streaming/install-execute';
const [mode, root, point, nthText] = process.argv.slice(2);
let count = 0;
const hook = async (name: string) => {
  if (name === point && ++count === Number(nthText)) process.exit(73);
};
if (mode.startsWith('retire-')) {
  const old = await installFixture('gradle', { root });
  const next = await installFixture('gradle', { root, nonce: 'b'.repeat(32), fail: hook });
  if (mode === 'retire-start') {
    await old.store.initialize(old.bindings);
    await old.files('', {
      [old.store.prefix + 'orphan/a']: 'a',
      [old.store.prefix + 'orphan/sub/b']: 'b',
    });
    const state = old.store.codec.schemas.documents['local-state'].parse(await old.store.state());
    state[3]++;
    state[4] = 'completed';
    state[14] = 'abandoned';
    await old.store.updateState(state);
    await next.store.initialize(next.bindings, old.store);
  } else if (mode === 'retire-resume') await next.store.resumeRetirements(next.budget);
  else throw new Error('Unknown retirement process mode.');
  if (next.budget.retained) throw new Error('Retirement fixture leaked budget.');
  process.exit(0);
}
const mixed = mode.endsWith('-mixed');
const f = await installFixture('gradle', {
  root,
  fail: hook,
  ...(mixed ? { model: mixedDirectoryModel() } : {}),
});
if (mode.startsWith('start')) {
  await f.store.initialize(f.bindings);
  if (mode === 'start-replace' || mode === 'start-delete')
    await f.files('', { 'state/old': 'old', 'state/sub/old': 'old-sub' });
  const input = mixed
    ? null
    : mode === 'start-replace'
      ? await f.incoming('state', { 'state/new': 'new' })
      : mode === 'start-delete'
        ? await f.incoming('state', {})
        : await f.incoming('data', { 'data/a': 'a', 'data/b': 'b', 'data/sub/c': 'c' });
  const plan = await freezeInstallPlan(
    f.store,
    mixed ? await mixedDirectoryInputs(f) : [input!],
    f.budget,
  );
  await executeInstall(f.store, plan, f.budget);
} else if (mode === 'recover' || mode === 'recover-mixed') await recoverInstall(f.store, f.budget);
else throw new Error('Unknown process fixture mode.');
if (f.budget.retained) throw new Error('Process fixture leaked working budget.');
