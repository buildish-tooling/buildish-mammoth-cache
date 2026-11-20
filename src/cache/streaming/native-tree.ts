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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { abortableValues, withAbort } from './abort';
import { add, decodeRecords, encodeRecord, equal, Digest, type Value } from './encoding';
import {
  countsSchema,
  componentSchema,
  modeSchema,
  pathSchema,
  scopeSchema,
  shaSchema,
  uintSchema,
  unitKindSchema,
  unitSchema,
  type Counts,
} from './schema';
import {
  checkIdentity,
  envelopeSchema,
  identitySchema,
  type Envelope,
  type ObjectIdentity,
} from './native-records';
import type { ResolvedModel } from './model';
import {
  TreeState,
  UnitProjection,
  type WorkingBudget,
  newCounts,
  joinPath,
  recognizedRoot,
  isWorkspaceRoot,
  normalizeMode,
  type UnitSummary,
} from './tree-state';

// Protocol: docs/dev/native-base-protocol.md#native-tree-grammar
const headerSchema = z.tuple([
  z.literal('tree'),
  z.literal(1),
  z.literal('native-tree-v1'),
  identitySchema,
  z.literal('partition-projection'),
]);
const events = {
  'dir-open': z.tuple([z.literal('dir-open'), pathSchema]),
  'dir-close': z.tuple([z.literal('dir-close'), pathSchema]),
  file: z.tuple([
    z.literal('file'),
    componentSchema,
    uintSchema,
    modeSchema,
    uintSchema,
    shaSchema,
  ]),
  'unit-open': z.tuple([
    z.literal('unit-open'),
    unitKindSchema,
    pathSchema,
    scopeSchema,
    z.literal('partition-projection'),
    countsSchema,
    shaSchema,
    shaSchema,
  ]),
  'unit-close': z.tuple([
    z.literal('unit-close'),
    unitKindSchema,
    pathSchema,
    countsSchema,
    shaSchema,
    shaSchema,
  ]),
  end: z.tuple([z.literal('end'), countsSchema, shaSchema, shaSchema]),
};
export interface NativeTreeOptions {
  readonly model: ResolvedModel;
  readonly identity: ObjectIdentity;
  readonly budget: WorkingBudget;
  readonly maxDirectoryEntries?: number;
}
export interface TreeSeal {
  counts: Counts;
  semantic: string;
  events: string;
}
class NativeTreeState {
  private readonly tree: TreeState;
  private readonly counts = newCounts();
  private readonly semantic = new Digest('base-tree-semantic');
  private readonly eventDigest = new Digest('base-tree-events');
  private started = false;
  private ended = false;
  private unit: UnitProjection | null = null;
  private assertion: UnitSummary | null = null;
  private closeRoot: string | null = null;
  private requiredUnit: string | null = null;
  constructor(private readonly options: NativeTreeOptions) {
    checkIdentity(options.identity, options.model);
    this.tree = new TreeState(options.budget, options.maxDirectoryEntries);
  }
  header(): Value {
    return ['tree', 1, 'native-tree-v1', this.options.identity, 'partition-projection'];
  }
  end(): Value {
    return ['end', [...this.counts], this.semantic.digest(), this.eventDigest.digest()];
  }
  private owner(path: string): string {
    const partition = this.options.model.owner(path)[0];
    if (partition !== this.options.identity[2])
      throw new Error('Wrong native-tree partition owner.');
    return partition;
  }
  accept(input: Value): void {
    if (this.ended) throw new Error('Trailing native tree record.');
    if (!this.started) {
      const header = headerSchema.parse(input);
      equal(header, this.header(), 'native header');
      this.eventDigest.update(header);
      this.started = true;
      return;
    }
    if (!Array.isArray(input) || typeof input[0] !== 'string' || !Object.hasOwn(events, input[0]))
      throw new Error('Unknown native tree event.');
    const row = events[input[0] as keyof typeof events].parse(input);
    const tag = row[0];
    if (this.requiredUnit !== null && tag !== 'unit-open')
      throw new Error('Missing recognized complete unit wrapper.');
    if (this.closeRoot !== null && (tag !== 'dir-close' || row[1] !== this.closeRoot))
      throw new Error('Missing workspace root close.');
    switch (row[0]) {
      case 'dir-open':
        this.tree.open(row[1]);
        this.counts[1] = add(this.counts[1]);
        this.semantic.update(['directory', row[1], 'open']);
        if (this.unit) this.unit.directory(row[1], 'open');
        else if (isWorkspaceRoot(this.options.model, row[1])) this.requiredUnit = row[1];
        break;
      case 'dir-close':
        if (this.unit?.unit[1] === row[1]) throw new Error('Missing native unit close.');
        if (row[1] && this.tree.leaf) {
          const probe = row[1] + '/.workspace-directory-probe';
          recognizedRoot(this.options.model, probe);
          const owner = this.owner(probe);
          this.unit?.ownership(owner);
        }
        if (this.unit) this.unit.directory(row[1], 'close');
        this.tree.close(row[1]);
        this.closeRoot = null;
        this.semantic.update(['directory', row[1], 'close']);
        break;
      case 'file': {
        const path = joinPath(this.tree.path, row[1]),
          owner = this.owner(path);
        this.tree.file(path);
        const root = recognizedRoot(this.options.model, path);
        if (root !== null && (!this.unit || this.unit.unit[1] !== root || root === path))
          throw new Error('Missing native complete unit.');
        if (normalizeMode(this.options.model.tuple[2], path, row[3]) !== row[3])
          throw new Error('Noncanonical launcher mode.');
        this.semantic.update(['file', path, owner, ...row.slice(2)]);
        this.unit?.file(path, owner, row[2], row[3], row[4], row[5]);
        this.counts[0] = add(this.counts[0]);
        this.counts[4] = add(this.counts[4], row[2]);
        break;
      }
      case 'unit-open': {
        if (this.unit || !this.tree.emptyDirectory || row[2] !== this.tree.path)
          throw new Error('Invalid native unit boundary.');
        const descriptor = unitSchema.parse(row.slice(1, 4));
        this.unit = new UnitProjection(
          this.options.model,
          descriptor,
          false,
          this.options.identity[2],
        );
        this.assertion = { counts: row[5], semantic: row[6], comparison: row[7] };
        this.semantic.update([
          'unit',
          ...descriptor,
          'partition-projection',
          this.options.identity[2],
        ]);
        this.requiredUnit = null;
        this.counts[2] = add(this.counts[2]);
        break;
      }
      case 'unit-close': {
        const unit = this.unit;
        if (
          !unit ||
          row[1] !== unit.unit[0] ||
          row[2] !== unit.unit[1] ||
          this.tree.path !== row[2]
        )
          throw new Error('Invalid native unit close.');
        const seal = unit.finish();
        equal(
          [row[3], row[4], row[5]],
          [seal.counts, seal.semantic, seal.comparison],
          'native unit close',
        );
        equal(
          [this.assertion!.counts, this.assertion!.semantic, this.assertion!.comparison],
          [seal.counts, seal.semantic, seal.comparison],
          'native unit opening assertion',
        );
        this.semantic.update(['unit-end', unit.unit[0], unit.unit[1]]);
        if (unit.unit[2] === 'direct') this.tree.endFiles();
        else this.closeRoot = unit.unit[1];
        this.unit = null;
        this.assertion = null;
        break;
      }
      case 'end':
        if (
          !this.tree.complete ||
          this.unit ||
          this.requiredUnit !== null ||
          this.closeRoot !== null
        )
          throw new Error('Incomplete native tree.');
        equal(row, this.end(), 'native tree seal');
        this.ended = true;
        return;
    }
    this.eventDigest.update(row);
  }
  finish(): TreeSeal {
    if (!this.ended) throw new Error('Missing native tree end.');
    return {
      counts: [...this.counts],
      semantic: this.semantic.digest(),
      events: this.eventDigest.digest(),
    };
  }
  dispose(): void {
    this.tree.dispose();
  }
}
/** Metadata-only acceptance; callbacks are provisional until resolution.
 * Payload membership/native guards remain integration obligations. */
