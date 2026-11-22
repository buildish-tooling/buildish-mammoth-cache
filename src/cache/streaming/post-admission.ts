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
import { sameObject, nativeIdentity, type NativeIdentity } from './native';
import type { Value } from './encoding';
import type { OwnedStore } from './owned-store';
import type { BaseObjectOptions } from './base-object';

/** Existing frozen-root check; orchestration may supply one fresh root observation. */
export function checkPostRootBinding(
  store: OwnedStore,
  bindings: ReturnType<OwnedStore['codec']['schemas']['documents']['bindings']['parse']>,
  native: NativeIdentity = store.root.binding,
) {
  if (
    bindings[5][0] !== store.root.path ||
    !sameObject(bindings[5][1], native) ||
    bindings[5][1][6] !== native[6]
  )
    throw new Error('Post root binding changed.');
}

/** Fresh fixed-cost orchestration barrier after awaited phase work; no process query. */
export async function assertLifecycleWindow(
  store: OwnedStore,
  bindings: Parameters<typeof checkPostRootBinding>[1],
  window: { readonly signal?: AbortSignal; readonly assertCurrent: () => undefined },
) {
  const check = () => {
    window.signal?.throwIfAborted();
    if (window.assertCurrent() !== undefined)
      throw new Error('Lifecycle window assertion must be synchronous.');
  };
  check();
  store.root.work.stats++;
  checkPostRootBinding(
    store,
    bindings,
    nativeIdentity(await lstat(store.root.path, { bigint: true })),
  );
  check();
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#invocation-bindings-and-operational-capture.
// Persisted context, not a live lock: the caller re-establishes the exclusive
// window before each operation/recovery. No launcher or daemon is invoked here.
export async function requirePostBindings(
  store: OwnedStore,
  stateValue: Value,
  bindingValue: Value,
  options: BaseObjectOptions,
) {
  options.signal?.throwIfAborted();
  store.codec.checkStateBindings(stateValue, bindingValue);
  const state = store.codec.schemas.documents['local-state'].parse(stateValue),
    bindings = store.codec.schemas.documents.bindings.parse(bindingValue);
  checkPostRootBinding(store, bindings);
  if ((options.maxDirectoryEntries ?? 100000) !== bindings[8][9])
    throw new Error('Post directory allowance differs from frozen policy.');
  if (
    store.codec.options.context[7] === 'gradle' &&
    store.codec.options.role !== 'distributed-worker'
  ) {
    if (!state[13]) throw new Error('Missing Gradle quiescence binding.');
    const q = store.codec.schemas.documents.quiescence.parse(
      await store.readDocument(state[13], 'quiescence'),
    );
    await store.readStream(
      q[3],
      'installations',
      { ...options, partition: null },
      undefined,
      options.signal,
    );
  }
  options.signal?.throwIfAborted();
}
