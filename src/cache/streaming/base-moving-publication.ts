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

import { LiveBaseInputs } from './live-base-inputs';
import { FrozenBaseTree } from './base-frozen-tree';
import type { PartitionSummaries } from './partition-summaries';
import { freezeMovePlans, checkMovePlanMetadata } from './base-move-plan';
import { assertBaseMetadata, type BaseMetadata } from './baseline-metadata';
import { type BaseObjectOptions } from './base-object';
import { baselineGeneration, freezeRecord, checkInheritedChoice } from './base-publication';
import { deriveBaseGroups } from './base-incoming';
import { verifyNativeEvidence } from './install-evidence';
import { requirePostBindings } from './post-admission';
import { checkPublicationBindings } from './local-bindings';
import { equal, tuple, encodeRecord, type Value } from './encoding';
import { decisionId, lineageId, writerId, type Decision } from './model';
import { policyId } from './local-schema';
import { createGeneration, type Generation, type ObjectRef } from './native-records';
import { baseFileBytes } from './base-layout';
import type { OwnedStore, Reference } from './owned-store';

type Choice = ReturnType<OwnedStore['codec']['schemas']['rows']['publicationPartition']['parse']>;
export type MovingCell = ReturnType<
  OwnedStore['codec']['schemas']['rows']['partitionState']['parse']
>;
type State = ReturnType<OwnedStore['codec']['schemas']['documents']['local-state']['parse']>;
const genuine = new WeakSet<object>();
const data = (values: readonly Value[]) =>
  (async function* () {
    yield* values;
  })();
function immutable<T extends Value>(v: T): T {
  if (Array.isArray(v)) {
    for (const x of v) immutable(x);
    Object.freeze(v);
  }
  return v;
}
export const movingObjectRef = (row: Exclude<Choice, ['empty', string]>): ObjectRef =>
  row[0] === 'reuse' ? row[2] : ['object-ref', row[2], row[3], row[4][3], row[4][4]];

