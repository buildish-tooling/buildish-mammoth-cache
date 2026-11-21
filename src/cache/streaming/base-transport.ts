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

import { opendir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BaseCacheBackend } from '../backend';
import type { OwnedStore } from './owned-store';
import { objectRefSchema, checkIdentity, type ObjectRef } from './native-records';
import { sameObject, type NativeIdentity } from './native';
import { retireOwnedDirectory } from './owned-retirement';
import { ValidatedBaseObject, type BaseObjectOptions } from './base-object';
import { baseObjectPaths } from './base-layout';
const attempts = new WeakSet<object>();
// Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
// SDK evidence is PROVISIONAL: it cannot grant source-return or generation authority.
export class NativeObjectSave {
  private constructor(
    readonly object: ValidatedBaseObject,
    readonly serviceId: number | null,
    readonly error: unknown,
    readonly barrierError: unknown,
  ) {
    attempts.add(this);
    Object.freeze(this);
  }
  static async save(
    backend: BaseCacheBackend,
    object: ValidatedBaseObject,
    options: BaseObjectOptions,
  ): Promise<NativeObjectSave> {
    options = Object.freeze({ ...options });
    ValidatedBaseObject.assertReceipt(object);
    if (!backend.capabilities.supportsExplicitSave || !backend.isFeatureAvailable())
      throw new Error('Native base backend cannot save.');
    await object.verifyStable(options);
    let id: number | null = null,
      error: unknown,
      barrierError: unknown;
    // No cancellation hook in BaseCacheBackend: wait for SDK settlement before any cleanup.
    try {
      const result = await backend.saveCache(
        baseObjectPaths(object.store, object.root),
        object.reference[2],
        { archiveRoot: object.store.root.resolve(object.root) },
      );
      if (Number.isSafeInteger(result) && result > 0) id = result;
    } catch (cause) {
      error = cause;
    }
    try {
      await object.verifyStable(options);
    } catch (cause) {
      barrierError = cause;
    }
    return new NativeObjectSave(object, id, error, barrierError);
  }
  assertBound(object = this.object): void {
    if (!attempts.has(this) || this.object !== object)
      throw new Error('Unbound native save attempt.');
    ValidatedBaseObject.assertReceipt(object);
  }
}
// Protocol: docs/dev/native-base-protocol.md#payload-validation-and-installation.
export class NativeObjectDownload {
  private readonly lifecycle = { disposed: false };
  private constructor(
    readonly store: OwnedStore,
    readonly root: string,
    private readonly owner: NativeIdentity,
    private readonly budget: BaseObjectOptions['budget'],
    readonly object: ValidatedBaseObject | null,
  ) {
    Object.freeze(this);
  }
  static async restore(
    store: OwnedStore,
    backend: BaseCacheBackend,
    ref: ObjectRef,
    options: BaseObjectOptions,
    hashBodies = false,
  ): Promise<NativeObjectDownload> {
    options = Object.freeze({ ...options });
    ref = objectRefSchema.parse(ref);
    checkIdentity(ref[1], store.codec.options.model);
    const root = store.prefix + 'base/' + randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (!backend.isFeatureAvailable()) throw new Error('Native base backend unavailable.');
    await store.makeParents(root + '/placeholder');
    const owner = (await store.root.stat(root))!;
    try {
      const key = await backend.restoreCache(baseObjectPaths(store, root), ref[2], [], {
        archiveRoot: store.root.resolve(root),
      });
      signal.throwIfAborted();
      const after = await store.root.stat(root);
      if (!after || !sameObject(owner, after) || owner[6] !== after[6])
        throw new Error('Native download root changed.');
      if (key !== undefined && key !== ref[2]) throw new Error('Native object exact-key mismatch.');
      if (key === undefined)
        for await (const entry of await opendir(store.root.resolve(root), { bufferSize: 1 }))
          throw new Error('Missing native result left partial extraction: ' + entry.name);
      const object =
        key === undefined
          ? null
          : await ValidatedBaseObject.verify(store, root, ref, options, hashBodies);
      signal.throwIfAborted();
      return new NativeObjectDownload(store, root, owner, options.budget, object);
    } catch (error) {
      try {
        await retireOwnedDirectory(store, root, owner, options.budget);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Native download cleanup blocked.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
  async dispose(): Promise<void> {
    if (this.lifecycle.disposed) return;
    await retireOwnedDirectory(this.store, this.root, this.owner, this.budget);
    this.lifecycle.disposed = true;
  }
}
