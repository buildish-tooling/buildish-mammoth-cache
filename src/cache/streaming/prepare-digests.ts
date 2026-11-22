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

import { tuple, equal, type Value } from './encoding';
import { WorkerSpool } from './worker-spool';
import { sameNative, sameRename, type NativeIdentity } from './native';
import { compareMembership } from './tree-state';
import type { WorkingBudget } from './tree-state';
import type { VerifiedIncoming } from './install-evidence';
import type { OwnedStore, Reference } from './owned-store';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { PrepareFacts, type DigestHandoff } from './prepare-state';
import type { LocalRow } from './local-stream';

type Placement = ReturnType<OwnedStore['codec']['schemas']['rows']['digestPlacement']['parse']>;
const order = (ak: string, a: string, bk: string, b: string) =>
  compareMembership(['member', ak, a], ['member', bk, b]);

// Protocol: docs/dev/cache-lifecycle-protocol.md#prepared-digest-handoff.
// Collects only checked install outcomes; source metadata already outlives staging.
export class InstallDigests {
  private readonly spools = new Map<string, WorkerSpool>();
  private constructor(
    private readonly store: OwnedStore,
    private readonly inputs: readonly VerifiedIncoming[],
    private readonly budget: WorkingBudget,
    private readonly stage: 0 | 1,
    private readonly signal: AbortSignal,
  ) {}
  static create(
    store: OwnedStore,
    inputs: readonly VerifiedIncoming[],
    budget: WorkingBudget,
    stage: 0 | 1,
    signal: AbortSignal,
  ) {
    for (const input of inputs)
      input.assertBound(store, input.partition, input.evidence, input.nativeRoot);
    return new InstallDigests(store, inputs, budget, stage, signal);
  }
  async record(
    partition: string,
    path: string,
    kind: 'file' | 'directory',
    binding: Value | null,
    after: NativeIdentity | null,
  ) {
    const input = this.inputs.find((i) => i.partition === partition);
    if (!input) throw new Error('Digest placement has no admitted source.');
    let spool = this.spools.get(partition);
    if (!spool) {
      spool = await WorkerSpool.create(this.store, this.budget);
      this.spools.set(partition, spool);
      await spool.append(['digest-source', input.evidence], this.signal);
    }
    let span: Value = null;
    if (binding) {
      const e = this.store.codec.schemas.memberEvidence.parse(binding);
      equal(e[1], input.evidence, 'digest install source');
      if (!after || after[2] !== kind || after[3] !== this.store.root.binding[3])
        throw new Error('Invalid installed digest root.');
      span = e[2];
    } else if (after) throw new Error('Digest invalidation has native authority.');
    await spool.append(['digest-placement', path, kind, span, after], this.signal);
  }
  async finish(): Promise<DigestHandoff[]> {
    const result: DigestHandoff[] = [];
    for (const p of this.store.codec.options.model.partitions) {
      const spool = this.spools.get(p[0]);
      if (!spool) continue;
      spool.seal(this.signal);
      const ref = await this.store.writeStream(
        'digest-placements',
        { budget: this.budget, partition: p[0] },
        spool.rows(this.signal),
        this.signal,
      );
      result.push(
        this.store.codec.schemas.rows.digestHandoff.parse([
          'digest-handoff',
          this.stage,
          p[0],
          ref,
        ]),
      );
    }
    return result;
  }
  async close() {
    await settleBaseCleanup([...this.spools.values()].map((s) => () => s.dispose()));
  }
}

