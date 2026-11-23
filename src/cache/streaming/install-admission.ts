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

import { lstat, writeFile, opendir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { canonical, add, equal, encodeRecord, decodeRecord, type Value } from './encoding';
import { sameNative, nativeIdentity, missing, type NativeIdentity } from './native';
import { IndexDirectories, indexedEntries, indexedNode } from './install-index';
import { InstallScratch } from './install-scratch';
import { isMavenTransientFile } from '../maven-repository';
import { isCacheMetadataPath } from '../metadata-paths';
import { retireOwnedDirectory } from './owned-retirement';
import { assertFrozenInstall, takeInstallIndexes, type FrozenInstall } from './install-plan';
import type { OwnedStore } from './owned-store';
import { parentPath, type WorkingBudget } from './tree-state';

/** Bounded parent-only lookup files; data rows remain solely in sealed plan/evidence. */
export class AdmittedParents {
  readonly prefix: string;
  constructor(
    readonly store: OwnedStore,
    prefix: string,
  ) {
    this.prefix = prefix;
  }
  private key(path: string) {
    return this.prefix + createHash('sha256').update(path).digest('hex');
  }
  async add(path: string, source: string, native: NativeIdentity) {
    const bytes = encodeRecord(['parent', path, source, native]);
    await writeFile(this.store.root.resolve(this.key(path)), bytes, { flag: 'wx', mode: 0o600 });
    this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, bytes.length);
  }
  async get(pathValue: string): Promise<readonly Value[] | null> {
    try {
      const path = this.key(pathValue);
      const stat = await this.store.root.stat(path);
      if (!stat) return null;
      if (BigInt(stat[5]) > 65536n) throw new Error('Oversized parent definition.');
      const chunks: Buffer[] = [];
      for await (const chunk of this.store.root.read(path, stat)) chunks.push(chunk);
      const row = decodeRecord(Buffer.concat(chunks)) as readonly Value[];
      if (row[0] !== 'parent' || row[1] !== pathValue)
        throw new Error('Parent definition collision.');
      return row;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
}
const admitted = new WeakSet<object>();
export class InstallAdmission {
  kind: 'file' | 'directory' = 'file';
  private scratch: InstallScratch | null = null;
  operations!: InstallScratch;
  private directories: IndexDirectories | null = null;
  readonly sourceDirectories: (IndexDirectories | null)[];
  async currentDirectory(path: string): Promise<NativeIdentity | null> {
    const node = await this.directories!.directory(path);
    return node ? (node[3] as NativeIdentity) : null;
  }
  private constructor(
    readonly frozen: FrozenInstall,
    readonly budget: WorkingBudget,
    readonly parents: AdmittedParents,
    readonly initialState: Value,
    private readonly namespaceNative: NativeIdentity,
  ) {
    this.sourceDirectories = frozen.store.codec.options.model.partitions.map(() => null);
    admitted.add(this);
  }
  assert(store: OwnedStore) {
    if (!admitted.has(this) || this.frozen.store !== store)
      throw new Error('No process-local native install admission.');
  }
  // Protocol: docs/dev/cache-lifecycle-protocol.md#install-batches-and-recovery.
  static async create(
    store: OwnedStore,
    frozen: FrozenInstall,
    budget: WorkingBudget,
    signal = new AbortController().signal,
  ): Promise<InstallAdmission> {
    assertFrozenInstall(store, frozen);
    signal.throwIfAborted();
    const state = await store.state();
    if (!Array.isArray(state) || state[4] !== 'prepare-pending')
      throw new Error('Install requires idle prepare-pending state.');
    const bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(state[5], 'bindings'),
    );
    if (bindings[8][9] !== frozen.maxDirectoryEntries)
      throw new Error('Frozen directory limit differs from persisted invocation policy.');
    const maxDirectoryEntries = frozen.maxDirectoryEntries;
    await store.assertNoIntents();
    await store.makeParents(store.prefix + 'backups/pending');
    const backupParent = await store.root.stat(store.prefix + 'backups');
    if (
      !backupParent ||
      backupParent[2] !== 'directory' ||
      backupParent[3] !== store.root.binding[3]
    )
      throw new Error('Unsafe/cross-filesystem backup parent.');
    const prefix = store.prefix + 'admission/' + randomUUID() + '/';
    await store.makeParents(prefix + 'pending');
    const result = new InstallAdmission(
      frozen,
      budget,
      new AdmittedParents(store, prefix),
      state,
      (await store.root.stat(prefix.slice(0, -1)))!,
    );
    try {
      // Borrow the original completed current index; decoded metadata grants no authority.
      const reused = await takeInstallIndexes(store, frozen);
      if (!reused) throw new Error('Install indexes already consumed or missing.');
      const scratch = reused.scratch;
      result.scratch = scratch;
      result.operations = await InstallScratch.create(store, budget);
      const directories = new IndexDirectories(scratch, reused.current);
      result.directories = directories;
      let lastMaven = '';
      const checkedMaven = new AdmittedParents(store, prefix + 'maven-');
      async function maven(path: string, kind: 'file' | 'directory') {
        if (
          store.codec.options.model.tuple[2] !== 'maven' ||
          kind !== 'file' ||
          !path.startsWith('repository/')
        )
          return;
        const parent = parentPath(path);
        if (parent === lastMaven) return;
        lastMaven = parent;
        if (await checkedMaven.get(parent)) return;
        const directory = await directories.directory(parent);
        if (!directory) return;
        for await (const entry of indexedEntries(scratch, directory)) {
          if (
            entry[1] === 'directory' ||
            isMavenTransientFile(entry[0]) ||
            isCacheMetadataPath(parent + '/' + entry[0])
          )
            continue;
          const child = await indexedNode(scratch, entry[2]);
          try {
            if (child.node[6] !== 0)
              throw new Error('Incomplete Maven repository directory: excluded artifact sibling.');
          } finally {
            child.release();
          }
        }
        await checkedMaven.add(parent, '', store.root.binding);
      }
      for (const input of frozen.inputs) {
        const p = store.codec.options.model.partitions.findIndex((v) => v[0] === input.partition);
        const sourceIndex = reused.sources.get(p);
        if (sourceIndex === undefined) throw new Error('Missing admitted source index.');
        result.sourceDirectories[p] = new IndexDirectories(scratch, sourceIndex);
      }
      const pending: { path: string; release: () => void }[] = [];
      const parentStack: { path: string; expected: NativeIdentity | null; release: () => void }[] =
        [];
      async function direct(path: string) {
        try {
          store.root.work.stats++;
          const raw = await lstat(store.root.resolve(path), { bigint: true });
          if (raw.isFile() && raw.nlink !== 1n)
            throw new Error('Aliased selected install endpoint.');
          return nativeIdentity(raw);
        } catch (error) {
          if (missing(error)) return null;
          throw error;
        }
      }
      async function checkParent(frame: (typeof parentStack)[number]) {
        const actual = await direct(frame.path);
        if (frame.expected) {
          if (
            !actual ||
            actual[2] !== 'directory' ||
            actual[3] !== store.root.binding[3] ||
            !sameNative(frame.expected, actual, true)
          )
            throw new Error('Frozen install ancestor changed.');
        } else if (actual) throw new Error('Unexpected install ancestor.');
      }
      async function leaveParent() {
        const frame = parentStack.pop()!;
        try {
          await checkParent(frame);
        } finally {
          frame.release();
        }
      }
      async function ancestors(path: string) {
        const target = parentPath(path),
          parts = target ? target.split('/') : [];
        while (
          parentStack.length > 1 &&
          parentStack[parentStack.length - 1].path !== target &&
          !target.startsWith(parentStack[parentStack.length - 1].path + '/')
        )
          await leaveParent();
        const paths = [''];
        let at = '';
        for (const part of parts) {
          at = at ? at + '/' + part : part;
          paths.push(at);
        }
        for (const path of paths.slice(parentStack.length)) {
          const node = await directories.directory(path);
          const expected = node ? ([...(node[3] as NativeIdentity)] as NativeIdentity) : null;
          if (!expected && !(await result.parents.get(path)))
            throw new Error('Missing install-parent creation authority.');
          const frame = {
            path,
            expected,
            release: budget.holdRecord(512 + Buffer.byteLength(path)),
          };
          parentStack.push(frame);
          await checkParent(frame);
        }
      }
      let admittedSource: NativeIdentity | null = null,
        admittedOld: NativeIdentity | null = null;
      try {
        for await (const row of store.rows(
          frozen.plan,
          'install-plan',
          { budget, partition: null, installKind: () => result.kind, maxDirectoryEntries },
          signal,
          async (value) => {
            admittedSource = null;
            admittedOld = null;
            if (!Array.isArray(value)) throw new Error('Invalid install row.');
            if (value[0] === 'install-context') {
              equal(value[1], frozen.metadata.nonce, 'process-owned install context');
              return;
            }
            if (value[0] === 'install-parent') {
              const parent = store.codec.schemas.rows.installParent.parse(value),
                key = createHash('sha256').update(parent[2]).digest('hex');
              if (parent[3] !== frozen.parentsPrefix + 'objects/' + key)
                throw new Error('Unexpected parent source namespace.');
              const native = await store.root.stat(parent[3]);
              if (
                !native ||
                native[3] !== store.root.binding[3] ||
                !sameNative(native, parent[4], true)
              )
                throw new Error('Parent source changed.');
              if (await store.root.stat(parent[2]))
                throw new Error('Expected absent install-parent target.');
              const directory = await opendir(store.root.resolve(parent[3]));
              try {
                if (await directory.read()) throw new Error('Parent source is not empty.');
              } finally {
                await directory.close();
              }
              const after = await store.root.stat(parent[3]);
              if (!after || !sameNative(native, after, true))
                throw new Error('Parent source changed during empty check.');
              await result.parents.add(parent[2], parent[3], parent[4]);
              pending.push({
                path: parent[2],
                release: budget.holdRecord(128 + Buffer.byteLength(parent[2])),
              });
              return;
            }
            if (value[0] === 'install-unit-close') {
              if (pending.length) throw new Error('Unused install-parent row.');
              return;
            }
            if (value[0] !== 'install') return;
            const op = store.codec.schemas.rows.install.parse(value);
            for (const parent of pending)
              if (!op[2].startsWith(parent.path + '/'))
                throw new Error('Parent row does not guard the following operation.');
            for (const parent of pending.splice(0)) parent.release();
            await ancestors(op[2]);
            const sourcePartition =
              op[3] === null
                ? -1
                : frozen.inputs.findIndex((i) => op[3] === i.nativeRoot + '/' + op[2]);
            let p = -1;
            if (op[3] !== null) {
              if (sourcePartition < 0)
                throw new Error('Source escapes selected disposable staging.');
              const input = frozen.inputs[sourcePartition];
              p = store.codec.options.model.partitions.findIndex((v) => v[0] === input.partition);
              let rootNative: NativeIdentity;
              const member = await result.sourceDirectories[p]!.member(op[2]);
              if (!member) throw new Error('Missing selected source member.');
              try {
                const node = member.node;
                const binding = frozen.metadata.parse(op[4]!, 'source', input.partition);
                const selected = await indexedNode(scratch, binding[4]);
                try {
                  equal(selected.node, node, 'selected metadata source node');
                } finally {
                  selected.release();
                }
                if (node[1] !== 'file' && node[1] !== 'directory')
                  throw new Error('Unsupported source member.');
                result.kind = node[1];
                rootNative = node[3] as NativeIdentity;
                admittedSource = rootNative;
              } finally {
                member.release();
              }
              const native = await direct(op[3]);
              if (!native || !rootNative || !sameNative(native, rootNative, true))
                throw new Error('Selected source root changed.');
            }
            let oldNative: NativeIdentity | null = null;
            if (op[5] !== null) {
              let oldKind: 'file' | 'directory';
              const binding = frozen.metadata.parse(op[5], 'current');
              const part = store.codec.options.model.partitions.findIndex(
                (v) => v[0] === binding[3],
              );
              if (part < 0 || (p >= 0 && p !== part))
                throw new Error('Mixed metadata preimage partition.');
              const node = await frozen.metadata.reader(op[5]).rootNode(op[5], op[2], null);
              oldKind = node[1] as 'file' | 'directory';
              oldNative = node[3] as NativeIdentity;
              if (op[3] === null) result.kind = oldKind;
            }
            admittedOld = oldNative;
            if (op[7] !== null && op[7] !== store.prefix + 'backups/' + String(op[1]))
              throw new Error('Backup namespace/index mismatch.');
            if (op[7] !== null && (await store.root.stat(op[7])))
              throw new Error('Expected absent install backup.');
            await maven(op[2], result.kind);
            const actual = await direct(op[2]);
            if (op[6] === 'insert') {
              if (actual !== null) throw new Error('Unexpected insert target.');
            } else if (!actual || !oldNative || !sameNative(actual, oldNative, true))
              throw new Error('Frozen preimage root changed.');
          },
        ))
          await result.operations.append([
            'admitted-row',
            row.value,
            admittedSource,
            admittedOld,
            row.start,
            row.end,
            row.record,
          ]);
        while (parentStack.length) await leaveParent();
      } finally {
        for (const frame of parentStack.splice(0)) frame.release();
        for (const parent of pending) parent.release();
      }
      if (!canonical((await store.state())!).equals(canonical(state)))
        throw new Error('Install state changed during admission.');
      signal.throwIfAborted();
      return result;
    } catch (error) {
      await result.close();
      throw error;
    }
  }
  async close() {
    admitted.delete(this);
    this.frozen.metadata.close();
    this.directories?.close();
    for (const directory of this.sourceDirectories) directory?.close();
    const closed = await Promise.allSettled([this.scratch?.close(), this.operations?.close()]);
    const disposed = await Promise.allSettled([
      retireOwnedDirectory(
        this.frozen.store,
        this.parents.prefix.slice(0, -1),
        this.namespaceNative,
        this.budget,
      ),
    ]);
    closed.push(...disposed);
    const failures = closed.filter((v): v is PromiseRejectedResult => v.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((v) => v.reason),
        'Admission reader cleanup failed.',
      );
  }
}
