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
import { checkGradleSeed } from './gradle-layer';
import type { LifecycleHandoff } from './lifecycle-handoff';
import { equal } from './encoding';
import { nativeIdentity } from './native';
import { checkPostRootBinding } from './post-admission';
import type { WorkingBudget } from './tree-state';
import { resolveLifecycle } from '../../build-tool/lifecycle';
import type { LifecycleResolver } from '../../build-tool/lifecycle-types';

interface WindowOptions {
  readonly layeredWorker?: LifecycleHandoff;
  readonly signal?: AbortSignal;
  /** Caller holds the documented dedicated-root/no-consumer lifetime; this must be cheap and synchronous. */
  readonly assertCurrent: () => undefined;
  readonly timeoutMs?: number;
  readonly clientTimeoutMs?: number;
  readonly exitGraceMs?: number;
  readonly lifecycle?: LifecycleResolver;
}

const windows = new WeakSet<ExclusiveWindow>();
export class ExclusiveWindow {
  private readonly lifetime = new AbortController();
  readonly signal: AbortSignal;

  private constructor(
    readonly store: OwnedStore,
    private readonly assertion: () => undefined,
    signal: AbortSignal,
  ) {
    windows.add(this);
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
  }

  static assertReceipt(window: ExclusiveWindow, store: OwnedStore): void {
    if (!windows.has(window) || window.store !== store) {
      throw new Error('Unavailable exclusive window.');
    }
    window.assertCurrent();
  }

  assertCurrent = (): undefined => {
    this.signal.throwIfAborted();
    if (this.assertion() !== undefined) {
      throw new Error('Exclusive-window assertion must be synchronous.');
    }
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
      (store.codec.options.role === 'distributed-worker' && !input.layeredWorker)
    ) {
      throw new Error('Exclusive base window requires writable base role.');
    }
    if (store.codec.options.role === 'distributed-worker') {
      input.layeredWorker!.assertBound(store);
      const seed = input.layeredWorker!.header[12];
      if (!seed && !input.layeredWorker!.header[13]) {
        throw new Error('Worker window requires a frozen Gradle layer owner.');
      }
      if (seed) {
        checkGradleSeed(store, seed, input.layeredWorker!.header[8]?.[0] ?? null);
      }
    }
    if (input.assertCurrent.constructor.name === 'AsyncFunction') {
      throw new Error('Exclusive-window assertion must be synchronous.');
    }
    const assert = () => {
      signal.throwIfAborted();
      if (input.assertCurrent() !== undefined) {
        throw new Error('Exclusive-window assertion must be synchronous.');
      }
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
    if (['prepare-pending', 'prepare-failed', 'completed'].includes(initial[4])) {
      throw new Error('Exclusive window outside active post lifecycle.');
    }
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
    ) {
      throw new Error('Invalid quiescence deadline.');
    }
    const deadline = performance.now() + timeout,
      limited = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    let installations: Reference | undefined;
    try {
      const tool = store.codec.options.context[7],
        lifecycle = await resolveLifecycle(tool, input.lifecycle);
      assert();
      installations = await lifecycle.quiesce({
        store,
        budget,
        installations: undefined,
        sourcesFrozen: false,
        signal: limited,
        assertCurrent: assert,
        deadline,
        clientTimeout,
        exitGrace,
      });
      // Tool operations cannot omit/replace the owner's required inventory or mint a grant.
      if (tool === 'gradle') {
        store.codec.schemas.ref('installations').parse(installations);
      } else if (installations !== undefined) {
        throw new Error('Unexpected Maven installation inventory.');
      }
      limited.throwIfAborted();
      assert();
      const current = store.codec.schemas.documents['local-state'].parse(await store.state());
      equal(current, initial, 'exclusive-window state');
      await checkRoot();
      limited.throwIfAborted();
      assert();
      if (installations) {
        await store.retireProducedMetadata(installations);
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
