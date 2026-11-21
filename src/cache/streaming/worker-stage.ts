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

import { mkdir, open, lstat, chmod, utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { add, encodeRecord, tuple } from './encoding';
import { nativeIdentity, sameNative, sameObject, sameRename, type NativeIdentity } from './native';
import type { OwnedStore } from './owned-store';
import { retireOwnedDirectory } from './owned-retirement';
import { joinPath, parentPath, type WorkingBudget } from './tree-state';
import { WorkerSpool } from './worker-spool';
import type { WorkerFile } from './worker-codec';

interface Frame {
  path: string;
  directories: Map<string, { identity: NativeIdentity; release: () => void }>;
  release: () => void;
}
export interface StagedPartition {
  readonly partition: string;
  readonly nativeRoot: string;
  readonly facts: WorkerSpool;
  readonly directories: WorkerSpool;
  readonly rootNative?: NativeIdentity;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence.
// Private worker candidate only. V2 acceptance moves complete partition roots into
// exact install/<partition> before sealing evidence; this class never installs live data.
export class WorkerStage {
  readonly work = { bodyBytes: 0, files: 0, metadataRepairs: 0, directories: 0 };
  private readonly frames: Frame[] = [];
  private readonly partitions = new Map<string, StagedPartition>();
  private readonly spools = new Set<WorkerSpool>();
  private readonly moves = new Map<
    string,
    { source: string; target: string; expected: NativeIdentity }
  >();
  private readonly roots = new Map<string, { identity: NativeIdentity; release: () => void }>();
  private sealed = false;
  private adopted = false;
  private disposed = false;
  private retired = false;
  private constructor(
    readonly store: OwnedStore,
    readonly budget: WorkingBudget,
    readonly path: string,
    private readonly identity: NativeIdentity,
  ) {}
  static async create(store: OwnedStore, budget: WorkingBudget): Promise<WorkerStage> {
    const name = store.prefix + 'worker/' + randomUUID();
    await store.makeParents(name + '/payload');
    const identity = await store.root.stat(name);
    if (!identity) throw new Error('Missing worker candidate.');
    return new WorkerStage(store, budget, name, identity);
  }
  enter(path: string): void {
    if (this.disposed || this.sealed) throw new Error('Disposed/sealed worker stage.');
    const parent = this.frames[this.frames.length - 1];
    if (parent ? parentPath(path) !== parent.path : path !== '')
      throw new Error('Unbalanced worker stage.');
    this.frames.push({
      path,
      directories: new Map(),
      release: this.budget.holdRecord(512 + Buffer.byteLength(path)),
    });
  }
  private async stat(name: string): Promise<NativeIdentity> {
    this.store.root.work.stats++;
    return nativeIdentity(await lstat(this.store.root.resolve(name), { bigint: true }));
  }
  hasPartition(partition: string): boolean {
    return this.partitions.has(partition);
  }
  async ensure(partition: string, signal: AbortSignal): Promise<StagedPartition> {
    signal.throwIfAborted();
    if (this.disposed || this.sealed) throw new Error('Disposed/sealed worker stage.');
    this.store.codec.schemas.partition.parse(partition);
    let part = this.partitions.get(partition);
    if (!part) {
      const facts = await WorkerSpool.create(this.store, this.budget);
      this.spools.add(facts);
      let directories: WorkerSpool;
      try {
        directories = await WorkerSpool.create(this.store, this.budget);
        this.spools.add(directories);
      } catch (error) {
        await facts.dispose();
        throw error;
      }
      part = { partition, nativeRoot: this.path + '/' + partition, facts, directories };
      this.partitions.set(partition, part);
    }
    for (const f of this.frames)
      if (!f.directories.has(partition)) {
        const name = f.path ? joinPath(part.nativeRoot, f.path) : part.nativeRoot;
        await mkdir(this.store.root.resolve(name));
        const identity = await this.stat(name);
        if (identity[3] !== this.store.root.binding[3])
          throw new Error('Cross-filesystem worker staging.');
        f.directories.set(partition, {
          identity,
          release: this.budget.holdRecord(encodeRecord(['directory', f.path, identity]).length),
        });
        this.work.directories++;
      }
    return part;
  }
  async write(
    file: WorkerFile,
    signal: AbortSignal,
  ): Promise<{
    finish: (sha: string, size: number, mode: number, mtimeMs: number) => Promise<void>;
    close: () => Promise<void>;
  }> {
    const part = await this.ensure(file.partition, signal),
      name = joinPath(part.nativeRoot, file.path);
    this.store.root.work.opens++;
    const handle = await open(
      this.store.root.resolve(name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let closed = false;
    const close = async () => {
      if (!closed) {
        await handle.close();
        closed = true;
      }
    };
    try {
      for await (const b of file.body) {
        signal.throwIfAborted();
        await handle.writeFile(b);
        this.work.bodyBytes = add(this.work.bodyBytes, b.length);
        this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, b.length);
      }
      this.store.root.work.stats++;
      const written = nativeIdentity(await handle.stat({ bigint: true }));
      if (
        written[2] !== 'file' ||
        written[3] !== this.store.root.binding[3] ||
        BigInt(written[5]) !== BigInt(file.header.size)
      )
        throw new Error('Invalid staged body identity/length.');
      return {
        close,
        finish: async (sha, size, mode, mtimeMs) => {
          signal.throwIfAborted();
          this.store.root.work.stats++;
          const before = await this.stat(name);
          if (
            !sameNative(written, before, true) ||
            !sameNative(written, nativeIdentity(await handle.stat({ bigint: true })), true)
          )
            throw new Error('Staged body changed before metadata repair.');
          await handle.chmod(mode);
          await handle.utimes(mtimeMs / 1000, mtimeMs / 1000);
          this.work.metadataRepairs++;
          await handle.sync();
          this.store.root.work.fileSyncs++;
          this.store.root.work.stats++;
          const native = nativeIdentity(await handle.stat({ bigint: true }));
          if (!sameNative(native, await this.stat(name), true))
            throw new Error('Staged body changed during metadata repair.');
          await close();
          await part.facts.append(
            ['file', file.path, file.partition, native, sha, size, mode, mtimeMs],
            signal,
          );
          this.work.files++;
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  async leave(path: string, signal: AbortSignal): Promise<void> {
    const f = this.frames[this.frames.length - 1];
    if (!f || f.path !== path) throw new Error('Unbalanced worker stage close.');
    for (const [partition, binding] of f.directories) {
      const expected = binding.identity;
      signal.throwIfAborted();
      const part = this.partitions.get(partition)!,
        name = path ? joinPath(part.nativeRoot, path) : part.nativeRoot,
        before = await this.stat(name);
      if (!sameObject(expected, before) || expected[6] !== before[6])
        throw new Error('Worker stage directory changed.');
      await chmod(this.store.root.resolve(name), 0o755);
      await utimes(this.store.root.resolve(name), 0, 0);
      await this.store.root.syncDirectory(name);
      const final = await this.stat(name);
      if (!sameObject(expected, final))
        throw new Error('Worker directory replaced during metadata repair.');
      await part.directories.append(['directory', path, final], signal);
      if (path === '') {
        if (this.roots.has(partition)) throw new Error('Repeated staged partition root.');
        this.roots.set(partition, {
          identity: Object.freeze(final) as NativeIdentity,
          release: this.budget.holdRecord(512),
        });
      }
    }
    this.frames.pop()!.release();
    for (const binding of f.directories.values()) binding.release();
  }
  async seal(signal: AbortSignal): Promise<readonly StagedPartition[]> {
    signal.throwIfAborted();
    if (this.frames.length || this.disposed || this.sealed)
      throw new Error('Unfinished worker staging.');
    for (const p of this.partitions.values()) {
      p.facts.seal(signal);
      p.directories.seal(signal);
    }
    for (const [id, part] of this.partitions) {
      const root = this.roots.get(id);
      if (!root) throw new Error('Missing sealed partition root.');
      this.partitions.set(id, Object.freeze({ ...part, rootNative: root.identity }));
    }
    this.sealed = true;
    return Object.freeze([...this.partitions.values()]);
  }
  /** Move private selected roots, never referenced Q paths or live cache trees. */
  async publish(
    kind: 'install' | 'snapshot',
    signal: AbortSignal,
  ): Promise<readonly StagedPartition[]> {
    if (this.disposed || !this.sealed || this.adopted || this.frames.length || this.moves.size)
      throw new Error('Worker stage publication unavailable.');
    // Caller holds the invocation prepare window after one recover/intents preflight.
    const retained =
      kind === 'snapshot'
        ? this.store.prefix + 'snapshots/' + randomUUID() + '/'
        : this.store.prefix + 'install/';
    for (const [partition, part] of this.partitions) {
      signal.throwIfAborted();
      const target = retained + partition,
        expected = this.roots.get(partition)!.identity;
      if (!sameNative(expected, await this.stat(part.nativeRoot), true))
        throw new Error('Selected worker root changed before publication.');
      await this.store.makeParents(target);
      this.moves.set(partition, { source: part.nativeRoot, target, expected });
      await this.store.root.renameAbsent(part.nativeRoot, target, expected);
      await this.store.root.syncDirectory(this.path);
      await this.store.root.syncDirectory(target.slice(0, target.lastIndexOf('/')));
      this.partitions.set(partition, Object.freeze({ ...part, nativeRoot: target }));
    }
    signal.throwIfAborted();
    return Object.freeze([...this.partitions.values()]);
  }
  adopt(): void {
    if (this.disposed) throw new Error('Disposed worker stage.');
    this.adopted = true;
  }
  private async rollback(): Promise<void> {
    if (this.adopted || !this.moves.size) return;
    const state = await this.store.state();
    if (
      (await this.store.readFixed(this.store.prefix + 'install-intent.json')) ||
      (state && tuple(state)[11] !== null)
    )
      throw new Error('Install still owns published worker sources.');
    for (const [partition, move] of [...this.moves].reverse()) {
      const source = await this.store.root.stat(move.source),
        target = await this.store.root.stat(move.target);
      if (source && sameNative(move.expected, source, true)) {
        this.moves.delete(partition);
        continue;
      }
      if (source && target) throw new Error('Ambiguous worker source publication.');
      if (target) {
        if (!sameRename(move.expected, target)) throw new Error('Published worker source changed.');
        await this.store.root.renameAbsent(move.target, move.source, target);
      } else if (!source || !sameRename(move.expected, source))
        throw new Error('Worker source publication lost.');
      await this.store.root.syncDirectory(this.path);
      await this.store.root.syncDirectory(move.target.slice(0, move.target.lastIndexOf('/')));
      const part = this.partitions.get(partition)!;
      this.partitions.set(partition, Object.freeze({ ...part, nativeRoot: move.source }));
      this.moves.delete(partition);
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    while (this.frames.length) {
      const f = this.frames.pop()!;
      for (const binding of f.directories.values()) binding.release();
      f.release();
    }
    for (const root of this.roots.values()) root.release();
    const results = await Promise.allSettled([...this.spools].map((spool) => spool.dispose()));
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    try {
      await this.rollback();
      if (!this.retired)
        await retireOwnedDirectory(
          this.store,
          this.path,
          this.identity,
          this.budget,
          'worker-candidate-retired',
        );
      this.retired = true;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Worker candidate cleanup failed.');
    this.disposed = true;
  }
}