// Protocol: docs/dev/cache-lifecycle-protocol.md#moving-source-publication-handoff.
// Immutable transfer metadata only. V3's prepared-source admission is unchanged;
// neither construction nor resume represents evacuation/stage/return completion.
export class FrozenMovingPublication {
  private readonly life = { disposed: false };
  private constructor(
    readonly store: OwnedStore,
    readonly publication: Reference,
    readonly generation: Generation,
    readonly record: Reference,
    readonly choices: readonly Choice[],
    private readonly trees: ReadonlyMap<string, FrozenBaseTree>,
    private readonly anchors: readonly Value[],
    private readonly baseline: Generation | null,
    private readonly sources: ReadonlyMap<
      string,
      ReturnType<OwnedStore['codec']['schemas']['source']['parse']>
    >,
    readonly options: BaseObjectOptions,
    private readonly release: () => void,
  ) {
    immutable(publication);
    immutable(generation);
    immutable(record);
    for (const anchor of anchors) immutable(anchor);
    if (baseline) immutable(baseline);
    for (const source of sources.values()) immutable(source);
    for (const c of choices) immutable(c);
    genuine.add(this);
    Object.freeze(this);
  }
  static assert(pub: FrozenMovingPublication, store = pub.store) {
    if (!genuine.has(pub) || pub.store !== store || pub.life.disposed)
      throw new Error('Unavailable moving publication.');
    pub.options.signal?.throwIfAborted();
  }
  static async freeze(
    input: LiveBaseInputs,
    ref: string,
    baseline: readonly BaseMetadata[] = [],
    summaries?: PartitionSummaries,
  ): Promise<FrozenMovingPublication> {
    LiveBaseInputs.assert(input);
    const { store, options } = input.view,
      model = store.codec.options.model,
      signal = options.signal ?? new AbortController().signal;
    summaries?.assert(model);
    if (baseline.length > model.partitions.length)
      throw new Error('Baseline metadata frontier exceeded.');
    baseline = Object.freeze([...baseline]);
    let retained = 0;
    const hold = (value: Value, extra = 0) => {
      const n = 512 + encodeRecord(value).length * 8 + extra;
      options.budget.retain(n);
      retained += n;
    };
    try {
      const state = store.codec.schemas.documents['local-state'].parse(await store.state());
      hold(state);
      const b = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      );
      hold(b);
      await requirePostBindings(store, state, b, options);
      await store.assertNoIntents();
      if (state[4] !== 'gc-complete' || state[8] || state[9])
        throw new Error('Moving freeze requires uncommitted GC completion.');
      equal(state[7], input.postSources, 'moving post sources');
      equal(state[6], input.view.observations, 'moving observation');
      const previous = await baselineGeneration(store, b),
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
          input.postSources[4],
        ],
        sha = decisionId(decision),
        lineage = lineageId(ref),
        writer = writerId(store.codec.options.invocation, store.codec.options.context),
        rows: Choice[] = [],
        drafts: (Choice | FrozenBaseTree)[] = [],
        cells: MovingCell[] = [],
        all: FrozenBaseTree[] = [],
        changed: FrozenBaseTree[] = [];
      if (previous) hold(previous);
      hold(decision);
      await input.view.assertStable();
      const seen = new Set<string>();
      for (const old of baseline) {
        assertBaseMetadata(old, store);
        hold([old.reference, old.envelope, old.tree], 8192);
        const p = old.reference[1][2],
          i = model.partitions.findIndex((d) => d[0] === p),
          expected = previous?.[8][i];
        if (seen.has(p) || expected?.[0] !== 'object')
          throw new Error('Invalid pinned baseline metadata.');
        equal(old.reference, expected[2], 'exact pinned baseline metadata');
        seen.add(p);
      }
      for (const [i, source] of input.partitions.entries()) {
        const p = model.partitions[i][0],
          old = previous?.[8][i],
          tree = await FrozenBaseTree.render(input, p, [
            model.family,
            model.id,
            p,
            lineage,
            writer,
            sha,
          ]);
        hold([tree.reference, tree.envelope, tree.tree, tree.envelopeRef], 8192);
        all.push(tree);
        const prior = baseline.find((o) => o.reference[1][2] === p);
        let row: Choice | FrozenBaseTree;
        const inherited = source.snapshot;
        if (tree.empty) row = ['empty', p];
        else if (
          prior &&
          old?.[0] === 'object' &&
          encodeRecord([prior.envelope[7], prior.envelope[8]]).equals(
            encodeRecord([tree.envelope[7], tree.envelope[8]]),
          ) &&
          (!inherited || (inherited[1] === 'baseline' && inherited[2][1] === old[2][2]))
        )
          row = ['reuse', p, old[2]];
        else {
          changed.push(tree);
          row = tree;
        }
        drafts.push(row);
        if (inherited && !(row instanceof FrozenBaseTree))
          await checkInheritedChoice(store, row, inherited, b[11], options);
        cells.push([
          'partition-state',
          p,
          [
            'baseline-partition',
            old?.[0] === 'object' ? 'restored' : old ? 'empty' : 'missing',
            old?.[0] === 'object' ? old[2] : null,
          ],
          null,
          inherited,
          null,
          null,
        ]);
        hold(cells[cells.length - 1]);
        if (!(row instanceof FrozenBaseTree)) hold(row);
      }
      const plans = await freezeMovePlans(input, changed, summaries);
      for (const draft of drafts)
        rows.push(
          store.codec.schemas.rows.publicationPartition.parse(
            draft instanceof FrozenBaseTree
              ? [
                  'new',
                  draft.reference[1][2],
                  draft.reference[1],
                  draft.reference[2],
                  draft.envelopeRef,
                  draft.tree,
                  plans.get(draft.reference[1][2]),
                ]
              : draft,
          ),
        );
      for (const row of rows) hold(row);
      for (const q of plans.values()) hold(q);
      const groups = await deriveBaseGroups(store, all, options);
      const generation = createGeneration(
        model,
        lineage,
        writer,
        sha,
        rows.map((r) =>
          r[0] === 'empty' ? ['empty', r[1]] : ['object', r[1], movingObjectRef(r)],
        ),
        groups.groups(),
      );
      hold(generation);
      const record = await freezeRecord(
        store,
        store.prefix + 'records/' + sha,
        generation,
        options,
      );
      hold(record);
      const partitions = await store.writeStream(
        'publication-partitions',
        { ...options, partition: null },
        data(rows),
        signal,
      );
      hold(partitions);
      const catalog = await store.writeStream(
        'partition-state',
        { ...options, partition: null },
        data(cells),
        signal,
      );
      hold(catalog);
      const publication = await store.writeDocument([
        'publication',
        1,
        store.codec.options.invocation,
        decision,
        sha,
        input.postSources,
        partitions,
        record,
        generation[11],
      ]);
      hold(publication);
      await input.view.assertStable();
      for (const tree of all) await tree.assertStable(options);
      await store.assertNoIntents();
      equal(await store.state(), state, 'moving freeze state');
      await store.fail('moving-publication-candidate');
      state[3]++;
      state[4] = 'objects-frozen';
      state[8] = store.codec.schemas.ref('publication').parse(publication);
      state[9] = store.codec.schemas.ref('partition-state').parse(catalog);
      await store.updateState(state);
      await store.fail('moving-publication-pointer');
      await input.view.assertStable();
      for (const source of input.partitions)
        if (source.nativeRoot)
          await verifyNativeEvidence(
            store,
            source.evidence,
            source.nativeRoot,
            source.partition,
            options,
          );
      const result = await FrozenMovingPublication.resume(store, options);
      for (const choice of result.choices) summaries?.choice(choice[1], choice[0]);
      return result;
    } finally {
      options.budget.release(retained);
    }
  }
  static async resume(
    store: OwnedStore,
    input: BaseObjectOptions,
  ): Promise<FrozenMovingPublication> {
    const options = Object.freeze({
        ...input,
        signal: input.signal ?? new AbortController().signal,
      }),
      state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (
      !state[8] ||
      !state[9] ||
      !state[7] ||
      state[7][1] !== 'post-sources' ||
      !movingPhase(state[4])
    )
      throw new Error('No frozen moving publication.');
    const b = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      ),
      pub = store.codec.schemas.documents.publication.parse(
        await store.readDocument(state[8], 'publication'),
      );
    await requirePostBindings(store, state, b, options);
    const generation = checkPublicationBindings(
        store.codec,
        state,
        b,
        pub,
        await baseFileBytes(store, pub[7]),
      ),
      previous = await baselineGeneration(store, b),
      rows: Choice[] = [],
      trees = new Map<string, FrozenBaseTree>(),
      sources = new Map<string, ReturnType<OwnedStore['codec']['schemas']['source']['parse']>>();
    let charge = 0,
      returned = false;
    const hold = (v: Value) => {
      const n = 512 + encodeRecord(v).length * 8;
      options.budget.retain(n);
      charge += n;
    };
    try {
      hold(generation);
      if (previous) hold(previous);
      for (const anchor of [state[5], state[6], state[7], state[10], state[13], state[8]])
        if (anchor) hold(anchor);
      await store.readStream(
        state[7],
        'post-sources',
        { ...options, partition: null },
        async (v) => {
          const r = tuple(v);
          if (r[0] === 'snapshot-source') {
            const s = store.codec.schemas.source.parse(r[1]);
            hold(s);
            sources.set(s[0], s);
          }
        },
        options.signal,
      );
      await store.readStream(
        pub[6],
        'publication-partitions',
        { ...options, partition: null },
        async (v) => {
          const r = tuple(v);
          if (r[0] === 'local-stream' || r[0] === 'local-end') return;
          const row = store.codec.schemas.rows.publicationPartition.parse(v),
            i = rows.length;
          hold(row);
          rows.push(row);
          equal(
            generation[8][i],
            row[0] === 'empty' ? ['empty', row[1]] : ['object', row[1], movingObjectRef(row)],
            'moving generation choice',
          );
          if (row[0] === 'reuse') {
            const old = previous?.[8][i];
            if (old?.[0] !== 'object') throw new Error('Moving reuse lacks pinned baseline.');
            equal(row[2], old[2], 'moving exact reuse');
          }
          const source = sources.get(row[1]);
          if (modelSingle(store, row[1]) && !source) throw new Error('Missing moving post source.');
          if (source && row[0] !== 'new')
            await checkInheritedChoice(store, row, source, b[11], options);
          if (row[0] !== 'new') return;
          equal(row[2].slice(3), [generation[5], generation[6], pub[4]], 'moving new identity');
          const tree = await FrozenBaseTree.read(store, movingObjectRef(row), options);
          equal(row[4], tree.envelopeRef, 'moving envelope ref');
          equal(row[5], tree.tree, 'moving tree ref');
          trees.set(row[1], tree);
          hold(tree.envelope);
          options.budget.retain(8192);
          charge += 8192; // fixed native metadata/proof frontier per partition
          await store.readStream(
            row[6],
            'move-plan',
            { ...options, partition: row[1] },
            async (v) => {
              const move = tuple(v);
              if (move[0] !== 'move') return;
              equal(tuple(move[6])[1], row[5][4], 'move portable span source');
              if (move[2] === 'live') {
                if (source || move[3] !== move[4]) throw new Error('Invalid moving live location.');
                equal(tuple(move[7])[1], state[6]![4], 'move original observation span');
              } else {
                if (!source || move[3] !== source[4] + '/' + move[4])
                  throw new Error('Invalid moving owned location.');
                equal(tuple(move[7])[1], source[3][4], 'move original owned span');
              }
            },
            options.signal,
          );
        },
        options.signal,
      );
      await checkMovePlanMetadata(
        store,
        state[6]!,
        rows.flatMap((row) =>
          row[0] !== 'new'
            ? []
            : [
                {
                  partition: row[1],
                  plan: row[6],
                  tree: trees.get(row[1])!,
                  source: sources.has(row[1])
                    ? {
                        partition: row[1],
                        nativeRoot: sources.get(row[1])![4],
                        evidence: sources.get(row[1])![3],
                        snapshot: sources.get(row[1])!,
                      }
                    : null,
                },
              ],
        ),
        options,
      );
      const result = new FrozenMovingPublication(
        store,
        state[8],
        generation,
        pub[7],
        Object.freeze(rows),
        trees,
        [state[5], state[6], state[7], state[10], state[13]],
        previous,
        sources,
        options,
        () => options.budget.release(charge),
      );
      const checked = await result.cells();
      checked.release();
      equal(await store.state(), state, 'moving resume state');
      options.signal.throwIfAborted();
      returned = true;
      return result;
    } finally {
      if (!returned) options.budget.release(charge);
    }
  }
  async state(): Promise<State> {
    FrozenMovingPublication.assert(this);
    const state = this.store.codec.schemas.documents['local-state'].parse(await this.store.state());
    if (!movingPhase(state[4])) throw new Error('Invalid moving publication phase.');
    equal(state[8], this.publication, 'same moving publication');
    equal(
      [state[5], state[6], state[7], state[10], state[13]],
      this.anchors,
      'unchanged moving source anchors',
    );
    return state;
  }
  tree(partition: string): FrozenBaseTree {
    FrozenMovingPublication.assert(this);
    const tree = this.trees.get(partition);
    if (!tree) throw new Error('No changed moving partition tree.');
    return tree;
  }
  async cells(): Promise<{ rows: MovingCell[]; release(): void }> {
    const state = await this.state(),
      result: MovingCell[] = [];
    let charge = 0,
      returned = false;
    try {
      await this.store.readStream(
        state[9]!,
        'partition-state',
        { ...this.options, partition: null },
        async (v) => {
          const r = tuple(v);
          if (r[0] === 'local-stream' || r[0] === 'local-end') return;
          const cell = this.store.codec.schemas.rows.partitionState.parse(v),
            row = this.choices[result.length];
          if (!row || row[1] !== cell[1]) throw new Error('Moving catalog partition mismatch.');
          const old = this.baseline?.[8][result.length];
          equal(
            cell[2],
            [
              'baseline-partition',
              old?.[0] === 'object' ? 'restored' : old ? 'empty' : 'missing',
              old?.[0] === 'object' ? old[2] : null,
            ],
            'moving catalog baseline',
          );
          equal(cell[4], this.sources.get(cell[1]) ?? null, 'moving catalog snapshot source');
          if (
            row[0] === 'new' &&
            cell[5] &&
            (cell[5][3] !== row[3] || cell[5][4] !== row[4][4] || cell[5][5] !== this.generation[7])
          )
            throw new Error('Moving receipt mismatch.');
          if (row[0] !== 'new' && (cell[3] !== null || cell[5] !== null || cell[6] !== null))
            throw new Error('Transfer state for unuploaded choice.');
          const n = 512 + encodeRecord(cell).length * 8;
          this.options.budget.retain(n);
          charge += n;
          result.push(cell);
        },
        this.options.signal,
      );
      returned = true;
      let held = true;
      return {
        rows: result,
        release: () => {
          if (held) {
            held = false;
            this.options.budget.release(charge);
          }
        },
      };
    } finally {
      if (!returned) this.options.budget.release(charge);
    }
  }
  dispose() {
    if (!this.life.disposed) {
      this.life.disposed = true;
      this.release();
    }
  }
}
function modelSingle(store: OwnedStore, p: string) {
  return store.codec.options.model.partitions.find((d) => d[0] === p)?.[3] === 'single-writer';
}

function movingPhase(phase: string) {
  return [
    'objects-frozen',
    'relocating',
    'staged',
    'object-saved',
    'returning',
    'sources-returned',
    'final-source-barrier',
    'record-saved',
  ].includes(phase);
}
