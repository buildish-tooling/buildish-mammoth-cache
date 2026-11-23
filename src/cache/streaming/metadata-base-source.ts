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
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { nativeBaseFile } from './base-layout';
import { add } from './encoding';
import {
  decodeMetadataDescriptor,
  assertMetadataModel,
  type MetadataDescriptor,
} from './metadata-base-records';
import { sameNative, sameObject, type NativeIdentity } from './native';
import { walkNative, type WalkOptions } from './native-walk';
import { objectRefSchema, type ObjectRef } from './native-records';
import type { OwnedStore } from './owned-store';
import {
  metadataSummaryProfile,
  PartitionMetadataSummary,
  pinnedPartitionMetadataSchema,
  type NativeMetadataRow,
  type PartitionMetadata,
  type MetadataSummaryProfile,
  type PinnedPartitionMetadata,
} from './partition-metadata';

// Staged layout only; existing publication/extraction paths still use the old wire.
export function metadataBaseObjectPaths(store: OwnedStore, root: string): string[] {
  store.codec.schemas.owned.parse(root);
  return [
    store.root.resolve(root + '/envelope.json'),
    store.root.resolve(root + '/payload') + path.sep,
  ];
}
export async function checkMetadataBaseLayout(
  store: OwnedStore,
  root: string,
): Promise<NativeIdentity> {
  store.codec.schemas.owned.parse(root);
  const before = await store.root.stat(root);
  if (!before || before[2] !== 'directory' || before[3] !== store.root.binding[3])
    throw new Error('Invalid metadata base root.');
  const wanted = new Set(['envelope.json', 'payload']);
  store.root.work.nativeListings++;
  for await (const entry of await opendir(store.root.resolve(root), { bufferSize: 4 })) {
    if (
      !wanted.delete(entry.name) ||
      (entry.name === 'payload' ? !entry.isDirectory() : !entry.isFile())
    )
      throw new Error('Unexpected metadata base member.');
  }
  const after = await store.root.stat(root);
  if (wanted.size || !after || !sameNative(before, after, true))
    throw new Error('Incomplete/changing metadata base layout.');
  return after;
}
const discoveries = new WeakSet<DiscoveredMetadataBase>();
export type MetadataDiscoveryOptions = TimingOptions &
  Pick<WalkOptions, 'budget' | 'maxDirectoryEntries' | 'signal'>;
/**
 * Genuine process-local completed native discovery, not content verification.
 * observe receives provisional metadata for the one active install/group hierarchy;
 * no rows or per-file catalogue are retained by this object or its handoff pin.
 */
export class DiscoveredMetadataBase {
  #active = true;
  private constructor(
    readonly store: OwnedStore,
    readonly nativeRoot: string,
    private readonly ref: ObjectRef,
    private readonly control: MetadataDescriptor,
    private readonly metadata: PartitionMetadata,
    private readonly profile: MetadataSummaryProfile,
    private readonly nativeIdentity: NativeIdentity,
    private readonly parentIdentity: NativeIdentity,
  ) {
    discoveries.add(this);
    Object.freeze(this);
  }
  get reference(): ObjectRef {
    return structuredClone(this.ref);
  }
  get descriptor(): MetadataDescriptor {
    return structuredClone(this.control);
  }
  get summary(): PartitionMetadata {
    return structuredClone(this.metadata);
  }
  get partition(): string {
    return this.ref[1][2];
  }
  static assertReceipt(source: DiscoveredMetadataBase, store = source.store): void {
    if (!discoveries.has(source) || !source.#active || source.store !== store)
      throw new Error('Metadata source is not an active discovery receipt.');
  }
  /** Successful initial materialization only. No caller-supplied identity or summary. */
  pin(): PinnedPartitionMetadata {
    DiscoveredMetadataBase.assertReceipt(this);
    const o = this.store.codec.options;
    return pinnedPartitionMetadataSchema.parse([
      'pinned-partition-metadata',
      2,
      'local-v2',
      o.invocation,
      o.model.family,
      o.model.id,
      this.partition,
      this.ref,
      this.profile,
      this.metadata,
    ]);
  }
  /** Selected root/parent guards only; the original completed discovery remains admission. */
  async assertNativeRoot(): Promise<void> {
    DiscoveredMetadataBase.assertReceipt(this);
    const native = await this.store.root.stat(this.nativeRoot),
      parent = await this.store.root.stat(
        this.nativeRoot.slice(0, this.nativeRoot.lastIndexOf('/')),
      );
    if (
      !native ||
      !parent ||
      !sameObject(this.nativeIdentity, native) ||
      !sameObject(this.parentIdentity, parent)
    )
      throw new Error('Metadata source root/parent changed.');
  }
  /** End the operation's authority; payload/scratch disposal stays with their existing owners. */
  close(): void {
    this.#active = false;
  }
  static async discover(
    store: OwnedStore,
    root: string,
    input: ObjectRef,
    options: MetadataDiscoveryOptions,
    observe: (row: NativeMetadataRow) => Promise<void>,
  ): Promise<DiscoveredMetadataBase> {
    const model = store.codec.options.model;
    assertMetadataModel(model);
    const ref = objectRefSchema.parse(input),
      signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const layout = await checkMetadataBaseLayout(store, root),
      envelope = root + '/envelope.json';
    const before = await nativeBaseFile(store, envelope, 65536);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of store.root.read(envelope, before)) {
      signal.throwIfAborted();
      bytes = add(bytes, chunk.length);
      if (bytes > 65536) throw new Error('Metadata descriptor exceeds admission.');
      chunks.push(chunk);
    }
    const descriptor = decodeMetadataDescriptor(Buffer.concat(chunks, bytes), ref, model);
    const profile = metadataSummaryProfile(),
      summary = new PartitionMetadataSummary(
        model,
        ref[1][2],
        options.budget,
        profile,
        options.maxDirectoryEntries,
      );
    const nativeRoot = root + '/payload';
    let payloadIdentity: NativeIdentity | undefined;
    try {
      for await (const event of walkNative(store.root, nativeRoot, {
        ...options,
        logicalRoot: '',
        metadata: 'reject',
      })) {
        if (event.tag === 'protected-child') throw new Error('Protected metadata base child.');
        if (
          event.identity[3] !== store.root.binding[3] ||
          (event.tag === 'file' && event.links !== '1')
        )
          throw new Error('Aliased/cross-filesystem metadata base source.');
        if (event.tag === 'directory-open' && event.path === '')
          payloadIdentity = structuredClone(event.identity);
        const row: NativeMetadataRow = [
          event.tag === 'file' ? 'file' : event.tag === 'directory-open' ? 'dir-open' : 'dir-close',
          event.path,
          event.identity,
        ];
        summary.accept(row);
        // Observers may spool/reuse their input; they cannot rewrite the walker's identities.
        await observe(structuredClone(row));
        signal.throwIfAborted();
      }
      const result = summary.finish();
      const controlAfter = await nativeBaseFile(store, envelope, 65536),
        layoutAfter = await store.root.stat(root);
      if (
        !sameNative(before, controlAfter, true) ||
        !layoutAfter ||
        !sameNative(layout, layoutAfter, true)
      )
        throw new Error('Metadata base control/layout changed.');
      signal.throwIfAborted();
      if (!payloadIdentity) throw new Error('Missing discovered native root.');
      return new DiscoveredMetadataBase(
        store,
        nativeRoot,
        ref,
        descriptor,
        result,
        profile,
        payloadIdentity,
        layout,
      );
    } finally {
      summary.dispose();
    }
  }
}
