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

import { z } from 'zod';
import { InstallScratch } from './install-scratch';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { Digest, type Value } from './encoding';
import { pathSchema, uintSchema } from './schema';
import type { Membership, MembershipSpool } from './worker-state';

// Protocol: docs/dev/cache-protocol.md#usage-validation.
// Unpublished operation-local sequential metadata, never a mutable Q or recovery authority.
export class WorkerSpool {
  private readonly digest = new Digest('worker-spool');
  private sealed: string | null = null;
  private count = 0;
  private readers = 0;
  private ready?: Promise<void>;
  private disposed = false;
  private writing = false;
  private failed = false;
  private constructor(private readonly scratch: InstallScratch) {}
  static async create(store: OwnedStore, budget: WorkingBudget): Promise<WorkerSpool> {
    return new WorkerSpool(await InstallScratch.create(store, budget));
  }
  get work() {
    return this.scratch.work;
  }
  async append(value: Value, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.sealed !== null || this.disposed) throw new Error('Worker spool is sealed/disposed.');
    if (this.writing || this.failed) throw new Error('Worker spool is busy/failed.');
    this.writing = true;
    try {
      await this.scratch.append(value, undefined, (bytes) =>
        this.digest.encoded(bytes.subarray(0, -1)),
      );
      this.count++;
      signal.throwIfAborted();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.writing = false;
    }
  }

  seal(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.disposed || this.sealed !== null || this.writing || this.failed)
      throw new Error('Worker spool is unavailable.');
    this.sealed = this.digest.digest();
  }
  async *rows(signal: AbortSignal): AsyncGenerator<Value> {
    signal.throwIfAborted();
    if (this.disposed || this.sealed === null || this.failed)
      throw new Error('Unsealed worker spool.');
    this.readers++;
    const digest = new Digest('worker-spool');
    let count = 0;
    try {
      if (this.ready) {
        await this.ready;
        await this.scratch.assertStable();
      } else {
        this.ready = this.scratch.flush();
        await this.ready;
      }
      signal.throwIfAborted();
      for await (const row of this.scratch.rows(0, this.scratch.position, (bytes) =>
        digest.encoded(bytes.subarray(0, -1)),
      )) {
        signal.throwIfAborted();
        count++;
        yield row;
      }
      signal.throwIfAborted();
      await this.scratch.assertStable();
      if (count !== this.count || digest.digest() !== this.sealed)
        throw new Error('Changed worker spool.');
    } finally {
      this.readers--;
      if (!this.readers) this.scratch.releaseReadCache();
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.readers || this.writing) throw new Error('Cannot dispose active worker spool.');
    await this.scratch.close();
    this.disposed = true;
  }
}
const memberSchema = z.tuple([z.literal('member'), z.enum(['file', 'unit']), pathSchema]);
export class DiskMembership implements MembershipSpool {
  private constructor(
    private readonly store: OwnedStore,
    private readonly budget: WorkingBudget,
    private readonly spool: WorkerSpool,
  ) {}
  static async create(store: OwnedStore, budget: WorkingBudget): Promise<DiskMembership> {
    return new DiskMembership(store, budget, await WorkerSpool.create(store, budget));
  }
  async append(member: Membership, signal: AbortSignal): Promise<void> {
    await this.spool.append(memberSchema.parse(member), signal);
  }
  async seal(signal: AbortSignal): Promise<() => AsyncIterable<Value>> {
    this.spool.seal(signal);
    return () => this.spool.rows(signal);
  }
  async fork(channel: number, signal: AbortSignal): Promise<MembershipSpool> {
    signal.throwIfAborted();
    uintSchema.parse(channel);
    const fork = await DiskMembership.create(this.store, this.budget);
    if (signal.aborted) {
      await fork.dispose();
      signal.throwIfAborted();
    }
    return fork;
  }
  async dispose(): Promise<void> {
    await this.spool.dispose();
  }
}
