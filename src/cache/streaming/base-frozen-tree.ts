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

import { encodeRecord, equal, tuple, type Value } from './encoding';
import { LiveBaseInputs } from './live-base-inputs';
import { BaseSourceTree } from './base-source-tree';
import { writeNativeTree, readNativeTree, type TreeSeal } from './native-tree';
import {
  checkIdentity,
  objectKey,
  decodeEnvelope,
  type Envelope,
  type ObjectIdentity,
  type ObjectRef,
} from './native-records';
import { baseFileBytes, nativeBaseFile } from './base-layout';
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
    const draft = await PreparedBaseTree.create(input, partition);
    try {
      return await draft.render(identity);
    } finally {
      await draft.dispose();
    }
  }
  /** Called only by the process-local draft after writer completion. */
  static async fromDraft(draft: PreparedBaseTree, identity: ObjectIdentity) {
    PreparedBaseTree.assert(draft);
    const { input, partition, builder } = draft,
      { store, options } = input.view,
      signal = options.signal ?? new AbortController().signal;
    identity = structuredClone(identity);
    checkIdentity(identity, store.codec.options.model, partition);
    const state = await draft.checkState(),
      root = store.prefix + 'objects/' + partition;
    await store.makeParents(root + '/pending');
    let envelope: Envelope | undefined;
    const tree = await writeBaseSourceMetadata(
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
      options.budget,
    );
    if (!envelope) throw new Error('Missing frozen tree envelope.');
    equal(
      [envelope[7], envelope[8]],
      [draft.summary.counts, draft.summary.semantic],
      'rendered projection',
    );
    equal(tree.slice(3), envelope.slice(5, 7), 'written tree bytes');
    const env = await writeBaseSourceMetadata(
        store,
        root,
        'envelope.json',
        (async function* () {
          yield encodeRecord(envelope!);
        })(),
        signal,
        options.budget,
      ),
      ref: ObjectRef = ['object-ref', identity, objectKey(identity), env[3], env[4]],
      en = store.completedFile(env),
      tn = store.completedFile(tree);
    // No reopen/hash/grammar replay: both exact references retain writer-bound N.
    const result =
      en && tn
        ? new FrozenBaseTree(store, ref, envelope, tree, env, [en, tn])
        : await FrozenBaseTree.read(store, ref, options);
    await result.assertStable(options);
    equal(await store.state(), state, 'keyed rendering state');
    signal.throwIfAborted();
    return result;
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
const drafts = new WeakSet<object>();
/** Bounded metadata spool from already captured N/hash facts, not payload authority. */
export class PreparedBaseTree {
  private disposed = false;
  private constructor(
    readonly input: LiveBaseInputs,
    readonly partition: string,
    readonly builder: BaseSourceTree,
    readonly summary: TreeSeal,
    private readonly ownsBuilder = true,
  ) {
    drafts.add(this);
  }
  static assert(draft: PreparedBaseTree) {
    if (!drafts.has(draft) || draft.disposed) throw new Error('Unavailable tree draft.');
    LiveBaseInputs.assert(draft.input);
  }
  async checkState() {
    PreparedBaseTree.assert(this);
    const { store } = this.input.view,
      state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (state[4] !== 'gc-complete' || state[8] || state[9])
      throw new Error('Tree rendering requires a pre-publication source.');
    equal(state[6], this.input.view.observations, 'render original observations');
    equal(state[7], this.input.postSources, 'render committed post sources');
    return state;
  }
  static async create(input: LiveBaseInputs, partition: string) {
    LiveBaseInputs.assert(input);
    const { store, options } = input.view,
      signal = options.signal ?? new AbortController().signal,
      source = input.partitions.find((p) => p.partition === partition);
    if (!source) throw new Error('Missing frozen partition source.');
    const captured = input.sourceTree(partition);
    if (captured) {
      const draft = new PreparedBaseTree(input, partition, captured, captured.summary, false);
      await draft.checkState();
      signal.throwIfAborted();
      return draft;
    }
    const builder = await BaseSourceTree.create(store, partition, options),
      stack: { path: string; release: () => void }[] = [];
    const close = async () => {
      const f = stack.pop()!;
      try {
        await builder.close(f.path, signal);
      } finally {
        f.release();
      }
    };
    try {
      // Metadata-only transformation. Consuming relocation/stage guards validate
      // the original native identities; encoding never adopts new native facts.
      for await (const row of store.rows(
        source.evidence,
        'native-evidence',
        { ...options, partition },
        signal,
      )) {
        const r = tuple(row.value);
        if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
        const logical = String(r[1]),
          native = r[2] as NativeIdentity,
          parent = r[0] === 'directory' && !logical ? null : parentPath(logical);
        while (stack.length && stack[stack.length - 1].path !== parent) await close();
        if (r[0] === 'directory') {
          await builder.open(logical, signal);
          stack.push({
            path: logical,
            release: options.budget.holdRecord(512 + Buffer.byteLength(logical)),
          });
        } else
          await builder.file(
            logical,
            Number(native[5]),
            normalizeMode(store.codec.options.model.tuple[2], logical, native[6]),
            Number(BigInt(native[8]) / 1000000n),
            String(r[3]),
            signal,
          );
      }
      while (stack.length) await close();
      await builder.seal(signal);
      const draft = new PreparedBaseTree(input, partition, builder, builder.summary);
      await draft.checkState();
      signal.throwIfAborted();
      return draft;
    } catch (error) {
      for (const f of stack) f.release();
      await settleBaseCleanup([() => builder.disposeUnit(), () => builder.events.dispose()], error);
      throw error;
    }
  }
  render(identity: ObjectIdentity) {
    return FrozenBaseTree.fromDraft(this, identity);
  }
  async dispose() {
    if (this.disposed) return;
    if (this.ownsBuilder)
      await settleBaseCleanup([
        () => this.builder.disposeUnit(),
        () => this.builder.events.dispose(),
      ]);
    this.disposed = true;
  }
}