class BatchRows {
  private batch: readonly LocalRow[] = [];
  private at = 0;
  constructor(private readonly batches: AsyncGenerator<readonly LocalRow[]>) {}
  next(): IteratorResult<LocalRow, undefined> | Promise<IteratorResult<LocalRow, undefined>> {
    if (this.at < this.batch.length) return { done: false, value: this.batch[this.at++] };
    return this.refill();
  }
  private async refill(): Promise<IteratorResult<LocalRow, undefined>> {
    const next = await this.batches.next();
    if (next.done) {
      this.batch = [];
      return { done: true, value: undefined };
    }
    this.batch = next.value;
    this.at = 0;
    return { done: false, value: this.batch[this.at++] };
  }
  async close() {
    await this.batches.return(undefined as never);
    this.batch = [];
  }
}
// One sequential placement/member frontier per stage/partition; no per-file map.
class DigestCursor {
  private head: Placement | undefined;
  private source: BatchRows | undefined;
  private sourceHead: LocalRow | undefined;
  private member: AsyncGenerator<Value, 'file' | 'directory'> | undefined;
  private leaf: readonly Value[] | undefined;
  private memberStarted = false;
  private last = '';
  private done = false;
  private constructor(
    private readonly store: OwnedStore,
    private readonly rows: BatchRows,
    private readonly options: BaseObjectOptions,
    readonly partition: string,
  ) {}
  static async open(
    store: OwnedStore,
    h: DigestHandoff,
    options: BaseObjectOptions,
    batchChargeLimit: number,
  ) {
    const c = new DigestCursor(
      store,
      new BatchRows(
        store.rowBatches(
          h[3],
          'digest-placements',
          { ...options, partition: h[2] },
          options.signal,
          batchChargeLimit,
        ),
      ),
      options,
      h[2],
    );
    try {
      let source: Reference | undefined;
      for (;;) {
        const r = await c.rows.next();
        if (r.done) throw new Error('Missing prepared digest source.');
        const v = tuple(r.value.value);
        if (v[0] === 'local-stream') continue;
        if (v[0] !== 'digest-source') throw new Error('Missing prepared digest source.');
        source = store.codec.schemas.ref('native-evidence').parse(v[1]);
        break;
      }
      c.source = new BatchRows(
        store.rowBatches(
          source,
          'native-evidence',
          { ...options, partition: h[2] },
          options.signal,
          batchChargeLimit,
        ),
      );
      await c.nextSource();
      await c.next();
      return c;
    } catch (error) {
      await settleBaseCleanup([() => c.close()], error);
      throw error;
    }
  }
  private nextSource(): void | Promise<void> {
    const next = this.source!.next();
    if (next instanceof Promise)
      return next.then((row) => {
        this.sourceHead = row.done ? undefined : row.value;
      });
    this.sourceHead = next.done ? undefined : next.value;
  }
  private async *memberRows(h: Placement): AsyncGenerator<Value, 'file' | 'directory'> {
    const span = h[3]!;
    const start = span[2],
      end = span[3];
    while (this.sourceHead && this.sourceHead.start < start) {
      const pending = this.nextSource();
      if (pending) await pending;
    }
    if (this.sourceHead?.start !== start) throw new Error('Wrong prepared digest span start.');
    let count = 0,
      lastEnd = start;
    while (this.sourceHead && this.sourceHead.start < end) {
      const row = this.sourceHead,
        v = tuple(row.value);
      if (row.end > end || (v[0] !== 'file' && v[0] !== 'directory'))
        throw new Error('Invalid prepared digest span boundary.');
      if (!count) {
        if (v[0] !== h[2] || v[1] !== h[1] || !h[4] || !sameRename(v[2] as NativeIdentity, h[4]))
          throw new Error('Unbound installed digest transition.');
      } else if (h[2] === 'file' || !String(v[1]).startsWith(h[1] + '/'))
        throw new Error('Prepared digest span escapes member.');
      count++;
      lastEnd = row.end;
      yield row.value;
      const pending = this.nextSource();
      if (pending) await pending;
    }
    if (!count || lastEnd !== end || !this.sourceHead || this.sourceHead.start !== end)
      throw new Error('Incomplete prepared digest span.');
    const next = tuple(this.sourceHead.value);
    if (
      h[2] === 'directory' &&
      next[0] !== 'local-end' &&
      (next[1] === h[1] || String(next[1]).startsWith(h[1] + '/'))
    )
      throw new Error('Incomplete prepared digest subtree span.');
    return h[2];
  }
  private startMember() {
    const h = this.head;
    if (h && h[3] !== null && !this.memberStarted) {
      this.member = this.memberRows(h);
      this.memberStarted = true;
    }
  }
  private async next() {
    this.startMember();
    if (this.member) {
      while (!(await this.member.next()).done) this.options.signal?.throwIfAborted();
      this.member = undefined;
      this.leaf = undefined;
    }
    this.head = undefined;
    this.memberStarted = false;
    for (;;) {
      const r = await this.rows.next();
      if (r.done) {
        this.done = true;
        return;
      }
      const v = tuple(r.value.value);
      if (v[0] === 'local-end') continue;
      this.head = this.store.codec.schemas.rows.digestPlacement.parse(v);
      return;
    }
  }
  private async nextLeaf() {
    this.leaf = undefined;
    while (this.member) {
      const r = await this.member.next();
      if (r.done) {
        this.member = undefined;
        return;
      }
      const v = tuple(r.value);
      if (v[0] === 'file') {
        this.leaf = v;
        return;
      }
    }
  }
  async match(path: string, n: NativeIdentity): Promise<{ covered: boolean; sha: string | null }> {
    if (this.last && order('file', this.last, 'file', path) >= 0)
      throw new Error('Digest lookup is not a forward traversal.');
    this.last = path;
    for (;;) {
      const h = this.head;
      if (!h) return { covered: false, sha: null };
      const covers = h[1] === path || (h[2] === 'directory' && path.startsWith(h[1] + '/'));
      if (covers) {
        if (h[3] === null || h[4] === null) return { covered: true, sha: null };
        if (!this.memberStarted) {
          this.startMember();
          await this.nextLeaf();
        }
        while (this.leaf && order('file', String(this.leaf[1]), 'file', path) < 0)
          await this.nextLeaf();
        if (this.leaf?.[1] !== path) return { covered: true, sha: null };
        const expected = (path === h[1] ? h[4] : this.leaf[2]) as NativeIdentity;
        const sha = sameNative(expected, n, true) ? String(this.leaf[3]) : null;
        await this.nextLeaf();
        return { covered: true, sha };
      }
      if (order(h[2], h[1], 'file', path) > 0) return { covered: false, sha: null };
      await this.next();
    }
  }
  async finish() {
    while (!this.done) await this.next();
    while (this.sourceHead) {
      const pending = this.nextSource();
      if (pending) await pending;
    }
  }
  async close() {
    const failures: unknown[] = [];
    for (const close of [
      () => this.member?.return(undefined as never),
      () => this.rows.close(),
      () => this.source?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Prepared digest cursor cleanup failed.');
  }
}

export class PreparedDigests {
  private closed = false;
  private readonly byPartition = new Map<string, DigestCursor[]>();
  private readonly cursors: { stage: number; cursor: DigestCursor }[] = [];
  private constructor() {}
  static async open(facts: PrepareFacts, options: BaseObjectOptions) {
    PrepareFacts.assert(facts);
    const store = facts.store,
      handoffs = facts.digestHandoffs;
    const result = new PreparedDigests();
    try {
      for (const h of handoffs) {
        const cursor = await DigestCursor.open(
          store,
          h,
          options,
          Math.max(1, Math.floor(options.budget.limit / Math.max(1, handoffs.length * 4))),
        );
        result.cursors.push({ stage: h[1], cursor });
        const group = result.byPartition.get(h[2]) ?? [];
        group.push(cursor);
        result.byPartition.set(h[2], group);
      }
      return result;
    } catch (error) {
      await settleBaseCleanup([() => result.close()], error);
      throw error;
    }
  }
  async take(partition: string, path: string, native: NativeIdentity): Promise<string | null> {
    if (this.closed) throw new Error('Prepared digest reader is closed.');
    let sha: string | null = null;
    // Both stages advance even when the later stage overrides the earlier result.
    for (const cursor of this.byPartition.get(partition) ?? []) {
      const result = await cursor.match(path, native);
      if (result.covered) sha = result.sha;
    }
    return sha;
  }
  async finish() {
    for (const { cursor } of this.cursors) await cursor.finish();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await settleBaseCleanup(
      this.cursors.map(
        ({ cursor }) =>
          () =>
            cursor.close(),
      ),
    );
  }
}
