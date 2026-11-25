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

import {
  CACHE_METADATA_DIRECTORY,
  CACHE_METADATA_LOCATOR,
  CACHE_METADATA_LOCATOR_NAME,
  CACHE_METADATA_VERSION_DIRECTORY,
  cacheInvocationPrefix,
  cacheInvocationStatePath,
} from '../metadata-paths';
import type { LocalRow } from './local-stream';
import { type BigIntStats } from 'node:fs';
import { opendir, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  NativeRoot,
  nativeIdentity,
  sameNative,
  sameObject,
  noFailpoint,
  type Failpoint,
  type NativeIdentity,
} from './native';
import { ownedReferenceSchema, nativeIdentitySchema, type LocalCodec } from './local-schema';
import {
  decodeRecord,
  decodeRecords,
  encodeRecord,
  rawSha,
  equal,
  add,
  type Value,
} from './encoding';
import { shaSchema } from './schema';
import type { WorkingBudget } from './tree-state';
import { BufferedWriter } from './buffered-writer';
import { abortableValues, withAbort } from './abort';
import {
  readLocalStream,
  readLocalRows,
  readLocalBatches,
  writeLocalStream,
  type LocalPurpose,
  type LocalStreamOptions,
  type LocalStreamSeal,
} from './local-stream';

export type Reference = ['ref', string, string, number, string];

export interface WrittenLocalStream {
  readonly reference: Reference;
  readonly native: NativeIdentity;
  readonly purpose: LocalPurpose;
  readonly partition: string | null;
  readonly maxDirectoryEntries: number;
  readonly headerEnd: number;
  readonly footerStart: number;
}

export const locatorSchema = z
  .tuple([z.literal('current'), z.literal(1), shaSchema, z.string()])
  .refine((r) => r[3] === cacheInvocationStatePath(r[2]));
