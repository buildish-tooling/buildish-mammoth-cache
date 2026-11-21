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

import { opendir } from 'node:fs/promises';
import type { BaseCacheBackend } from '../backend';
import type { OwnedStore, Reference } from './owned-store';
import { equal, encodeRecord, tuple, type Value } from './encoding';
import { decisionId, lineageId, writerId, type Decision } from './model';
import { policyId } from './local-schema';
import {
  createGeneration,
  decodeGeneration,
  type Generation,
  type ObjectRef,
} from './native-records';
import { PreparedBaseSource, ValidatedBaseObject, type BaseObjectOptions } from './base-object';
import { NativeObjectSave, NativeObjectDownload } from './base-transport';
import { deriveBaseGroups } from './base-incoming';
import { verifyNativeEvidence } from './install-evidence';
import { sameNative, type NativeIdentity } from './native';
import { baseFileBytes, bindBaseFile } from './base-layout';
import { saveNativeRecord } from './base-record-save';

type State = ReturnType<OwnedStore['codec']['schemas']['documents']['local-state']['parse']>;
type Cell = ReturnType<OwnedStore['codec']['schemas']['rows']['partitionState']['parse']>;
type ChoiceRow = ReturnType<
  OwnedStore['codec']['schemas']['rows']['publicationPartition']['parse']
>;
export type BasePublicationChoice =
  | { readonly kind: 'new'; readonly source: PreparedBaseSource }
  | { readonly kind: 'reuse'; readonly object: ValidatedBaseObject }
  | { readonly kind: 'empty'; readonly partition: string };
const genuine = new WeakSet<object>();
const data = (values: readonly Value[]) =>
  (async function* () {
    yield* values;
  })();
const signalOf = (o: BaseObjectOptions) => o.signal ?? new AbortController().signal;

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans.
// Isolated zero-transfer publisher: no live observation/GC/return engine or Action entrypoint.
export class FrozenBasePublication {
  private readonly lifecycle = { busy: false, disposed: false };
  private constructor(
    readonly store: OwnedStore,
    readonly publication: Reference,
    readonly generation: Generation,
    readonly record: Reference,
    private readonly rows: readonly ChoiceRow[],
    private readonly evidence: ReadonlyMap<string, Reference>,
    private readonly objects: ReadonlyMap<string, ValidatedBaseObject>,
    private readonly anchors: readonly Value[],
    private readonly options: BaseObjectOptions,
    private readonly release: () => void,
  ) {
    freezeValue(publication);
    freezeValue(generation);
    freezeValue(record);
    for (const row of rows) freezeValue(row);
    for (const q of evidence.values()) freezeValue(q);
    freezeValue(anchors);
    genuine.add(this);
    Object.freeze(this);
  }

