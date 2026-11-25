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

import { assertNoDetachedMetadata, NativeRoot } from './native';
import { assertNoRootIntents, completedPreviousOwner } from './owned-store';
import { lstat } from 'node:fs/promises';
import { OpenedInvocation, type InvocationAnchor } from './invocation';
import type { LifecycleOptions } from './lifecycle-options';
import { PostAttempt } from './lifecycle-attempt';

/** Read-only post reads owned metadata, never managed content or a provider backend. */
export async function postStreamingReadOnly(anchor: InvocationAnchor, options: LifecycleOptions) {
  const opened = await OpenedInvocation.open(anchor, options.budget, options.cleanupSignal),
    attempt = await PostAttempt.open(opened, options);
  try {
    if (attempt.store.codec.options.access !== 'read-only') {
      throw new Error('Read-only post requires frozen read-only access.');
    }
    if (attempt.state[4] === 'completed' && attempt.state[7]?.[1] !== 'read-only') {
      throw new Error('Invalid read-only terminal outcome.');
    }
    if (attempt.state[4] !== 'completed') {
      await attempt.finish(['outcome', 'read-only', null, null, null]);
    }
    await attempt.guard();
    return { outcome: 'read-only' as const };
  } finally {
    attempt.close();
  }
}
/** Disabling a cache cannot hide an old destructive owner before provisioning. */
export async function reconcileDisabledRoot(root: string, options: LifecycleOptions) {
  options.cleanupSignal?.throwIfAborted();
  let present = true;
  try {
    await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    present = false;
  }
  if (present) {
    const native = await NativeRoot.bind(root);
    await completedPreviousOwner(native);
    await assertNoRootIntents(native);
  } else {
    await assertNoDetachedMetadata(root);
  }
  options.cleanupSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  if (options.assertCurrent() !== undefined) {
    throw new Error('Lifecycle assertion must be synchronous.');
  }
}