export async function readFixedMetadata(root: NativeRoot, relative: string): Promise<Value | null> {
  const current = await root.stat(relative);
  if (!current) {
    return null;
  }
  if (BigInt(current[5]) > 65536n) {
    throw new Error('Fixed document exceeds record bound.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of root.read(relative, current)) {
    size = add(size, chunk.length);
    if (size > 65536) {
      throw new Error('Fixed document grew.');
    }
    chunks.push(chunk);
  }
  return decodeRecord(Buffer.concat(chunks));
}

/** Control records only; old payload and plans never become cleanup authority. */
export async function completedPreviousOwner(root: NativeRoot): Promise<string | null> {
  const raw = await readFixedMetadata(root, CACHE_METADATA_LOCATOR);
  if (raw === null) {
    return null;
  }
  const locator = locatorSchema.parse(raw),
    state = await readFixedMetadata(root, locator[3]);
  if (
    !Array.isArray(state) ||
    state.length !== 8 ||
    state[0] !== 'local-state' ||
    state[1] !== 2 ||
    state[2] !== locator[2] ||
    state[4] !== 'completed'
  ) {
    throw new Error(
      'Interrupted lifecycle; use a fresh dedicated root or handle retained data manually.',
    );
  }
  const reference = ownedReferenceSchema(locator[2], 'bindings').parse(state[5]);
  const binding = await readFixedMetadata(root, reference[2]);
  if (
    !Array.isArray(binding) ||
    binding.length !== 9 ||
    binding[1] !== 2 ||
    !Array.isArray(binding[5])
  ) {
    throw new Error('Missing previous root binding.');
  }
  const bytes = encodeRecord(binding);
  equal([bytes.length, rawSha(bytes)], [reference[3], reference[4]], 'previous bindings');
  const anchor = binding[5];
  if (anchor[0] !== root.path || !sameObject(nativeIdentitySchema.parse(anchor[1]), root.binding)) {
    throw new Error('Previous root binding changed.');
  }
  return locator[2];
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#durable-replacement-and-cursors
export class OwnedStore {
  private readonly writtenReferences = new WeakMap<object, Reference>();
  private readonly writtenNative = new WeakMap<object, NativeIdentity>();
  private readonly admittedNative = new WeakMap<object, NativeIdentity>();
  private readonly writtenStreams = new WeakMap<object, WrittenLocalStream>();

  /** Only the exact reference returned by this writer can transfer its original N. */
  completedFile(reference: Reference): NativeIdentity | undefined {
    const original = this.writtenReferences.get(reference);
    if (original) {
      equal(reference, original, 'completed file reference');
    }
    return this.writtenNative.get(reference);
  }

  completedStream(reference: Value): WrittenLocalStream | undefined {
    const proof =
      reference && typeof reference === 'object' ? this.writtenStreams.get(reference) : undefined;
    if (proof) {
      equal(reference, proof.reference, 'completed stream reference');
    }
    return proof;
  }

  readonly prefix: string;

  private constructor(
    readonly root: NativeRoot,
    readonly codec: LocalCodec,
    readonly fail: Failpoint,
  ) {
    this.prefix = codec.schemas.prefix;
  }

  static async bind(
    root: string,
    codec: LocalCodec,
    fail: Failpoint = noFailpoint,
  ): Promise<OwnedStore> {
    return new OwnedStore(
      await NativeRoot.bind(root, undefined, codec.options.context[7]),
      codec,
      fail,
    );
  }

  async makeParents(relative: string): Promise<void> {
    if (relative !== CACHE_METADATA_LOCATOR) {
      this.codec.schemas.owned.parse(relative);
    }
    await this.root.verifyRoot();
    let current = '';
    for (const part of relative.split('/').slice(0, -1)) {
      current = current ? current + '/' + part : part;
      const before = await this.root.stat(current);
      if (before) {
        if (before[2] !== 'directory') {
          throw new Error('Owned parent is not a directory.');
        }
        continue;
      }
      await mkdir(this.root.resolve(current));
      this.root.work.directoryCreations++;
    }
  }

  async write(
    purpose: string,
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
    budget?: WorkingBudget,
  ): Promise<Reference> {
    return this.writeAt(purpose, this.prefix + 'files/' + randomUUID(), source, signal, budget);
  }

  /** SDK raw upload names artifacts from the file basename; pin it before Q publication. */
  async writeNamedWorkerArchive(
    name: string,
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
  ): Promise<Reference> {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,232}\.tar\.gz$/.test(name)) {
      throw new Error('Invalid raw worker artifact filename.');
    }
    return this.writeAt(
      'worker-archive',
      this.prefix + 'archives/' + randomUUID() + '/' + name,
      source,
      signal,
    );
  }

  /** Native SDK metadata has fixed basenames before its immutable Q is exposed. */
  async writeNativeMetadata(
    root: string,
    name: 'envelope.json' | 'record.json',
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
    budget?: WorkingBudget,
  ): Promise<Reference> {
    this.codec.schemas.owned.parse(root);
    if (!['envelope.json', 'record.json'].includes(name)) {
      throw new Error('Unknown native metadata name.');
    }
    const purpose = {
      'envelope.json': 'envelope',
      'record.json': 'generation',
    }[name];
    if (!purpose) {
      throw new Error('Unknown native metadata name.');
    }
    return this.writeAt(purpose, root + '/' + name, source, signal, budget);
  }

  private async writeAt(
    purpose: string,
    target: string,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    budget?: WorkingBudget,
  ): Promise<Reference> {
    signal.throwIfAborted();
    const candidate = target + '.tmp';
    await this.makeParents(target);
    this.root.work.opens++;
    const handle = await open(this.root.resolve(candidate), 'wx', 0o600);
    let createdRaw: BigIntStats;
    try {
      createdRaw = await handle.stat({ bigint: true });
    } catch (error) {
      await handle.close();
      throw error;
    }
    const created = nativeIdentity(createdRaw),
      hash = createHash('sha256');
    let previousNative = created,
      writer: BufferedWriter | undefined;
    const checkWritten = async () => {
      this.root.work.stats++;
      const raw = await handle.stat({ bigint: true });
      if (raw.nlink !== 1n || !sameNative(previousNative, nativeIdentity(raw), true)) {
        throw new Error('Owned candidate changed outside its writer.');
      }
    };
    const wrote = async (length: number) => {
      this.root.work.stats++;
      const raw = await handle.stat({ bigint: true }),
        after = nativeIdentity(raw);
      if (
        raw.nlink !== 1n ||
        Number(raw.size) !== length ||
        created.some((v, i) => ![5, 7, 8, 9].includes(i) && v !== after[i])
      ) {
        throw new Error('Owned candidate write identity/length changed.');
      }
      previousNative = after;
    };
    if (budget) {
      writer = new BufferedWriter(
        handle,
        budget,
        (n) => {
          this.root.work.writeBytes = add(this.root.work.writeBytes, n);
        },
        0,
        () => {
          this.root.work.metadataWriteCalls++;
        },
        checkWritten,
        () => wrote(writer!.written),
      );
    }
    let bytes = 0;
    let movedIdentity: NativeIdentity | undefined;
    try {
      if (createdRaw.nlink !== 1n || createdRaw.size !== 0n) {
        throw new Error('Unsafe owned candidate.');
      }
      for await (const chunk of abortableValues(source, signal)) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 256 * 1024) {
          throw new Error('Invalid owned stream chunk.');
        }
        if (writer) {
          await writer.append(chunk);
        } else {
          await checkWritten();
          this.root.work.metadataWriteCalls++;
          await handle.writeFile(chunk);
          await wrote(bytes + chunk.byteLength);
          this.root.work.writeBytes = add(this.root.work.writeBytes, chunk.byteLength);
        }
        hash.update(chunk);
        bytes = add(bytes, chunk.byteLength);
      }
      if (!bytes) {
        throw new Error('Empty referenced bytes.');
      }
      signal.throwIfAborted();
      await writer?.flush();
      await checkWritten();
      const written = previousNative;
      await this.fail('immutable-file-written');
      await checkWritten();
      await handle.close();
      movedIdentity = await this.root.renameAbsent(candidate, target, written);
      await this.fail('immutable-rename');
      await this.fail('immutable-publication-barrier');
      const published = await this.root.stat(target);
      if (!published || !sameNative(movedIdentity, published, true)) {
        throw new Error('Published owned candidate changed.');
      }
      signal.throwIfAborted();
      const reference = this.codec.schemas
        .ref(purpose)
        .parse(['ref', purpose, target, bytes, hash.copy().digest('hex')]);
      this.writtenReferences.set(reference, Object.freeze([...reference]) as Reference);
      this.writtenNative.set(reference, Object.freeze([...movedIdentity]) as NativeIdentity);
      return reference;
    } catch (error) {
      await handle.close();
      try {
        // No reference escapes this method before return. On ordinary failure,
        // retire only our same native object; crashes leave discoverable owned files.
        for (const name of [candidate, target]) {
          const current = await this.root.stat(name);
          if (!current) {
            continue;
          }
          if (
            name === target
              ? !movedIdentity || !sameNative(movedIdentity, current, true)
              : !sameObject(created, current)
          ) {
            throw new Error('Unpublished candidate ownership is ambiguous.', { cause: error });
          }
          await unlink(this.root.resolve(name));
        }
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Owned write failed; candidate cleanup blocked.',
          { cause: cleanup },
        );
      }
      throw error;
    } finally {
      writer?.dispose();
      await handle.close();
    }
  }

  async writeDocument(value: Value): Promise<Reference> {
    const valid = this.codec.validate(value),
      purpose = String((valid as Value[])[0]),
      bytes = this.codec.encode(valid);
    if (
      [
        'current',
        'local-state',
        'install-intent',
        'gc-intent',
        'relocation',
        'retirement',
      ].includes(purpose)
    ) {
      throw new Error('Fixed document cannot be a Q candidate.');
    }
    return this.write(
      purpose,
      (async function* () {
        yield bytes;
      })(),
    );
  }

  async writeStream(
    purpose: LocalPurpose,
    options: Omit<LocalStreamOptions, 'codec'>,
    records: AsyncIterable<Value>,
    signal = new AbortController().signal,
    onRow?: (row: LocalRow) => Promise<void>,
  ): Promise<Reference> {
    const work = this.root.work,
      profile = { ...options, codec: this.codec };
    async function* counted() {
      for await (const row of abortableValues(records, signal)) {
        work.metadataRowsWritten++;
        yield row;
      }
    }
    let seal: LocalStreamSeal | undefined;
    const reference = await this.write(
      purpose,
      writeLocalStream(
        counted(),
        purpose,
        profile,
        (s) => {
          seal = s;
        },
        signal,
        onRow,
      ),
      signal,
      profile.budget,
    );
    // Only context-independent stream grammars participate in this producer handoff.
    if (purpose === 'observations') {
      if (!seal || seal.sha !== reference[4] || seal.bytes !== reference[3]) {
        throw new Error('Incomplete local writer seal.');
      }
      const header = [
        'local-stream',
        1,
        purpose,
        this.codec.options.invocation,
        this.codec.options.model.id,
        this.codec.options.model.family,
        profile.partition,
      ] as Value;
      this.writtenStreams.set(
        reference,
        Object.freeze({
          reference: Object.freeze([...reference]) as Reference,
          native: this.writtenNative.get(reference)!,
          purpose,
          partition: profile.partition,
          maxDirectoryEntries: profile.maxDirectoryEntries ?? 100000,
          headerEnd: encodeRecord(header).length,
          footerStart: seal.bytes - encodeRecord(['local-end', seal.records, seal.eventSha]).length,
        }),
      );
    }
    return reference;
  }

  async *read(reference: Value, purpose: string): AsyncGenerator<Buffer> {
    const ref = this.codec.schemas.ref(purpose).parse(reference),
      hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of this.root.read(ref[2])) {
      bytes = add(bytes, chunk.length);
      if (bytes > ref[3]) {
        throw new Error('Owned reference length exceeded.');
      }
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== ref[3] || hash.digest('hex') !== ref[4]) {
      throw new Error('Owned reference bytes changed.');
    }
  }

  async readDocument(reference: Value, purpose: string): Promise<Value> {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    if (ref[3] > 65536) {
      throw new Error('Local document exceeds record bound.');
    }
    const chunks: Buffer[] = [];
    for await (const bytes of this.read(ref, purpose)) {
      chunks.push(bytes);
    }
    return this.codec.decodeReferenced(Buffer.concat(chunks), ref);
  }

  async readStream(
    reference: Value,
    purpose: LocalPurpose,
    options: Omit<LocalStreamOptions, 'codec'>,
    event?: (value: Value) => Promise<void>,
    signal = new AbortController().signal,
  ): Promise<void> {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    // The stream reader supplies the same raw hash gate. Avoid hashing twice here.
    await readLocalStream(
      this.root.read(ref[2]),
      purpose,
      { ...options, codec: this.codec },
      ref,
      event,
      signal,
    );
  }

  async *rowBatches(
    reference: Value,
    purpose: LocalPurpose,
    options: Omit<LocalStreamOptions, 'codec'>,
    signal = new AbortController().signal,
    batchChargeLimit = options.budget.limit,
  ) {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    this.root.work.metadataValidations++;
    for await (const batch of readLocalBatches(
      this.root.read(ref[2]),
      purpose,
      { ...options, codec: this.codec },
      ref,
      signal,
      batchChargeLimit,
    )) {
      this.root.work.metadataBatches++;
      for (const row of batch) {
        if (
          Array.isArray(row.value) &&
          !['local-stream', 'local-end'].includes(String(row.value[0]))
        ) {
          this.root.work.metadataRowsRead++;
        }
      }
      yield batch;
    }
  }

  async *rows(
    reference: Value,
    purpose: LocalPurpose,
    options: Omit<LocalStreamOptions, 'codec'>,
    signal = new AbortController().signal,
    beforeAccept?: (value: Value) => Promise<void>,
  ) {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    const proof = this.completedStream(reference);
    if (
      proof &&
      options.installKind === undefined &&
      proof.purpose === purpose &&
      proof.partition === options.partition &&
      proof.maxDirectoryEntries === (options.maxDirectoryEntries ?? 100000)
    ) {
      let record = 0;
      for await (const row of decodeRecords(
        abortableValues(this.root.read(ref[2], proof.native), signal),
      )) {
        const release = options.budget.holdRecord(row.raw.length);
        try {
          signal.throwIfAborted();
          const data =
            Array.isArray(row.value) &&
            row.value[0] !== 'local-stream' &&
            row.value[0] !== 'local-end';
          if (data) {
            this.root.work.metadataRowsRead++;
            if (beforeAccept) {
              await withAbort(beforeAccept(row.value), signal);
            }
          }
          signal.throwIfAborted();
          yield { value: row.value, start: row.start, end: row.end, record: record++ };
        } finally {
          release();
        }
      }
      signal.throwIfAborted();
      return;
    }
    signal.throwIfAborted();
    this.root.work.metadataValidations++;
    let acceptedNative: NativeIdentity | undefined;
    for await (const row of readLocalRows(
      this.root.read(ref[2], undefined, (native) => {
        acceptedNative = native;
      }),
      purpose,
      { ...options, codec: this.codec },
      ref,
      signal,
      beforeAccept,
    )) {
      if (
        Array.isArray(row.value) &&
        row.value[0] !== 'local-stream' &&
        row.value[0] !== 'local-end'
      ) {
        this.root.work.metadataRowsRead++;
      }
      yield row;
    }
    if (!acceptedNative) {
      throw new Error('Missing completed metadata read identity.');
    }
    if (reference && typeof reference === 'object') {
      this.admittedNative.set(reference, acceptedNative);
    }
  }

  async readFixed(relative: string): Promise<Value | null> {
    return readFixedMetadata(this.root, relative);
  }

  private async fixed(relative: string, value: Value): Promise<void> {
    const bytes = this.codec.encode(value),
      candidate = relative + '.candidate';
    await this.makeParents(relative);
    const existing = await this.root.stat(candidate);
    if (existing) {
      if (existing[2] !== 'file') {
        throw new Error('Unsafe fixed-document candidate.');
      }
      await unlink(this.root.resolve(candidate));
    }
    this.root.work.opens++;
    const handle = await open(this.root.resolve(candidate), 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      this.root.work.writeBytes = add(this.root.work.writeBytes, bytes.length);
    } finally {
      await handle.close();
    }
    await this.fail('fixed-file-written');
    const target = await this.root.stat(relative);
    if (target && target[2] !== 'file') {
      throw new Error('Unsafe fixed target.');
    }
    await rename(this.root.resolve(candidate), this.root.resolve(relative));
    this.root.work.renames++;
    await this.fail('fixed-rename');
    await this.fail('fixed-publication-barrier');
  }

  async locator(): Promise<z.infer<typeof locatorSchema> | null> {
    const value = await this.readFixed(CACHE_METADATA_LOCATOR);
    return value === null ? null : locatorSchema.parse(value);
  }

  async state(): Promise<Value> {
    const locator = await this.locator();
    if (!locator || locator[2] !== this.codec.options.invocation) {
      throw new Error('Invocation is not current.');
    }
    const value = await this.readFixed(locator[3]);
    if (value === null) {
      throw new Error('Current state missing.');
    }
    return this.codec.schemas.documents['local-state'].parse(value);
  }

  async initialize(bindings: Value, previous?: OwnedStore): Promise<Value> {
    if (
      previous &&
      (previous.codec.options.invocation === this.codec.options.invocation ||
        previous.root.path !== this.root.path ||
        !sameObject(previous.root.binding, this.root.binding))
    ) {
      throw new Error('Invalid previous owner/root or same invocation.');
    }
    await this.assertNoIntents();
    const locator = await this.locator();
    if (locator) {
      const old = await completedPreviousOwner(this.root);
      if (old === this.codec.options.invocation) {
        throw new Error('Prepare cannot restart the same invocation.');
      }
    }
    const b = this.codec.schemas.documents.bindings.parse(this.codec.validate(bindings));
    if (b[5][0] !== this.root.path || !sameObject(b[5][1], this.root.binding)) {
      throw new Error('Bindings managed-root identity mismatch.');
    }
    const ref = await this.writeDocument(b),
      state: Value = [
        'local-state',
        2,
        this.codec.options.invocation,
        0,
        'prepare-pending',
        ref,
        null,
        null,
      ];
    await this.fixed(cacheInvocationStatePath(this.codec.options.invocation), state);
    await this.fixed(CACHE_METADATA_LOCATOR, [
      'current',
      1,
      this.codec.options.invocation,
      cacheInvocationStatePath(this.codec.options.invocation),
    ]);
    return state;
  }

  async updateState(value: Value): Promise<void> {
    const before = this.codec.schemas.documents['local-state'].parse(await this.state()),
      next = this.codec.schemas.documents['local-state'].parse(value);
    if (next[3] !== before[3] + 1) {
      throw new Error('State revision did not advance once.');
    }
    await this.fixed(cacheInvocationStatePath(this.codec.options.invocation), next);
  }

  async assertNoIntents(): Promise<void> {
    await checkRootIntents(this.root);
  }

  async retireAdmittedMetadata(reference: Reference): Promise<void> {
    const expected = this.admittedNative.get(reference);
    if (!expected) {
      throw new Error('Missing completed admitted metadata disposal owner.');
    }
    const actual = await this.root.stat(reference[2]);
    if (!actual || !sameNative(expected, actual, true)) {
      throw new Error('Admitted metadata changed; retained at ' + this.root.resolve(reference[2]));
    }
    await unlink(this.root.resolve(reference[2]));
    this.root.work.unlinks++;
    this.root.work.cleanupFiles++;
    this.admittedNative.delete(reference);
  }

  hasAdmittedMetadata(reference: Reference): boolean {
    return this.admittedNative.has(reference);
  }

  /** Original successful writer identity authorizes disposal, never a decoded reference or content rehash. */
  async retireProducedMetadata(reference: Reference): Promise<void> {
    const expected = this.writtenNative.get(reference);
    if (!expected) {
      throw new Error('Missing original produced metadata disposal owner.');
    }
    const actual = await this.root.stat(reference[2]);
    if (!actual) {
      return;
    }
    if (!sameNative(expected, actual, true)) {
      throw new Error('Produced metadata changed; retained at ' + this.root.resolve(reference[2]));
    }
    await unlink(this.root.resolve(reference[2]));
    this.root.work.unlinks++;
    this.root.work.cleanupFiles++;
    this.writtenNative.delete(reference);
    this.writtenStreams.delete(reference);
  }

  /** These Q purposes are referenced only by root-state cells, never arbitrary streams. */
  async retireReplacedDocument(reference: Value): Promise<void> {
    if (
      !Array.isArray(reference) ||
      !['bindings', 'install-progress', 'gc-progress', 'publication', 'quiescence'].includes(
        String(reference[1]),
      )
    ) {
      throw new Error('Retirement requires a root-state document.');
    }
    const ref = this.codec.schemas.ref(String(reference[1])).parse(reference),
      state = await this.state();
    const contains = (v: Value): boolean =>
      Array.isArray(v) && ((v[0] === 'ref' && v[2] === ref[2]) || v.some(contains));
    if (contains(state)) {
      throw new Error('Cannot retire referenced immutable bytes.');
    }
    // Revalidate exact old bytes before unlink; no recursive or name-only cleanup.
    for await (const chunk of this.read(ref, ref[1])) {
      void chunk;
    }
    await unlink(this.root.resolve(ref[2]));
    this.root.work.unlinks++;
  }

  /** Purpose-exclusive install metadata, detached by its owning installer. */
  async retireInstallMetadata(reference: Value): Promise<void> {
    this.codec.schemas.ref('install-plan').parse(reference);
    await this.retireProducedMetadata(reference as Reference);
  }
}

