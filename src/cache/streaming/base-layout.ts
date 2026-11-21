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

import { opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { OwnedStore, Reference } from './owned-store';
import { sameNative, nativeIdentity, type NativeIdentity } from './native';
import { add } from './encoding';

// Protocol: docs/dev/native-base-protocol.md#native-object-layout-and-envelope.
export function baseObjectPaths(store: OwnedStore, root: string): string[] {
  store.codec.schemas.owned.parse(root);
  return ['envelope.json', 'tree.ndjson']
    .map((n) => store.root.resolve(root + '/' + n))
    .concat(store.root.resolve(root + '/payload') + path.sep);
}
export function baseRecordPaths(store: OwnedStore, root: string): string[] {
  store.codec.schemas.owned.parse(root);
  return [store.root.resolve(root + '/record.json')];
}
export async function checkBaseLayout(
  store: OwnedStore,
  root: string,
  record = false,
): Promise<NativeIdentity> {
  store.codec.schemas.owned.parse(root);
  await store.root.parents(root);
  const before = await store.root.stat(root);
  if (!before || before[2] !== 'directory' || before[3] !== store.root.binding[3])
    throw new Error('Invalid native archive root.');
  const wanted = new Set(record ? ['record.json'] : ['envelope.json', 'tree.ndjson', 'payload']);
  for await (const entry of await opendir(store.root.resolve(root), { bufferSize: 4 })) {
    if (
      !wanted.delete(entry.name) ||
      (entry.name === 'payload' ? !entry.isDirectory() : !entry.isFile())
    )
      throw new Error('Unexpected native archive root member.');
  }
  const after = await store.root.stat(root);
  if (wanted.size || !after || !sameNative(before, after, true))
    throw new Error('Incomplete or changing native archive layout.');
  return after;
}
export async function bindBaseFile(
  store: OwnedStore,
  file: string,
  purpose: string,
  signal: AbortSignal,
  max = Number.MAX_SAFE_INTEGER,
): Promise<Reference> {
  store.codec.schemas.owned.parse(file);
  const before = await nativeBaseFile(store, file, max);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of store.root.read(file, before)) {
    signal.throwIfAborted();
    bytes = add(bytes, chunk.length);
    if (bytes > max) throw new Error('Native metadata exceeds admission.');
    hash.update(chunk);
  }
  const after = await nativeBaseFile(store, file, max);
  if (!sameNative(before, after, true)) throw new Error('Native metadata changed after binding.');
  return Object.freeze(
    store.codec.schemas.ref(purpose).parse(['ref', purpose, file, bytes, hash.digest('hex')]),
  ) as Reference;
}
export async function baseFileBytes(store: OwnedStore, reference: Reference): Promise<Buffer> {
  if (reference[3] > 65536) throw new Error('Native document exceeds admission.');
  const chunks: Buffer[] = [];
  for await (const chunk of store.read(reference, reference[1])) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function nativeBaseFile(
  store: OwnedStore,
  file: string,
  max = Number.MAX_SAFE_INTEGER,
): Promise<NativeIdentity> {
  store.codec.schemas.owned.parse(file);
  await store.root.parents(file);
  store.root.work.stats++;
  const raw = await lstat(store.root.resolve(file), { bigint: true });
  const n = nativeIdentity(raw);
  if (
    n[2] !== 'file' ||
    raw.nlink !== 1n ||
    n[3] !== store.root.binding[3] ||
    raw.size > BigInt(max)
  )
    throw new Error('Native metadata missing, aliased or exceeds admission.');
  return n;
}