export async function readNativeTree(
  source: AsyncIterable<Uint8Array>,
  options: NativeTreeOptions,
  envelope: Envelope,
  event?: (value: Value) => Promise<void>,
  signal = new AbortController().signal,
): Promise<TreeSeal> {
  envelopeSchema.parse(envelope);
  equal(envelope[3], options.identity, 'tree envelope identity');
  const state = new NativeTreeState(options),
    raw = createHash('sha256');
  let bytes = 0;
  try {
    for await (const record of decodeRecords(abortableValues(source, signal))) {
      const release = options.budget.holdRecord(record.raw.length);
      try {
        bytes = add(bytes, record.raw.length);
        raw.update(record.raw);
        state.accept(record.value);
        if (event) await withAbort(event(record.value), signal);
      } finally {
        release();
      }
    }
    const seal = state.finish();
    equal(
      [bytes, raw.digest('hex'), seal.counts, seal.semantic],
      [envelope[5], envelope[6], envelope[7], envelope[8]],
      'native envelope tree binding',
    );
    return seal;
  } finally {
    state.dispose();
  }
}
/** Encodes caller-supplied ordered metadata, never payload bytes or a filesystem scan. */
export async function* writeNativeTree(
  records: AsyncIterable<Value>,
  options: NativeTreeOptions,
  sealed: (envelope: Envelope) => void,
  signal = new AbortController().signal,
): AsyncGenerator<Buffer> {
  const state = new NativeTreeState(options),
    raw = createHash('sha256');
  let bytes = 0;
  const encode = (value: Value) => {
    signal.throwIfAborted();
    const encoded = encodeRecord(value),
      release = options.budget.holdRecord(encoded.length);
    try {
      state.accept(value);
      raw.update(encoded);
      bytes = add(bytes, encoded.length);
      return encoded;
    } finally {
      release();
    }
  };
  try {
    yield encode(state.header());
    for await (const record of abortableValues(records, signal)) {
      if (Array.isArray(record) && (record[0] === 'tree' || record[0] === 'end'))
        throw new Error('Caller supplied native framing.');
      yield encode(record);
    }
    yield encode(state.end());
    signal.throwIfAborted();
    const summary = state.finish();
    sealed([
      'envelope',
      1,
      'native-tree-v1',
      options.identity,
      'partition-projection',
      bytes,
      raw.digest('hex'),
      summary.counts,
      summary.semantic,
    ]);
  } finally {
    state.dispose();
  }
}
