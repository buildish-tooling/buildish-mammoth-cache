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

import type { Value } from './encoding';
import { walkNative, type WalkOptions, type WalkWork } from './native-walk';
import type { OwnedStore, Reference } from './owned-store';

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// One shared current-root scan; no untouched body hashes or per-partition cache walks.
export async function captureInstallCurrent(
  store: OwnedStore,
  options: Pick<WalkOptions, 'budget' | 'maxDirectoryEntries' | 'signal'>,
  work?: WalkWork,
): Promise<Reference> {
  // All metadata parents must exist before freezing the live root directory facts.
  await store.makeParents(store.prefix + 'files/pending');
  return store.writeStream(
    'install-current',
    { budget: options.budget, partition: null, maxDirectoryEntries: options.maxDirectoryEntries },
    installCurrentRows(store, options, work),
    options.signal,
  );
}

export async function* installCurrentRows(
  store: OwnedStore,
  options: Pick<WalkOptions, 'budget' | 'maxDirectoryEntries' | 'signal'>,
  work?: WalkWork,
): AsyncGenerator<Value> {
  for await (const event of walkNative(
    store.root,
    '',
    {
      ...options,
      metadata: 'exclude',
      inspectChild: async (child) => {
        if (child.pruned || child.type === 'symlink' || child.type === 'other') return 'prune';
      },
    },
    work,
  )) {
    if (event.tag === 'protected-child') {
      yield ['parent-child', event.parent, event.name, event.type, event.device, event.fileId];
      continue;
    }
    if (event.tag === 'file') yield ['file', event.path, event.identity];
    else
      yield [event.tag === 'directory-open' ? 'dir-open' : 'dir-close', event.path, event.identity];
  }
}