  static async freeze(
    store: OwnedStore,
    ref: string,
    input: readonly BasePublicationChoice[],
    options: BaseObjectOptions,
  ): Promise<FrozenBasePublication> {
    options = Object.freeze({ ...options });
    if (input.length !== store.codec.options.model.partitions.length)
      throw new Error('Incomplete publication choices.');
    input = Object.freeze(input.map((c) => Object.freeze({ ...c })));
    const state = await publicationState(store),
      bindings = await store.readDocument(state[5], 'bindings'),
      b = store.codec.schemas.documents.bindings.parse(bindings);
    requireDirectoryPolicy(b[8][9], options);
    if (state[4] !== 'gc-complete' || state[8] !== null || state[9] !== null || !state[7])
      throw new Error('Publication requires committed post sources before identity derivation.');
    const committed = await zeroTransferGate(store, state, options);
    const model = store.codec.options.model,
      baseline = await baselineGeneration(store, b),
      decision: Decision = [
        'decision',
        1,
        store.codec.options.invocation,
        model.id,
        model.family,
        policyId(b[8]),
        state[6]![4],
        b[9]?.[1] ?? null,
        b[10][4],
        state[7][4],
      ],
      sha = decisionId(decision),
      lineage = lineageId(ref),
      writer = writerId(store.codec.options.invocation, store.codec.options.context),
      rows: ChoiceRow[] = [],
      cells: Cell[] = [],
      objects: ValidatedBaseObject[] = [];
    for (const [index, c] of input.entries()) {
      const p = model.partitions[index][0],
        previous = baseline?.[8][index];
      const cell: Cell = [
        'partition-state',
        p,
        [
          'baseline-partition',
          previous?.[0] === 'object' ? 'restored' : previous ? 'empty' : 'missing',
          previous?.[0] === 'object' ? previous[2] : null,
        ],
        null,
        null,
        null,
        null,
      ];
      const single = model.partitions[index][3] === 'single-writer';
      if (single) {
        const source = committed.find((s) => s[0] === p);
        if (!source) throw new Error('Missing committed source.');
        cell[4] = source;
      }
      if (c.kind === 'new') {
        PreparedBaseSource.assertReceipt(c.source, store);
        if (c.source.partition !== p) throw new Error('Unordered publication sources.');
        if (model.partitions[index][3] === 'single-writer') {
          const source = c.source.snapshotSource();
          await requirePostSource(store, state[7], source, options);
          cell[4] = store.codec.schemas.source.parse(source);
        }
        const object = await c.source.render(
            [model.family, model.id, p, lineage, writer, sha],
            options,
          ),
          plan = await store.writeStream(
            'move-plan',
            { ...options, partition: p, moveMode: 'prepared' },
            data([['prepared-source', c.source.evidence]]),
            signalOf(options),
          );
        const env: Reference = [
          'ref',
          'envelope',
          object.root + '/envelope.json',
          object.reference[3],
          object.reference[4],
        ];
        rows.push(
          store.codec.schemas.rows.publicationPartition.parse([
            'new',
            p,
            object.reference[1],
            object.reference[2],
            env,
            object.tree,
            plan,
          ]),
        );
        objects.push(object);
      } else if (c.kind === 'reuse') {
        ValidatedBaseObject.assertReceipt(c.object, store);
        if (previous?.[0] !== 'object') throw new Error('Reuse requires pinned baseline object.');
        equal(c.object.reference, previous[2], 'exact baseline reuse');
        rows.push(['reuse', p, previous[2]]);
        objects.push(c.object);
      } else {
        equal(c.partition, p, 'empty partition order');
        rows.push(['empty', p]);
      }
      if (single && c.kind !== 'new')
        await checkInheritedChoice(store, rows[rows.length - 1], cell[4]!, b[11], options);
      cells.push(cell);
    }
    const groups = await deriveBaseGroups(store, objects, options),
      generation = createGeneration(
        model,
        lineage,
        writer,
        sha,
        rows.map((r) => (r[0] === 'empty' ? ['empty', r[1]] : ['object', r[1], rowRef(r)])),
        groups.groups(),
      ),
      root = store.prefix + 'records/' + sha,
      record = await freezeRecord(store, root, generation, options),
      partitions = await store.writeStream(
        'publication-partitions',
        { ...options, partition: null },
        data(rows),
        signalOf(options),
      ),
      catalog = await store.writeStream(
        'partition-state',
        { ...options, partition: null },
        data(cells),
        signalOf(options),
      ),
      publication = await store.writeDocument([
        'publication',
        1,
        store.codec.options.invocation,
        decision,
        sha,
        state[7],
        partitions,
        record,
        generation[11],
      ]);
    // No SDK operation occurs before this atomic pointer. Uncommitted freeze orphans
    // are not restart authority; V5 must abandon them, never adopt them by pathname.
    await zeroTransferGate(store, state, options);
    for (const c of input) if (c.kind === 'new') await c.source.verifyStable(options);
    const current = await publicationState(store);
    equal(current, state, 'publication freeze state');
    current[3]++;
    current[4] = 'objects-frozen';
    current[8] = store.codec.schemas.ref('publication').parse(publication);
    current[9] = store.codec.schemas.ref('partition-state').parse(catalog);
    await store.updateState(current);
    return FrozenBasePublication.resume(store, options);
  }

