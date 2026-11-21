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

import { randomUUID } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import type { BaseCacheBackend } from '../backend';
import type { OwnedStore, Reference } from './owned-store';
import { lineageId } from './model';
import { nameSchema } from './schema';
import { decodeGeneration, lineagePrefix, type Generation } from './native-records';
import { sameNative, sameObject, type NativeIdentity } from './native';
import {
  baseFileBytes,
  baseRecordPaths,
  bindBaseFile,
  checkBaseLayout,
  nativeBaseFile,
} from './base-layout';
import { NativeObjectDownload } from './base-transport';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { retireOwnedDirectory } from './owned-retirement';
export interface BaseLineages {
  readonly currentRef: string;
  readonly defaultRef?: string;
}
const pins = new WeakSet<object>(),
  sets = new WeakSet<object>();
function lineages(store: OwnedStore, input: BaseLineages): readonly string[] {
  const refs = [nameSchema.parse(input.currentRef)];
  if (input.defaultRef !== undefined && input.defaultRef !== input.currentRef)
    refs.push(nameSchema.parse(input.defaultRef));
  return Object.freeze(refs.map(lineageId));
}
function checkLineage(generation: Generation, allowed: readonly string[]) {
  if (!allowed.includes(generation[5]))
    throw new Error('Generation is outside authorized lineages.');
}
/** Only bounded protocol tuples, not per-file state. */
function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) immutable(v);
    Object.freeze(value);
  }
  return value;
}
// Protocol: docs/dev/native-base-protocol.md#model-family-and-key-identities.
export class PinnedBaseGeneration {
  private readonly lifecycle = { disposed: false, retiring: false, busy: false, leases: 0 };
  private constructor(
    readonly store: OwnedStore,
    readonly key: string,
    readonly record: Reference,
    readonly generation: Generation,
    private readonly native: NativeIdentity,
    private readonly release: () => void,
    private readonly owner?: { root: string; native: NativeIdentity },
  ) {
    pins.add(this);
    Object.freeze(this);
  }
  static assertReceipt(pin: PinnedBaseGeneration, store = pin.store): void {
    if (!pins.has(pin) || pin.store !== store || pin.lifecycle.disposed || pin.lifecycle.retiring)
      throw new Error('Unbound/retired pinned generation.');
  }
  static async discover(
    store: OwnedStore,
    backend: BaseCacheBackend,
    refs: BaseLineages,
    options: BaseObjectOptions,
  ): Promise<PinnedBaseGeneration | null> {
    options = Object.freeze({ ...options });
    const allowed = lineages(store, refs),
      signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (!backend.capabilities.supportsNewestPrefixRestore || !backend.isFeatureAvailable())
      throw new Error('Native base generation discovery unavailable.');
    const root = store.prefix + 'base/' + randomUUID();
    await store.makeParents(root + '/placeholder');
    const owner = (await store.root.stat(root))!;
    try {
      const prefixes = allowed.map((id) => lineagePrefix(store.codec.options.model.family, id));
      const key = await backend.restoreCache(
        baseRecordPaths(store, root),
        prefixes[0],
        prefixes.slice(1),
        { archiveRoot: store.root.resolve(root) },
      );
      signal.throwIfAborted();
      const after = await store.root.stat(root);
      if (!after || !sameObject(owner, after) || after[6] !== owner[6])
        throw new Error('Generation download namespace changed.');
      if (key === undefined) {
        for await (const entry of await opendir(store.root.resolve(root), { bufferSize: 1 }))
          throw new Error('Unavailable generation left partial extraction: ' + entry.name);
        await retireOwnedDirectory(store, root, owner, options.budget);
        signal.throwIfAborted();
        return null;
      }
      if (!prefixes.some((p) => key.startsWith(p)))
        throw new Error('Generation returned an unauthorized key.');
      await checkBaseLayout(store, root, true);
      const record = await bindBaseFile(store, root + '/record.json', 'generation', signal, 65536);
      const pin = await PinnedBaseGeneration.open(store, key, record, allowed, options, {
        root,
        native: owner,
      });
      try {
        signal.throwIfAborted();
        return pin;
      } catch (error) {
        await settleBaseCleanup([() => pin.dispose()], error);
        throw error;
      }
    } catch (error) {
      try {
        if (await store.root.stat(root))
          await retireOwnedDirectory(store, root, owner, options.budget);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Generation discovery cleanup blocked.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
  /** Reopen an exact persisted Q/key with independently supplied authorized refs; never rediscover latest. */
  static async resume(
    store: OwnedStore,
    key: string,
    record: Reference,
    refs: BaseLineages,
    options: BaseObjectOptions,
  ): Promise<PinnedBaseGeneration> {
    return PinnedBaseGeneration.open(
      store,
      key,
      record,
      lineages(store, refs),
      Object.freeze({ ...options }),
    );
  }
  private static async open(
    store: OwnedStore,
    key: string,
    record: Reference,
    allowed: readonly string[],
    options: BaseObjectOptions,
    owner?: { root: string; native: NativeIdentity },
  ): Promise<PinnedBaseGeneration> {
    record = Object.freeze(store.codec.schemas.ref('generation').parse(record)) as Reference;
    if (record[3] > 65536) throw new Error('Generation exceeds record admission.');
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const release = options.budget.holdRecord(record[3]);
    try {
      const native = await nativeBaseFile(store, record[2], 65536),
        bytes = await baseFileBytes(store, record),
        generation = decodeGeneration(bytes, store.codec.options.model, key);
      checkLineage(generation, allowed);
      if (!sameNative(native, await nativeBaseFile(store, record[2], 65536), true))
        throw new Error('Pinned generation changed during decoding.');
      signal.throwIfAborted();
      return new PinnedBaseGeneration(
        store,
        key,
        record,
        immutable(generation),
        Object.freeze(native) as NativeIdentity,
        release,
        owner,
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  async assertStable(): Promise<void> {
    PinnedBaseGeneration.assertReceipt(this);
    if (!sameNative(this.native, await nativeBaseFile(this.store, this.record[2], 65536), true))
      throw new Error('Pinned generation changed.');
  }
  lease(): () => void {
    PinnedBaseGeneration.assertReceipt(this);
    this.lifecycle.leases++;
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.lifecycle.leases--;
      }
    };
  }
  async dispose(): Promise<void> {
    if (this.lifecycle.disposed) return;
    if (this.lifecycle.leases) throw new Error('Pinned generation has active object consumers.');
    if (this.lifecycle.busy) throw new Error('Generation retirement already active.');
    this.lifecycle.retiring = true;
    this.lifecycle.busy = true;
    try {
      if (this.owner) await retireOwnedDirectory(this.store, this.owner.root, this.owner.native);
      this.lifecycle.disposed = true;
      this.release();
    } finally {
      this.lifecycle.busy = false;
    }
  }
}
// Protocol: docs/dev/native-base-protocol.md#recovery-groups.
// Provisional set: availability/native facts cannot grant install authority before group reconstruction.
export class ProvisionalBaseSet {
  private readonly lifecycle = {
    disposed: false,
    retiring: false,
    busy: false,
    claimed: false,
    consumers: 0,
  };
  private constructor(
    readonly pin: PinnedBaseGeneration,
    readonly downloads: readonly NativeObjectDownload[],
    private readonly release: () => void,
  ) {
    sets.add(this);
    Object.freeze(this);
  }
  static assertReceipt(set: ProvisionalBaseSet, store = set.pin.store): void {
    if (!sets.has(set) || set.lifecycle.disposed || set.lifecycle.retiring)
      throw new Error('Unbound/retired provisional base set.');
    PinnedBaseGeneration.assertReceipt(set.pin, store);
  }
  static async acquire(
    pin: PinnedBaseGeneration,
    backend: BaseCacheBackend,
    options: BaseObjectOptions,
  ): Promise<ProvisionalBaseSet> {
    options = Object.freeze({ ...options });
    PinnedBaseGeneration.assertReceipt(pin);
    const releasePin = pin.lease(),
      downloads: NativeObjectDownload[] = [];
    try {
      await pin.assertStable();
      for (const entry of pin.generation[8])
        if (entry[0] === 'object')
          downloads.push(await NativeObjectDownload.restore(pin.store, backend, entry[2], options));
      await pin.assertStable();
      options.signal?.throwIfAborted();
      return new ProvisionalBaseSet(pin, Object.freeze(downloads), releasePin);
    } catch (error) {
      try {
        await settleBaseCleanup(
          downloads.map((d) => () => d.dispose()),
          error,
        );
      } finally {
        releasePin();
      }
      throw error;
    }
  }
  claim(): () => void {
    ProvisionalBaseSet.assertReceipt(this);
    if (this.lifecycle.claimed) throw new Error('Base object set already claimed.');
    this.lifecycle.claimed = true;
    this.lifecycle.consumers++;
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.lifecycle.consumers--;
      }
    };
  }
  available(): ReadonlySet<string> {
    ProvisionalBaseSet.assertReceipt(this);
    return new Set(
      this.pin.generation[8]
        .filter((e) => e[0] === 'empty')
        .map((e) => e[1])
        .concat(this.downloads.flatMap((d) => (d.object ? [d.object.reference[1][2]] : []))),
    );
  }
  async dispose(): Promise<void> {
    if (this.lifecycle.disposed) return;
    if (this.lifecycle.consumers) throw new Error('Base object set has active consumers.');
    if (this.lifecycle.busy) throw new Error('Base-set retirement already active.');
    this.lifecycle.retiring = true;
    this.lifecycle.busy = true;
    try {
      await settleBaseCleanup(this.downloads.map((d) => () => d.dispose()));
      this.lifecycle.disposed = true;
      this.release();
    } finally {
      this.lifecycle.busy = false;
    }
  }
}
