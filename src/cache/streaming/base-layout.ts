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
import type { OwnedStore } from './owned-store';
import { nativeIdentity, type NativeIdentity } from './native';

export function baseRecordPaths(store: OwnedStore, root: string): string[] {
  store.codec.schemas.owned.parse(root);
  return [store.root.resolve(root + '/record.json')];
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
