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

import { sameObject, type NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';

/** Existing frozen-root check; orchestration may supply one fresh root observation. */
export function checkPostRootBinding(
  store: OwnedStore,
  bindings: { readonly 5: readonly [string, NativeIdentity] },
  native: NativeIdentity = store.root.binding,
) {
  if (
    bindings[5][0] !== store.root.path ||
    !sameObject(bindings[5][1], native) ||
    bindings[5][1][6] !== native[6]
  ) {
    throw new Error('Post root binding changed.');
  }
}

/** Fresh fixed-cost orchestration barrier after awaited phase work; no process query. */
export async function assertLifecycleWindow(
  store: OwnedStore,
  bindings: Parameters<typeof checkPostRootBinding>[1],
  window: { readonly signal?: AbortSignal; readonly assertCurrent: () => undefined },
) {
  const check = () => {
    window.signal?.throwIfAborted();
    if (window.assertCurrent() !== undefined) {
      throw new Error('Lifecycle window assertion must be synchronous.');
    }
  };
  check();
  await store.root.verifyRoot(true);
  checkPostRootBinding(store, bindings);
  check();
}
