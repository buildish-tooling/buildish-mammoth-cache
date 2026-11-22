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

import { setTimeout as delay } from 'node:timers/promises';
import { opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { OwnedStore, Reference } from '../../cache/streaming/owned-store';
import { H, tuple } from '../../cache/streaming/encoding';
import { sameNative } from '../../cache/streaming/native';
import type { WorkingBudget } from '../../cache/streaming/tree-state';
import { readLocalStream } from '../../cache/streaming/local-stream';
import { inspectGradleDaemons } from './process-inspection';
import { stopGradleInstallation } from './stop-client';
import type { ConsumerWindowInput } from '../lifecycle-types';
import type { GradleConsumerDependencies } from './lifecycle';
import { registrationDirectory, registrationFailure } from './registrations';

// Protocol: docs/dev/cache-lifecycle-protocol.md#gradle-installation-registration.
async function sealInstallations(
  store: OwnedStore,
  budget: WorkingBudget,
  signal: AbortSignal,
): Promise<Reference> {
  const dir = registrationDirectory(store),
    before = await store.root.stat(dir);
  if (!before || before[2] !== 'directory')
    throw new Error('Missing operational registration directory.');
  async function* records() {
    const entries = await opendir(store.root.resolve(dir));
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
        throw new Error('Incomplete/invalid operational registration.');
      const value = store.codec.schemas.documents['gradle-installation'].parse(
        await store.readFixed(dir + '/' + entry.name),
      );
      if (entry.name !== H('gradle-installation', value) + '.json')
        throw new Error('Operational registration name changed.');
      yield ['installation', value] as const;
    }
    const after = await store.root.stat(dir);
    if (!after || !sameNative(before!, after, true))
      throw new Error('Operational inventory changed while sealing.');
  }
  return store.writeStream('installations', { budget, partition: null }, records(), signal);
}
export async function quiesceGradle(
  input: ConsumerWindowInput,
  dependencies: GradleConsumerDependencies,
): Promise<Reference> {
  const {
    store,
    budget,
    signal: limited,
    assertCurrent: assert,
    deadline,
    clientTimeout,
    exitGrace,
  } = input;
  if (!dependencies.inspect && !['linux', 'win32', 'darwin'].includes(process.platform))
    throw new Error('Native process inspection unavailable on this platform.');
  if (input.sourcesFrozen && !input.installations)
    throw new Error('Frozen post requires original quiescence.');
  if (await store.root.stat(registrationFailure(store)))
    throw new Error('Operational capture failed.');
  const installations = input.installations ?? (await sealInstallations(store, budget, limited));
  const ref = installations,
    native = await store.root.stat(ref[2]);
  if (!native) throw new Error('Missing sealed installation inventory.');
  const streamOptions = { codec: store.codec, budget, partition: null };
  // Validate EOF before executing any installation; reuse that exact native file.
  await readLocalStream(
    store.root.read(ref[2], native),
    'installations',
    streamOptions,
    ref,
    undefined,
    limited,
  );
  if (!input.sourcesFrozen)
    await readLocalStream(
      store.root.read(ref[2], native),
      'installations',
      streamOptions,
      ref,
      async (value) => {
        const row = tuple(value);
        if (row[0] !== 'installation') return;
        assert();
        limited.throwIfAborted();
        const r = store.codec.schemas.rows.registration.parse(row[1]),
          installation = { gradleHome: r[3], gradleUserHome: r[5], javaHome: r[6] },
          launcher = path.join(r[3], 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle'),
          raw = await lstat(launcher);
        if (!raw.isFile() || raw.isSymbolicLink())
          throw new Error('Captured Gradle launcher unavailable.');
        const remaining = Math.floor(Math.min(clientTimeout, deadline - performance.now()));
        if (remaining < 1) throw new Error('Quiescence deadline exceeded.');
        await (dependencies.stop ?? stopGradleInstallation)(installation, limited, remaining);
      },
      new AbortController().signal,
    );
  const inspect = dependencies.inspect ?? inspectGradleDaemons,
    settleBy = Math.min(deadline, performance.now() + exitGrace);
  let proof = await inspect(limited);
  while (proof.remaining && !proof.uncertain && performance.now() < settleBy) {
    await delay(Math.min(250, settleBy - performance.now()), undefined, { signal: limited });
    proof = await inspect(limited);
  }
  if (proof.remaining || proof.uncertain)
    throw new Error(
      proof.reason ??
        (proof.remaining
          ? 'Relevant Gradle daemons remain after stop.'
          : 'Process evidence is unavailable.'),
    );
  if (await store.root.stat(registrationFailure(store)))
    throw new Error('Operational capture failed during shutdown.');
  return installations;
}
