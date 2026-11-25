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

import type { TimingOptions } from '../../util/timing';
import { timed } from '../../util/timing';
import { opendir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  ArtifactLookupScope,
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from '../../delta/backend';
import type { OwnedStore, Reference } from './owned-store';
import { nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import { retireOwnedDirectory } from './owned-retirement';
import { abortableValues } from './abort';
import { add, type Value } from './encoding';
import { contextSchema, type Context } from './schema';
import {
  rawWorkerBackend,
  workerSnapshotAuthorization,
  workerScope,
  workerDescriptor,
  workerDigest,
  workerArtifactPrefix,
  workerArtifactAttempt,
} from './worker-artifact-identity';
import type { WorkerMergeInput } from './worker-merge';
export interface SelectedWorkerArtifact {
  readonly artifact: WorkflowArtifactDescriptor;
  readonly context: Context;
  readonly authorizedSnapshots: readonly string[];
}

// Protocol: docs/dev/cache-protocol.md#worker-transport.
// SDK transport/download hashing is distinct from the SINGLE later TAR/gzip parse.
// This immutable Q binds a raw downloaded file in place; no compressed payload copy.
export class DownloadedWorkerArchive {
  private readonly lifecycle = { disposed: false, retired: false, streams: new Set<Readable>() };

  private constructor(
    readonly store: OwnedStore,
    readonly artifact: Readonly<WorkflowArtifactDescriptor>,
    readonly context: Context,
    readonly authorizedSnapshots: readonly string[],
    readonly reference: Reference,
    private readonly identity: NativeIdentity,
    private readonly container: string,
    private readonly owner: NativeIdentity,
  ) {
    Object.freeze(this);
  }

  static async download(
    store: OwnedStore,
    backend: WorkflowArtifactBackend,
    input: SelectedWorkerArtifact,
    options: {
      readonly timing?: TimingOptions['timing'];
      readonly scope?: ArtifactLookupScope;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<DownloadedWorkerArchive> {
    const context = Object.freeze(contextSchema.parse(input.context)) as Context,
      artifact = workerDescriptor(input.artifact),
      authorized = workerSnapshotAuthorization(
        store.codec.options.model,
        context[4],
        input.authorizedSnapshots,
      ),
      scope = workerScope(options.scope, context),
      signal = options.signal ?? new AbortController().signal;
    rawWorkerBackend(backend, scope);
    signal.throwIfAborted();
    if (
      workerArtifactAttempt(
        artifact.name,
        workerArtifactPrefix(store.codec.options.model, context),
      ) !== context[5]
    ) {
      throw new Error('Raw worker artifact name differs from selected context.');
    }
    const container = store.prefix + 'worker/' + randomUUID(),
      directory = container + '/download';
    await store.makeParents(directory + '/placeholder');
    const owner = (await store.root.stat(container))!,
      downloadRoot = (await store.root.stat(directory))!;
    try {
      signal.throwIfAborted();
      // Backend API has no cancellation hook. Observe cancellation AFTER it settles,
      // before cleanup, so the SDK never writes into an already-retired directory.
      const result = await timed(
        options,
        `incoming worker SDK restore [worker=${context[4]}]`,
        () =>
          backend.downloadArtifact(artifact.id, {
            path: store.root.resolve(directory),
            expectedHash: artifact.digest ?? undefined,
            scope,
            skipDecompress: true,
          }),
        (result) => (result.digestMismatch ? 'failed' : 'success'),
      );
      signal.throwIfAborted();
      const relative = path.relative(
        store.root.resolve(directory),
        path.resolve(result.downloadPath),
      );
      if (
        result.digestMismatch ||
        relative === '..' ||
        relative.startsWith('..' + path.sep) ||
        path.isAbsolute(relative)
      ) {
        throw new Error('Unsafe raw worker download result/digest.');
      }
      const afterContainer = await store.root.stat(container),
        afterRoot = await store.root.stat(directory);
      if (
        !afterContainer ||
        !afterRoot ||
        !sameObject(owner, afterContainer) ||
        owner[6] !== afterContainer[6] ||
        !sameObject(downloadRoot, afterRoot) ||
        downloadRoot[6] !== afterRoot[6]
      ) {
        throw new Error('Raw worker download namespace changed.');
      }
      let file: string | undefined;
      for await (const entry of await opendir(store.root.resolve(directory), { bufferSize: 2 })) {
        if (file || !entry.isFile()) {
          throw new Error('Raw worker download requires exactly one regular file.');
        }
        file = directory + '/' + entry.name;
      }
      if (!file) {
        throw new Error('Raw worker archive is missing.');
      }
      await store.root.parents(file);
      store.root.work.stats++;
      const raw = await lstat(store.root.resolve(file), { bigint: true }),
        before = nativeIdentity(raw);
      if (
        raw.nlink !== 1n ||
        before[2] !== 'file' ||
        before[3] !== store.root.binding[3] ||
        BigInt(artifact.size) !== raw.size
      ) {
        throw new Error('Raw worker file is aliased or has unexpected identity/size.');
      }
      store.root.work.opens++;
      const handle = await open(
          store.root.resolve(file),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        ),
        hash = createHash('sha256');
      let bytes = 0,
        identity: NativeIdentity;
      try {
        store.root.work.stats++;
        const opened = await handle.stat({ bigint: true });
        if (opened.nlink !== 1n || !sameNative(before, nativeIdentity(opened), true)) {
          throw new Error('Raw worker file changed on open.');
        }
        for await (const chunk of abortableValues(
          handle.createReadStream({ autoClose: false, highWaterMark: 65536 }),
          signal,
        )) {
          hash.update(chunk);
          bytes = add(bytes, chunk.length);
          store.root.work.readBytes = add(store.root.work.readBytes, chunk.length);
        }
        store.root.work.stats++;
        const after = await handle.stat({ bigint: true });
        identity = nativeIdentity(after);
        if (after.nlink !== 1n || !sameNative(before, identity, true) || bytes !== artifact.size) {
          throw new Error('Raw worker file changed during binding.');
        }
      } finally {
        await handle.close();
      }
      const sha = hash.digest('hex'),
        reported = workerDigest(artifact.digest);
      if (reported !== null && reported !== sha) {
        throw new Error('Raw worker compressed SHA-256 differs from service digest.');
      }
      const named = await store.root.stat(file);
      if (!named || !sameNative(identity!, named, true)) {
        throw new Error('Raw worker file name changed.');
      }
      signal.throwIfAborted();
      const reference = Object.freeze(
        store.codec.schemas
          .ref('worker-archive')
          .parse(['ref', 'worker-archive', file, bytes, sha]),
      ) as Reference;
      return new DownloadedWorkerArchive(
        store,
        artifact,
        context,
        authorized,
        reference,
        Object.freeze(identity!) as NativeIdentity,
        container,
        owner,
      );
    } catch (error) {
      try {
        await retireOwnedDirectory(store, container, owner);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Raw worker download failed; cleanup blocked.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }

  async assertStable(): Promise<void> {
    if (this.lifecycle.disposed) {
      throw new Error('Downloaded worker archive retired.');
    }
    const actual = await this.store.root.stat(this.reference[2]);
    if (!actual || !sameNative(this.identity, actual, true)) {
      throw new Error('Downloaded worker archive changed.');
    }
  }

  open(): Readable {
    if (this.lifecycle.disposed || this.lifecycle.streams.size) {
      throw new Error('Downloaded worker archive is retired/already reading.');
    }
    const stream = Readable.from(
      async function* (this: DownloadedWorkerArchive) {
        await this.assertStable();
        yield* this.store.read(this.reference, 'worker-archive');
        await this.assertStable();
      }.call(this),
      { objectMode: false, highWaterMark: 65536 },
    );
    this.lifecycle.streams.add(stream);
    stream.on('error', () => {});
    stream.once('close', () => this.lifecycle.streams.delete(stream));
    return stream;
  }

  input(): WorkerMergeInput {
    return {
      job: this.context[4],
      context: this.context,
      source: this.open(),
      authorizedSnapshots: this.authorizedSnapshots,
      producerId: String(this.artifact.id),
    };
  }

  producer(): Value {
    return [
      'producer',
      [
        this.artifact.name,
        String(this.artifact.id),
        this.reference[4],
        this.context,
        this.reference,
      ],
    ];
  }

  /** Caller retires committed producer references first; never delete while a reader is retained. */
  async dispose(): Promise<void> {
    if (this.lifecycle.retired) {
      return;
    }
    this.lifecycle.disposed = true;
    await Promise.all(
      [...this.lifecycle.streams].map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              return resolve();
            }
            stream.once('close', resolve);
            stream.destroy();
          }),
      ),
    );
    await retireOwnedDirectory(this.store, this.container, this.owner);
    this.lifecycle.retired = true;
  }
}
