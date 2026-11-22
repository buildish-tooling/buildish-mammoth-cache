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

import { ValidatedBaseObject, type BaseObjectOptions } from './base-object';
import { baseFileBytes, bindBaseFile } from './base-layout';
import { objectRefSchema, decodeEnvelope, type ObjectRef, type Envelope } from './native-records';
import { readNativeTree } from './native-tree';
import { equal } from './encoding';
import type { OwnedStore, Reference } from './owned-store';

const genuine = new WeakSet<object>();
function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) immutable(item);
    Object.freeze(value);
  }
  return value;
}
export type BaseMetadata = ValidatedBaseObject | BaselineMetadata;
export function assertBaseMetadata(value: BaseMetadata, store: OwnedStore) {
  if (value instanceof BaselineMetadata) BaselineMetadata.assert(value, store);
  else ValidatedBaseObject.assertReceipt(value, store);
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#retained-baseline-metadata.
// Metadata provenance only: never payload, installation or relocation authority.
export class BaselineMetadata {
  private constructor(
    readonly store: OwnedStore,
    readonly reference: ObjectRef,
    readonly envelope: Envelope,
    readonly tree: Reference,
  ) {
    immutable(reference);
    immutable(envelope);
    immutable(tree);
    genuine.add(this);
    Object.freeze(this);
  }
  static assert(value: BaselineMetadata, store: OwnedStore) {
    if (!genuine.has(value) || value.store !== store) throw new Error('Unbound baseline metadata.');
  }
  static async retain(object: ValidatedBaseObject, options: BaseObjectOptions) {
    ValidatedBaseObject.assertReceipt(object);
    const { store } = object,
      root = store.prefix + 'baseline/' + object.reference[1][2],
      signal = options.signal ?? new AbortController().signal;
    for (const [name, q] of [
      [
        'envelope.json',
        await bindBaseFile(store, object.root + '/envelope.json', 'envelope', signal, 65536),
      ],
      ['tree.ndjson', object.tree],
    ] as const) {
      if (!(await store.root.stat(root + '/' + name)))
        await store.writeNativeMetadata(root, name, store.read(q, q[1]), signal);
      const retained = await bindBaseFile(
        store,
        root + '/' + name,
        q[1],
        signal,
        name === 'envelope.json' ? 65536 : Number.MAX_SAFE_INTEGER,
      );
      equal(retained.slice(3), q.slice(3), 'retained immutable baseline bytes');
    }
    return BaselineMetadata.open(store, object.reference, options);
  }
  static async open(store: OwnedStore, reference: ObjectRef, options: BaseObjectOptions) {
    reference = immutable(objectRefSchema.parse(structuredClone(reference)));
    const root = store.prefix + 'baseline/' + reference[1][2],
      signal = options.signal ?? new AbortController().signal,
      env = await bindBaseFile(store, root + '/envelope.json', 'envelope', signal, 65536),
      envelope = decodeEnvelope(
        await baseFileBytes(store, env),
        reference,
        store.codec.options.model,
      ),
      tree = store.codec.schemas
        .ref('native-tree')
        .parse(['ref', 'native-tree', root + '/tree.ndjson', envelope[5], envelope[6]]);
    await readNativeTree(
      store.read(tree, 'native-tree'),
      { ...options, model: store.codec.options.model, identity: reference[1] },
      envelope,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    return new BaselineMetadata(store, reference, envelope, Object.freeze(tree) as Reference);
  }
}
