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

import { NativeRoot } from './native';
import { assertNoRootIntents } from './owned-store';
import { lstat } from 'node:fs/promises';
import { OpenedInvocation, type InvocationAnchor } from './invocation';
import { reconcileInvocation, type RecoveryOptions } from './recovery';
import { assertLifecycleWindow } from './post-admission';

/** Read-only post reads owned metadata, never managed content or a provider backend. */
export async function postStreamingReadOnly(anchor: InvocationAnchor, options: RecoveryOptions) {
  const opened = await OpenedInvocation.open(anchor, options.budget, options.cleanupSignal),
    store = await reconcileInvocation(opened, 'resume', options),
    state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(state[5], 'bindings'),
    );
  if (store.codec.options.access !== 'read-only')
    throw new Error('Read-only post requires frozen read-only access.');
  if (state[4] !== 'build-ready' && !(state[4] === 'completed' && state[14] === 'read-only'))
    throw new Error('Read-only prepare did not complete.');
  await assertLifecycleWindow(store, bindings, options);
  if (state[4] !== 'completed') {
    state[3]++;
    state[4] = 'completed';
    state[14] = 'read-only';
    await store.updateState(state);
  }
  await assertLifecycleWindow(store, bindings, options);
  return { outcome: 'read-only' as const };
}
/** Disabling a cache cannot hide an old destructive owner before provisioning. */
export async function reconcileDisabledRoot(root: string, options: RecoveryOptions) {
  options.cleanupSignal?.throwIfAborted();
  let present = true;
  try {
    await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    present = false;
  }
  const previous = present
    ? await OpenedInvocation.current(root, options.budget, options.cleanupSignal)
    : null;
  if (previous) await reconcileInvocation(previous, 'abandon', options);
  else if (present) await assertNoRootIntents(await NativeRoot.bind(root));
  options.cleanupSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  if (options.assertCurrent() !== undefined)
    throw new Error('Lifecycle assertion must be synchronous.');
}
