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

import { lstat } from 'node:fs/promises';
import type { OwnedStore, Reference } from './owned-store';
import { equal } from './encoding';
import { nativeIdentity } from './native';
import { checkPostRootBinding } from './post-admission';
import type { WorkingBudget } from './tree-state';
import { resolveLifecycle } from '../../build-tool/lifecycle';
import type { LifecycleResolver } from '../../build-tool/lifecycle-types';

interface WindowOptions {
  readonly signal?: AbortSignal;
  /** Caller holds the documented dedicated-root/no-consumer lifetime; this must be cheap and synchronous. */
  readonly assertCurrent: () => undefined;
  readonly timeoutMs?: number;
  readonly clientTimeoutMs?: number;
  readonly exitGraceMs?: number;
  readonly lifecycle?: LifecycleResolver;
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
      const tool = store.codec.options.context[7],
        prior = initial[13]
          ? store.codec.schemas.documents.quiescence.parse(
              await store.readDocument(initial[13], 'quiescence'),
            )[3]
          : undefined,
        lifecycle = await resolveLifecycle(tool, input.lifecycle);
      assert();
      installations = await lifecycle.quiesce({
        store,
        budget,
        installations: prior,
        sourcesFrozen: !!initial[6],
        signal: limited,
        assertCurrent: assert,
        deadline,
        clientTimeout,
        exitGrace,
      });
      // Tool operations cannot omit/replace the owner's required inventory or mint a grant.
      if (tool === 'gradle')
        installations = store.codec.schemas.ref('installations').parse(installations);
      else if (installations !== undefined)
        throw new Error('Unexpected Maven installation inventory.');
      if (prior) equal(installations!, prior, 'quiescence installation inventory');
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
