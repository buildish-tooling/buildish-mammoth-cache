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

import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { abortableValues, withAbort } from './abort';
import { RecordDecoder, encodeRecord, equal, Digest, add, type Value } from './encoding';
import type { LocalCodec } from './local-schema';
import { shaSchema, uintSchema } from './schema';
import { ownedReferenceSchema } from './local-schema';
import { resolveModel, type ResolvedModel } from './model';
import { tuple } from './encoding';
import { decodedRecordCharge, type WorkingBudget } from './tree-state';
import { HandoffGrammar } from './lifecycle-handoff';
import { LocalTreeState } from './local-tree-state';
import { LocalInstallState, type InstallKind } from './local-install-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#immutable-references-and-append-prefixes
export const localPurposes = [
  'model',
  'handoff',
  'installations',
  'observations',
  'activity',
  'install-plan',
] as const;
export type LocalPurpose = (typeof localPurposes)[number];
export interface LocalStreamOptions {
  readonly codec: LocalCodec;
  readonly budget: WorkingBudget;
  readonly partition: string | null;
  readonly maxDirectoryEntries?: number;
  /** Required for install streams: member kind from independently validated referenced evidence. */
  readonly installKind?: InstallKind;
}
export interface LocalStreamSeal {
  bytes: number;
  records: number;
  sha: string;
  eventSha: string;
}
export class LocalStreamGrammar {
  private readonly tree?: LocalTreeState;
  private readonly handoff?: HandoffGrammar;
  private readonly install?: LocalInstallState;
  private count = 0;
  constructor(
    private readonly purpose: LocalPurpose,
    private readonly options: LocalStreamOptions,
  ) {
    z.enum(localPurposes).parse(purpose);
    if (options.partition !== null) throw new Error('Unexpected local stream partition scope.');
    if (purpose === 'activity' || purpose === 'observations')
      this.tree = new LocalTreeState(
        purpose,
        options.codec.schemas,
        options.budget,
        options.maxDirectoryEntries,
      );
    if (purpose === 'handoff') this.handoff = new HandoffGrammar(options.codec);
    if (purpose === 'install-plan')
      this.install = new LocalInstallState(options.codec.schemas, options.installKind);
  }
  header(): Value {
    const options = this.options.codec.options;
    return [
      'local-stream',
      1,
      this.purpose,
      options.invocation,
      options.model.id,
      options.model.family,
      null,
    ];
  }
  accept(value: Value): void {
    if (this.tree) this.tree.accept(value);
    else if (this.handoff) this.handoff.accept(value);
    else if (this.install) this.install.accept(value);
    else if (this.purpose === 'installations')
      z.tuple([z.literal('installation'), this.options.codec.schemas.rows.registration]).parse(
        value,
      );
    else if (this.purpose === 'model') {
      const model = this.options.codec.options.model,
        expected =
          this.count === 0
            ? ['model-header', model.tuple[2], model.tuple[3]]
            : this.count <= model.partitions.length
              ? ['partition', ...model.partitions[this.count - 1]]
              : null;
      if (expected === null) throw new Error('Extra model row.');
      equal(value, expected, 'frozen model row');
    } else throw new Error('Unknown local stream purpose.');
    this.count = add(this.count);
  }
  finish(): void {
    this.tree?.finish();
    this.handoff?.finish();
    this.install?.finish();
    if (
      this.purpose === 'model' &&
      this.count !== this.options.codec.options.model.partitions.length + 1
    )
      throw new Error('Incomplete model stream.');
  }
  dispose(): void {
    this.tree?.dispose();
    this.install?.dispose();
  }
}
const endSchema = z.tuple([z.literal('local-end'), uintSchema, shaSchema]);
export interface LocalRow {
  readonly value: Value;
  readonly start: number;
  readonly end: number;
  /** Zero-based physical record number, including the header. */
  readonly record: number;
}
/** Provisional rows for bounded joins. Acceptance requires verified EOF, never early return. */
export async function* readLocalRows(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  reference: Value,
  signal = new AbortController().signal,
  beforeAccept?: (value: Value) => Promise<void>,
): AsyncGenerator<LocalRow, LocalStreamSeal> {
  const ref = options.codec.schemas.ref(purpose).parse(reference);
  const result = yield* read(
    source,
    purpose,
    options,
    { bytes: ref[3], sha: ref[4] },
    undefined,
    signal,
    beforeAccept,
  );
  return result.seal;
}
async function drain<T>(rows: AsyncGenerator<LocalRow, T>): Promise<T> {
  while (true) {
    const row = await rows.next();
    if (row.done) return row.value;
  }
}
/** References bind exact bytes; callbacks remain provisional until this resolves. */
export async function readLocalStream(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  reference: Value,
  event?: (value: Value) => Promise<void>,
  signal = new AbortController().signal,
): Promise<LocalStreamSeal> {
  const ref = options.codec.schemas.ref(purpose).parse(reference);
  return (
    await drain(read(source, purpose, options, { bytes: ref[3], sha: ref[4] }, event, signal))
  ).seal;
}
function read(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  expected: { bytes: number; sha: string },
  event: ((value: Value) => Promise<void>) | undefined,
  signal: AbortSignal,
  beforeAccept?: (value: Value) => Promise<void>,
) {
  return readFrames(
    source,
    purpose,
    options.budget,
    new LocalStreamGrammar(purpose, options),
    expected,
    event,
    signal,
    beforeAccept,
  );
}
interface StreamGrammar {
  header(): Value;
  accept(value: Value): void;
  finish(): void;
  dispose(): void;
}
export async function readModelStream(
  source: AsyncIterable<Uint8Array>,
  reference: Value,
  identity: { invocation: string; model: string; family: string; prefix: string; version: number },
  budget: WorkingBudget,
  signal = new AbortController().signal,
) {
  const ref = ownedReferenceSchema(identity.invocation, 'model').parse(reference),
    partitions: Value[] = [],
    releases: (() => void)[] = [];
  let head: readonly Value[] | undefined, model: ResolvedModel | undefined;
  const grammar: StreamGrammar = {
    header: () => [
      'local-stream',
      1,
      'model',
      identity.invocation,
      identity.model,
      identity.family,
      null,
    ],
    accept(value) {
      const row = tuple(value);
      if (!head) {
        head = tuple(value, 'model-header', 3);
      } else {
        if (partitions.length === 64 || row[0] !== 'partition')
          throw new Error('Invalid bootstrap model row.');
        partitions.push(row.slice(1));
      }
      releases.push(budget.holdRecord(encodeRecord(value).length));
    },
    finish() {
      if (!head) throw new Error('Missing model header.');
      model = resolveModel(
        ['model', 1, head[1], head[2], partitions],
        identity.prefix,
        identity.version,
      );
      equal(
        [model.id, model.family],
        [identity.model, identity.family],
        'bootstrap model identity',
      );
    },
    dispose() {
      for (const release of releases) release();
    },
  };
  await drain(
    readFrames(source, 'model', budget, grammar, { bytes: ref[3], sha: ref[4] }, undefined, signal),
  );
  return model!;
}
async function* readFrames<G extends StreamGrammar>(
  ...args: Parameters<typeof readFrameBatches<G>>
) {
  const batches = readFrameBatches(...args);
  try {
    for (;;) {
      const result = await batches.next();
      if (result.done) return result.value;
      for (const row of result.value) {
        args[6].throwIfAborted();
        yield row;
      }
    }
  } finally {
    await batches.return(undefined as never);
  }
}
/** Provisional byte/row bounded batches; verified acceptance requires complete EOF. */
export async function* readLocalBatches(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  reference: Value,
  signal = new AbortController().signal,
  batchChargeLimit = options.budget.limit,
) {
  if (!Number.isSafeInteger(batchChargeLimit) || batchChargeLimit < 1)
    throw new Error('Invalid local batch charge allowance.');
  const ref = options.codec.schemas.ref(purpose).parse(reference);
  return yield* readFrameBatches(
    source,
    purpose,
    options.budget,
    new LocalStreamGrammar(purpose, options),
    { bytes: ref[3], sha: ref[4] },
    undefined,
    signal,
    undefined,
    batchChargeLimit,
  );
}
async function* readFrameBatches<G extends StreamGrammar>(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  budget: WorkingBudget,
  grammar: G,
  expected: { bytes: number; sha: string },
  event: ((value: Value) => Promise<void>) | undefined,
  signal: AbortSignal,
  beforeAccept?: (value: Value) => Promise<void>,
  batchChargeLimit = budget.limit,
) {
  const digest = new Digest('local-' + purpose),
    raw = createHash('sha256');
  let bytes = 0,
    records = 0,
    physicalRecord = 0,
    started = false,
    ended = false;
  let decoderBytes = 0,
    workRows = 0,
    workBytes = 0;
  const decoder = new RecordDecoder(() => {
    budget.retain(65536);
    decoderBytes = 65536;
  });
  let batch: LocalRow[] = [],
    batchBytes = 0,
    batchCharge = 0;
  const releases: (() => void)[] = [];
  const clear = () => {
    for (const release of releases.splice(0)) release();
    batch = [];
    batchBytes = 0;
    batchCharge = 0;
  };
  try {
    for await (const chunk of abortableValues(source, signal))
      for (const frame of decoder.push(chunk)) {
        signal.throwIfAborted();
        if (
          batch.length &&
          (batchBytes + frame.raw.length > 65536 ||
            batch.length >= 256 ||
            batchCharge + decodedRecordCharge(frame.raw.length) > batchChargeLimit)
        ) {
          yield batch;
          clear();
          await setImmediate();
          signal.throwIfAborted();
        }
        if ((event || beforeAccept) && (workRows >= 256 || workBytes + frame.raw.length > 65536)) {
          await setImmediate();
          signal.throwIfAborted();
          workRows = 0;
          workBytes = 0;
        }
        workRows++;
        workBytes += frame.raw.length;
        releases.push(budget.holdRecord(frame.raw.length));
        batchBytes += frame.raw.length;
        batchCharge += decodedRecordCharge(frame.raw.length);
        if (ended) throw new Error('Trailing local stream row.');
        bytes = add(bytes, frame.raw.length);
        if (bytes > expected.bytes) throw new Error('Local reference length exceeded.');
        raw.update(frame.raw);
        if (!started) {
          equal(frame.value, grammar.header(), 'local stream header');
          started = true;
          digest.encoded(frame.raw.subarray(0, -1));
        } else if (Array.isArray(frame.value) && frame.value[0] === 'local-end') {
          const end = endSchema.parse(frame.value);
          grammar.finish();
          equal(end, ['local-end', records, digest.digest()], 'local stream seal');
          ended = true;
        } else {
          if (beforeAccept) await withAbort(beforeAccept(frame.value), signal);
          grammar.accept(frame.value);
          records = add(records);
          digest.encoded(frame.raw.subarray(0, -1));
        }
        if (event) await withAbort(event(frame.value), signal);
        batch.push({
          value: frame.value,
          start: bytes - frame.raw.length,
          end: bytes,
          record: physicalRecord++,
        });
        if (event || beforeAccept) {
          yield batch;
          clear();
        }
      }
    decoder.finish();
    if (batch.length) {
      yield batch;
      clear();
      await setImmediate();
      signal.throwIfAborted();
    }
    if (!started || !ended) throw new Error('Truncated local stream.');
    const sha = raw.copy().digest('hex');
    equal([bytes, sha], [expected.bytes, expected.sha], 'local reference');
    return {
      seal: { bytes, records, sha, eventSha: digest.digest() },
    };
  } finally {
    clear();
    budget.release(decoderBytes);
    grammar.dispose();
  }
}
export async function* writeLocalStream(
  records: AsyncIterable<Value>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  sealed: (seal: LocalStreamSeal) => void,
  signal = new AbortController().signal,
  onRow?: (row: LocalRow) => Promise<void>,
): AsyncGenerator<Buffer> {
  const grammar = new LocalStreamGrammar(purpose, options),
    digest = new Digest('local-' + purpose),
    raw = createHash('sha256');
  let bytes = 0,
    count = 0;
  const emit = (encoded: Buffer) => {
    signal.throwIfAborted();
    raw.update(encoded);
    bytes = add(bytes, encoded.length);
    return encoded;
  };
  try {
    const header = encodeRecord(grammar.header());
    digest.encoded(header.subarray(0, -1));
    if (onRow)
      await onRow({ value: grammar.header(), start: bytes, end: bytes + header.length, record: 0 });
    yield emit(header);
    for await (const value of abortableValues(records, signal)) {
      const encoded = encodeRecord(value),
        release = options.budget.holdRecord(encoded.length);
      try {
        grammar.accept(value);
        digest.encoded(encoded.subarray(0, -1));
        count = add(count);
      } finally {
        release();
      }
      if (onRow) await onRow({ value, start: bytes, end: bytes + encoded.length, record: count });
      yield emit(encoded);
    }
    grammar.finish();
    const end: Value = ['local-end', count, digest.digest()],
      encodedEnd = encodeRecord(end);
    if (onRow)
      await onRow({ value: end, start: bytes, end: bytes + encodedEnd.length, record: count + 1 });
    yield emit(encodedEnd);
    signal.throwIfAborted();
    sealed({ bytes, records: count, sha: raw.digest('hex'), eventSha: digest.digest() });
  } finally {
    grammar.dispose();
  }
}
