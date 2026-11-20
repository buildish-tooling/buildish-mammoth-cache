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

import { createHash, type Hash } from 'node:crypto';
import { z } from 'zod';
import { abortableValues, withAbort } from './abort';
import { decodeRecords, encodeRecord, equal, Digest, add, type Value } from './encoding';
import type { LocalCodec, LocalSchemas } from './local-schema';
import { shaSchema, uintSchema, unitSchema } from './schema';
import { parentPath, type WorkingBudget, validateUnit } from './tree-state';
import { LocalTreeState } from './local-tree-state';
import { LocalEvidenceState, type InstallKind } from './local-evidence-state';

// Protocol: docs/dev/cache-lifecycle-protocol.md#immutable-references-and-append-prefixes
export const localPurposes = [
  'model',
  'producers',
  'prepare-sources',
  'post-sources',
  'worker-sources',
  'installations',
  'partition-state',
  'publication-partitions',
  'cursor-stack',
  'observations',
  'activity',
  'gc-evidence',
  'native-evidence',
  'stage-evidence',
  'adjustments',
  'outbound-evidence',
  'return-evidence',
  'move-plan',
  'install-plan',
  'install-evidence',
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
class Grammar {
  private readonly schemas: LocalSchemas;
  private tree?: LocalTreeState;
  private evidence?: LocalEvidenceState;
  private count = 0;
  private index = -1;
  private lastProducer: string | null = null;
  private stackPath: string | null = null;
  constructor(
    private readonly purpose: LocalPurpose,
    private readonly options: LocalStreamOptions,
  ) {
    z.enum(localPurposes).parse(purpose);
    this.schemas = options.codec.schemas;
    const partitioned = [
      'native-evidence',
      'stage-evidence',
      'adjustments',
      'outbound-evidence',
      'return-evidence',
      'move-plan',
    ].includes(purpose);
    if (purpose !== 'cursor-stack' && partitioned !== (options.partition !== null))
      throw new Error('Wrong local stream partition scope.');
    if (options.partition !== null) this.schemas.partition.parse(options.partition);
    if (purpose === 'activity' || purpose === 'observations')
      this.tree = new LocalTreeState(
        purpose,
        this.schemas,
        options.budget,
        options.maxDirectoryEntries,
      );
    else if (partitioned || ['gc-evidence', 'install-plan', 'install-evidence'].includes(purpose))
      this.evidence = new LocalEvidenceState(
        purpose,
        this.schemas,
        options.budget,
        options.partition,
        options.maxDirectoryEntries,
        options.installKind,
      );
  }
  header(): Value {
    const o = this.options.codec.options;
    return [
      'local-stream',
      1,
      this.purpose,
      o.invocation,
      o.model.id,
      o.model.family,
      this.options.partition,
    ];
  }
  private modelOrder(id: string, all = false): void {
    const index = this.schemas.options.model.partitions.findIndex((p) => p[0] === id);
    if (index < 0 || index <= this.index || (all && index !== this.index + 1))
      throw new Error('Local partition order/membership mismatch.');
    this.index = index;
  }
  accept(value: Value): void {
    if (this.tree) {
      this.tree.accept(value);
      this.count = add(this.count);
      return;
    }
    if (this.evidence) {
      this.evidence.accept(value);
      this.count = add(this.count);
      return;
    }
    const s = this.schemas,
      m = s.options.model;
    if (!Array.isArray(value)) throw new Error('Invalid local row.');
    switch (this.purpose) {
      case 'model': {
        const expected =
          this.count === 0
            ? ['model-header', m.tuple[2], m.tuple[3]]
            : this.count <= m.partitions.length
              ? ['partition', ...m.partitions[this.count - 1]]
              : null;
        if (expected === null) throw new Error('Extra model row.');
        equal(value, expected, 'frozen model row');
        break;
      }
      case 'producers': {
        const row = z.tuple([z.literal('producer'), s.rows.producer]).parse(value),
          producer = row[1],
          job = producer[3][4];
        if (this.count === 16 || (this.lastProducer !== null && this.lastProducer >= job))
          throw new Error('Unordered/duplicate producer inventory.');
        for (const i of [0, 1, 2, 3, 6, 7] as const)
          if (producer[3][i] !== s.options.context[i]) throw new Error('Wrong producer CI scope.');
        this.lastProducer = job;
        break;
      }
      case 'prepare-sources':
      case 'post-sources': {
        const row = z.tuple([z.literal('snapshot-source'), s.source]).parse(value);
        if (this.purpose === 'prepare-sources' && row[1][1] === 'local-writer')
          throw new Error('Post-build source in prepare bindings.');
        this.modelOrder(row[1][0]);
        break;
      }
      case 'worker-sources': {
        const row = z
          .tuple([z.literal('worker-snapshot'), s.partition, s.ref('observations')])
          .parse(value);
        const partition = m.partitions.find((p) => p[0] === row[1])!;
        if (
          s.options.role !== 'distributed-worker' ||
          partition[3] !== 'single-writer' ||
          (partition[4] !== null && partition[4] !== s.options.context[4])
        )
          throw new Error('Unauthorized worker source.');
        this.modelOrder(row[1]);
        break;
      }
      case 'installations':
        z.tuple([z.literal('installation'), s.rows.registration]).parse(value);
        break;
      case 'partition-state': {
        const row = s.rows.partitionState.parse(value);
        this.modelOrder(row[1], true);
        break;
      }
      case 'publication-partitions': {
        const row = s.rows.publicationPartition.parse(value);
        this.modelOrder(row[1], true);
        break;
      }
      case 'cursor-stack': {
        const row = s.rows.frame.parse(value);
        if (
          this.count === 100 ||
          row[1] !== this.count ||
          (this.stackPath === null
            ? row[2] !== ''
            : parentPath(row[2]) !== this.stackPath || !row[2])
        )
          throw new Error('Invalid cursor ancestor stack.');
        if (row[3] === 'files' && row[5] !== null)
          throw new Error('Directory marker during file phase.');
        if (row[6]) {
          validateUnit(m, unitSchema.parse(row[6]));
          if (row[2] !== row[6][1] && !row[2].startsWith(row[6][1] + '/'))
            throw new Error('Cursor unit outside frame.');
        }
        this.stackPath = row[2];
        break;
      }
      default:
        throw new Error('Unknown local stream purpose.');
    }
    this.count = add(this.count);
  }
  finish(): void {
    this.tree?.finish();
    this.evidence?.finish();
    const m = this.schemas.options.model;
    if (this.purpose === 'model' && this.count !== m.partitions.length + 1)
      throw new Error('Incomplete model stream.');
    if (
      ['partition-state', 'publication-partitions'].includes(this.purpose) &&
      this.count !== m.partitions.length
    )
      throw new Error('Incomplete partition catalog.');
  }
  dispose(): void {
    this.tree?.dispose();
    this.evidence?.dispose();
  }
}
const endSchema = z.tuple([z.literal('local-end'), uintSchema, shaSchema]);
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
    await read(source, purpose, options, { bytes: ref[3], sha: ref[4] }, false, event, signal)
  ).seal;
}
/** Caller clips source to committed P.bytes; uncommitted tail is never accepted. No total-byte quota. */
export async function readLocalPrefix(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  reference: Value,
  event?: (value: Value) => Promise<void>,
  signal = new AbortController().signal,
): Promise<{ seal: LocalStreamSeal; rawHash: Hash; eventDigest: Digest }> {
  if (!['outbound-evidence', 'return-evidence', 'adjustments'].includes(purpose))
    throw new Error('Prefix not allowed for purpose.');
  const ref = options.codec.schemas.appendPrefix(purpose).parse(reference);
  const result = await read(
    source,
    purpose,
    options,
    { bytes: ref[3], sha: ref[5] },
    true,
    event,
    signal,
  );
  if (result.seal.records !== ref[4]) throw new Error('Prefix record count mismatch.');
  return result;
}
async function read(
  source: AsyncIterable<Uint8Array>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  expected: { bytes: number; sha: string },
  prefix: boolean,
  event: ((value: Value) => Promise<void>) | undefined,
  signal: AbortSignal,
) {
  const grammar = new Grammar(purpose, options),
    digest = new Digest('local-' + purpose),
    raw = createHash('sha256');
  let bytes = 0,
    records = 0,
    started = false,
    ended = false;
  try {
    for await (const frame of decodeRecords(abortableValues(source, signal))) {
      const release = options.budget.holdRecord(frame.raw.length);
      try {
        if (ended) throw new Error('Trailing local stream row.');
        bytes = add(bytes, frame.raw.length);
        if (bytes > expected.bytes) throw new Error('Local reference length exceeded.');
        raw.update(frame.raw);
        if (!started) {
          equal(frame.value, grammar.header(), 'local stream header');
          started = true;
          digest.update(frame.value);
        } else if (Array.isArray(frame.value) && frame.value[0] === 'local-end') {
          if (prefix) throw new Error('Sealed stream supplied as live prefix.');
          const end = endSchema.parse(frame.value);
          grammar.finish();
          equal(end, ['local-end', records, digest.digest()], 'local stream seal');
          ended = true;
        } else {
          grammar.accept(frame.value);
          records = add(records);
          digest.update(frame.value);
        }
        if (event) await withAbort(event(frame.value), signal);
      } finally {
        release();
      }
    }
    if (!started || (!prefix && !ended)) throw new Error('Truncated local stream.');
    if (prefix) grammar.finish();
    const sha = raw.copy().digest('hex');
    equal([bytes, sha], [expected.bytes, expected.sha], 'local reference');
    return {
      seal: { bytes, records, sha, eventSha: digest.digest() },
      rawHash: raw,
      eventDigest: digest,
    };
  } finally {
    grammar.dispose();
  }
}
export async function* writeLocalStream(
  records: AsyncIterable<Value>,
  purpose: LocalPurpose,
  options: LocalStreamOptions,
  sealed: (seal: LocalStreamSeal) => void,
  signal = new AbortController().signal,
): AsyncGenerator<Buffer> {
  const grammar = new Grammar(purpose, options),
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
      yield emit(encoded);
    }
    grammar.finish();
    yield emit(encodeRecord(['local-end', count, digest.digest()]));
    signal.throwIfAborted();
    sealed({ bytes, records: count, sha: raw.digest('hex'), eventSha: digest.digest() });
  } finally {
    grammar.dispose();
  }
}
