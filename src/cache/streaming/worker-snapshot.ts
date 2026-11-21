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
import { encodeRecord, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { verifyNativeEvidence } from './install-evidence';
// Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
const receipts = new WeakSet<object>();
/** Process-local native-base/retained-snapshot authority; serialized fields alone cannot grant it. */
export class PreparedWorkerSnapshot {
  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly nativeRoot: string,
    readonly evidence: Reference,
    readonly provenance: string,
    readonly origin: 'baseline' | 'worker-writer',
    private readonly budget: WorkingBudget,
    private readonly max: number,
  ) {
    Object.freeze(this);
  }
  static async verify(
    store: OwnedStore,
    input: {
      readonly partition: string;
      readonly nativeRoot: string;
      readonly evidence: Reference;
      readonly provenance: string;
      readonly origin?: 'baseline' | 'worker-writer';
      readonly finishVerification: (binding: Value, signal: AbortSignal) => Promise<Value>;
    },
    budget: WorkingBudget,
    options: { readonly signal?: AbortSignal; readonly maxDirectoryEntries?: number } = {},
  ): Promise<PreparedWorkerSnapshot> {
    const signal = options.signal ?? new AbortController().signal,
      max = options.maxDirectoryEntries ?? 100000;
    const source = store.codec.schemas.source.parse([
      input.partition,
      input.origin ?? 'baseline',
      [input.origin ?? 'baseline', input.provenance],
      input.evidence,
      input.nativeRoot,
    ]);
    const evidence = Object.freeze(source[3]) as Reference,
      partition = source[0],
      nativeRoot = source[4],
      provenance = source[2][1],
      origin = source[1] as 'baseline' | 'worker-writer',
      finish = input.finishVerification;
    const o = store.codec.options,
      binding: Value = Object.freeze([
        'snapshot-verification',
        1,
        o.invocation,
        o.model.id,
        o.model.family,
        Object.freeze([...o.context]),
        Object.freeze([
          partition,
          origin,
          Object.freeze([origin, provenance]),
          evidence,
          nativeRoot,
        ]),
      ]);
    const expected = encodeRecord(binding);
    signal.throwIfAborted();
    const result = await withAbort(finish(binding, signal), signal);
    if (!expected.equals(encodeRecord(result)))
      throw new Error('Prepared snapshot verification binding changed.');
    const receipt = new PreparedWorkerSnapshot(
      store,
      partition,
      nativeRoot,
      evidence,
      provenance,
      origin,
      budget,
      max,
    );
    await verifyNativeEvidence(store, evidence, nativeRoot, partition, {
      budget,
      signal,
      maxDirectoryEntries: max,
    });
    signal.throwIfAborted();
    receipts.add(receipt);
    return receipt;
  }
  static assertReceipt(
    receipt: PreparedWorkerSnapshot,
    store: OwnedStore,
    partition: string,
  ): void {
    if (!receipts.has(receipt) || receipt.store !== store || receipt.partition !== partition)
      throw new Error('Unbound prepared worker snapshot.');
  }
  assertBound(store: OwnedStore, partition: string): void {
    if (!receipts.has(this) || this.store !== store || this.partition !== partition)
      throw new Error('Unbound prepared worker snapshot.');
  }
  async verify(
    signal: AbortSignal,
    budget = this.budget,
    maxDirectoryEntries = this.max,
  ): Promise<void> {
    this.assertBound(this.store, this.partition);
    await verifyNativeEvidence(this.store, this.evidence, this.nativeRoot, this.partition, {
      budget,
      signal,
      maxDirectoryEntries,
    });
    signal.throwIfAborted();
  }
  source(): Value {
    return [
      this.partition,
      this.origin,
      [this.origin, this.provenance],
      this.evidence,
      this.nativeRoot,
    ];
  }
}
