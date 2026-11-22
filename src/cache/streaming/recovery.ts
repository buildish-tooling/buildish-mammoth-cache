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

import { equal } from './encoding';
import { lstat, opendir } from 'node:fs/promises';
import { OpenedInvocation } from './invocation';
import { nativeIdentity, sameObject } from './native';
import { checkPostRootBinding } from './post-admission';
import { resolveLifecycle } from '../../build-tool/lifecycle';
import type { LifecycleResolver } from '../../build-tool/lifecycle-types';
import { recoverInstall } from './install-execute';
import { recoverGc } from './gc-execute';
import { FrozenMovingPublication } from './base-moving-publication';
import { MovingBasePublication } from './moving-publication';
import type { BaseObjectOptions } from './base-object';
import type { OwnedStore } from './owned-store';

export interface RecoveryOptions extends BaseObjectOptions {
  /** Dedicated-root/completed-consumer lifetime, independent of foreground cancellation. */
  readonly assertCurrent: () => undefined;
  readonly cleanupSignal?: AbortSignal;
  readonly lifecycle?: LifecycleResolver;
}
type Documents = OwnedStore['codec']['schemas']['documents'];
type Intent =
  | ReturnType<Documents['install-intent']['parse']>
  | ReturnType<Documents['gc-intent']['parse']>
  | ReturnType<Documents['relocation']['parse']>;
