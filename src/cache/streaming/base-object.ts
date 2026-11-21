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

import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeRecord, tuple, equal, add, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import {
  checkIdentity,
  objectKey,
  decodeEnvelope,
  type ObjectRef,
  type ObjectIdentity,
  type Envelope,
} from './native-records';
import { writeNativeTree, readNativeTree } from './native-tree';
import { walkNative, walkWork } from './native-walk';
import { NativeReadPhase } from './native-read-phase';
import { sameNative, type NativeIdentity } from './native';
import { type WorkingBudget, normalizeMode, parentPath, baseName } from './tree-state';
import { BaseSourceTree } from './base-source-tree';
import type { LocalRow } from './local-stream';
import { WorkerSpool } from './worker-spool';
import { PreparedWorkerSnapshot } from './worker-snapshot';
import { verifyNativeEvidence } from './install-evidence';
import { baseFileBytes, bindBaseFile, checkBaseLayout, nativeBaseFile } from './base-layout';

export interface BaseObjectOptions {
  readonly budget: WorkingBudget;
  readonly signal?: AbortSignal;
  readonly maxDirectoryEntries?: number;
}
const receipts = new WeakSet<object>();
// Protocol: docs/dev/native-base-protocol.md#payload-validation-and-installation.
// Per-object validity only: no installer/snapshot capability until the generation's group gate.
export class ValidatedBaseObject {
  private constructor(
    readonly store: OwnedStore,
    readonly root: string,
    readonly reference: ObjectRef,
    readonly envelope: Envelope,
    readonly tree: Reference,
    readonly evidence: Reference,
    readonly native: NativeIdentity,
    private readonly metadata: readonly NativeIdentity[],
  ) {
    Object.freeze(evidence);
    receipts.add(this);
    Object.freeze(this);
  }
  get payload(): string {
    return this.root + '/payload';
  }
  static async verify(
    store: OwnedStore,
    root: string,
    reference: ObjectRef,
    options: BaseObjectOptions,
    hashBodies = false,
    mode: 'restore' | 'prepared' | 'moving' = 'restore',
    expectedFacts?: AsyncIterable<Value>,
  ): Promise<ValidatedBaseObject> {
    options = Object.freeze({ ...options });
    reference = structuredClone(reference);
    checkIdentity(reference[1], store.codec.options.model);
    equal(reference[2], objectKey(reference[1]), 'object key');
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const native = await checkBaseLayout(store, root),
      envNative = await nativeBaseFile(store, root + '/envelope.json', 65536),
      envRef = await bindBaseFile(store, root + '/envelope.json', 'envelope', signal, 65536),
      envelope = decodeEnvelope(
        await baseFileBytes(store, envRef),
        reference,
        store.codec.options.model,
      ),
      treeNative = await nativeBaseFile(store, root + '/tree.ndjson'),
      tree = Object.freeze(
        store.codec.schemas
          .ref('native-tree')
          .parse(['ref', 'native-tree', root + '/tree.ndjson', envelope[5], envelope[6]]),
      ) as Reference,
      facts = await WorkerSpool.create(store, options.budget),
      phase = new NativeReadPhase(store.root, root + '/payload'),
      walker = walkNative(store.root, root + '/payload', {
        ...options,
        logicalRoot: '',
        metadata: 'reject',
      });
    const expected = expectedFacts?.[Symbol.asyncIterator]();
    let pending: Promise<void> | undefined,
      completed: ValidatedBaseObject | undefined,
      failure: unknown;
    const next = async () => {
      const result = await walker.next();
      if (result.done || result.value.tag === 'protected-child')
        throw new Error('Native payload membership mismatch.');
      return result.value;
    };
    try {
      await readNativeTree(
        store.root.read(tree[2], treeNative),
        { ...options, model: store.codec.options.model, identity: reference[1] },
        envelope,
        (value) => {
          pending = (async () => {
            const r = tuple(value),
              tag = r[0];
            if (tag === 'tree' || tag === 'unit-open' || tag === 'unit-close') return;
            if (tag === 'end') {
              if (expected && !(await expected.next()).done)
                throw new Error('Extra captured native source proof.');
              if (!(await walker.next()).done) throw new Error('Extra native payload member.');
              return;
            }
            const e = await next();
            const path = tag === 'file' ? e.path : String(r[1]);
            if (
              e.tag !==
                (tag === 'dir-open'
                  ? 'directory-open'
                  : tag === 'dir-close'
                    ? 'directory-close'
                    : 'file') ||
              e.path !== path
            )
              throw new Error('Native payload membership mismatch.');
            if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
              throw new Error('Aliased/cross-filesystem native payload.');
            if (expected && e.tag !== 'directory-close') {
              const fact = await expected.next();
              const r = fact.done ? [] : tuple(fact.value);
              if (
                r[0] !== (e.tag === 'file' ? 'file' : 'directory') ||
                r[1] !== e.path ||
                !sameNative(r[2] as NativeIdentity, e.identity, true)
              )
                throw new Error('Captured native source changed before sealing.');
              if (e.tag === 'file' && r[3] !== tuple(value)[5])
                throw new Error('Captured source hash changed.');
            }
            if (e.tag === 'directory-open') {
              await phase.enter(e.nativePath, e.identity);
              await facts.append(['directory', e.path, e.identity], signal);
            } else if (e.tag === 'directory-close') await phase.leave(e.nativePath, e.identity);
            else {
              // Path names are checked against the current tree directory, not the next native file alone.
              if (
                baseName(e.path) !== r[1] ||
                Number(e.identity[5]) !== r[2] ||
                (process.platform !== 'win32' &&
                  normalizeMode(store.codec.options.model.tuple[2], e.path, e.identity[6]) !==
                    r[3]) ||
                Number(BigInt(e.identity[8]) / 1000000n) !== r[4]
              )
                throw new Error('Native payload file metadata mismatch.');
              if (hashBodies && (await phase.hash(e.nativePath, e.identity, null, signal)) !== r[5])
                throw new Error('Native payload content differs from planned hash.');
              await facts.append(['file', e.path, e.identity, r[5], r[3]], signal);
            }
          })();
          return pending;
        },
        signal,
      );
      facts.seal(signal);
      const evidence = await store.writeStream(
        'native-evidence',
        { ...options, partition: reference[1][2] },
        canonicalFacts(store, root + '/payload', facts, mode, options.budget, signal),
        signal,
      );
      const after = await checkBaseLayout(store, root);
      if (!sameNative(native, after, true)) throw new Error('Native object root changed.');
      if (
        !sameNative(envNative, await nativeBaseFile(store, envRef[2], 65536), true) ||
        !sameNative(treeNative, await nativeBaseFile(store, tree[2]), true)
      )
        throw new Error('Native metadata changed after validation.');
      // Q publication is an invalidation boundary: recheck native N after sealing metadata.
      await verifyNativeEvidence(store, evidence, root + '/payload', reference[1][2], options);
      signal.throwIfAborted();
      completed = new ValidatedBaseObject(
        store,
        root,
        freezeRef(reference),
        Object.freeze(envelope.map((v) => (Array.isArray(v) ? Object.freeze(v) : v))) as Envelope,
        tree,
        evidence,
        Object.freeze(after) as NativeIdentity,
        Object.freeze([
          Object.freeze(envNative),
          Object.freeze(treeNative),
        ]) as readonly NativeIdentity[],
      );
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await pending?.catch(() => {});
      await settleBaseCleanup(
        [
          () => walker.return(undefined),
          () => expected?.return?.(undefined),
          () => facts.dispose(),
        ],
        failure,
      );
    }
    signal.throwIfAborted();
    return completed!;
  }
  static assertReceipt(object: ValidatedBaseObject, store?: OwnedStore): void {
    if (!receipts.has(object) || (store !== undefined && object.store !== store))
      throw new Error('Unbound native object proof.');
  }
  assertBound(store = this.store): void {
    ValidatedBaseObject.assertReceipt(this, store);
  }
  async verifyStable(options: BaseObjectOptions): Promise<void> {
    this.assertBound();
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const n = await checkBaseLayout(this.store, this.root);
    if (!sameNative(this.native, n, true)) throw new Error('Native archive root changed.');
    const names = ['envelope.json', 'tree.ndjson'];
    for (let i = 0; i < 2; i++)
      if (
        !sameNative(
          this.metadata[i],
          await nativeBaseFile(this.store, this.root + '/' + names[i]),
          true,
        )
      )
        throw new Error('Frozen native metadata changed.');
    await verifyNativeEvidence(
      this.store,
      this.evidence,
      this.payload,
      this.reference[1][2],
      options,
    );
  }
}
function freezeRef(ref: ObjectRef): ObjectRef {
  Object.freeze(ref[1]);
  return Object.freeze(ref) as ObjectRef;
}
// Protocol: docs/dev/native-base-protocol.md#native-tree-grammar.
// New prepared bytes: one guarded capture/hash pass, then native SDK reads for archiving.
const sources = new WeakSet<object>();
/** Pre-identity guarded source: native evidence can commit before decision/key derivation. */
export class PreparedBaseSource {
  private readonly lifecycle = {
    rendering: false,
    metadataDisposed: false,
    metadataRetiring: false,
    metadataBusy: false,
  };
  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly evidence: Reference,
    private readonly events: WorkerSpool,
    private readonly budget: WorkingBudget,
    readonly origin: 'baseline' | 'local-writer' | 'worker-writer',
    readonly provenance: string,
  ) {
    sources.add(this);
    Object.freeze(this);
  }
  get root(): string {
    return this.store.prefix + 'objects/' + this.partition;
  }
  get payload(): string {
    return this.root + '/payload';
  }
  static assertReceipt(source: PreparedBaseSource, store?: OwnedStore): void {
    if (!sources.has(source) || (store !== undefined && source.store !== store))
      throw new Error('Unbound prepared native source.');
  }
  snapshotSource(): Value {
    PreparedBaseSource.assertReceipt(this);
    return this.store.codec.schemas.source.parse([
      this.partition,
      this.origin,
      [this.origin, this.provenance],
      this.evidence,
      this.payload,
    ]);
  }
  async verifyStable(options: BaseObjectOptions): Promise<void> {
    PreparedBaseSource.assertReceipt(this);
    await verifyNativeEvidence(this.store, this.evidence, this.payload, this.partition, options);
    options.signal?.throwIfAborted();
  }
  async render(identity: ObjectIdentity, options: BaseObjectOptions): Promise<ValidatedBaseObject> {
    options = Object.freeze({ ...options });
    PreparedBaseSource.assertReceipt(this);
    identity = structuredClone(identity);
    checkIdentity(identity, this.store.codec.options.model, this.partition);
    if (options.budget !== this.budget)
      throw new Error('Native rendering requires the shared source budget.');
    if (
      this.lifecycle.rendering ||
      this.lifecycle.metadataDisposed ||
      this.lifecycle.metadataRetiring
    )
      throw new Error('Native source metadata is unavailable.');
    this.lifecycle.rendering = true;
    const store = this.store,
      root = this.root,
      model = store.codec.options.model,
      signal = options.signal ?? new AbortController().signal;
    try {
      await this.verifyStable(options);
      let envelope: Envelope | undefined;
      await writeBaseSourceMetadata(
        store,
        root,
        'tree.ndjson',
        writeNativeTree(
          this.events.rows(signal),
          { ...options, model, identity },
          (e) => {
            envelope = e;
          },
          signal,
        ),
        signal,
      );
      if (!envelope) throw new Error('Missing native tree seal.');
      const env = await writeBaseSourceMetadata(
          store,
          root,
          'envelope.json',
          (async function* () {
            yield encodeRecord(envelope!);
          })(),
          signal,
        ),
        reference: ObjectRef = ['object-ref', identity, objectKey(identity), env[3], env[4]],
        self = this;
      const expected = (async function* () {
        for await (const row of store.rows(self.evidence, 'native-evidence', {
          ...options,
          partition: self.partition,
        })) {
          const r = tuple(row.value);
          if (r[0] !== 'local-stream' && r[0] !== 'local-end') yield r;
        }
      })();
      const object = await ValidatedBaseObject.verify(
        store,
        root,
        reference,
        options,
        false,
        'prepared',
        expected,
      );
      signal.throwIfAborted();
      return object;
    } finally {
      this.lifecycle.rendering = false;
    }
  }
  /** Closes unpublished metadata, not the invocation-owned evidence/payload source. */
  async dispose(): Promise<void> {
    if (this.lifecycle.metadataDisposed) return;
    if (this.lifecycle.rendering) throw new Error('Native source has active rendering.');
    if (this.lifecycle.metadataBusy) throw new Error('Native metadata retirement already active.');
    this.lifecycle.metadataRetiring = true;
    this.lifecycle.metadataBusy = true;
    try {
      await this.events.dispose();
      this.lifecycle.metadataDisposed = true;
    } finally {
      this.lifecycle.metadataBusy = false;
    }
  }
  static async capture(
    store: OwnedStore,
    partition: string,
    options: BaseObjectOptions,
    source?: PreparedWorkerSnapshot,
  ): Promise<PreparedBaseSource> {
    options = Object.freeze({ ...options });
    partition = store.codec.schemas.partition.parse(partition);
    const signal = options.signal ?? new AbortController().signal,
      root = store.prefix + 'objects/' + partition,
      payload = root + '/payload',
      phase = new NativeReadPhase(store.root, payload),
      model = store.codec.options.model;
    if (source) {
      PreparedWorkerSnapshot.assertReceipt(source, store, partition);
      if (source.nativeRoot !== payload) {
        throw new Error('Prepared source is not the physical native payload.');
      }
    }
    signal.throwIfAborted();
    await assertUnkeyedSource(store, root);
    const builder = await BaseSourceTree.create(store, partition, options),
      events = builder.events;
    const proof: AsyncIterator<LocalRow, unknown> | null = source
      ? store
          .rows(source.evidence, 'native-evidence', { ...options, partition: partition })
          [Symbol.asyncIterator]()
      : null;
    const proofNext = async () => {
      let row = await proof!.next();
      if (!row.done && tuple(row.value.value)[0] === 'local-stream') row = await proof!.next();
      return row;
    };
    let completed: PreparedBaseSource | undefined,
      failure: unknown,
      captured: WorkerSpool | undefined;
    try {
      captured = await WorkerSpool.create(store, options.budget);
      for await (const e of walkNative(
        store.root,
        payload,
        { ...options, logicalRoot: '', metadata: 'reject' },
        walkWork(),
      )) {
        if (e.tag === 'protected-child') throw new Error('Protected native source.');
        if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
          throw new Error('Aliased/cross-filesystem native source.');
        if (e.tag === 'directory-open')
          await captured.append(['directory', e.path, e.identity], signal);
        let trusted: string | null = null;
        if (proof && e.tag !== 'directory-close') {
          const row = await proofNext();
          if (row.done) throw new Error('Missing prepared source evidence.');
          const r = tuple(row.value.value);
          if (
            r[0] !== (e.tag === 'file' ? 'file' : 'directory') ||
            r[1] !== e.path ||
            !sameNative(r[2] as NativeIdentity, e.identity, true)
          )
            throw new Error('Prepared native source changed.');
          if (e.tag === 'file') trusted = String(r[3]);
        }
        if (e.tag === 'directory-open') {
          await phase.enter(e.nativePath, e.identity);
          await builder.open(e.path, signal);
        } else if (e.tag === 'directory-close') {
          await builder.close(e.path, signal);
          await phase.leave(e.nativePath, e.identity);
        } else {
          if (model.owner(e.path)[0] !== partition)
            throw new Error('Wrong prepared native partition.');
          const size = Number(e.identity[5]),
            mode = normalizeMode(model.tuple[2], e.path, e.identity[6]);
          if (!Number.isSafeInteger(size) || size < 0)
            throw new Error('Native file length is not representable.');
          if (!canonicalBaseMode(e.identity[6], mode))
            throw new Error('Prepared native mode is not canonical.');
          const sha = await phase.hash(e.nativePath, e.identity, trusted, signal);
          await captured.append(['file', e.path, e.identity, sha], signal);
          await builder.file(
            e.path,
            size,
            mode,
            Number(BigInt(e.identity[8]) / 1000000n),
            sha,
            signal,
          );
        }
      }
      if (proof) {
        const end = await proofNext();
        if (end.done || tuple(end.value.value)[0] !== 'local-end' || !(await proof.next()).done)
          throw new Error('Extra prepared source evidence.');
      }
      builder.seal(signal);
      captured.seal(signal);
      const evidence = Object.freeze(
        await store.writeStream(
          'native-evidence',
          { ...options, partition },
          captured.rows(signal),
          signal,
        ),
      ) as Reference;
      await verifyNativeEvidence(store, evidence, payload, partition, options);
      completed = new PreparedBaseSource(
        store,
        partition,
        evidence,
        events,
        options.budget,
        source ? source.origin : 'local-writer',
        source ? source.provenance : store.codec.options.invocation,
      );
    } catch (error) {
      failure = error;
    }
    try {
      await settleBaseCleanup(
        [() => proof?.return?.(undefined), () => builder.disposeUnit(), () => captured?.dispose()],
        failure,
      );
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      await settleBaseCleanup([() => events.dispose()], failure);
      throw failure;
    }
    try {
      await assertUnkeyedSource(store, root);
      signal.throwIfAborted();
      return completed!;
    } catch (error) {
      await settleBaseCleanup([() => events.dispose()], error);
      throw error;
    }
  }
}
export async function captureBaseObject(
  store: OwnedStore,
  identity: ObjectIdentity,
  options: BaseObjectOptions,
  trusted?: PreparedWorkerSnapshot,
): Promise<ValidatedBaseObject> {
  identity = structuredClone(identity);
  checkIdentity(identity, store.codec.options.model);
  options = Object.freeze({ ...options });
  const source = await PreparedBaseSource.capture(store, identity[2], options, trusted);
  let result: ValidatedBaseObject;
  try {
    result = await source.render(identity, options);
  } finally {
    await source.dispose();
  }
  options.signal?.throwIfAborted();
  return result;
}
/** Allocate a prepared zero-transfer payload; never moves a live or retained source. */
export async function createBasePayload(store: OwnedStore, partition: string): Promise<string> {
  store.codec.schemas.partition.parse(partition);
  const payload = store.prefix + 'objects/' + partition + '/payload';
  await store.makeParents(payload);
  await mkdir(store.root.resolve(payload));
  await store.root.syncDirectory(parentPath(payload));
  return payload;
}

