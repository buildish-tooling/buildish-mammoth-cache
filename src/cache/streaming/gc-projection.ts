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

import { isWorkspaceScaffolding } from './tree-state';
import { lstat, opendir } from 'node:fs/promises';
import { equal } from './encoding';
import { nativeIdentity, nativeIds, sameNative, missing, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import {
  ObservationIndex,
  type ObservedDirectory,
  type ObservedFile,
  type ObservedChild,
} from './observation-index';
import type { InstallParentPhase } from './install-parent-phase';

export interface GcProjectionObserver {
  open(directory: ObservedDirectory, native: NativeIdentity): Promise<void>;
  file(file: ObservedFile, native: NativeIdentity): Promise<void>;
  protected(parent: string, child: ObservedChild): Promise<void>;
  close(directory: ObservedDirectory, native: NativeIdentity): Promise<void>;
}
/** A relocation join must prove every skipped root and each changed directory itself. */
export interface GcRelocationProjection {
  member(path: string, present: boolean): Promise<boolean>;
  directory(
    directory: ObservedDirectory,
    actual: NativeIdentity,
    gcChanged: boolean,
  ): Promise<void>;
}
export interface GcProjectionWork {
  directories: number;
  entries: number;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#shared-gc-parent-projections.
// Fresh native facts become a process-local parent phase ONLY after the original
// complete projection has been reconciled against the durable deletion high-water.
export async function checkGcProjection(
  index: ObservationIndex,
  completed: number,
  active: number,
  phase?: InstallParentPhase,
  work: GcProjectionWork = { directories: 0, entries: 0 },
  observer?: GcProjectionObserver,
  relocation?: GcRelocationProjection,
): Promise<GcProjectionWork> {
  ObservationIndex.assert(index);
  if (active < completed) throw new Error('GC high-water precedes completion.');
  const { store, options } = index,
    signal = options.signal;
  async function absentTree(d: ObservedDirectory, unitEnd: number): Promise<string | null> {
    // An omitted directory must itself be an explicitly eligible postorder target:
    // no protected children, mixed ownership or retained descendants.
    if (!unitEnd || unitEnd > active) throw new Error('Unplanned missing GC directory.');
    let owner: string | null = null;
    for await (const e of index.children(d)) {
      if (e[5] === null) throw new Error('Protected child omitted with GC directory.');
      const lease = await index.node(e[5]);
      try {
        let childOwner: string | null;
        if (lease.node[0] === 'observed-directory')
          childOwner = await absentTree(lease.node, unitEnd);
        else {
          if (lease.node[6] !== 'delete')
            throw new Error('Retained file omitted with GC directory.');
          childOwner = lease.node[3];
        }
        if (owner !== null && childOwner !== owner)
          throw new Error('Mixed GC directory ownership.');
        owner ??= childOwner;
      } finally {
        lease.release();
      }
    }
    if (owner === null)
      owner = store.codec.options.model.owner(d[1] + '/.workspace-directory-probe')[0];
    return owner;
  }
  async function visit(offset: number, subtreeEnd = 0): Promise<string | null> {
    signal?.throwIfAborted();
    const lease = await index.node(offset);
    if (lease.node[0] !== 'observed-directory') {
      lease.release();
      throw new Error('Expected GC directory.');
    }
    const d = lease.node,
      path = d[1];
    const entries = new Map<string, { type: string }>();
    let charge = 0;
    try {
      const u = d[9];
      if (u?.[3] === 'subtree' && u[5] === 'delete') subtreeEnd = u[8];
      store.root.work.stats++;
      const before = await lstat(store.root.resolve(path), { bigint: true })
        .then(nativeIdentity)
        .catch((error) => {
          if (missing(error)) return null;
          throw error;
        });
      if (!before) {
        return await absentTree(d, subtreeEnd);
      }
      if (!sameDirectoryObject(d[2], before)) throw new Error('Frozen GC directory replaced.');
      const directory = await opendir(store.root.resolve(path), { bufferSize: 32 });
      work.directories++;
      try {
        while (true) {
          signal?.throwIfAborted();
          const entry = await directory.read();
          if (!entry) break;
          if (entries.size >= (options.maxDirectoryEntries ?? 100000))
            throw new Error('GC directory entry allowance exceeded.');
          const n = 320 + 4 * Buffer.byteLength(entry.name);
          options.budget.retain(n);
          charge += n;
          // Identity is read at the consuming child boundary, not once here and
          // immediately again below. Unknown names reject without another stat.
          const type = entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : entry.isSymbolicLink()
                ? 'symlink'
                : 'other';
          work.entries++;
          entries.set(entry.name, { type });
        }
      } finally {
        await directory.close();
      }
      // Provisional ledger rows remain operation-local until this entire join succeeds.
      if (phase) await phase.created(path, before);
      await observer?.open(d, before);
      let affected = false,
        cleanup = !isWorkspaceScaffolding(store.codec.options.model, path),
        owner: string | null = null;
      const combine = (childOwner: string | null) => {
        if (childOwner === null || (owner !== null && owner !== childOwner)) cleanup = false;
        owner ??= childOwner;
      };
      for await (const e of index.children(d)) {
        signal?.throwIfAborted();
        const actual = entries.get(e[1]);
        entries.delete(e[1]);
        if (actual) equal(actual.type, e[2], 'original GC child kind');
        if (e[5] === null) {
          if (!actual) throw new Error('Missing protected GC child.');
          store.root.work.stats++;
          const raw = await lstat(store.root.resolve(path ? path + '/' + e[1] : e[1]), {
            bigint: true,
          });
          const kind = raw.isFile()
            ? 'file'
            : raw.isDirectory()
              ? 'directory'
              : raw.isSymbolicLink()
                ? 'symlink'
                : 'other';
          equal([kind, ...nativeIds(raw)], e.slice(2, 5), 'original protected GC identity');
          cleanup = false;
          await observer?.protected(path, e);
          continue;
        }
        if (relocation && (await relocation.member(path ? path + '/' + e[1] : e[1], !!actual))) {
          if (actual) {
            store.root.work.stats++;
            const raw = await lstat(store.root.resolve(path ? path + '/' + e[1] : e[1]), {
              bigint: true,
            });
            const kind = raw.isFile()
              ? 'file'
              : raw.isDirectory()
                ? 'directory'
                : raw.isSymbolicLink()
                  ? 'symlink'
                  : 'other';
            equal([kind, ...nativeIds(raw)], e.slice(2, 5), 'relocated original child identity');
            if (raw.isFile() && raw.nlink !== 1n)
              throw new Error('Aliased relocated original child.');
          }
          affected ||= !actual;
          cleanup = false;
          continue;
        }
        const child = await index.node(e[5]);
        try {
          if (child.node[0] === 'observed-file') {
            const f = child.node,
              end = subtreeEnd || (u?.[3] === 'direct' ? u[8] : f[8]),
              selected = f[6] === 'delete';
            cleanup &&= selected;
            combine(f[3]);
            if (!actual) {
              if (!selected || end > active) throw new Error('Unplanned missing GC file.');
              affected = true;
            } else {
              if (selected && end <= completed) throw new Error('Completed GC target recreated.');
              store.root.work.stats++;
              const raw = await lstat(store.root.resolve(f[1]), { bigint: true });
              if (raw.nlink !== 1n || !sameNative(f[2], nativeIdentity(raw), true))
                throw new Error('Frozen GC file changed.');
              await observer?.file(f, nativeIdentity(raw));
            }
          } else {
            const childUnit = child.node[9],
              end =
                childUnit?.[3] === 'subtree' && childUnit[5] === 'delete'
                  ? childUnit[8]
                  : subtreeEnd;
            if (!actual) {
              combine(await absentTree(child.node, end));
              affected = true;
            } else combine(await visit(e[5], subtreeEnd));
          }
        } finally {
          child.release();
        }
      }
      if (entries.size) throw new Error('Unexpected GC directory child.');
      store.root.work.stats++;
      const after = nativeIdentity(await lstat(store.root.resolve(path), { bigint: true }));
      if (!after || !sameNative(before, after, true))
        throw new Error('GC directory changed during projection check.');
      if (relocation) await relocation.directory(d, before, affected);
      else if (!affected && !sameNative(d[2], before, true))
        throw new Error('Unexplained GC directory change.');
      signal?.throwIfAborted();
      if (owner === null) {
        try {
          owner = store.codec.options.model.owner(path + '/.workspace-directory-probe')[0];
        } catch {
          cleanup = false;
        }
      }
      if (subtreeEnd && subtreeEnd <= completed && cleanup && owner !== null)
        throw new Error('Completed GC directory recreated.');
      if (phase && affected) {
        // An unlink/rmdir can complete before its parent's checkpoint is published.
        // Attribute each surviving parent once, including all-absent active units.
        signal?.throwIfAborted();
        await phase.parents(path + (path ? '/' : '') + 'pending');
        await phase.changed(path + (path ? '/' : '') + 'pending');
      }
      await observer?.close(d, before);
      return cleanup ? owner : null;
    } finally {
      options.budget.release(charge);
      lease.release();
    }
  }
  await visit(index.root);
  signal?.throwIfAborted();
  return work;
}
