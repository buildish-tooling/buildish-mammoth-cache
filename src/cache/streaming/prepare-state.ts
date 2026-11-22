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

import { checkPostRootBinding } from './post-admission';
import { equal, encodeRecord, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import type { LocalCodec } from './local-schema';
import type { BaseObjectOptions } from './base-object';
type Schemas = LocalCodec['schemas'];
export type PrepareSelection = ReturnType<Schemas['rows']['prepareSelection']['parse']>;
export type PrepareSource = ReturnType<Schemas['source']['parse']>;
export type Producer = ReturnType<Schemas['rows']['producer']['parse']>;
export type PrepareBindings = ReturnType<Schemas['documents']['bindings']['parse']>;
export type PrepareState = ReturnType<Schemas['documents']['local-state']['parse']>;
export const localRecords = async function* (rows: readonly Value[]) {
  yield* rows;
};

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-prepare-selection.
// Bounded P/K facts only. Each retained decoded row remains charged until close.
const receipts = new WeakSet<object>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export class PrepareFacts {
  private readonly lifecycle = { charge: 0, closed: false };
  selection: PrepareSelection | null = null;
  readonly sources: PrepareSource[] = [];
  readonly producers: Producer[] = [];
  private constructor(
    readonly store: OwnedStore,
    readonly options: BaseObjectOptions,
    readonly state: PrepareState,
    readonly bindings: PrepareBindings,
  ) {
    receipts.add(this);
  }
  static assert(facts: PrepareFacts) {
    if (!receipts.has(facts) || facts.lifecycle.closed)
      throw new Error('Unavailable prepare facts.');
  }
  static async open(store: OwnedStore, options: BaseObjectOptions) {
    options = Object.freeze({ ...options });
    options.signal?.throwIfAborted();
    const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
      bindings = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      );
    store.codec.checkStateBindings(state, bindings);
    checkPostRootBinding(store, bindings);
    const facts = new PrepareFacts(store, options, state, bindings);
    const hold = (value: Value) => {
      const n = 512 + encodeRecord(value).length * 8;
      options.budget.retain(n);
      facts.lifecycle.charge += n;
    };
    try {
      hold(state);
      hold(bindings);
      await store.readStream(
        bindings[11],
        'prepare-sources',
        { ...options, partition: null },
        async (value) => {
          if (!Array.isArray(value)) return;
          if (value[0] === 'prepare-selection') {
            hold(value);
            facts.selection = store.codec.schemas.rows.prepareSelection.parse(value);
          } else if (value[0] === 'snapshot-source') {
            hold(value);
            facts.sources.push(store.codec.schemas.source.parse(value[1]));
          }
        },
        options.signal,
      );
      await store.readStream(
        bindings[10],
        'producers',
        { ...options, partition: null },
        async (value) => {
          if (Array.isArray(value) && value[0] === 'producer') {
            hold(value);
            facts.producers.push(store.codec.schemas.rows.producer.parse(value[1]));
          }
        },
        options.signal,
      );
      options.signal?.throwIfAborted();
      for (const value of [
        facts.state,
        facts.bindings,
        facts.selection,
        facts.sources,
        facts.producers,
      ])
        freeze(value);
      Object.freeze(facts);
      return facts;
    } catch (error) {
      facts.close();
      throw error;
    }
  }
  close() {
    if (!this.lifecycle.closed) {
      this.lifecycle.closed = true;
      this.options.budget.release(this.lifecycle.charge);
      this.lifecycle.charge = 0;
    }
  }
  async commit(change: {
    selection?: PrepareSelection;
    sources?: readonly PrepareSource[];
    producers?: readonly Producer[];
    baseline?: PrepareBindings[9];
    activity?: Reference;
    cutoff?: number;
    ready?: boolean;
  }) {
    if ((change.sources?.length ?? 0) > 64 || (change.producers?.length ?? 0) > 16)
      throw new Error('Prepare frontier exceeded.');
    let charge = 0;
    try {
      const values: Value[] = [
        ...(change.selection ? [change.selection] : []),
        ...(change.sources ?? []),
        ...(change.producers ?? []),
        ...(change.baseline ? [change.baseline] : []),
        ...(change.activity ? [change.activity] : []),
      ];
      for (const value of values) {
        const n = 512 + encodeRecord(value).length * 8;
        this.options.budget.retain(n);
        charge += n;
      }
      await this.replace(structuredClone(change));
    } finally {
      this.options.budget.release(charge);
    }
  }
  private async replace(change: Parameters<PrepareFacts['commit']>[0]) {
    if (this.lifecycle.closed || this.state[4] !== 'prepare-pending' || this.state[11] !== null)
      throw new Error('Prepare facts are not writable.');
    this.options.signal?.throwIfAborted();
    await this.store.assertNoIntents();
    equal(await this.store.state(), this.state, 'prepare state before replacement');
    const next = this.store.codec.schemas.rows.prepareSelection.parse(
      change.selection ?? this.selection,
    );
    if (this.selection) {
      const old = this.selection;
      equal(next.slice(0, 5), old.slice(0, 5), 'frozen prepare configuration');
      equal(next[8], old[8], 'frozen install container');
      if (old[5][0] !== 'pending') equal(next[5], old[5], 'pinned base choice');
      if (old[6][0] !== 'pending') equal(next[6], old[6], 'pinned worker choice');
      if (old[7] !== null) equal(next[7], old[7], 'accepted base availability');
      const stages = ['selected', 'base-installed', 'workers-installed'];
      const advance = stages.indexOf(next[9]) - stages.indexOf(old[9]);
      if (advance < 0 || advance > 1) throw new Error('Nonmonotonic prepare stage.');
    }
    const bindings = structuredClone(this.bindings),
      state = structuredClone(this.state);
    const sources = change.sources ?? this.sources;
    const positions = new Map(this.store.codec.options.model.partitions.map((p, i) => [p[0], i]));
    const ordered = [...sources].sort((a, b) => positions.get(a[0])! - positions.get(b[0])!);
    const stream = { ...this.options, partition: null };
    if (change.selection || change.sources)
      bindings[11] = this.store.codec.schemas
        .ref('prepare-sources')
        .parse(
          await this.store.writeStream(
            'prepare-sources',
            stream,
            localRecords([next, ...ordered.map((s) => ['snapshot-source', s] as Value)]),
            this.options.signal,
          ),
        );
    if (change.producers) {
      const rows = [...change.producers].sort((a, b) =>
        a[3][4] < b[3][4] ? -1 : a[3][4] > b[3][4] ? 1 : 0,
      );
      bindings[10] = this.store.codec.schemas
        .ref('producers')
        .parse(
          await this.store.writeStream(
            'producers',
            stream,
            localRecords(rows.map((p) => ['producer', p])),
            this.options.signal,
          ),
        );
    }
    if (change.baseline !== undefined) bindings[9] = change.baseline;
    if (change.activity)
      bindings[12] = this.store.codec.schemas.ref('activity').parse(change.activity);
    if (change.cutoff !== undefined) bindings[8][7] = change.cutoff;
    if (next[9] !== 'selected') {
      if (next[5][0] === 'pinned') {
        if (!bindings[9]) throw new Error('Installed base lacks its retained generation.');
        equal(
          [bindings[9][1], bindings[9][2][3], bindings[9][2][4]],
          [next[5][1], next[5][2][3], next[5][2][4]],
          'installed baseline choice',
        );
      } else if (bindings[9] !== null) throw new Error('Miss acquired a baseline.');
    }
    if (next[9] === 'workers-installed' && !bindings[12])
      throw new Error('Installed workers lack selected activity.');
    if (change.ready) {
      if (next[9] !== 'workers-installed') throw new Error('Prepare not installed.');
      state[4] = 'build-ready';
    }
    state[5] = this.store.codec.schemas
      .ref('bindings')
      .parse(await this.store.writeDocument(bindings));
    state[3]++;
    this.store.codec.checkStateBindings(state, bindings);
    this.options.signal?.throwIfAborted();
    await this.store.updateState(state);
    await this.store.retireReplacedDocument(this.state[5]);
    this.options.signal?.throwIfAborted();
  }
}