/** Native platform mode representation: Windows exposes writable/read-only, not Unix execute bits. */
export function canonicalBaseMode(native: number, portable: number): boolean {
  return process.platform === 'win32'
    ? (native & 0o200) === (portable & 0o200)
    : (native & 0o777) === portable;
}
async function* canonicalFacts(
  store: OwnedStore,
  payload: string,
  facts: WorkerSpool,
  mode: 'restore' | 'prepared' | 'moving',
  budget: WorkingBudget,
  signal: AbortSignal,
): AsyncGenerator<Value> {
  const phase = new NativeReadPhase(store.root, payload),
    stack: { path: string; native: NativeIdentity; release: () => void }[] = [];
  const leave = async () => {
    const top = stack.pop()!;
    try {
      await phase.leave(top.path, top.native);
    } finally {
      top.release();
    }
  };
  try {
    for await (const value of facts.rows(signal)) {
      const r = tuple(value),
        logical = String(r[1]),
        path = payload + (logical ? '/' + logical : ''),
        n = r[2] as NativeIdentity;
      const parent = r[0] === 'directory' && logical === '' ? null : parentPath(path);
      while (stack.length && stack[stack.length - 1].path !== parent) await leave();
      if (r[0] === 'directory') {
        await phase.enter(path, n);
        const release = budget.holdRecord(512 + Buffer.byteLength(path));
        stack.push({ path, native: n, release });
        yield value;
      } else {
        let actual = n;
        if (mode !== 'moving' && !canonicalBaseMode(n[6], Number(r[4]))) {
          if (mode === 'prepared')
            throw new Error(
              'Prepared native mode is not canonical; source evidence cannot be rewritten.',
            );
          actual = await phase.repairMode(path, n, Number(r[4]), signal);
          if (!canonicalBaseMode(actual[6], Number(r[4])))
            throw new Error('Native mode repair failed.');
        }
        yield ['file', logical, actual, r[3]];
      }
    }
    while (stack.length) await leave();
  } finally {
    for (const frame of stack) frame.release();
    stack.length = 0;
  }
}
export async function settleBaseCleanup(
  actions: (() => unknown)[],
  primary?: unknown,
): Promise<void> {
  const results = await Promise.allSettled(actions.map(async (action) => action()));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
  if (errors.length)
    throw new AggregateError(
      primary === undefined ? errors : [primary, ...errors],
      'Native object cleanup failed.',
    );
}

