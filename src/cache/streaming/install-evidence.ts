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

import { withAbort } from './abort';
import { encodeRecord, equal, type Value } from './encoding';
import { sameNative, type NativeIdentity } from './native';
import { walkNative, type WalkOptions } from './native-walk';
import type { OwnedStore, Reference } from './owned-store';
import { EvidenceFile } from './evidence-file';
import type { LocalRow } from './local-stream';

/** Advance framing without ever buffering a catalogue. All returned rows remain provisional. */
export async function nextEvidence(rows: AsyncIterator<LocalRow>): Promise<Value | null> {
  while (true) {
    const next = await rows.next();
    if (next.done) return null;
    const value = next.value.value;
    if (Array.isArray(value) && value[0] !== 'local-stream' && value[0] !== 'local-end')
      return value;
  }
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#native-identity-and-evidence.
// Byte hashes come from upstream worker verification or pinned trusted base metadata.
// This join proves native membership and stability; it deliberately does not hash bodies again.
export async function openVerifiedNativeEvidence(
  store: OwnedStore,
  evidence: Reference,
  nativeRoot: string,
  partition: string,
  options: Omit<WalkOptions, 'logicalRoot' | 'prune' | 'metadata' | 'inspectChild'>,
  observedRow?: (row: LocalRow) => Promise<void>,
): Promise<EvidenceFile> {
  store.codec.schemas.owned.parse(nativeRoot);
  store.codec.schemas.partition.parse(partition);
  const actual = walkNative(store.root, nativeRoot, {
    ...options,
    logicalRoot: '',
    metadata: 'reject',
  });
  async function next() {
    let row = await actual.next();
    while (!row.done && row.value.tag === 'directory-close') row = await actual.next();
    return row;
  }
  try {
    return await EvidenceFile.open(
      store,
      evidence,
      partition,
      options.budget,
      options.signal,
      async (record) => {
        if (observedRow) await observedRow(record);
        const value = record.value as readonly Value[];
        if (value[0] === 'local-stream') return;
        const observed = await next();
        if (value[0] === 'local-end') {
          if (!observed.done) throw new Error('Trailing native member.');
          return;
        }
        if (observed.done || observed.value.tag === 'protected-child')
          throw new Error('Native evidence membership mismatch.');
        const event = observed.value;
        if (
          event.identity[3] !== store.root.binding[3] ||
          (event.tag === 'file' && event.links !== '1')
        )
          throw new Error('Aliased/cross-filesystem disposable source.');
        if (value[0] !== (event.tag === 'file' ? 'file' : 'directory') || value[1] !== event.path)
          throw new Error('Native evidence membership mismatch.');
        if (!sameNative(value[2] as NativeIdentity, event.identity, true))
          throw new Error('Native evidence identity mismatch.');
      },
      options.maxDirectoryEntries,
    );
  } finally {
    await actual.return(undefined);
  }
}
export async function verifyNativeEvidence(
  store: OwnedStore,
  evidence: Reference,
  nativeRoot: string,
  partition: string,
  options: Omit<WalkOptions, 'logicalRoot' | 'prune' | 'metadata' | 'inspectChild'>,
): Promise<void> {
  const reader = await openVerifiedNativeEvidence(store, evidence, nativeRoot, partition, options);
  await reader.close();
}

/** Exact, process-local upstream completion binding; not a persisted validation flag. */
export type IncomingVerification = readonly [
  'incoming-verification',
  1,
  string,
  string,
  string,
  Value,
  'worker' | 'trusted-base',
  string,
  string,
  Reference,
];
/**
 * Process-local receipt. Producers apply selected portable mode/mtime and seal the
 * resulting full native identities BEFORE verify; the installer performs no repair.
 * Reopening serialized metadata cannot reconstruct this capability.
 */
export class VerifiedIncoming {
  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly nativeRoot: string,
    readonly evidence: Reference,
    readonly origin: 'worker' | 'trusted-base',
  ) {}
  static async verify(
    store: OwnedStore,
    input: {
      readonly partition: string;
      readonly nativeRoot: string;
      readonly evidence: Reference;
      readonly origin: 'worker' | 'trusted-base';
      /** Finishes ALL upstream archive/object validation; failure grants no native capability. */
      readonly finishVerification: (
        binding: IncomingVerification,
        signal: AbortSignal,
      ) => Promise<IncomingVerification>;
    },
    options: Omit<WalkOptions, 'logicalRoot' | 'prune' | 'metadata' | 'inspectChild'>,
  ): Promise<VerifiedIncoming> {
    const partition = store.codec.schemas.partition.parse(input.partition);
    // Disposable install copies have a separate namespace from retained snapshots/objects.
    const nativeRoot = store.codec.schemas.owned.parse(input.nativeRoot);
    if (nativeRoot !== store.prefix + 'install/' + partition)
      throw new Error('Incoming root is not disposable install staging.');
    const evidence = Object.freeze(
      store.codec.schemas.ref('native-evidence').parse(input.evidence),
    ) as Reference;
    const origin = input.origin;
    if (origin !== 'worker' && origin !== 'trusted-base')
      throw new Error('Unknown incoming provenance.');
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const o = store.codec.options;
    const binding: IncomingVerification = Object.freeze([
      'incoming-verification',
      1,
      o.invocation,
      o.model.id,
      o.model.family,
      Object.freeze([...o.context]),
      origin,
      partition,
      nativeRoot,
      evidence,
    ]);
    const expected = encodeRecord(binding);
    const completed = await withAbort(input.finishVerification(binding, signal), signal);
    if (!encodeRecord(completed).equals(expected))
      throw new Error('Upstream verification binding mismatch.');
    signal.throwIfAborted();
    await verifyNativeEvidence(store, evidence, nativeRoot, partition, options);
    return new VerifiedIncoming(
      store,
      partition,
      nativeRoot,
      Object.freeze(evidence) as Reference,
      origin,
    );
  }
  assertBound(store: OwnedStore, partition: string, reference: Value, nativeRoot: string): void {
    if (this.store !== store || partition !== this.partition || nativeRoot !== this.nativeRoot)
      throw new Error('Incoming receipt belongs to another operation/root.');
    equal(this.evidence, reference, 'incoming evidence receipt');
  }
}
