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
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import {
  baseFileBytes,
  baseRecordPaths,
  bindBaseFile,
  checkBaseLayout,
  nativeBaseFile,
} from './base-layout';
import { decodeGeneration } from './native-records';
import { sameNative, sameObject } from './native';
import { retireOwnedDirectory } from './owned-retirement';

// Protocol: docs/dev/native-base-protocol.md#generation-record and
// docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
// Transport confirmation ONLY: the caller must have completed the shared source gate.
export async function saveNativeRecord(
  store: OwnedStore,
  backend: BaseCacheBackend,
  record: Reference,
  key: string,
  options: BaseObjectOptions,
): Promise<void> {
  options = Object.freeze({ ...options });
  record = store.codec.schemas.ref('generation').parse(record);
  const signal = options.signal ?? new AbortController().signal,
    bytes = await baseFileBytes(store, record),
    generation = decodeGeneration(bytes, store.codec.options.model, key),
    root = store.prefix + 'records/' + generation[7];
  if (record[2] !== root + '/record.json') throw new Error('Unbound candidate record geometry.');
  signal.throwIfAborted();
  if (!backend.capabilities.supportsExplicitSave || !backend.isFeatureAvailable())
    throw new Error('Native generation backend cannot save.');
  const before = await checkBaseLayout(store, root, true),
    file = await nativeBaseFile(store, record[2], 65536);
  // Metadata bytes were read before N was captured: bind again under that exact N.
  const bound = await bindBaseFile(store, record[2], 'generation', signal, 65536);
  if (bound[3] !== record[3] || bound[4] !== record[4])
    throw new Error('Candidate record changed.');
  let serviceId: number | null = null;
  try {
    const id = await backend.saveCache(baseRecordPaths(store, root), key, {
      archiveRoot: store.root.resolve(root),
    });
    if (Number.isSafeInteger(id) && id > 0) serviceId = id;
  } catch {
    /* Ambiguous outcome: exact immutable readback, never latest/existence lookup. */
  }
  // SDK has no cancellation hook. Settlement must precede cleanup or caller return.
  signal.throwIfAborted();
  const after = await checkBaseLayout(store, root, true),
    current = await nativeBaseFile(store, record[2], 65536);
  if (serviceId !== null && sameNative(before, after, true) && sameNative(file, current, true))
    return;
  const temporary = store.prefix + 'base/' + randomUUID();
  await store.makeParents(temporary + '/placeholder');
  const owner = (await store.root.stat(temporary))!;
  let failure: unknown;
  try {
    const found = await backend.restoreCache(baseRecordPaths(store, temporary), key, [], {
      archiveRoot: store.root.resolve(temporary),
    });
    signal.throwIfAborted();
    const actual = await store.root.stat(temporary);
    if (!actual || !sameObject(owner, actual) || owner[6] !== actual[6])
      throw new Error('Record readback root changed.');
    if (found !== undefined && found !== key)
      throw new Error('Record exact-key readback mismatch.');
    if (found === undefined) {
      for await (const e of await opendir(store.root.resolve(temporary), { bufferSize: 1 }))
        throw new Error('Unavailable record readback left partial extraction: ' + e.name);
      throw new Error('Generation record save remains unconfirmed.');
    }
    await checkBaseLayout(store, temporary, true);
    const q = await bindBaseFile(store, temporary + '/record.json', 'generation', signal, 65536),
      readback = await baseFileBytes(store, q);
    decodeGeneration(readback, store.codec.options.model, key);
    if (!readback.equals(bytes)) throw new Error('Wrong immutable generation record bytes.');
    signal.throwIfAborted();
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    await settleBaseCleanup(
      [() => retireOwnedDirectory(store, temporary, owner, options.budget)],
      failure,
    );
  }
  signal.throwIfAborted();
}