  static async resume(
    store: OwnedStore,
    options: BaseObjectOptions,
  ): Promise<FrozenBasePublication> {
    options = Object.freeze({ ...options });
    const state = await publicationState(store);
    if (
      !state[8] ||
      !state[9] ||
      !state[7] ||
      ![
        'objects-frozen',
        'object-saved',
        'sources-returned',
        'final-source-barrier',
        'record-saved',
      ].includes(state[4])
    )
      throw new Error('No committed frozen publication to resume.');
    const pub = store.codec.schemas.documents.publication.parse(
        await store.readDocument(state[8], 'publication'),
      ),
      b = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      ),
      baseline = await baselineGeneration(store, b);
    requireDirectoryPolicy(b[8][9], options);
    equal(pub[5], state[7], 'committed publication sources');
    const decision: Decision = [
      'decision',
      1,
      store.codec.options.invocation,
      store.codec.options.model.id,
      store.codec.options.model.family,
      policyId(b[8]),
      state[6]![4],
      b[9]?.[1] ?? null,
      b[10][4],
      state[7][4],
    ];
    equal(pub[3], decision, 'frozen publication decision');
    const generation = decodeGeneration(
      await baseFileBytes(store, pub[7]),
      store.codec.options.model,
      pub[8],
    );
    equal(generation[7], pub[4], 'generation publication decision');
    equal(
      generation[6],
      writerId(store.codec.options.invocation, store.codec.options.context),
      'generation writer',
    );
    const rows: ChoiceRow[] = [],
      evidence = new Map<string, Reference>(),
      objects = new Map<string, ValidatedBaseObject>();
    let charge = 0;
    const hold = (v: Value) => {
      const n = 128 + 4 * encodeRecord(v).length;
      options.budget.retain(n);
      charge += n;
    };
    try {
      hold(generation);
      hold(pub);
      const committed = await zeroTransferGate(store, state, options);
      await store.readStream(
        pub[6],
        'publication-partitions',
        { ...options, partition: null },
        async (v) => {
          if (tuple(v)[0] === 'local-stream' || tuple(v)[0] === 'local-end') return;
          const r = store.codec.schemas.rows.publicationPartition.parse(v),
            index = rows.length;
          hold(r);
          rows.push(r);
          if (
            store.codec.options.model.partitions[index][3] === 'single-writer' &&
            r[0] !== 'new'
          ) {
            const source = committed.find((s) => s[0] === r[1]);
            if (!source) throw new Error('Missing committed source.');
            await checkInheritedChoice(store, r, source, b[11], options);
          }
          equal(
            generation[8][index],
            r[0] === 'empty' ? ['empty', r[1]] : ['object', r[1], rowRef(r)],
            'generation choices',
          );
          if (r[0] === 'reuse') {
            const old = baseline?.[8][index];
            if (old?.[0] !== 'object') throw new Error('Missing reuse baseline.');
            equal(r[2], old[2], 'frozen exact reuse');
          } else if (r[0] === 'new') {
            equal(r[2].slice(3), [generation[5], generation[6], pub[4]], 'new object identity');
            const root = store.prefix + 'objects/' + r[1];
            equal(r[4][2], root + '/envelope.json', 'prepared envelope location');
            equal(r[5][2], root + '/tree.ndjson', 'prepared tree location');
            let original: Reference | undefined;
            await store.readStream(
              r[6],
              'move-plan',
              { ...options, partition: r[1], moveMode: 'prepared' },
              async (value) => {
                const x = tuple(value);
                if (x[0] === 'prepared-source')
                  original = store.codec.schemas.ref('native-evidence').parse(x[1]);
              },
              signalOf(options),
            );
            if (!original) throw new Error('Missing original prepared source.');
            hold(original);
            evidence.set(r[1], original);
            const expected = (async function* () {
              for await (const item of store.rows(
                original!,
                'native-evidence',
                { ...options, partition: r[1] },
                signalOf(options),
              )) {
                const row = tuple(item.value);
                if (row[0] !== 'local-stream' && row[0] !== 'local-end') yield row;
              }
            })();
            const object = await ValidatedBaseObject.verify(
              store,
              root,
              rowRef(r),
              options,
              false,
              'prepared',
              expected,
            );
            equal(object.tree, r[5], 'frozen native tree');
            objects.set(r[1], object);
            const p = store.codec.options.model.partitions[index];
            if (p[3] === 'single-writer') {
              let found = false;
              await store.readStream(
                state[7]!,
                'post-sources',
                { ...options, partition: null },
                async (v) => {
                  const s = tuple(v);
                  if (s[0] === 'snapshot-source' && tuple(s[1])[0] === r[1]) {
                    const source = store.codec.schemas.source.parse(s[1]);
                    equal(source[3], original!, 'original snapshot evidence');
                    equal(source[4], root + '/payload', 'physical snapshot source');
                    found = true;
                  }
                },
                signalOf(options),
              );
              if (!found) throw new Error('Missing committed single-writer source.');
            }
          }
        },
        signalOf(options),
      );
      const result = new FrozenBasePublication(
        store,
        state[8],
        generation,
        pub[7],
        rows,
        evidence,
        objects,
        [state[5], state[6], state[7], state[10], state[13]],
        options,
        () => options.budget.release(charge),
      );
      const checkedCells = await result.cells(state);
      checkedCells.release();
      signalOf(options).throwIfAborted();
      return result;
    } catch (e) {
      options.budget.release(charge);
      throw e;
    }
  }

  private async state(): Promise<State> {
    if (!genuine.has(this) || this.lifecycle.disposed)
      throw new Error('Unavailable frozen publication.');
    const state = await publicationState(this.store);
    equal(state[8], this.publication, 'publication pointer');
    equal(
      [state[5], state[6], state[7], state[10], state[13]],
      this.anchors,
      'publication phase evidence',
    );
    if (
      ![
        'objects-frozen',
        'object-saved',
        'sources-returned',
        'final-source-barrier',
        'record-saved',
      ].includes(state[4])
    )
      throw new Error('Publication phase changed.');
    const pub = this.store.codec.schemas.documents.publication.parse(
      await this.store.readDocument(this.publication, 'publication'),
    );
    equal(state[7], pub[5], 'publication source pointer');
    return state;
  }
  private async cells(state: State): Promise<{ rows: Cell[]; release: () => void }> {
    let charge = 0;
    try {
      const cells: Cell[] = [];
      const stateSources = await zeroTransferGate(this.store, state, this.options);
      await this.store.readStream(
        state[9]!,
        'partition-state',
        { ...this.options, partition: null },
        async (v) => {
          if (tuple(v)[0] === 'local-stream' || tuple(v)[0] === 'local-end') return;
          const cell = this.store.codec.schemas.rows.partitionState.parse(v),
            r = this.rows[cells.length];
          equal(
            cell[4],
            stateSources.find((s) => s[0] === r[1]) ?? null,
            'partition source binding',
          );
          if (cell[3] !== null || cell[6] !== null)
            throw new Error('Moving source requires V4b return proof.');
          if (cell[5]) {
            if (r[0] !== 'new') throw new Error('Receipt without new object.');
            equal(
              cell[5].slice(2, 6),
              [r[1], r[3], r[4][4], this.generation[7]],
              'publication receipt binding',
            );
          }
          const n = 128 + 4 * encodeRecord(cell).length;
          this.options.budget.retain(n);
          charge += n;
          cells.push(cell);
        },
        signalOf(this.options),
      );
      return { rows: cells, release: () => this.options.budget.release(charge) };
    } catch (e) {
      this.options.budget.release(charge);
      throw e;
    }
  }
  private async sourceGate(state: State, partition?: string): Promise<void> {
    const post = await zeroTransferGate(this.store, state, this.options);
    const sources = new Map<string, { q: Reference; root: string }>();
    for (const [p, q] of this.evidence)
      sources.set(p, { q, root: this.store.prefix + 'objects/' + p + '/payload' });
    for (const source of post) {
      const original = sources.get(source[0]);
      if (original) {
        equal(original.q, source[3], 'deduplicated original source evidence');
        equal(original.root, source[4], 'deduplicated original source root');
      } else sources.set(source[0], { q: source[3], root: source[4] });
    }
    for (const [p, { q, root }] of sources) {
      if (partition !== undefined && p !== partition) continue;
      await verifyNativeEvidence(this.store, q, root, p, this.options);
    }
    signalOf(this.options).throwIfAborted();
  }
  async saveObjects(backend: BaseCacheBackend): Promise<void> {
    if (this.lifecycle.busy) throw new Error('Publication operation already active.');
    this.lifecycle.busy = true;
    let releaseCells = () => {};
    try {
      let state = await this.state();
      if (state[4] === 'record-saved') {
        signalOf(this.options).throwIfAborted();
        return;
      }
      const catalog = await this.cells(state),
        cells = catalog.rows;
      releaseCells = catalog.release;
      await this.sourceGate(state);
      for (const [index, r] of this.rows.entries()) {
        if (r[0] !== 'new' || cells[index][5]) continue;
        const object = this.objects.get(r[1])!;
        const saved = await NativeObjectSave.save(backend, object, this.options);
        let confirmation: Value | undefined;
        if (saved.serviceId !== null && !saved.barrierError)
          confirmation = ['save', String(saved.serviceId)];
        else {
          // A failed stage guard requires strong remote body verification before
          // receipt eligibility. This never rebases the original local source N.
          const readback = await NativeObjectDownload.restore(
            this.store,
            backend,
            rowRef(r),
            this.options,
            !!saved.barrierError,
          );
          try {
            if (readback.object) confirmation = ['readback', r[3]];
          } finally {
            await readback.dispose();
          }
        }
        if (!confirmation) throw new Error('Native object save remains unconfirmed.');
        state = await this.state();
        await this.sourceGate(state, r[1]);
        cells[index][5] = this.store.codec.schemas.documents['object-receipt'].parse([
          'object-receipt',
          1,
          r[1],
          r[3],
          r[4][4],
          this.generation[7],
          confirmation,
        ]);
        const catalog = await this.store.writeStream(
          'partition-state',
          { ...this.options, partition: null },
          data(cells),
          signalOf(this.options),
        );
        state = await this.state();
        state[3]++;
        state[4] = 'object-saved';
        state[9] = this.store.codec.schemas.ref('partition-state').parse(catalog);
        await this.store.updateState(state);
      }
      state = await this.state();
      await this.sourceGate(state);
      state[3]++;
      state[4] = 'sources-returned';
      await this.store.updateState(state);
      signalOf(this.options).throwIfAborted();
    } finally {
      releaseCells();
      this.lifecycle.busy = false;
    }
  }
  // Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
  // Only the exact frozen candidate is eligible, after all real object/source gates.
  async publish(backend: BaseCacheBackend): Promise<Generation> {
    if (this.lifecycle.busy) throw new Error('Publication operation already active.');
    this.lifecycle.busy = true;
    let releaseCells = () => {};
    try {
      let state = await this.state();
      if (state[4] === 'record-saved') {
        signalOf(this.options).throwIfAborted();
        return this.generation;
      }
      if (!['sources-returned', 'final-source-barrier'].includes(state[4]))
        throw new Error('Generation requires completed source gates.');
      const catalog = await this.cells(state);
      releaseCells = catalog.release;
      for (const [index, row] of this.rows.entries())
        if (row[0] === 'new' && catalog.rows[index][5] === null)
          throw new Error('Generation has an unconfirmed object.');
      await this.sourceGate(state);
      state[3]++;
      state[4] = 'final-source-barrier';
      await this.store.updateState(state);
      // The durable pointer replacement is a source invalidation boundary too.
      state = await this.state();
      await this.sourceGate(state);
      await saveNativeRecord(this.store, backend, this.record, this.generation[11], this.options);
      const current = await this.state();
      equal(current, state, 'record-save lifecycle state');
      current[3]++;
      current[4] = 'record-saved';
      await this.store.updateState(current);
      signalOf(this.options).throwIfAborted();
      return this.generation;
    } finally {
      releaseCells();
      this.lifecycle.busy = false;
    }
  }
  dispose(): void {
    if (this.lifecycle.busy) throw new Error('Publication has an active backend operation.');
    if (!this.lifecycle.disposed) {
      this.lifecycle.disposed = true;
      this.release();
    }
  }
}
function rowRef(r: Exclude<ChoiceRow, ['empty', string]>): ObjectRef {
  return r[0] === 'reuse' ? r[2] : ['object-ref', r[2], r[3], r[4][3], r[4][4]];
}
async function* dataBytes(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}
async function publicationState(store: OwnedStore): Promise<State> {
  const state = store.codec.schemas.documents['local-state'].parse(await store.state());
  if (
    store.codec.options.access !== 'writable' ||
    store.codec.options.role === 'distributed-worker'
  )
    throw new Error('Not a writable base publisher.');
  await store.assertNoIntents();
  return state;
}
export async function baselineGeneration(
  store: OwnedStore,
  b: ReturnType<OwnedStore['codec']['schemas']['documents']['bindings']['parse']>,
): Promise<Generation | null> {
  return b[9]
    ? decodeGeneration(await baseFileBytes(store, b[9][2]), store.codec.options.model, b[9][1])
    : null;
}
async function requirePostSource(
  store: OwnedStore,
  ref: Reference,
  source: Value,
  options: BaseObjectOptions,
) {
  let found = false;
  await store.readStream(
    ref,
    'post-sources',
    { ...options, partition: null },
    async (v) => {
      const r = tuple(v);
      if (r[0] === 'snapshot-source' && tuple(r[1])[0] === tuple(source)[0]) {
        equal(r[1], source, 'committed source');
        found = true;
      }
    },
    signalOf(options),
  );
  if (!found) throw new Error('Missing committed source.');
}
// No return boolean: actual no-transfer geometry, original root projection/full N,
// completed empty-GC boundary and every original post-source N are checked instead.
async function zeroTransferGate(
  store: OwnedStore,
  state: State,
  options: BaseObjectOptions,
): Promise<ReturnType<OwnedStore['codec']['schemas']['source']['parse']>[]> {
  await store.assertNoIntents();
  if (!state[6] || !state[7] || !state[10]) throw new Error('Missing source gate evidence.');
  let root: NativeIdentity | undefined,
    child: Value[] | undefined,
    end = 0,
    record = 0,
    count = 0;
  for await (const item of store.rows(
    state[6],
    'observations',
    { ...options, partition: null },
    signalOf(options),
  )) {
    const r = tuple(item.value);
    if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
    if (count === 0 && r[0] === 'dir-open' && r[1] === '') root = r[2] as NativeIdentity;
    else if (count === 1 && r[0] === 'child' && r[1] === '.mammoth' && r[2] === 'directory')
      child = [...r];
    else if (count === 2 && r[0] === 'dir-close' && r[1] === '') {
      end = item.end;
      record = item.record;
    } else throw new Error('Live sources/GC require the V4b source-return gate.');
    count++;
  }
  if (count !== 3 || !root || !child) throw new Error('Not an owned-only zero-transfer source.');
  const current = await store.root.stat(''),
    own = await store.root.stat('.mammoth');
  if (
    !current ||
    !sameNative(root, current, true) ||
    !own ||
    own[2] !== 'directory' ||
    own[3] !== child[3] ||
    own[4] !== child[4]
  )
    throw new Error('Zero-transfer root changed.');
  for await (const e of await opendir(store.root.path, { bufferSize: 2 }))
    if (e.name !== '.mammoth') throw new Error('Unobserved live source.');
  const after = await store.root.stat('');
  if (!after || !sameNative(root, after, true))
    throw new Error('Zero-transfer root changed during listing.');
  const gc = store.codec.schemas.documents['gc-progress'].parse(
    await store.readDocument(state[10], 'gc-progress'),
  );
  equal(gc[3], state[6], 'GC observation reference');
  if (
    gc[5] !== null ||
    gc[4][2] !== end ||
    gc[4][3] !== record ||
    gc[4][4] !== 0 ||
    gc[4][5] !== null
  )
    throw new Error('GC cursor not at empty final boundary.');
  const sources: ReturnType<OwnedStore['codec']['schemas']['source']['parse']>[] = [];
  await store.readStream(
    state[7],
    'post-sources',
    { ...options, partition: null },
    async (v) => {
      const r = tuple(v);
      if (r[0] === 'snapshot-source') {
        const source = store.codec.schemas.source.parse(r[1]);
        sources.push(source);
      }
    },
    signalOf(options),
  );
  signalOf(options).throwIfAborted();
  return sources;
}

