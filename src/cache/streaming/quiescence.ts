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
import type { OwnedStore, Reference } from './owned-store';
import { H, equal, tuple } from './encoding';
import { sameNative, nativeIdentity } from './native';
import { checkPostRootBinding } from './post-admission';
import type { WorkingBudget } from './tree-state';
import { readLocalStream } from './local-stream';
import { inspectGradleDaemons, type DaemonInspection } from './process-inspection';
import { stopGradleInstallation, type GradleInstallation } from './stop-client';

export const registrationDirectory = (store: OwnedStore): string => store.prefix + 'registrations';
export const registrationFailure = (store: OwnedStore): string =>
  store.prefix + 'registrations.failed.json';
interface WindowOptions {
  readonly signal?: AbortSignal;
  /** Caller holds the documented dedicated-root/no-consumer lifetime; this must be cheap and synchronous. */
  readonly assertCurrent: () => undefined;
  readonly timeoutMs?: number;
  readonly clientTimeoutMs?: number;
  readonly exitGraceMs?: number;
  readonly inspect?: (signal: AbortSignal) => Promise<DaemonInspection>;
  readonly stop?: (
    installation: GradleInstallation,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<void>;
}
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
export class ExclusiveWindow {
  private readonly lifetime = new AbortController();
  readonly signal: AbortSignal;
  private constructor(
    readonly store: OwnedStore,
    private readonly assertion: () => undefined,
    signal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
  }
  assertCurrent = (): undefined => {
    this.signal.throwIfAborted();
    if (this.assertion() !== undefined)
      throw new Error('Exclusive-window assertion must be synchronous.');
  };
  get purgeWindow() {
    return {
      root: this.store.root,
      invocation: this.store.codec.options.invocation,
      assertCurrent: this.assertCurrent,
    };
  }
  close() {
    this.lifetime.abort(new Error('Exclusive window closed.'));
  }
  static async establish(
    store: OwnedStore,
    budget: WorkingBudget,
    options: WindowOptions,
  ): Promise<
    | { status: 'ready'; window: ExclusiveWindow }
    | { status: 'skipped-not-quiescent'; message: string }
  > {
    const input = Object.freeze({ ...options }),
      signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (
      store.codec.options.access !== 'writable' ||
      store.codec.options.role === 'distributed-worker'
    )
      throw new Error('Exclusive base window requires writable base role.');
    if (input.assertCurrent.constructor.name === 'AsyncFunction')
      throw new Error('Exclusive-window assertion must be synchronous.');
    const assert = () => {
      signal.throwIfAborted();
      if (input.assertCurrent() !== undefined)
        throw new Error('Exclusive-window assertion must be synchronous.');
    };
    assert();
    const initial = store.codec.schemas.documents['local-state'].parse(await store.state()),
      bindings = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(initial[5], 'bindings'),
      );
    store.codec.checkStateBindings(initial, bindings);
    const checkRoot = async () => {
      store.root.work.stats++;
      checkPostRootBinding(
        store,
        bindings,
        nativeIdentity(await lstat(store.root.path, { bigint: true })),
      );
    };
    await checkRoot();
    if (initial[4] === 'prepare-pending' || initial[4] === 'completed')
      throw new Error('Exclusive window outside post/recovery lifecycle.');
    const timeout = input.timeoutMs ?? 180000,
      clientTimeout = input.clientTimeoutMs ?? 60000,
      exitGrace = input.exitGraceMs ?? 5000;
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      !Number.isSafeInteger(clientTimeout) ||
      clientTimeout < 1 ||
      !Number.isSafeInteger(exitGrace) ||
      exitGrace < 0
    )
      throw new Error('Invalid quiescence deadline.');
    const deadline = performance.now() + timeout,
      limited = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    let installations: Reference | undefined;
    try {
      if (store.codec.options.model.tuple[2] === 'gradle') {
        if (!input.inspect && !['linux', 'win32', 'darwin'].includes(process.platform))
          throw new Error('Native process inspection unavailable on this platform.');
        if (initial[6] && !initial[13])
          throw new Error('Frozen post requires original quiescence.');
        if (await store.root.stat(registrationFailure(store)))
          throw new Error('Operational capture failed.');
        installations = initial[13]
          ? store.codec.schemas.documents.quiescence.parse(
              await store.readDocument(initial[13], 'quiescence'),
            )[3]
          : await sealInstallations(store, budget, limited);
        const ref = installations,
          native = await store.root.stat(ref[2]);
        if (!native) throw new Error('Missing sealed installation inventory.');
        const streamOptions = { codec: store.codec, budget, partition: null };
        // Validate EOF before executing any installation. Reuse that exact native file
        // on the command pass, so a later open cannot adopt replacement metadata.
        await readLocalStream(
          store.root.read(ref[2], native),
          'installations',
          streamOptions,
          ref,
          undefined,
          limited,
        );
        if (!initial[6])
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
                launcher = path.join(
                  r[3],
                  'bin',
                  process.platform === 'win32' ? 'gradle.bat' : 'gradle',
                ),
                raw = await lstat(launcher);
              if (!raw.isFile() || raw.isSymbolicLink())
                throw new Error('Captured Gradle launcher unavailable.');
              const remaining = Math.floor(Math.min(clientTimeout, deadline - performance.now()));
              if (remaining < 1) throw new Error('Quiescence deadline exceeded.');
              await (input.stop ?? stopGradleInstallation)(installation, limited, remaining);
            },
            new AbortController().signal,
          );
        const inspect = input.inspect ?? inspectGradleDaemons,
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
      }
      limited.throwIfAborted();
      assert();
      const current = store.codec.schemas.documents['local-state'].parse(await store.state());
      equal(current, initial, 'exclusive-window state');
      await checkRoot();
      limited.throwIfAborted();
      assert();
      const old = current[13];
      if (installations && !initial[6])
        current[13] = store.codec.schemas
          .ref('quiescence')
          .parse(
            await store.writeDocument([
              'quiescence',
              1,
              store.codec.options.invocation,
              installations,
              'all-exited',
              Date.now(),
            ]),
          );
      if (current[4] === 'build-ready') current[4] = 'quiescent';
      if (!initial[6]) {
        current[3]++;
        await store.updateState(current);
        if (old) await store.retireReplacedDocument(old);
      }
      assert();
      limited.throwIfAborted();
      return { status: 'ready', window: new ExclusiveWindow(store, input.assertCurrent, signal) };
    } catch (error) {
      signal.throwIfAborted();
      return {
        status: 'skipped-not-quiescent',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