/** Disabled/no-owner admission uses the same conservative refusal checks. */
export async function assertNoRootIntents(root: NativeRoot) {
  await checkRootIntents(root);
}
async function checkRootIntents(root: NativeRoot) {
  for (const name of [
    'restore-move-v1.json',
    'groovy-apply-v1/intent.json',
    'workspace-apply-v2/intent.json',
    'workspace-apply-v3/intent.json',
    'cutoff-state-v2/current.json',
  ]) {
    if (await root.stat(CACHE_METADATA_DIRECTORY + '/' + name)) {
      throw new Error('Incompatible legacy destructive intent/lifecycle.');
    }
  }
  if (!(await root.stat(CACHE_METADATA_VERSION_DIRECTORY))) {
    return;
  }
  for await (const entry of await opendir(root.resolve(CACHE_METADATA_VERSION_DIRECTORY))) {
    if (entry.name === CACHE_METADATA_LOCATOR_NAME || !/^[a-f0-9]{64}$/.test(entry.name)) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Unsafe invocation discovery directory.');
    }
    const prefix = cacheInvocationPrefix(entry.name);
    for (const file of ['install-intent.json', 'gc-intent.json']) {
      if (await root.stat(prefix + file)) {
        throw new Error('Pending root-local destructive intent.');
      }
    }
    const relocation = prefix + 'relocation';
    if (await root.stat(relocation)) {
      for await (const marker of await opendir(root.resolve(relocation))) {
        if (marker.name.endsWith('.json')) {
          throw new Error('Pending root-local relocation.');
        }
      }
    }
  }
}
