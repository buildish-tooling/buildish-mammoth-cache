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

import { encodeRecord, equal, type Value } from './encoding';
import { LiveBaseInputs, type LivePartitionSource } from './live-base-inputs';
import { BaseSourceTree } from './base-source-tree';
import { writeNativeTree, readNativeTree } from './native-tree';
import {
  checkIdentity,
  objectKey,
  decodeEnvelope,
  type Envelope,
  type ObjectIdentity,
  type ObjectRef,
} from './native-records';
import { baseFileBytes, nativeBaseFile } from './base-layout';
import { baseEvidence } from './base-evidence';
import { writeBaseSourceMetadata, settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { sameNative, type NativeIdentity } from './native';
import { normalizeMode, parentPath } from './tree-state';
import type { OwnedStore, Reference } from './owned-store';

const genuine = new WeakSet<object>();
function immutable<T extends Value>(value: T): T {
  if (Array.isArray(value)) {
    for (const v of value) immutable(v);
    Object.freeze(value);
  }
  return value;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#moving-source-publication-handoff.
// This is canonical METADATA, never a ready SDK payload/native-object receipt.
export class FrozenBaseTree {
  private constructor(
    readonly store: OwnedStore,
    readonly reference: ObjectRef,
    readonly envelope: Envelope,
    readonly tree: Reference,
    readonly envelopeRef: Reference,
    private readonly metadata: readonly NativeIdentity[],
  ) {
    immutable(reference);
    immutable(envelope);
    immutable(tree);
    immutable(envelopeRef);
    genuine.add(this);
    Object.freeze(this);
  }
  get root() {
    return this.store.prefix + 'objects/' + this.reference[1][2];
  }
  get empty() {
    return this.envelope[7][0] === 0 && this.envelope[7][1] === 1;
  }
  static assert(tree: FrozenBaseTree, store = tree.store) {
    if (!genuine.has(tree) || tree.store !== store)
      throw new Error('Unbound frozen native metadata.');
  }
  async assertStable(options: BaseObjectOptions) {
    FrozenBaseTree.assert(this);
    for (const [i, q] of [this.envelopeRef, this.tree].entries()) {
      options.signal?.throwIfAborted();
      if (!sameNative(this.metadata[i], await nativeBaseFile(this.store, q[2]), true))
        throw new Error('Frozen native metadata changed.');
    }
    options.signal?.throwIfAborted();
  }
  static async render(
    input: LiveBaseInputs,
    partition: string,
    identity: ObjectIdentity,
  ): Promise<FrozenBaseTree> {
    LiveBaseInputs.assert(input);
    const { store, options } = input.view,
      signal = options.signal ?? new AbortController().signal,
      source = input.partitions.find((p) => p.partition === partition);
    if (!source) throw new Error('Missing frozen partition source.');
    identity = structuredClone(identity);
    checkIdentity(identity, store.codec.options.model, partition);
    const state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (state[4] !== 'gc-complete' || state[8] || state[9])
      throw new Error('Tree rendering requires a pre-publication source.');
    equal(state[6], input.view.observations, 'render original observations');
    equal(state[7], input.postSources, 'render committed post sources');
    const builder = await BaseSourceTree.create(store, partition, options),
      stack: { path: string; release: () => void }[] = [];
    let failure: unknown, result: FrozenBaseTree | undefined;
    const close = async () => {
      const f = stack.pop()!;
      try {
        await builder.close(f.path, signal);
      } finally {
        f.release();
      }
    };
    try {
      // Original-N/hash evidence stays bound through keyed encoding. NativeReadPhase
      // checks it without another body read; live mixed parents are projected.
      for await (const e of baseEvidence(
        store,
        source.nativeRoot,
        source.evidence,
        partition,
        options,
      )) {
        const parent = e.row[0] === 'directory' && !e.logical ? null : parentPath(e.logical);
        while (stack.length && stack[stack.length - 1].path !== parent) await close();
        if (e.row[0] === 'directory') {
          await builder.open(e.logical, signal);
          stack.push({
            path: e.logical,
            release: options.budget.holdRecord(512 + Buffer.byteLength(e.logical)),
          });
        } else {
          await e.phase.hash(e.path, e.native, String(e.row[3]), signal);
          await builder.file(
            e.logical,
            Number(e.native[5]),
            normalizeMode(store.codec.options.model.tuple[2], e.logical, e.native[6]),
            Number(BigInt(e.native[8]) / 1000000n),
            String(e.row[3]),
            signal,
          );
        }
      }
      while (stack.length) await close();
      builder.seal(signal);
      const root = store.prefix + 'objects/' + partition;
      await store.makeParents(root + '/pending');
      let envelope: Envelope | undefined;
      await writeBaseSourceMetadata(
        store,
        root,
        'tree.ndjson',
        writeNativeTree(
          builder.events.rows(signal),
          { ...options, model: store.codec.options.model, identity },
          (e) => {
            envelope = e;
          },
          signal,
        ),
        signal,
      );
      if (!envelope) throw new Error('Missing frozen tree envelope.');
      const env = await writeBaseSourceMetadata(
          store,
          root,
          'envelope.json',
          (async function* () {
            yield encodeRecord(envelope!);
          })(),
          signal,
        ),
        ref: ObjectRef = ['object-ref', identity, objectKey(identity), env[3], env[4]];
      result = await FrozenBaseTree.read(store, ref, options);
      await checkSource(source, store, options);
      equal(await store.state(), state, 'keyed rendering state');
    } catch (e) {
      failure = e;
    }
    for (const f of stack) f.release();
    try {
      await settleBaseCleanup(
        [() => builder.disposeUnit(), () => builder.events.dispose()],
        failure,
      );
    } catch (e) {
      failure = e;
    }
    if (failure !== undefined) throw failure;
    signal.throwIfAborted();
    return result!;
  }
  /** Checks immutable portable bytes only, including when payload roots are away. */
  static async read(
    store: OwnedStore,
    reference: ObjectRef,
    options: BaseObjectOptions,
  ): Promise<FrozenBaseTree> {
    reference = structuredClone(reference);
    checkIdentity(reference[1], store.codec.options.model);
    equal(reference[2], objectKey(reference[1]), 'frozen object key');
    const root = store.prefix + 'objects/' + reference[1][2],
      envRef: Reference = ['ref', 'envelope', root + '/envelope.json', reference[3], reference[4]],
      en = await nativeBaseFile(store, envRef[2], 65536),
      envelope = decodeEnvelope(
        await baseFileBytes(store, envRef),
        reference,
        store.codec.options.model,
      ),
      tree: Reference = ['ref', 'native-tree', root + '/tree.ndjson', envelope[5], envelope[6]],
      tn = await nativeBaseFile(store, tree[2]);
    await readNativeTree(
      store.read(tree, 'native-tree'),
      { ...options, model: store.codec.options.model, identity: reference[1] },
      envelope,
      undefined,
      options.signal,
    );
    const result = new FrozenBaseTree(store, reference, envelope, tree, envRef, [en, tn]);
    await result.assertStable(options);
    return result;
  }
}
async function checkSource(
  source: LivePartitionSource,
  store: OwnedStore,
  options: BaseObjectOptions,
) {
  for await (const _ of baseEvidence(
    store,
    source.nativeRoot,
    source.evidence,
    source.partition,
    options,
  ))
    if (_.row[0] === 'file')
      await _.phase.hash(
        _.path,
        _.native,
        String(_.row[3]),
        options.signal ?? new AbortController().signal,
      );
}
