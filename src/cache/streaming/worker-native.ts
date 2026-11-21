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

import type { OwnedStore, Reference } from './owned-store';
import { WorkerStage, type StagedPartition } from './worker-stage';
import { walkNative } from './native-walk';
import { NativeReadPhase } from './native-read-phase';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { add, tuple, type Value } from './encoding';
import type { WorkingBudget } from './tree-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence.
// Payload hashes came from immediate worker metadata. Directory guards are postorder
// so they include completed child writes; neither sealing nor copying rehashes bodies.
export async function writeWorkerNativeEvidence(
  store: OwnedStore,
  part: StagedPartition,
  budget: WorkingBudget,
  signal: AbortSignal,
  maxDirectoryEntries = 100000,
  renamed = false,
): Promise<Reference> {
  const files = part.facts.rows(signal)[Symbol.asyncIterator](),
    directories = part.directories.rows(signal)[Symbol.asyncIterator]();
  const retire = async () => {
    const settled = await Promise.allSettled([
        files.return?.(undefined),
        directories.return?.(undefined),
      ]),
      errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Worker evidence reader cleanup failed.',
      );
  };
  async function* rows(): AsyncGenerator<Value> {
    for await (const e of walkNative(store.root, part.nativeRoot, {
      budget,
      signal,
      maxDirectoryEntries,
      logicalRoot: '',
      metadata: 'reject',
    })) {
      if (e.tag === 'protected-child')
        throw new Error('Protected child in selected worker staging.');
      if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
        throw new Error('Aliased/cross-filesystem selected staging.');
      if (e.tag === 'directory-open') yield ['directory', e.path, e.identity];
      else if (e.tag === 'directory-close') {
        const next = await directories.next();
        if (next.done) throw new Error('Extra native worker directory.');
        const fact = tuple(next.value);
        if (
          fact[1] !== e.path ||
          !(renamed && e.path === ''
            ? sameRename(fact[2] as NativeIdentity, e.identity)
            : sameNative(fact[2] as NativeIdentity, e.identity, true))
        )
          throw new Error('Selected worker directory changed.');
      } else {
        if (e.tag !== 'file') throw new Error('Unexpected selected snapshot event.');
        const next = await files.next();
        if (next.done) throw new Error('Extra native worker file.');
        const fact = tuple(next.value);
        if (
          fact[1] !== e.path ||
          fact[2] !== part.partition ||
          !sameNative(fact[3] as NativeIdentity, e.identity, true)
        )
          throw new Error('Selected worker file changed.');
        yield ['file', e.path, e.identity, fact[4]];
      }
    }
    if (!(await files.next()).done || !(await directories.next()).done)
      throw new Error('Missing selected worker native member.');
  }
  try {
    return await store.writeStream(
      'native-evidence',
      { budget, partition: part.partition, maxDirectoryEntries },
      rows(),
      signal,
    );
  } finally {
    await retire();
  }
}
export async function copyWorkerSnapshot(
  store: OwnedStore,
  part: StagedPartition,
  budget: WorkingBudget,
  signal: AbortSignal,
  maxDirectoryEntries = 100000,
): Promise<{ stage: WorkerStage; readBytes: number }> {
  const stage = await WorkerStage.create(store, budget),
    phase = new NativeReadPhase(store.root, part.nativeRoot),
    files = part.facts.rows(signal)[Symbol.asyncIterator](),
    directories = part.directories.rows(signal)[Symbol.asyncIterator]();
  let readBytes = 0;
  const retire = async () => {
    const settled = await Promise.allSettled([
        files.return?.(undefined),
        directories.return?.(undefined),
      ]),
      errors = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Snapshot source reader cleanup failed.',
      );
  };
  try {
    for await (const e of walkNative(store.root, part.nativeRoot, {
      budget,
      signal,
      maxDirectoryEntries,
      logicalRoot: '',
      metadata: 'reject',
    })) {
      if (e.tag === 'protected-child') throw new Error('Unexpected snapshot protected child.');
      if (e.tag === 'directory-open') {
        await phase.enter(e.nativePath, e.identity);
        stage.enter(e.path);
        await stage.ensure(part.partition, signal);
      } else if (e.tag === 'directory-close') {
        const next = await directories.next();
        if (next.done) throw new Error('Extra selected snapshot directory.');
        const fact = tuple(next.value);
        if (fact[1] !== e.path || !sameNative(fact[2] as NativeIdentity, e.identity, true))
          throw new Error('Selected snapshot directory changed.');
        await phase.leave(e.nativePath, e.identity);
        await stage.leave(e.path, signal);
      } else {
        if (e.tag !== 'file') throw new Error('Unexpected selected snapshot event.');
        const next = await files.next();
        if (next.done || e.links !== '1') throw new Error('Extra/aliased selected snapshot file.');
        const fact = tuple(next.value);
        if (fact[1] !== e.path || !sameNative(fact[3] as NativeIdentity, e.identity, true))
          throw new Error('Selected snapshot file changed.');
        const size = Number(fact[5]),
          mode = Number(fact[6]),
          mtimeMs = Number(fact[7]);
        const pending = await stage.write(
          {
            path: e.path,
            partition: part.partition,
            ordinal: 1,
            header: {
              name: 'payload/snapshot/' + part.partition + '/' + e.path,
              type: 'file',
              size,
              mode,
              mtimeMs,
            },
            body: phase.read(e.nativePath, e.identity, signal),
          },
          signal,
        );
        try {
          await pending.finish(String(fact[4]), size, mode, mtimeMs);
          readBytes = add(readBytes, size);
        } finally {
          await pending.close();
        }
      }
    }
    if (!(await files.next()).done || !(await directories.next()).done)
      throw new Error('Missing selected snapshot member.');
    await stage.seal(signal);
    return { stage, readBytes };
  } catch (error) {
    await stage.dispose();
    throw error;
  } finally {
    await retire();
  }
}