async function marker(store: OwnedStore) {
  const install = await store.readFixed(store.prefix + 'install-intent.json'),
    gc = await store.readFixed(store.prefix + 'gc-intent.json');
  let active: Intent | null = install
    ? store.codec.schemas.documents['install-intent'].parse(install)
    : gc
      ? store.codec.schemas.documents['gc-intent'].parse(gc)
      : null;
  if (install && gc) throw new Error('Conflicting root recovery intents.');
  const directory = store.prefix + 'relocation';
  if (await store.root.stat(directory))
    for await (const entry of await opendir(store.root.resolve(directory))) {
      if (!entry.name.endsWith('.json')) continue;
      if (active) throw new Error('Concurrent root recovery intents.');
      const value = store.codec.schemas.documents.relocation.parse(
        await store.readFixed(directory + '/' + entry.name),
      );
      if (entry.name !== value[3] + '.json') throw new Error('Relocation marker name changed.');
      active = value;
    }
  await store.assertNoIntents(active ?? undefined);
  return active;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#recovery-and-abandonment-dispatch.
// No backend/config/build-report imports. Only recorded destructive work is replayed;
// an immutable publication without a marker does not cause another live tree scan.
export async function reconcileInvocation(
  invocation: OpenedInvocation,
  mode: 'resume' | 'abandon',
  input: RecoveryOptions,
): Promise<OwnedStore> {
  OpenedInvocation.assert(invocation);
  const options = { ...input },
    store = invocation.store,
    signal = options.cleanupSignal ?? new AbortController().signal;
  const assert = () => {
    signal.throwIfAborted();
    if (options.assertCurrent() !== undefined)
      throw new Error('Recovery lifetime assertion must be synchronous.');
  };
  // Keep all authority from the reopened owner; never use the next invocation's model.
  const initial = store.codec.schemas.documents['local-state'].parse(await store.state()),
    bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(initial[5], 'bindings'),
    );
  store.codec.checkStateBindings(initial, bindings);
  options.maxDirectoryEntries = bindings[8][9];
  Object.freeze(options);
  const rootCheck = async () => {
    assert();
    store.root.work.stats++;
    checkPostRootBinding(
      store,
      bindings,
      nativeIdentity(await lstat(store.root.path, { bigint: true })),
    );
    assert();
  };
  await rootCheck();
  const active = await marker(store),
    pending = active !== null || initial[11] !== null;
  if (initial[10]) {
    const progress = store.codec.schemas.documents['gc-progress'].parse(
      await store.readDocument(initial[10], 'gc-progress'),
    );
    if (progress[5] !== null && active?.[0] !== 'gc-intent')
      throw new Error('Missing GC intent owner required by progress.');
  }
  if (initial[4] === 'completed' && pending)
    throw new Error('Completed owner has outstanding destructive work.');
  if (pending) {
    // A captured launcher may itself be evacuated. Recovery gets only permission to
    // reconcile existing work, using fresh absence evidence, never a new save/purge grant.
    if (store.codec.options.role !== 'distributed-worker') {
      const lifecycle = await resolveLifecycle(store.codec.options.context[7], options.lifecycle);
      assert();
      await lifecycle.verifyRecoveryConsumers(signal);
    }
    await rootCheck();
    equal(await store.state(), initial, 'recovery owner state');
    const recovery = { ...options, signal };
    if (active?.[0] === 'install-intent' || initial[11] !== null) {
      if (active && active[0] !== 'install-intent')
        throw new Error('Install recovery owner differs.');
      await recoverInstall(store, options.budget, signal);
    } else if (active?.[0] === 'gc-intent') {
      await recoverGc(store, recovery);
    } else if (active?.[0] === 'relocation') {
      const frozen = await FrozenMovingPublication.resume(store, recovery);
      const publication = MovingBasePublication.open(frozen, { cleanupSignal: signal });
      const failures: unknown[] = [];
      try {
        assert();
        await publication.recoverSources();
      } catch (error) {
        failures.push(error);
      }
      try {
        await publication.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        frozen.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(failures, 'Source recovery and cleanup failed.');
    }
    assert();
    await store.assertNoIntents();
  }
  await store.resumeRetirements(options.budget);
  await rootCheck();
  if (mode === 'abandon') {
    const current = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (current[4] !== 'completed') {
      if (current[11]) throw new Error('Unreconciled install progress.');
      await store.assertNoIntents();
      current[3]++;
      current[4] = 'completed';
      current[14] = 'abandoned';
      await store.updateState(current);
    }
  }
  assert();
  options.signal?.throwIfAborted();
  return store;
}

/**
 * A pre-locator crash may leave a fully sealed revision-zero private candidate.
 * Reuse that exact owner without deleting its unreferenced files; an incomplete or
 * unproven namespace stays in place and blocks initialization.
 */
export async function admitBootstrapCandidate(store: OwnedStore, options: BaseObjectOptions) {
  options.signal?.throwIfAborted();
  await store.assertNoIntents();
  if ((await store.locator())?.[2] === store.codec.options.invocation)
    throw new Error('Reopen the current invocation instead of a bootstrap candidate.');
  const rootCheck = async () => {
    options.signal?.throwIfAborted();
    store.root.work.stats++;
    const native = nativeIdentity(await lstat(store.root.path, { bigint: true }));
    if (!sameObject(native, store.root.binding) || native[6] !== store.root.binding[6])
      throw new Error('Bootstrap root binding changed.');
    options.signal?.throwIfAborted();
    return native;
  };
  const existing = await store.root.stat(store.prefix.slice(0, -1));
  if (!existing) {
    await rootCheck();
    return;
  }
  const state = store.codec.schemas.documents['local-state'].parse(
    await store.readFixed(store.prefix + 'state.json'),
  );
  if (state[3] !== 0 || state[4] !== 'prepare-pending' || state.slice(6).some((v) => v !== null))
    throw new Error('Unproven unpublished invocation namespace; preserved for reconciliation.');
  const bindings = store.codec.schemas.documents.bindings.parse(
    await store.readDocument(state[5], 'bindings'),
  );
  store.codec.checkStateBindings(state, bindings);
  checkPostRootBinding(store, bindings);
  if (bindings[8][7] !== null || bindings[9] !== null || bindings[12] !== null)
    throw new Error('Unpublished invocation already has prepare decisions.');
  await store.readStream(
    bindings[6],
    'model',
    { ...options, partition: null },
    undefined,
    options.signal,
  );
  for (const [ref, purpose] of [
    [bindings[10], 'producers'],
    [bindings[11], 'prepare-sources'],
  ] as const)
    await store.readStream(
      ref,
      purpose,
      { ...options, partition: null },
      async (v) => {
        if (!Array.isArray(v) || ['local-stream', 'local-end'].includes(String(v[0]))) return;
        if (purpose === 'prepare-sources' && v[0] === 'prepare-selection') {
          const selection = store.codec.schemas.rows.prepareSelection.parse(v);
          if (
            selection[5][0] === 'pending' &&
            selection[6][0] === 'pending' &&
            selection[7] === null &&
            selection[9] === 'selected' &&
            (bindings[8][5] === 'off') === (selection[4][5] === null)
          ) {
            const parent = store.prefix + 'install',
              native = await store.root.stat(parent);
            if (
              !native ||
              !sameObject(native, selection[8]) ||
              native[6] !== selection[8][6] ||
              native[3] !== store.root.binding[3]
            )
              throw new Error('Bootstrap install container changed.');
            const directory = await opendir(store.root.resolve(parent));
            try {
              if (await directory.read())
                throw new Error('Unpublished install container is not empty.');
            } finally {
              await directory.close();
            }
            return;
          }
        }
        throw new Error('Unpublished invocation has selected inputs.');
      },
      options.signal,
    );
  checkPostRootBinding(store, bindings, await rootCheck());
  options.signal?.throwIfAborted();
}
