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

import { equal, rawSha, type Value } from './encoding';
import { policyId, type LocalCodec } from './local-schema';
import { decodeGeneration, type Generation } from './native-records';
import { writerId } from './model';

function requireBinding(condition: boolean, label: string): void {
  if (!condition) throw new Error('Mismatched ' + label + '.');
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans
/** Validates supplied immutable documents; does not resolve a path or recreate native proof. */
export function checkPublicationBindings(
  codec: LocalCodec,
  state: Value,
  bindings: Value,
  publication: Value,
  generationBytes: Buffer,
): Generation {
  codec.checkStateBindings(state, bindings);
  const s = codec.schemas.documents['local-state'].parse(state),
    b = codec.schemas.documents.bindings.parse(bindings),
    p = codec.schemas.documents.publication.parse(codec.validate(publication));
  const bytes = codec.encode(p);
  requireBinding(
    s[8] !== null && s[8][3] === bytes.length && s[8][4] === rawSha(bytes),
    'publication reference',
  );
  equal(s[7], p[5], 'committed post sources');
  const d = p[3];
  equal(
    [d[5], d[6], d[7], d[8], d[9]],
    [policyId(b[8]), s[6]?.[4] ?? null, b[9]?.[1] ?? null, b[10][4], p[5][4]],
    'frozen publication decision',
  );
  requireBinding(
    generationBytes.length === p[7][3] && rawSha(generationBytes) === p[7][4],
    'candidate generation reference',
  );
  const generation = decodeGeneration(generationBytes, codec.options.model, p[8]);
  equal(
    [generation[6], generation[7]],
    [writerId(codec.options.invocation, codec.options.context), p[4]],
    'generation publisher/decision',
  );
  return generation;
}
/** Co-read at most P publication choices with the selected generation, one row at a time. */
export function checkPublicationChoice(
  codec: LocalCodec,
  row: Value,
  publication: Value,
  generation: Generation,
  baseline?: PinnedBaseline,
): void {
  const choice = codec.schemas.rows.publicationPartition.parse(row),
    p = codec.schemas.documents.publication.parse(publication),
    index = codec.options.model.partitions.findIndex((part) => part[0] === choice[1]),
    entry = generation[8][index];
  requireBinding(entry?.[1] === choice[1], 'publication choice partition');
  if (choice[0] === 'empty') equal(entry, ['empty', choice[1]], 'empty choice');
  else if (choice[0] === 'reuse') {
    equal(entry, ['object', choice[1], choice[2]], 'reused choice');
    requireBinding(baseline instanceof PinnedBaseline, 'pinned reuse baseline');
    baseline!.check(choice[1], choice[2], p[3][7]);
  } else {
    equal(
      [choice[2][3], choice[2][4], choice[2][5]],
      [generation[5], writerId(codec.options.invocation, codec.options.context), p[4]],
      'new object publisher/decision',
    );
    equal(
      entry,
      ['object', choice[1], ['object-ref', choice[2], choice[3], choice[4][3], choice[4][4]]],
      'new object choice',
    );
  }
}
/** Decode pinned baseline once per stable phase, never fetch predecessor generations. */
export class PinnedBaseline {
  readonly #entries: Generation[8];
  readonly #key: string;
  private constructor(generation: Generation) {
    this.#entries = generation[8];
    this.#key = generation[11];
  }
  static decode(codec: LocalCodec, bindings: Value, bytes: Buffer): PinnedBaseline {
    const b = codec.schemas.documents.bindings.parse(codec.validate(bindings));
    requireBinding(b[9] !== null, 'pinned baseline binding');
    const [, key, ref] = b[9]!;
    requireBinding(ref[3] === bytes.length && ref[4] === rawSha(bytes), 'pinned baseline bytes');
    return new PinnedBaseline(decodeGeneration(bytes, codec.options.model, key));
  }
  check(partition: string, ref: Value, key: string | null): void {
    requireBinding(this.#key === key, 'pinned baseline decision key');
    const entry = this.#entries.find((e) => e[1] === partition);
    equal(entry ?? null, ['object', partition, ref], 'pinned reused object');
  }
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts
export function checkObjectReceipt(codec: LocalCodec, receipt: Value, choice: Value): void {
  const r = codec.schemas.documents['object-receipt'].parse(receipt),
    p = codec.schemas.rows.publicationPartition.parse(choice);
  requireBinding(p[0] === 'new', 'receipt new-object choice');
  if (p[0] === 'new')
    equal([r[2], r[3], r[4], r[5]], [p[1], p[3], p[4][4], p[2][5]], 'object receipt');
}
