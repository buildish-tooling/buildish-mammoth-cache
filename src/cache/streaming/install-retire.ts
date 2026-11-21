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
import { buildInstallIndex, IndexDirectories } from './install-index';
import type { InstallReaders } from './install-program';
import type { LocalRow } from './local-stream';
import { parentPath } from './tree-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
// Called only after the complete-unit cursor/root pointer commit. A fresh process
// first verifies surviving old members and passes its observed root N, not a flag.
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
  if (!(await store.root.stat(physical))) return;
  if (observed[2] === 'file') {
    await owned.parents(physical);
    const native = await checkInstallMember(
      readers,
      binding,
      logical,
      physical,
      {
        renamed: true,
        hash: false,
        rootNative: observed,
        stat: (p) => owned.stat(p),
      },
      signal,
    );
    const actual = await owned.stat(physical);
    if (!actual || !sameNative(native, actual, true))
      throw new Error('Backup file changed before retirement.');
    signal.throwIfAborted();
    await unlink(store.root.resolve(physical));
    store.root.work.unlinks++;
    await owned.changed(physical);
    await store.fail('install-backup-member-retired');
    return;
  }
  const files: InstallScratch[] = [];
  let ledgerDirectory: { path: string; native: NativeIdentity } | undefined;
  let directories: IndexDirectories | undefined, phase: InstallParentPhase | undefined;
  const frames: { path: string; native: NativeIdentity; release: () => void }[] = [];
  try {
    const selectors = await InstallScratch.create(store, budget);
    files.push(selectors);
    const facts = await InstallScratch.create(store, budget);
    files.push(facts);
    const indexFile = await InstallScratch.create(store, budget);
    files.push(indexFile);
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
        hash: false,
        rootNative: observed,
        observed: async (row, path, native) => {
          const value = row as readonly Value[];
          while (frames.length && frames[frames.length - 1].path !== parentPath(path))
            await closeDirectory();
          const relative = path === physical ? '' : path.slice(physical.length + 1);
          if (value[0] === 'directory') {
            frames.push({
              path,
              native,
              release: budget.holdRecord(512 + Buffer.byteLength(path)),
            });
            await facts.append(['directory', relative, native]);
          } else {
            await selectors.append(['remove-file', path, native]);
            if (observed[2] === 'directory')
              await facts.append(['file', relative, native, '0'.repeat(64)]);
          }
        },
      },
      signal,
    );
    while (frames.length) await closeDirectory();
    if (observed[2] === 'directory') {
      async function* rows(): AsyncGenerator<LocalRow> {
        let record = 0;
        for await (const value of facts.rows(0, facts.position))
          yield { value, start: record, end: ++record, record };
        yield { value: ['local-end'], start: record, end: record, record };
      }
      const reader = await readers.reader(binding, signal);
      const index = await buildInstallIndex(
        indexFile,
        rows(),
        store.codec.options.model,
        reader.partition,
        signal,
      );
      directories = new IndexDirectories(indexFile, index);
      const ledger = store.prefix + 'mutation/' + randomUUID() + '/';
      await store.makeParents(ledger + 'pending');
      ledgerDirectory = {
        path: ledger.slice(0, -1),
        native: (await store.root.stat(ledger.slice(0, -1)))!,
      };
      const dirs = directories;
      phase = new InstallParentPhase(store, physical, ledger, budget, async (path) => {
        const n = await dirs.directory(path === physical ? '' : path.slice(physical.length + 1));
        return n ? (n[3] as NativeIdentity) : null;
      });
    }
    for await (const value of selectors.rows(0, selectors.position)) {
      signal.throwIfAborted();
      const row = value as readonly Value[],
        path = String(row[1]),
        native = row[2] as NativeIdentity;
      const parent = path === physical ? owned : phase!;
      if (path === physical) await phase?.barrier();
      await parent.parents(path);
      const actual = await parent.stat(path);
      // No member can disappear during this stable cleanup phase. Already missing
      // members were omitted by the checked partial join before selectors were sealed.
      if (
        !actual ||
        (row[0] === 'remove-file'
          ? !sameNative(native, actual, true)
          : !sameDirectoryObject(native, actual))
      )
        throw new Error('Backup retirement member changed.');
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
    for (const frame of frames) frame.release();
    phase?.release();
    directories?.close();
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
  if (failed.length)
    throw new AggregateError(
      failed.map((r) => r.reason),
      'Backup selector cleanup failed.',
    );
}
