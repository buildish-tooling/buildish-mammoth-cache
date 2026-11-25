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

import { unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Value } from './encoding';
import type { NativeIdentity } from './native';
import { retireOwnedDirectory } from './owned-retirement';
import { sameNative } from './native';
import { sameDirectoryObject, checkInstallMember } from './install-member';
import { InstallScratch } from './install-scratch';
import { InstallParentPhase } from './install-parent-phase';
import type { InstallReaders } from './install-program';
import { parentPath } from './tree-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Called only for this operation's completed replacement/deletion. Original
// backup identity and admitted facts remain owned until direct cleanup finishes.
export async function retireBackup(
  readers: InstallReaders,
  binding: Value,
  logical: string,
  physical: string,
  observed: NativeIdentity,
  owned: InstallParentPhase,
  signal: AbortSignal,
) {
  const store = readers.store,
    budget = readers.budget;
  if (!(await store.root.stat(physical))) {
    return;
  }
  if (observed[2] === 'file') {
    await owned.parents(physical);
    const native = await checkInstallMember(
      readers,
      binding,
      logical,
      physical,
      {
        renamed: true,
        rootNative: observed,
        stat: (p) => owned.stat(p),
      },
      signal,
    );
    const actual = await owned.stat(physical);
    if (!actual || !sameNative(native, actual, true)) {
      throw new Error('Backup file changed before retirement.');
    }
    signal.throwIfAborted();
    await unlink(store.root.resolve(physical));
    store.root.work.unlinks++;
    await owned.changed(physical);
    await store.fail('install-backup-member-retired');
    return;
  }
  const files: InstallScratch[] = [];
  let ledgerDirectory: { path: string; native: NativeIdentity } | undefined;
  let phase: InstallParentPhase | undefined;
  const frames: { path: string; native: NativeIdentity; release: () => void }[] = [];
  try {
    const selectors = await InstallScratch.create(store, budget);
    files.push(selectors);
    const metadata = await readers.reader(binding, signal);
    async function createPhase(expected: (path: string) => Promise<NativeIdentity | null>) {
      const ledger = store.prefix + 'mutation/' + randomUUID() + '/';
      await store.makeParents(ledger + 'pending');
      ledgerDirectory = {
        path: ledger.slice(0, -1),
        native: (await store.root.stat(ledger.slice(0, -1)))!,
      };
      phase = new InstallParentPhase(store, physical, ledger, budget, expected);
    }
    await createPhase((path) => metadata.directoryNative(logical + path.slice(physical.length)));

    async function closeDirectory() {
      const frame = frames.pop()!;
      try {
        await selectors.append(['remove-directory', frame.path, frame.native]);
      } finally {
        frame.release();
      }
    }
    await checkInstallMember(
      readers,
      binding,
      logical,
      physical,
      {
        renamed: true,
        partial: true,
        rootNative: observed,
        observed: async (row, path, native) => {
          const value = row as readonly Value[];
          while (frames.length && frames[frames.length - 1].path !== parentPath(path)) {
            await closeDirectory();
          }
          if (value[0] === 'directory') {
            frames.push({
              path,
              native,
              release: budget.holdRecord(512 + Buffer.byteLength(path)),
            });
            {
              const original = await metadata.directoryNative(
                logical + path.slice(physical.length),
              );
              if (!original || !sameNative(original, native, true)) {
                await phase!.created(path, native);
              }
            }
          } else {
            await selectors.append(['remove-file', path, native]);
          }
        },
      },
      signal,
    );
    while (frames.length) {
      await closeDirectory();
    }
    for await (const value of selectors.rows(0, selectors.position)) {
      signal.throwIfAborted();
      const row = value as readonly Value[],
        path = String(row[1]),
        native = row[2] as NativeIdentity;
      const parent = path === physical ? owned : phase!;
      if (path === physical) {
        await phase?.barrier();
      }
      await parent.parents(path);
      const actual = await parent.stat(path);
      // No member can disappear during this stable cleanup phase. Already missing
      // members were omitted by the checked partial join before selectors were sealed.
      if (
        !actual ||
        (row[0] === 'remove-file'
          ? !sameNative(native, actual, true)
          : !sameDirectoryObject(native, actual))
      ) {
        throw new Error('Backup retirement member changed.');
      }
      signal.throwIfAborted();
      if (row[0] === 'remove-file') {
        await unlink(store.root.resolve(path));
        store.root.work.unlinks++;
      } else {
        await rmdir(store.root.resolve(path));
        store.root.work.directoryRemovals++;
      }
      await parent.changed(path);
      await store.fail('install-backup-member-retired');
    }
  } finally {
    for (const frame of frames) {
      frame.release();
    }
    phase?.release();
    await closeRetirementFiles(
      files,
      ledgerDirectory
        ? retireOwnedDirectory(store, ledgerDirectory.path, ledgerDirectory.native, budget)
        : undefined,
    );
  }
}
async function closeRetirementFiles(files: InstallScratch[], ledger?: Promise<void>) {
  const results = await Promise.allSettled([...files.map((f) => f.close()), ledger]);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) {
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Backup selector cleanup failed.',
    );
  }
}
