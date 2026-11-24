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

import { lstat, opendir } from 'node:fs/promises';
import type { AdmissionScope, ResolvedModel } from './model';
import { nativeIdentity, sameNative, type NativeRoot } from './native';
import { type WalkOptions, walkWork } from './native-walk';
import { componentSchema, pathSchema } from './schema';
import { directoryBreadthError, joinPath } from './tree-state';

const remedy =
  'Run Mammoth before the build tool and other cache restores. ' +
  'Use a fresh dedicated home or remove the conflicting workflow step and retry on a fresh runner.';

/** Read only the enabled partitions' projection, without opening payloads or creating an index. */
export async function assertEmptyManagedArea(
  root: NativeRoot,
  model: ResolvedModel,
  options: Pick<WalkOptions, 'budget' | 'maxDirectoryEntries' | 'signal'>,
  work = walkWork(),
): Promise<void> {
  const max = options.maxDirectoryEntries ?? 100000;
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid directory entry allowance.');
  const stat = (absolute: string) => {
    options.signal?.throwIfAborted();
    work.stats++;
    root.work.stats++;
    return lstat(absolute, { bigint: true });
  };
  async function visit(relative: string, scope: AdmissionScope, depth: number) {
    const absolute = relative ? root.resolve(relative) : root.path;
    const raw = await stat(absolute);
    options.signal?.throwIfAborted();
    if (!raw.isDirectory() || String(raw.dev) !== root.binding[3]) {
      const partition = scope.owner();
      const unsafe = !raw.isFile() || String(raw.dev) !== root.binding[3];
      if (unsafe && (raw.isDirectory() || scope.blocksUnsafeLeaf()))
        throw new Error(
          `Unsafe native entry ${JSON.stringify(relative)} in the managed cache area` +
            (partition ? ` for partition ${JSON.stringify(partition[0])}` : '') +
            `. ${remedy}`,
        );
      if (partition)
        throw new Error(
          `Managed cache path ${JSON.stringify(relative)} already exists in partition ` +
            `${JSON.stringify(partition[0])}. ${remedy}`,
        );
      return;
    }
    if (!scope.hasDescendants) return;
    if (depth > 100) throw new Error('Native tree depth exceeded.');
    const before = nativeIdentity(raw);
    const release = options.budget.holdRecord(512 + Buffer.byteLength(relative));
    try {
      work.listings++;
      root.work.nativeListings++;
      const directory = await opendir(absolute, { bufferSize: 32 });
      let entries = 0;
      for await (const entry of directory) {
        options.signal?.throwIfAborted();
        work.entries++;
        if (++entries > max) throw directoryBreadthError(relative, max, 'restore admission');
        componentSchema.parse(entry.name);
        const child = joinPath(relative, entry.name);
        const next = scope.child(child);
        if (next) await visit(pathSchema.parse(child), next, depth + 1);
      }
      if (!sameNative(before, nativeIdentity(await stat(absolute)), true))
        throw new Error('Native directory changed during restore admission.');
    } finally {
      release();
    }
  }
  options.signal?.throwIfAborted();
  root.work.nativeWalks++;
  await root.verifyRoot();
  await visit('', model.admissionScope(), 1);
  await root.verifyRoot();
}
