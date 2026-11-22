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

import { mkdir, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { OwnedStore, Reference } from './owned-store';
import { NativeReadPhase } from './native-read-phase';
import { nativeIdentity, sameNative, portableMtimeSeconds, type NativeIdentity } from './native';
import { tuple, add } from './encoding';
import { parentPath } from './tree-state';
import { walkNative } from './native-walk';
import { WorkerSpool } from './worker-spool';
import { retireOwnedDirectory } from './owned-retirement';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence.
// Checked preorder evidence: scoped parents remain live while a caller reads one file.
export async function* baseEvidence(
  store: OwnedStore,
  root: string,
  evidence: Reference,
  partition: string,
  options: BaseObjectOptions,
) {
  const signal = options.signal ?? new AbortController().signal,
    phase = new NativeReadPhase(store.root, root),
    stack: { path: string; native: NativeIdentity; release: () => void }[] = [];
  const leave = async () => {
    signal.throwIfAborted();
    const frame = stack.pop()!;
    try {
      await phase.leave(frame.path, frame.native);
      signal.throwIfAborted();
    } finally {
      frame.release();
    }
  };
  try {
    signal.throwIfAborted();
    for await (const row of store.rows(
      evidence,
      'native-evidence',
      { ...options, partition },
      signal,
    )) {
      signal.throwIfAborted();
      const r = tuple(row.value);
      if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
      const logical = String(r[1]),
        path = root ? root + (logical ? '/' + logical : '') : logical,
        native = r[2] as NativeIdentity,
        parent = r[0] === 'directory' && logical === '' ? null : parentPath(path);
      while (stack.length && stack[stack.length - 1].path !== parent) await leave();
      if (r[0] === 'directory') {
        await phase.enter(path, native);
        signal.throwIfAborted();
        const release = options.budget.holdRecord(512 + Buffer.byteLength(path));
        stack.push({ path, native, release });
      }
      yield { row: r, logical, path, native, phase };
    }
    while (stack.length) await leave();
    signal.throwIfAborted();
  } finally {
    for (const frame of stack) frame.release();
  }
}
export async function movedBaseEvidence(
  store: OwnedStore,
  evidence: Reference,
  partition: string,
  native: NativeIdentity,
  options: BaseObjectOptions,
): Promise<Reference> {
  return store.writeStream(
    'native-evidence',
    { ...options, partition },
    (async function* () {
      for await (const row of store.rows(evidence, 'native-evidence', { ...options, partition })) {
        const r = tuple(row.value);
        if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
        yield r[0] === 'directory' && r[1] === '' ? ['directory', '', native] : r;
      }
    })(),
    options.signal,
  );
}
export interface BaseCopy {
  readonly container: string;
  readonly root: string;
  readonly evidence: Reference;
  readonly native: NativeIdentity;
  readonly bytes: number;
  dispose(): Promise<void>;
}
/** Only selected authoritative snapshots get independent copies; never an EXDEV fallback. */
export async function copyBaseSnapshot(
  store: OwnedStore,
  root: string,
  evidence: Reference,
  partition: string,
  options: BaseObjectOptions,
): Promise<BaseCopy> {
  if (store.codec.options.model.partitions.find((p) => p[0] === partition)?.[3] !== 'single-writer')
    throw new Error('Only snapshots require an independent native copy.');
  const container = store.prefix + 'base/' + randomUUID(),
    target = container + '/copy',
    signal = options.signal ?? new AbortController().signal;
  await store.makeParents(target + '/placeholder');
  const owner = (await store.root.stat(container))!;
  const stat = async (path: string) => {
    store.root.work.stats++;
    const n = nativeIdentity(await lstat(store.root.resolve(path), { bigint: true }));
    if (n[2] !== 'directory' || n[3] !== store.root.binding[3])
      throw new Error('Unsafe snapshot copy directory.');
    return n;
  };
  const initial = await stat(target),
    frames: { path: string; logical: string; native: NativeIdentity; release: () => void }[] = [];
  let files: WorkerSpool | undefined,
    dirs: WorkerSpool | undefined,
    bytes = 0,
    sealedRoot: NativeIdentity | undefined;
  const finish = async () => {
    const frame = frames.pop()!;
    try {
      if (!sameNative(frame.native, await stat(frame.path), true))
        throw new Error('Created snapshot directory changed.');
      await dirs!.append(['directory', frame.logical, frame.native], signal);
      if (!frame.logical) sealedRoot = frame.native;
    } finally {
      frame.release();
    }
  };
  const parentBefore = async () => {
    const parent = frames[frames.length - 1];
    if (!parent || !sameNative(parent.native, await stat(parent.path), true))
      throw new Error('Snapshot copy parent changed.');
    return parent;
  };
  const parentAfter = async (parent: (typeof frames)[number]) => {
    const after = await stat(parent.path);
    if (parent.native.some((v, i) => ![5, 7, 8, 9].includes(i) && v !== after[i]))
      throw new Error('Snapshot copy parent identity changed.');
    parent.native = after;
  };
  try {
    files = await WorkerSpool.create(store, options.budget);
    dirs = await WorkerSpool.create(store, options.budget);
    for await (const e of baseEvidence(store, root, evidence, partition, options)) {
      signal.throwIfAborted();
      const destination = target + (e.logical ? '/' + e.logical : ''),
        parent = e.logical ? parentPath(destination) : null;
      while (frames.length && frames[frames.length - 1].path !== parent) await finish();
      if (e.row[0] === 'directory') {
        let native = initial;
        if (e.logical) {
          const p = await parentBefore();
          await mkdir(store.root.resolve(destination), { mode: 0o700 });
          await parentAfter(p);
          native = await stat(destination);
        } else if (!sameNative(initial, await stat(target), true))
          throw new Error('Empty copy root changed before population.');
        const release = options.budget.holdRecord(512 + Buffer.byteLength(destination));
        frames.push({ path: destination, logical: e.logical, native, release });
        continue;
      }
      const parentFrame = await parentBefore();
      store.root.work.opens++;
      const output = await open(
        store.root.resolve(destination),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await parentAfter(parentFrame);
        let size = 0;
        for await (const chunk of e.phase.read(e.path, e.native, signal)) {
          await output.writeFile(chunk);
          size = add(size, chunk.length);
          bytes = add(bytes, chunk.length);
          store.root.work.writeBytes = add(store.root.work.writeBytes, chunk.length);
        }
        if (size !== Number(e.native[5])) throw new Error('Native snapshot copy length changed.');
        await output.chmod(e.native[6] & 0o777);
        const time = portableMtimeSeconds(Number(BigInt(e.native[8]) / 1000000n));
        await output.utimes(time, time);
        store.root.work.stats++;
        const written = nativeIdentity(await output.stat({ bigint: true }));
        if (
          written[3] !== store.root.binding[3] ||
          written[5] !== e.native[5] ||
          BigInt(written[8]) / 1000000n !== BigInt(e.native[8]) / 1000000n
        )
          throw new Error('Native snapshot copy portable metadata changed.');
        await files.append(['file', e.logical, written, e.row[3]], signal);
      } finally {
        await output.close();
      }
    }
    while (frames.length) await finish();
    files.seal(signal);
    dirs.seal(signal);
    const fileRows = files.rows(signal)[Symbol.asyncIterator](),
      dirRows = dirs.rows(signal)[Symbol.asyncIterator]();
    let sealed: Reference;
    try {
      sealed = await store.writeStream(
        'native-evidence',
        { ...options, partition },
        (async function* () {
          for await (const e of walkNative(store.root, target, {
            ...options,
            logicalRoot: '',
            metadata: 'reject',
          })) {
            if (e.tag === 'directory-open') yield ['directory', e.path, e.identity];
            else if (e.tag === 'directory-close') {
              const next = await dirRows.next(),
                r = next.done ? [] : tuple(next.value);
              if (r[1] !== e.path || !sameNative(r[2] as NativeIdentity, e.identity, true))
                throw new Error('Unplanned or replaced native copy directory.');
            } else if (e.tag === 'file') {
              const next = await fileRows.next(),
                r = next.done ? [] : tuple(next.value);
              if (
                r[1] !== e.path ||
                !sameNative(r[2] as NativeIdentity, e.identity, true) ||
                e.links !== '1'
              )
                throw new Error('Native snapshot copy changed before sealing.');
              yield ['file', e.path, e.identity, r[3]];
            } else throw new Error('Protected snapshot copy.');
          }
          if (!(await fileRows.next()).done || !(await dirRows.next()).done)
            throw new Error('Missing copied native member.');
        })(),
        signal,
      );
    } finally {
      await settleBaseCleanup([() => fileRows.return(undefined), () => dirRows.return(undefined)]);
    }
    await settleBaseCleanup([() => files!.dispose(), () => dirs!.dispose()]);
    signal.throwIfAborted();
    let retired = false;
    return Object.freeze({
      container,
      root: target,
      evidence: Object.freeze(sealed) as Reference,
      native: Object.freeze(sealedRoot!) as NativeIdentity,
      bytes,
      dispose: async () => {
        if (!retired) {
          await retireOwnedDirectory(store, container, owner, options.budget);
          retired = true;
        }
      },
    });
  } catch (error) {
    await settleBaseCleanup(
      [
        () => files?.dispose(),
        () => dirs?.dispose(),
        () => retireOwnedDirectory(store, container, owner, options.budget),
      ],
      error,
    );
    throw error;
  } finally {
    for (const frame of frames) frame.release();
  }
}