// An uncommitted partial render may be replayed only with the original genuine
// source. Existing immutable metadata is compared, never replaced or adopted by name.
export async function writeBaseSourceMetadata(
  store: OwnedStore,
  root: string,
  name: 'tree.ndjson' | 'envelope.json',
  bytes: AsyncIterable<Buffer>,
  signal: AbortSignal,
): Promise<Reference> {
  if (!(await store.root.stat(root + '/' + name)))
    return store.writeNativeMetadata(root, name, bytes, signal);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of bytes) {
    signal.throwIfAborted();
    size = add(size, chunk.length);
    hash.update(chunk);
  }
  const existing = await bindBaseFile(
    store,
    root + '/' + name,
    name === 'tree.ndjson' ? 'native-tree' : 'envelope',
    signal,
    name === 'envelope.json' ? 65536 : Number.MAX_SAFE_INTEGER,
  );
  if (existing[3] !== size || existing[4] !== hash.digest('hex'))
    throw new Error('Partial prepared metadata differs from the frozen identity.');
  return existing;
}

async function assertUnkeyedSource(store: OwnedStore, root: string): Promise<void> {
  for (const name of ['tree.ndjson', 'envelope.json'])
    if (await store.root.stat(root + '/' + name))
      throw new Error('Keyed metadata exists; cannot recapture an uncommitted native source.');
}