export async function freezeRecord(
  store: OwnedStore,
  root: string,
  generation: Generation,
  options: BaseObjectOptions,
): Promise<Reference> {
  const bytes = encodeRecord(generation),
    target = root + '/record.json';
  if (!(await store.root.stat(target)))
    return store.writeNativeMetadata(root, 'record.json', dataBytes(bytes), signalOf(options));
  const q = await bindBaseFile(store, target, 'generation', signalOf(options), 65536);
  if (!(await baseFileBytes(store, q)).equals(bytes))
    throw new Error('Partial candidate record differs.');
  return q;
}

function freezeValue<T extends Value>(value: T): T {
  if (Array.isArray(value)) {
    for (const child of value) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

export async function checkInheritedChoice(
  store: OwnedStore,
  row: ChoiceRow,
  source: ReturnType<OwnedStore['codec']['schemas']['source']['parse']>,
  prepare: Reference,
  options: BaseObjectOptions,
): Promise<void> {
  if (row[0] === 'empty') {
    let count = 0;
    await store.readStream(
      source[3],
      'native-evidence',
      { ...options, partition: row[1] },
      async (v) => {
        const r = tuple(v);
        if (r[0] === 'local-stream' || r[0] === 'local-end') return;
        if (count++ !== 0 || r[0] !== 'directory' || r[1] !== '')
          throw new Error('Empty choice discards committed snapshot contents.');
      },
      signalOf(options),
    );
    if (count !== 1) throw new Error('Empty choice lacks root evidence.');
  } else if (row[0] === 'reuse') {
    if (source[1] !== 'baseline' || source[2][1] !== row[2][2])
      throw new Error('Reuse does not match inherited baseline snapshot.');
    let found = false;
    await store.readStream(
      prepare,
      'prepare-sources',
      { ...options, partition: null },
      async (v) => {
        const r = tuple(v);
        if (r[0] === 'snapshot-source' && tuple(r[1])[0] === row[1]) {
          equal(r[1], source, 'unchanged inherited snapshot');
          found = true;
        }
      },
      signalOf(options),
    );
    if (!found) throw new Error('Reuse lacks unchanged prepare snapshot.');
  }
}

function requireDirectoryPolicy(allowance: number, options: BaseObjectOptions): void {
  if ((options.maxDirectoryEntries ?? 100000) !== allowance)
    throw new Error('Publication directory allowance differs from committed policy.');
}
