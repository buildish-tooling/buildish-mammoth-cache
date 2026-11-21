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

import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, opendir } from 'node:fs/promises';
import { randomUUID, createHash, type Hash } from 'node:crypto';
import path from 'node:path';
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
import type { LocalCodec } from './local-schema';
import {
  decodeRecord,
  decodeRecords,
  encodeRecord,
  rawSha,
  add,
  Digest,
  type Value,
} from './encoding';
import { shaSchema } from './schema';
import { WorkingBudget } from './tree-state';
import { retireOwnedDirectory } from './owned-retirement';
import { abortableValues } from './abort';
import {
  readLocalStream,
  readLocalRows,
  readLocalPrefix,
  LocalStreamGrammar,
  writeLocalStream,
  type LocalPurpose,
  type LocalStreamOptions,
} from './local-stream';

export type Reference = ['ref', string, string, number, string];
export type Prefix = ['prefix', string, string, number, number, string];
const locatorSchema = z
  .tuple([z.literal('current'), z.literal(1), shaSchema, z.string()])
  .refine((r) => r[3] === `.mammoth/v1/${r[2]}/state.json`);
const fixedIntents = ['install-intent.json', 'gc-intent.json'];
// Protocol: docs/dev/cache-lifecycle-protocol.md#durable-replacement-and-cursors
export class OwnedStore {
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
    return new OwnedStore(await NativeRoot.bind(root), codec, fail);
  }
  async makeParents(relative: string): Promise<void> {
    if (relative !== '.mammoth/v1/current.json') this.codec.schemas.owned.parse(relative);
    await this.root.verifyRoot();
    let current = '';
    for (const part of relative.split('/').slice(0, -1)) {
      current = current ? current + '/' + part : part;
      const before = await this.root.stat(current);
      if (before) {
        if (before[2] !== 'directory') throw new Error('Owned parent is not a directory.');
        continue;
      }
      await mkdir(this.root.resolve(current));
      await this.root.syncDirectory(
        path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current),
      );
    }
  }
  async write(
    purpose: string,
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
  ): Promise<Reference> {
    return this.writeAt(purpose, this.prefix + 'files/' + randomUUID(), source, signal);
  }
  /** SDK raw upload names artifacts from the file basename; pin it before Q publication. */
  async writeNamedWorkerArchive(
    name: string,
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
  ): Promise<Reference> {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,232}\.tar\.gz$/.test(name))
      throw new Error('Invalid raw worker artifact filename.');
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
    name: 'tree.ndjson' | 'envelope.json' | 'record.json',
    source: AsyncIterable<Uint8Array>,
    signal = new AbortController().signal,
  ): Promise<Reference> {
    this.codec.schemas.owned.parse(root);
    if (!['tree.ndjson', 'envelope.json', 'record.json'].includes(name))
      throw new Error('Unknown native metadata name.');
    const purpose = {
      'tree.ndjson': 'native-tree',
      'envelope.json': 'envelope',
      'record.json': 'generation',
    }[name];
    if (!purpose) throw new Error('Unknown native metadata name.');
    return this.writeAt(purpose, root + '/' + name, source, signal);
  }
  private async writeAt(
    purpose: string,
    target: string,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Reference> {
    signal.throwIfAborted();
    const candidate = target + '.tmp';
    await this.makeParents(target);
    this.root.work.opens++;
    const handle = await open(this.root.resolve(candidate), 'wx', 0o600),
      created = nativeIdentity(await handle.stat({ bigint: true })),
      hash = createHash('sha256');
    let bytes = 0;
    let movedIdentity: NativeIdentity | undefined;
    try {
      for await (const chunk of abortableValues(source, signal)) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > 256 * 1024)
          throw new Error('Invalid owned stream chunk.');
        await handle.writeFile(chunk);
        this.root.work.writeBytes = add(this.root.work.writeBytes, chunk.byteLength);
        hash.update(chunk);
        bytes = add(bytes, chunk.byteLength);
      }
      if (!bytes) throw new Error('Empty referenced bytes.');
      signal.throwIfAborted();
      await handle.sync();
      this.root.work.fileSyncs++;
      await this.fail('immutable-file-sync');
      const written = nativeIdentity(await handle.stat({ bigint: true }));
      await handle.close();
      movedIdentity = await this.root.renameAbsent(candidate, target, written);
      await this.fail('immutable-rename');
      await this.root.syncDirectory(path.posix.dirname(target));
      await this.fail('immutable-publication-barrier');
      signal.throwIfAborted();
      return this.codec.schemas
        .ref(purpose)
        .parse(['ref', purpose, target, bytes, hash.copy().digest('hex')]);
    } catch (error) {
      await handle.close();
      try {
        // No reference escapes this method before return. On ordinary failure,
        // retire only our same native object; crashes leave discoverable owned files.
        for (const name of [candidate, target]) {
          const current = await this.root.stat(name);
          if (!current) continue;
          if (
            name === target
              ? !movedIdentity || !sameNative(movedIdentity, current, true)
              : !sameObject(created, current)
          )
            throw new Error('Unpublished candidate ownership is ambiguous.', { cause: error });
          if (
            name === target &&
            (await this.root.hash(name, current)) !== hash.copy().digest('hex')
          )
            throw new Error('Unpublished candidate bytes changed.', { cause: error });
          await unlink(this.root.resolve(name));
          await this.root.syncDirectory(path.posix.dirname(name));
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
    )
      throw new Error('Fixed document cannot be a Q candidate.');
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
  ): Promise<Reference> {
    return this.write(
      purpose,
      writeLocalStream(records, purpose, { ...options, codec: this.codec }, () => {}, signal),
      signal,
    );
  }
  async *read(reference: Value, purpose: string): AsyncGenerator<Buffer> {
    const ref = this.codec.schemas.ref(purpose).parse(reference),
      hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of this.root.read(ref[2])) {
      bytes = add(bytes, chunk.length);
      if (bytes > ref[3]) throw new Error('Owned reference length exceeded.');
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== ref[3] || hash.digest('hex') !== ref[4])
      throw new Error('Owned reference bytes changed.');
  }
  async readDocument(reference: Value, purpose: string): Promise<Value> {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    if (ref[3] > 65536) throw new Error('Local document exceeds record bound.');
    const chunks: Buffer[] = [];
    for await (const bytes of this.read(ref, purpose)) chunks.push(bytes);
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
  rows(
    reference: Value,
    purpose: LocalPurpose,
    options: Omit<LocalStreamOptions, 'codec'>,
    signal = new AbortController().signal,
    beforeAccept?: (value: Value) => Promise<void>,
  ) {
    const ref = this.codec.schemas.ref(purpose).parse(reference);
    return readLocalRows(
      this.root.read(ref[2]),
      purpose,
      { ...options, codec: this.codec },
      ref,
      signal,
      beforeAccept,
    );
  }
  async readFixed(relative: string): Promise<Value | null> {
    const current = await this.root.stat(relative);
    if (!current) return null;
    if (BigInt(current[5]) > 65536n) throw new Error('Fixed document exceeds record bound.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.root.read(relative, current)) {
      size = add(size, chunk.length);
      if (size > 65536) throw new Error('Fixed document grew.');
      chunks.push(chunk);
    }
    return decodeRecord(Buffer.concat(chunks));
  }
  private async fixed(relative: string, value: Value): Promise<void> {
    const bytes = this.codec.encode(value),
      candidate = relative + '.candidate';
    await this.makeParents(relative);
    const existing = await this.root.stat(candidate);
    if (existing) {
      if (existing[2] !== 'file') throw new Error('Unsafe fixed-document candidate.');
      await unlink(this.root.resolve(candidate));
      await this.root.syncDirectory(path.posix.dirname(candidate));
    }
    this.root.work.opens++;
    const handle = await open(this.root.resolve(candidate), 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      this.root.work.writeBytes = add(this.root.work.writeBytes, bytes.length);
      await handle.sync();
      this.root.work.fileSyncs++;
    } finally {
      await handle.close();
    }
    await this.fail('fixed-file-sync');
    const target = await this.root.stat(relative);
    if (target && target[2] !== 'file') throw new Error('Unsafe fixed target.');
    await rename(this.root.resolve(candidate), this.root.resolve(relative));
    this.root.work.renames++;
    await this.fail('fixed-rename');
    await this.root.syncDirectory(path.posix.dirname(relative));
    await this.fail('fixed-publication-barrier');
  }
  async locator(): Promise<z.infer<typeof locatorSchema> | null> {
    const value = await this.readFixed('.mammoth/v1/current.json');
    return value === null ? null : locatorSchema.parse(value);
  }
  async state(): Promise<Value> {
    const locator = await this.locator();
    if (!locator || locator[2] !== this.codec.options.invocation)
      throw new Error('Invocation is not current.');
    const value = await this.readFixed(locator[3]);
    if (value === null) throw new Error('Current state missing.');
    return this.codec.schemas.documents['local-state'].parse(value);
  }
  async initialize(bindings: Value, previous?: OwnedStore): Promise<Value> {
    if (
      previous &&
      (previous.codec.options.invocation === this.codec.options.invocation ||
        previous.root.path !== this.root.path ||
        !sameObject(previous.root.binding, this.root.binding))
    )
      throw new Error('Invalid previous owner/root or same invocation.');
    await this.assertNoIntents();
    const locator = await this.locator();
    if (locator) {
      if (
        !previous ||
        previous.root.path !== this.root.path ||
        locator[2] !== previous.codec.options.invocation
      )
        throw new Error('Existing lifecycle must be reconciled before initialization.');
      const old = previous.codec.schemas.documents['local-state'].parse(await previous.state());
      if (old[4] !== 'completed') throw new Error('Previous lifecycle is not complete.');
      await previous.resumeRetirements();
      const binding = previous.codec.schemas.documents.bindings.parse(
        await previous.readDocument(old[5], 'bindings'),
      );
      if (binding[5][0] !== this.root.path || !sameObject(binding[5][1], this.root.binding))
        throw new Error('Previous root binding changed.');
    }
    const b = this.codec.schemas.documents.bindings.parse(this.codec.validate(bindings));
    if (b[5][0] !== this.root.path || !sameObject(b[5][1], this.root.binding))
      throw new Error('Bindings managed-root identity mismatch.');
    const ref = await this.writeDocument(b),
      state: Value = [
        'local-state',
        1,
        this.codec.options.invocation,
        0,
        'prepare-pending',
        ref,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    await this.fixed(this.prefix + 'state.json', state);
    if (previous) await this.prepareRetirement(previous);
    await this.fixed('.mammoth/v1/current.json', [
      'current',
      1,
      this.codec.options.invocation,
      this.prefix + 'state.json',
    ]);
    if (previous) {
      await this.fail('retirement-owner-published');
      await this.resumeRetirements();
    }
    return state;
  }
  async updateState(value: Value): Promise<void> {
    const before = this.codec.schemas.documents['local-state'].parse(await this.state()),
      next = this.codec.schemas.documents['local-state'].parse(value);
    if (next[3] !== before[3] + 1) throw new Error('State revision did not advance once.');
    if (next[4] === 'completed') await this.resumeRetirements();
    await this.fixed(this.prefix + 'state.json', next);
  }
  // Protocol: docs/dev/cache-lifecycle-protocol.md#owned-metadata-retirement.
  // Callers close old consumers before completion. Only the dedicated private
  // terminal namespace is detached; live cache paths never enter this API.
  private async prepareRetirement(previous: OwnedStore): Promise<void> {
    if (
      previous.codec.options.invocation === this.codec.options.invocation ||
      previous.root.path !== this.root.path ||
      !sameObject(previous.root.binding, this.root.binding)
    )
      throw new Error('Invalid previous retirement owner/root.');
    const source = previous.prefix.slice(0, -1),
      from = await this.root.stat(source);
    if (!from || from[2] !== 'directory' || from[3] !== this.root.binding[3])
      throw new Error('Unsafe previous namespace.');
    const state = previous.codec.schemas.documents['local-state'].parse(
      await previous.readFixed(previous.prefix + 'state.json'),
    );
    if (state[4] !== 'completed') throw new Error('Previous lifecycle is not complete.');
    const binding = previous.codec.schemas.documents.bindings.parse(
      await previous.readDocument(state[5], 'bindings'),
    );
    if (binding[5][0] !== this.root.path || !sameObject(binding[5][1], this.root.binding))
      throw new Error('Previous retirement root binding changed.');
    await this.fixed(this.prefix + 'retirements/' + previous.codec.options.invocation + '.json', [
      'retirement',
      1,
      this.codec.options.invocation,
      previous.codec.options.invocation,
      from,
      rawSha(encodeRecord(state)),
      this.root.binding,
    ]);
    await this.fail('retirement-record-published');
  }
  private async checkRetirementOwner() {
    const state = this.codec.schemas.documents['local-state'].parse(await this.state());
    const bindings = this.codec.schemas.documents.bindings.parse(
      await this.readDocument(state[5], 'bindings'),
    );
    if (bindings[5][0] !== this.root.path || !sameObject(bindings[5][1], this.root.binding))
      throw new Error('Current retirement root binding changed.');
    await this.assertNoIntents();
  }
  async resumeRetirements(budget = new WorkingBudget()): Promise<void> {
    await this.checkRetirementOwner();
    const records = this.prefix + 'retirements',
      native = await this.root.stat(records);
    if (!native) {
      await this.assertRetiredEmpty();
      return;
    }
    if (native[2] !== 'directory' || native[3] !== this.root.binding[3])
      throw new Error('Unsafe retirement record directory.');
    const entries = await opendir(this.root.resolve(records), { bufferSize: 1 });
    try {
      while (true) {
        const entry = await entries.read();
        if (!entry) break;
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new Error('Unknown retirement record.');
        const name = records + '/' + entry.name;
        const record = this.codec.schemas.documents.retirement.parse(await this.readFixed(name));
        if (entry.name !== record[3] + '.json' || !sameObject(record[6], this.root.binding))
          throw new Error('Retirement record binding changed.');
        const source = '.mammoth/v1/' + record[3],
          parent = this.prefix + 'retired',
          target = parent + '/' + record[3];
        let from = await this.root.stat(source),
          to = await this.root.stat(target);
        if (from && to) throw new Error('Ambiguous retirement source and target.');
        if (from) {
          if (!sameNative(record[4], from, true))
            throw new Error('Previous namespace changed before detachment.');
          const state = await this.readFixed(source + '/state.json');
          if (
            !Array.isArray(state) ||
            state[0] !== 'local-state' ||
            state[1] !== 1 ||
            state[2] !== record[3] ||
            state[4] !== 'completed' ||
            rawSha(encodeRecord(state)) !== record[5]
          )
            throw new Error('Previous terminal state changed.');
          // Completion/initialize drain older records, preventing recursive garbage nesting.
          for (const folder of ['retired', 'retirements']) {
            const nested = await this.root.stat(source + '/' + folder);
            if (!nested) continue;
            if (nested[2] !== 'directory' || nested[3] !== this.root.binding[3])
              throw new Error('Unsafe previous retirement directory.');
            const children = await opendir(this.root.resolve(source + '/' + folder), {
              bufferSize: 1,
            });
            try {
              if (await children.read())
                throw new Error('Previous retirements must finish before detachment.');
            } finally {
              await children.close();
            }
          }
          await this.root.parents(parent);
          try {
            await mkdir(this.root.resolve(parent));
            await this.root.syncDirectory(this.prefix.slice(0, -1));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          const p = await this.root.stat(parent);
          if (!p || p[2] !== 'directory' || p[3] !== this.root.binding[3])
            throw new Error('Cross-filesystem retirement parent.');
          // Recheck after nested-directory reads (their atime is the sole allowed read effect).
          from = await this.root.stat(source);
          if (!from || !sameNative(record[4], from, true))
            throw new Error('Previous namespace changed during retirement validation.');
          to = await this.root.renameAbsent(source, target, from);
          await this.fail('retired-container-renamed');
        }
        if (to) {
          const expected = record[4];
          if (
            to[2] !== 'directory' ||
            to[3] !== expected[3] ||
            to[4] !== expected[4] ||
            to[6] !== expected[6] ||
            (process.platform !== 'win32' && to[10] !== expected[10])
          )
            throw new Error('Detached retirement container replaced.');
          await this.root.syncDirectory('.mammoth/v1');
          await this.root.syncDirectory(parent);
          await this.fail('retired-container-detached');
          await retireOwnedDirectory(this, target, to, budget, 'retired-member-retired');
          await this.fail('retired-container-retired');
        } else {
          // Neither location remains: resume the deletion namespace barrier before dropping authority.
          await this.root.syncDirectory('.mammoth/v1');
          if (await this.root.stat(parent)) await this.root.syncDirectory(parent);
        }
        const actual = await this.readFixed(name);
        if (actual === null || !encodeRecord(actual).equals(encodeRecord(record)))
          throw new Error('Retirement record changed.');
        await unlink(this.root.resolve(name));
        this.root.work.unlinks++;
        await this.root.syncDirectory(records);
        await this.fail('retirement-record-retired');
      }
    } finally {
      await entries.close();
    }
    await this.assertRetiredEmpty();
  }
  private async assertRetiredEmpty(): Promise<void> {
    const parent = this.prefix + 'retired',
      native = await this.root.stat(parent);
    if (!native) return;
    if (native[2] !== 'directory' || native[3] !== this.root.binding[3])
      throw new Error('Unsafe retired namespace.');
    const entries = await opendir(this.root.resolve(parent), { bufferSize: 1 });
    try {
      if (await entries.read()) throw new Error('Unrecorded retired container.');
    } finally {
      await entries.close();
    }
  }
  async publishIntent(value: Value): Promise<void> {
    await this.state();
    const valid = this.codec.validate(value),
      tag = (valid as Value[])[0];
    const relative =
      tag === 'install-intent' || tag === 'gc-intent'
        ? this.prefix + tag + '.json'
        : tag === 'relocation'
          ? this.prefix + 'relocation/' + (valid as Value[])[3] + '.json'
          : null;
    if (relative === null) throw new Error('Not a fixed destructive intent.');
    if (await this.readFixed(relative)) throw new Error('Outstanding destructive intent.');
    await this.fixed(relative, valid);
  }
  async clearIntent(expected: Value): Promise<void> {
    const valid = this.codec.validate(expected),
      row = valid as Value[],
      relative =
        row[0] === 'relocation'
          ? this.prefix + 'relocation/' + row[3] + '.json'
          : this.prefix + row[0] + '.json';
    if (!['install-intent', 'gc-intent', 'relocation'].includes(String(row[0])))
      throw new Error('Not a fixed intent.');
    const actual = await this.readFixed(relative);
    if (actual === null) return;
    if (rawSha(encodeRecord(actual)) !== rawSha(encodeRecord(valid)))
      throw new Error('Intent changed before retirement.');
    await unlink(this.root.resolve(relative));
    await this.root.syncDirectory(path.posix.dirname(relative));
    await this.fail('intent-retired');
  }
  async assertNoIntents(): Promise<void> {
    // Known old destructive formats never become executable new-format inputs.
    for (const name of [
      'restore-move-v1.json',
      'groovy-apply-v1/intent.json',
      'workspace-apply-v2/intent.json',
      'workspace-apply-v3/intent.json',
    ])
      if (await this.root.stat('.mammoth/' + name))
        throw new Error('Incompatible legacy destructive intent.');
    const legacy = '.mammoth/cutoff-state-v2/current.json';
    const legacyPointer = await this.root.stat(legacy);
    if (legacyPointer) {
      if (BigInt(legacyPointer[5]) > 4096n)
        throw new Error('Unrecognized legacy lifecycle pointer.');
      const chunks: Buffer[] = [];
      for await (const chunk of this.root.read(legacy, legacyPointer)) chunks.push(chunk);
      const pointer = z
        .object({
          schemaVersion: z.literal(1),
          journal: z.string().regex(/^journal-[a-f0-9-]{36}\.json$/),
        })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const file = '.mammoth/cutoff-state-v2/' + pointer.journal,
        { handle, identity } = await this.root.openRead(file);
      try {
        const bytes = Buffer.alloc(256);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const id = pointer.journal.slice(8, -5),
          prefix = `{"schemaVersion":6,"invocation":"${id}","phase":"completed",`;
        if (!bytes.subarray(0, bytesRead).toString('utf8').startsWith(prefix))
          throw new Error('Incompatible unfinished legacy lifecycle.');
        const current = await this.root.stat(file);
        if (!current || !sameNative(identity, current, true))
          throw new Error('Legacy lifecycle changed.');
      } finally {
        await handle.close();
      }
    }
    const base = '.mammoth/v1';
    if (!(await this.root.stat(base))) return;
    for await (const entry of await opendir(this.root.resolve(base))) {
      if (entry.name === 'current.json') continue;
      if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Unsafe invocation discovery directory.');
      for (const file of fixedIntents)
        if (await this.root.stat(base + '/' + entry.name + '/' + file))
          throw new Error('Pending root-local destructive intent.');
      const relocation = base + '/' + entry.name + '/relocation';
      if (await this.root.stat(relocation))
        for await (const marker of await opendir(this.root.resolve(relocation)))
          if (marker.name.endsWith('.json')) throw new Error('Pending root-local relocation.');
    }
  }
  /** These Q purposes are referenced only by root-state cells, never arbitrary streams. */
  async retireReplacedDocument(reference: Value): Promise<void> {
    if (
      !Array.isArray(reference) ||
      !['bindings', 'install-progress', 'gc-progress', 'publication', 'quiescence'].includes(
        String(reference[1]),
      )
    )
      throw new Error('Retirement requires a root-state document.');
    const ref = this.codec.schemas.ref(String(reference[1])).parse(reference),
      state = await this.state();
    const contains = (v: Value): boolean =>
      Array.isArray(v) && ((v[0] === 'ref' && v[2] === ref[2]) || v.some(contains));
    if (contains(state)) throw new Error('Cannot retire referenced immutable bytes.');
    // Revalidate exact old bytes before unlink; no recursive or name-only cleanup.
    for await (const chunk of this.read(ref, ref[1])) void chunk;
    await unlink(this.root.resolve(ref[2]));
    this.root.work.unlinks++;
    await this.root.syncDirectory(path.posix.dirname(ref[2]));
  }
  /** Purpose-exclusive install metadata, detached by its owning installer. */
  async retireInstallMetadata(reference: Value): Promise<void> {
    if (
      !Array.isArray(reference) ||
      !['install-plan', 'install-current', 'native-evidence', 'install-evidence'].includes(
        String(reference[1]),
      )
    )
      throw new Error('Not install-owned metadata.');
    const ref = this.codec.schemas.ref(String(reference[1])).parse(reference);
    const state = this.codec.schemas.documents['local-state'].parse(await this.state());
    if (await this.readFixed(this.prefix + 'install-intent.json'))
      throw new Error('Install metadata still has an intent owner.');
    if (ref[1] !== 'install-evidence' && state[11] !== null)
      throw new Error('Install metadata still has a progress owner.');
    if (!(await this.root.stat(ref[2]))) return;
    for await (const bytes of this.read(ref, ref[1])) void bytes;
    await unlink(this.root.resolve(ref[2]));
    this.root.work.unlinks++;
    await this.root.syncDirectory(path.posix.dirname(ref[2]));
  }
  async append(
    purpose: 'adjustments' | 'outbound-evidence' | 'return-evidence',
    partition: string,
    budget: WorkingBudget,
  ): Promise<OwnedAppend> {
    const relative = this.prefix + 'prefixes/' + randomUUID();
    await this.makeParents(relative);
    this.root.work.opens++;
    const handle = await open(this.root.resolve(relative), 'wx+', 0o600);
    const grammar = new LocalStreamGrammar(purpose, { codec: this.codec, budget, partition });
    const append = new OwnedAppend(
      this,
      purpose,
      relative,
      handle,
      grammar,
      createHash('sha256'),
      new Digest('local-' + purpose),
      0,
      0,
    );
    try {
      await append.header();
      return append;
    } catch (error) {
      await append.close();
      throw error;
    }
  }
  async resumePrefix(
    reference: Value,
    purpose: 'adjustments' | 'outbound-evidence' | 'return-evidence',
    partition: string,
    budget: WorkingBudget,
    intent: Value,
  ): Promise<OwnedAppend> {
    const prefix = this.codec.schemas.appendPrefix(purpose).parse(reference),
      marker = this.codec.schemas.documents.relocation.parse(intent);
    if (partition !== marker[3]) throw new Error('Prefix partition differs from relocation.');
    const actual = await this.readFixed(this.prefix + 'relocation/' + marker[3] + '.json');
    if (actual === null || rawSha(encodeRecord(actual)) !== rawSha(encodeRecord(marker)))
      throw new Error('Prefix has no matching live intent.');
    const committed =
      purpose === 'outbound-evidence'
        ? marker[11]
        : purpose === 'return-evidence'
          ? marker[12]
          : marker[13];
    if (
      !committed ||
      committed[0] !== 'prefix' ||
      rawSha(encodeRecord(committed)) !== rawSha(encodeRecord(prefix))
    )
      throw new Error('Prefix is not committed by intent.');
    const containsQ = (value: Value): boolean =>
      Array.isArray(value) &&
      ((value[0] === 'ref' && value[2] === prefix[2]) || value.some(containsQ));
    const state = this.codec.schemas.documents['local-state'].parse(await this.state());
    let published = containsQ(state) || containsQ(marker);
    if (state[9])
      await this.readStream(
        state[9],
        'partition-state',
        { budget, partition: null },
        async (row) => {
          if (containsQ(row)) published = true;
        },
      );
    if (published)
      throw new Error('Prefix is already published as immutable Q; reconcile retirement.');
    const before = await this.root.stat(prefix[2]);
    if (!before || BigInt(before[5]) < BigInt(prefix[3]))
      throw new Error('Committed prefix is missing.');
    const iterator = this.root.read(prefix[2], before)[Symbol.asyncIterator]();
    let remainder: Buffer | null = null;
    const clipped = (async function* () {
      let left = prefix[3];
      while (left > 0) {
        const next = await iterator.next();
        if (next.done) return;
        const size = Math.min(left, next.value.length);
        remainder = next.value.length > size ? next.value.subarray(size) : null;
        yield next.value.subarray(0, size);
        left -= size;
      }
    })();
    let restored: Awaited<ReturnType<typeof readLocalPrefix>> | undefined;
    try {
      restored = await readLocalPrefix(
        clipped,
        purpose,
        { codec: this.codec, budget, partition },
        prefix,
      );
      let tailReadFailed = false;
      const tail = (async function* () {
        if (remainder) yield remainder;
        while (true) {
          let next: IteratorResult<Buffer>;
          try {
            next = await iterator.next();
          } catch (error) {
            tailReadFailed = true;
            throw error;
          }
          if (next.done) return;
          yield next.value;
        }
      })();
      let sealed = false;
      try {
        for await (const row of decodeRecords(tail))
          if (Array.isArray(row.value) && row.value[0] === 'local-end') sealed = true;
      } catch (error) {
        if (sealed || tailReadFailed) throw error;
      } // Incomplete/malformed uncommitted tail may be discarded.
      if (sealed) {
        restored.grammar.dispose();
        throw new Error('Prefix is sealed; reconcile immutable candidate.');
      }
    } catch (error) {
      restored?.grammar.dispose();
      throw error;
    } finally {
      await iterator.return?.(undefined);
    }
    if (!restored) throw new Error('Prefix reload incomplete.');
    const after = await this.root.stat(prefix[2]);
    if (!after || !sameNative(before, after, true)) {
      restored.grammar.dispose();
      throw new Error('Prefix changed during reload.');
    }
    this.root.work.opens++;
    const handle = await open(
      this.root.resolve(prefix[2]),
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = nativeIdentity(await handle.stat({ bigint: true }));
      this.root.work.stats++;
      if (!sameNative(after, opened, true)) throw new Error('Prefix changed while opening.');
      await handle.truncate(prefix[3]);
      await handle.sync();
      this.root.work.fileSyncs++;
      return new OwnedAppend(
        this,
        purpose,
        prefix[2],
        handle,
        restored.grammar,
        restored.rawHash,
        restored.eventDigest,
        prefix[3],
        prefix[4],
      );
    } catch (error) {
      await handle.close();
      restored.grammar.dispose();
      throw error;
    }
  }
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#immutable-references-and-append-prefixes
export class OwnedAppend {
  private closed = false;
  private failed = false;
  constructor(
    private readonly store: OwnedStore,
    readonly purpose: string,
    readonly path: string,
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly grammar: LocalStreamGrammar,
    private readonly hash: Hash,
    private readonly events: Digest,
    private bytes: number,
    private records: number,
  ) {}
  private async writeEncoded(bytes: Buffer): Promise<void> {
    if (this.closed || this.failed) throw new Error('Closed/failed prefix.');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.handle.write(
          bytes,
          offset,
          bytes.length - offset,
          this.bytes + offset,
        );
        this.store.root.work.writeBytes = add(this.store.root.work.writeBytes, bytesWritten);
        if (!bytesWritten) throw new Error('Append made no progress.');
        offset += bytesWritten;
      }
      this.hash.update(bytes);
      this.bytes = add(this.bytes, bytes.length);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  async header(): Promise<void> {
    if (this.bytes !== 0) throw new Error('Duplicate prefix header.');
    const header = encodeRecord(this.grammar.header());
    await this.writeEncoded(header);
    this.events.encoded(header.subarray(0, -1));
  }
  async append(value: Value): Promise<void> {
    if (this.closed || this.failed) throw new Error('Closed/failed prefix.');
    const bytes = encodeRecord(value);
    try {
      this.grammar.accept(value);
      await this.writeEncoded(bytes);
      this.events.encoded(bytes.subarray(0, -1));
      this.records = add(this.records);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  async checkpoint(): Promise<Prefix> {
    if (this.closed || this.failed) throw new Error('Closed/failed prefix.');
    this.grammar.finish();
    await this.handle.sync();
    this.store.root.work.fileSyncs++;
    await this.store.root.syncDirectory(path.posix.dirname(this.path));
    return this.store.codec.schemas
      .appendPrefix(this.purpose)
      .parse([
        'prefix',
        this.purpose,
        this.path,
        this.bytes,
        this.records,
        this.hash.copy().digest('hex'),
      ]);
  }
  async seal(): Promise<Reference> {
    if (this.closed || this.failed) throw new Error('Closed/failed prefix.');
    this.grammar.finish();
    await this.writeEncoded(encodeRecord(['local-end', this.records, this.events.digest()]));
    await this.handle.sync();
    this.store.root.work.fileSyncs++;
    await this.handle.close();
    this.closed = true;
    this.grammar.dispose();
    await this.store.root.syncDirectory(path.posix.dirname(this.path));
    return this.store.codec.schemas
      .ref(this.purpose)
      .parse(['ref', this.purpose, this.path, this.bytes, this.hash.digest('hex')]);
  }
  async close(): Promise<void> {
    if (!this.closed) {
      await this.handle.close();
      this.closed = true;
      this.grammar.dispose();
    }
  }
}
