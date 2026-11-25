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

import { unlink } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import type { OwnedStore, Reference } from './owned-store';
import { nativeIdentity, sameNative, type NativeIdentity } from './native';
import { WorkerSources, type WorkerSourceView } from './worker-walk';
import { DiskMembership } from './worker-spool';
import { writeWorkerArchive, type WorkerWriteWork } from './worker-codec';
import type { WorkerSummary } from './worker-state';
import type { WorkingBudget } from './tree-state';
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      freeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
const genuine = new WeakSet<object>();
// Protocol: docs/dev/cache-protocol.md#worker-transport and docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
// Completed immutable bytes, stable basename and native identity authorize one upload.
// No serialized package pointer grants retry or cleanup authority.
export class FrozenWorkerArchive {
  #upload: 'fresh' | 'active' | 'confirmed' | 'unconfirmed' | 'retired' = 'fresh';

  claimUpload(): void {
    if (this.#upload !== 'fresh') {
      throw new Error('Worker package upload already attempted.');
    }
    this.#upload = 'active';
  }

  settleUpload(confirmed: boolean): void {
    if (this.#upload !== 'active') {
      throw new Error('Worker upload is not active.');
    }
    this.#upload = confirmed ? 'confirmed' : 'unconfirmed';
  }

  async retireUploaded(): Promise<void> {
    if (this.#upload !== 'confirmed') {
      throw new Error('Worker package has no settled direct confirmation.');
    }
    const current = await this.store.root.stat(this.reference[2]);
    if (!current || !sameNative(this.native, current, true)) {
      throw new Error('Worker package replaced; retained at ' + this.file);
    }
    await unlink(this.file);
    this.store.root.work.unlinks++;
    this.store.root.work.cleanupFiles++;
    this.#upload = 'retired';
  }

  private constructor(
    readonly store: OwnedStore,
    readonly reference: Reference,
    readonly name: string,
    readonly summary: WorkerSummary,
    readonly work: Readonly<WorkerWriteWork>,
    private readonly native: NativeIdentity,
  ) {
    genuine.add(this);
    Object.freeze(this);
  }

  get file(): string {
    return this.store.root.resolve(this.reference[2]);
  }

  get bytes(): number {
    return this.reference[3];
  }

  get sha(): string {
    return this.reference[4];
  }

  static async package(
    store: OwnedStore,
    view: WorkerSourceView,
    name: string,
    budget: WorkingBudget,
    options: { readonly signal?: AbortSignal; readonly maxDirectoryEntries?: number } = {},
  ): Promise<FrozenWorkerArchive> {
    // Validate/copy all scalar caller inputs before opening any source/candidate.
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,232}\.tar\.gz$/.test(name)) {
      throw new Error('Invalid raw worker artifact filename.');
    }
    options = Object.freeze({ ...options });
    const controller = new AbortController(),
      signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    signal.throwIfAborted();
    const sources = await WorkerSources.create(
      store,
      view,
      budget,
      signal,
      options.maxDirectoryEntries,
    );
    const stream = new PassThrough({ highWaterMark: 16384 }),
      work: WorkerWriteWork = { tarBytes: 0, controlMembers: 0, controlBodyBytes: 0 };
    let result: FrozenWorkerArchive | undefined;
    try {
      const membership = await DiskMembership.create(store, budget);
      const writer = writeWorkerArchive(
        stream,
        {
          model: store.codec.options.model,
          context: store.codec.options.context,
          authorizedSnapshots: sources.snapshots,
          budget,
          membership,
          snapshots: sources.snapshots,
          incompleteUsage: view.incompleteUsage,
          maxDirectoryEntries: options.maxDirectoryEntries,
          assertStable: (s) => sources.assertStable(s),
          work,
        },
        (s) => sources.events(s),
        signal,
      );
      const archive = store.writeNamedWorkerArchive(name, stream, signal);
      // Either failure must release the other's backpressure wait before joining it.
      const abort = (error: unknown) => {
        controller.abort(error);
        stream.destroy(error instanceof Error ? error : new Error('Worker package aborted.'));
      };
      void writer.catch(abort);
      void archive.catch(abort);
      const settled = await Promise.allSettled([writer, archive]);
      const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) {
        throw new AggregateError(
          failed.map((r) => r.reason),
          'Worker package did not freeze.',
        );
      }
      const summary = (settled[0] as PromiseFulfilledResult<WorkerSummary>).value,
        reference = (settled[1] as PromiseFulfilledResult<Reference>).value;
      if (path.posix.basename(reference[2]) !== name) {
        throw new Error('Raw worker artifact basename changed.');
      }
      const opened = await store.root.openRead(reference[2]);
      try {
        store.root.work.stats++;
        const current = await opened.handle.stat({ bigint: true });
        if (current.nlink !== 1n || !sameNative(opened.identity, nativeIdentity(current), true)) {
          throw new Error('Aliased/changed worker archive.');
        }
        result = new FrozenWorkerArchive(
          store,
          freeze([...reference]) as Reference,
          name,
          freeze(summary),
          freeze({ ...work }),
          freeze(opened.identity),
        );
      } finally {
        await opened.handle.close();
      }
    } finally {
      stream.destroy();
      await sources.dispose();
    }
    signal.throwIfAborted();
    if (!result) {
      throw new Error('Missing frozen worker archive.');
    }
    return result;
  }

  async assertStable(signal: AbortSignal): Promise<void> {
    if (!genuine.has(this)) {
      throw new Error('Unbound frozen worker archive.');
    }
    signal.throwIfAborted();
    const opened = await this.store.root.openRead(this.reference[2], this.native);
    try {
      this.store.root.work.stats++;
      const current = await opened.handle.stat({ bigint: true });
      if (current.nlink !== 1n || !sameNative(this.native, nativeIdentity(current), true)) {
        throw new Error('Frozen worker archive changed.');
      }
    } finally {
      await opened.handle.close();
    }
    signal.throwIfAborted();
  }

  open(): Readable {
    // Q length/hash validation is compressed-byte integrity, not another TAR pass.
    return Readable.from(
      async function* (this: FrozenWorkerArchive) {
        const signal = new AbortController().signal;
        await this.assertStable(signal);
        yield* this.store.read(this.reference, 'worker-archive');
        await this.assertStable(signal);
      }.call(this),
      {
        objectMode: false,
        highWaterMark: 65536,
      },
    );
  }
}
