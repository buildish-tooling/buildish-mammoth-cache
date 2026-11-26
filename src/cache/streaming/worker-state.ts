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

import { z } from 'zod';
import { add, Digest, equal, tuple, type Value } from './encoding';
import { STREAMING_PROFILES } from './profiles';
import { keySchema } from './native-records';
import type { ResolvedModel } from './model';
import {
  componentSchema,
  contextSchema,
  countsSchema,
  familySchema,
  modeSchema,
  partitionSchema,
  pathSchema,
  positiveSchema,
  shaSchema,
  uintSchema,
  unitKindSchema,
  unitSchema,
  scopeSchema,
  type Context,
  type Counts,
} from './schema';
import {
  compareMembership,
  countInto,
  joinPath,
  newCounts,
  normalizeMode,
  recognizedRoot,
  isWorkspaceRoot,
  TreeState,
  UnitProjection,
  type WorkingBudget,
} from './tree-state';
import type { WorkerTarHeader } from './worker-transport';
import { withAbort } from './abort';

// Protocol: docs/dev/cache-protocol.md#usage-validation
export type Membership = readonly ['member', 'file' | 'unit', string];

/** Caller-owned sequential metadata storage; append/seal/dispose must honor cancellation. */
export interface MembershipSpool {
  append(member: Membership, signal: AbortSignal): Promise<void>;
  seal(signal: AbortSignal): Promise<() => AsyncIterable<Value>>;
  /** Independent sequential projection, owned/disposed by the returned handle. */
  fork(channel: number, signal: AbortSignal): Promise<MembershipSpool>;
  dispose(): Promise<void>;
}

export interface WorkerContext {
  readonly model: ResolvedModel;
  readonly context: Context;
  readonly authorizedSnapshots: readonly string[];
  readonly budget: WorkingBudget;
  readonly maxDirectoryEntries?: number;
  readonly membership: MembershipSpool;
}

const identityFields = [
  z.literal(STREAMING_PROFILES.worker),
  z.literal('gzip'),
  contextSchema,
  shaSchema,
  familySchema,
  z.array(partitionSchema).max(64),
] as const;
const workerSweepEvidenceSchema = z
  .tuple([
    z.literal('sweep-usage'),
    keySchema,
    uintSchema,
    uintSchema,
    z.array(partitionSchema).max(64),
  ])
  .refine((evidence) => evidence[2] <= evidence[3]);
export type WorkerSweepEvidence = z.infer<typeof workerSweepEvidenceSchema>;

const identitySchema = z.union([
  z.tuple([z.literal('identity'), z.literal(1), ...identityFields]),
  z.tuple([z.literal('identity'), z.literal(2), ...identityFields, z.literal('incomplete-usage')]),
  z.tuple([z.literal('identity'), z.literal(3), ...identityFields, workerSweepEvidenceSchema]),
]);
const summarySchema = z.tuple([
  uintSchema,
  z.enum(['aggregate', 'usage', 'snapshot']),
  partitionSchema.nullable(),
  countsSchema,
  shaSchema,
]);
const controls = {
  'channel-open': z.tuple([
    z.literal('channel-open'),
    uintSchema,
    z.enum(['aggregate', 'usage', 'snapshot']),
    partitionSchema.nullable(),
  ]),
  'dir-open': z.tuple([z.literal('dir-open'), uintSchema, pathSchema]),
  'dir-close': z.tuple([z.literal('dir-close'), uintSchema, pathSchema]),
  'unit-open': z.tuple([
    z.literal('unit-open'),
    uintSchema,
    unitKindSchema,
    pathSchema,
    scopeSchema,
  ]),
  'used-unit-open': z.tuple([
    z.literal('used-unit-open'),
    uintSchema,
    unitKindSchema,
    pathSchema,
    scopeSchema,
  ]),
  'file-meta': z.tuple([
    z.literal('file-meta'),
    uintSchema,
    positiveSchema,
    shaSchema,
    partitionSchema,
  ]),
  'unit-close': z.tuple([
    z.literal('unit-close'),
    uintSchema,
    unitKindSchema,
    pathSchema,
    countsSchema,
    shaSchema,
    shaSchema,
  ]),
  'used-unit-close': z.tuple([
    z.literal('used-unit-close'),
    uintSchema,
    unitKindSchema,
    pathSchema,
    countsSchema,
    shaSchema,
  ]),
  used: z.tuple([z.literal('used'), uintSchema, componentSchema, partitionSchema]),
  'channel-close': z.tuple([z.literal('channel-close'), uintSchema, countsSchema, shaSchema]),
};
const membershipSchema = z.tuple([z.literal('member'), z.enum(['file', 'unit']), pathSchema]);
const completeSchema = z.tuple([
  z.literal('complete'),
  z.literal(1),
  uintSchema,
  uintSchema,
  countsSchema,
  z.array(summarySchema).max(66),
  shaSchema,
]);
export interface WorkerSummary {
  readonly identity: z.infer<typeof identitySchema>;
  readonly counts: Counts;
  readonly channels: z.infer<typeof summarySchema>[];
  readonly eventSha: string;
}

interface Channel {
  cid: number;
  purpose: 'aggregate' | 'usage' | 'snapshot';
  partition: string | null;
  tree: TreeState;
  events: Digest;
  counts: Counts;
}

interface FileBinding {
  partition: string;
  ordinal: number;
  path: string;
  size: number;
  mode: number;
  time: number;
  sha?: string;
}

export function globalChannelKey(
  model: ResolvedModel,
  snapshots: readonly string[],
  cid: number,
): number {
  uintSchema.parse(cid);
  if (cid < 2) {
    return cid;
  }
  const id = snapshots[cid - 2],
    index = model.partitions.findIndex((p) => p[0] === id);
  if (index < 0) {
    throw new Error('Unknown input-local snapshot channel.');
  }
  return index + 2;
}
interface Projection {
  spool: MembershipSpool;
  digest: Digest;
  count: number;
  read?: () => AsyncIterable<Value>;
}

export class WorkerState {
  sequence = 0;
  ordinal = 0;
  private identity?: z.infer<typeof identitySchema>;
  private channel: Channel | null = null;
  private channelIndex = 0;
  private readonly totals = newCounts();
  private readonly summaries: z.infer<typeof summarySchema>[] = [];
  private readonly events = new Digest('worker-events');
  private readonly upserts = new Digest('usage-upserts');
  private upsertCount = 0;
  private readonly projections: Projection[] = [];
  private unitProjection?: Projection;
  private replayDigest = new Digest('usage-upserts');
  private replayCount = 0;
  private replay: AsyncIterator<Value> | null = null;
  private replayHead: Membership | null = null;
  private replayPrevious: Membership | null = null;
  private releaseReplay: (() => void) | null = null;
  private unit: UnitProjection | null = null;
  private closeRoot: string | null = null;
  private pendingDirectory: string | null = null;
  private pendingFile: FileBinding | null = null;
  private completed = false;
  private requiredUnit: string | null = null;
  private releaseHeader: (() => void) | null = null;

  constructor(
    readonly options: WorkerContext,
    readonly signal: AbortSignal,
  ) {
    contextSchema.parse(options.context);
    if (options.context[7] !== options.model.tuple[2]) {
      throw new Error('Context build tool mismatch.');
    }
    const allowed = options.authorizedSnapshots;
    if (
      allowed.length > 64 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some(
        (id) =>
          !options.model.partitions.some(
            (p) =>
              p[0] === id &&
              p[3] === 'single-writer' &&
              (p[4] === null || p[4] === options.context[4]),
          ),
      )
    ) {
      throw new Error('Invalid snapshot authorization.');
    }
  }

  private current(): Channel {
    if (!this.channel) {
      throw new Error('No current worker channel.');
    }
    return this.channel;
  }

  get cid(): number {
    return this.current().cid;
  }

  get purpose(): string {
    return this.current().purpose;
  }

  get currentPath(): string {
    return this.current().tree.path;
  }

  get file(): Readonly<FileBinding> {
    if (!this.pendingFile) {
      throw new Error('No pending file.');
    }
    return this.pendingFile;
  }

  private declaration(index: number): [number, 'aggregate' | 'usage' | 'snapshot', string | null] {
    if (!this.identity || index >= this.identity[7].length + 2) {
      throw new Error('Unexpected channel.');
    }
    return [
      index,
      index === 0 ? 'aggregate' : index === 1 ? 'usage' : 'snapshot',
      index < 2 ? null : this.identity[7][index - 2],
    ];
  }

  identityTuple(
    snapshots: readonly string[],
    incompleteUsage = false,
    sweep?: WorkerSweepEvidence,
  ): Value[] {
    if (incompleteUsage && sweep) {
      throw new Error('Incomplete worker usage cannot qualify for a sweep.');
    }
    return [
      'identity',
      incompleteUsage ? 2 : sweep ? 3 : 1,
      STREAMING_PROFILES.worker,
      'gzip',
      this.options.context,
      this.options.model.id,
      this.options.model.family,
      snapshots,
      ...(incompleteUsage ? ['incomplete-usage'] : sweep ? [sweep] : []),
    ];
  }

  channelOpenTuple(): Value[] {
    return ['channel-open', ...this.declaration(this.channelIndex)];
  }

  channelCloseTuple(): Value[] {
    const c = this.current();
    return ['channel-close', c.cid, [...c.counts], c.events.digest()];
  }

  unitCloseTuple(): Value[] {
    if (!this.unit) {
      throw new Error('No active unit.');
    }
    const u = this.unit,
      s = u.finish();
    return u.usage
      ? ['used-unit-close', this.cid, u.unit[0], u.unit[1], s.counts, s.semantic]
      : ['unit-close', this.cid, u.unit[0], u.unit[1], s.counts, s.semantic, s.comparison];
  }

  fileMetaTuple(): Value[] {
    const f = this.file;
    if (f.sha === undefined) {
      throw new Error('Body not hashed.');
    }
    return ['file-meta', this.cid, f.ordinal, f.sha, f.partition];
  }

  completeTuple(): Value[] {
    return [
      'complete',
      1,
      this.sequence,
      this.ordinal,
      [...this.totals],
      this.summaries,
      this.events.digest(),
    ];
  }

  headerName(path: string, directory = false): string {
    pathSchema.parse(path);
    const c = this.current();
    if (c.purpose === 'usage') {
      throw new Error('Payload in usage channel.');
    }
    return (
      (c.purpose === 'aggregate' ? 'payload/aggregate/' : `payload/snapshot/${c.partition}/`) +
      path +
      (directory && path ? '/' : '')
    );
  }

  private ownership(path: string): string {
    const p = this.options.model.owner(path),
      c = this.current();
    if (
      (c.purpose === 'snapshot' && p[0] !== c.partition) ||
      (c.purpose !== 'snapshot' && p[3] !== 'aggregate')
    ) {
      throw new Error('Channel partition ownership mismatch.');
    }
    return p[0];
  }

  private requireFileUnit(path: string): void {
    const root = recognizedRoot(this.options.model, path);
    if (root !== null && (!this.unit || this.unit.unit[1] !== root || root === path)) {
      throw new Error('Missing recognized complete unit.');
    }
  }

  payloadHeader(header: WorkerTarHeader): void {
    if (
      this.completed ||
      this.pendingDirectory !== null ||
      this.pendingFile ||
      this.closeRoot !== null ||
      this.requiredUnit !== null
    ) {
      throw new Error('Payload interrupts required metadata/close.');
    }
    const c = this.current(),
      prefix =
        c.purpose === 'aggregate'
          ? 'payload/aggregate/'
          : c.purpose === 'snapshot'
            ? `payload/snapshot/${c.partition}/`
            : '';
    if (!prefix || !header.name.startsWith(prefix)) {
      throw new Error('Invalid payload namespace/channel.');
    }
    let path = header.name.slice(prefix.length);
    if (header.type === 'directory' && path) {
      if (!path.endsWith('/')) {
        throw new Error('Missing directory slash.');
      }
      path = path.slice(0, -1);
    }
    pathSchema.parse(path);
    uintSchema.parse(header.size);
    uintSchema.parse(header.mtimeMs);
    const fact: Value[] = [
      'header',
      c.cid,
      path,
      header.type,
      header.size,
      header.mode,
      header.mtimeMs,
    ];
    if (header.type === 'directory') {
      if (
        header.size !== 0 ||
        header.mode !== 493 ||
        header.mtimeMs !== 0 ||
        this.unit?.unit[2] === 'direct'
      ) {
        throw new Error('Invalid directory header/unit boundary.');
      }
      this.pendingDirectory = path;
    } else {
      modeSchema.parse(header.mode);
      if (normalizeMode(this.options.model.tuple[2], path, header.mode) !== header.mode) {
        throw new Error('Noncanonical launcher mode.');
      }
      c.tree.file(path);
      this.requireFileUnit(path);
      this.pendingFile = {
        partition: this.ownership(path),
        ordinal: (this.ordinal = add(this.ordinal)),
        path,
        size: header.size,
        mode: header.mode,
        time: header.mtimeMs,
      };
    }
    this.releaseHeader = this.options.budget.holdRecord(Buffer.byteLength(header.name) + 128);
    this.events.update(fact);
    c.events.update(fact);
  }

  body(sha: string, bytes: number): void {
    const f = this.pendingFile;
    if (!f || f.size !== bytes || f.sha !== undefined) {
      throw new Error('Body length/state mismatch.');
    }
    shaSchema.parse(sha);
    f.sha = sha;
  }

  private async append(type: 'file' | 'unit', path: string): Promise<void> {
    const member: Membership = ['member', type, path];
    this.upserts.update(member);
    this.upsertCount = add(this.upsertCount);
    await withAbort(this.options.membership.append(member, this.signal), this.signal);
  }

  private async advance(): Promise<void> {
    if (!this.replay) {
      throw new Error('Unsealed upsert membership.');
    }
    const item = await withAbort(this.replay.next(), this.signal);
    if (item.done) {
      this.replayHead = null;
      this.replayPrevious = null;
      this.releaseReplay?.();
      this.releaseReplay = null;
      if (
        this.replayCount !== this.upsertCount ||
        this.replayDigest.digest() !== this.upserts.digest()
      ) {
        throw new Error('Changed upsert membership spool.');
      }
      return;
    }
    const member = membershipSchema.parse(item.value);
    if (this.replayPrevious && compareMembership(this.replayPrevious, member) >= 0) {
      throw new Error('Unordered membership spool.');
    }
    const release = this.options.budget.holdRecord(Buffer.byteLength(member[2]) + 128);
    this.releaseReplay?.();
    this.releaseReplay = release;
    this.replayPrevious = member;
    this.replayHead = member;
    this.replayCount = add(this.replayCount);
    this.replayDigest.update(member);
  }

  private async usage(type: 'file' | 'unit', path: string): Promise<void> {
    const member: Membership = ['member', type, path];
    while (this.replayHead && compareMembership(this.replayHead, member) < 0) {
      await this.advance();
    }
    if (this.replayHead && compareMembership(this.replayHead, member) === 0) {
      throw new Error('Overlapping upsert and usage membership.');
    }
  }

  async control(value: Value): Promise<void> {
    if (this.completed) {
      throw new Error('Member after completion.');
    }
    const raw = tuple(value),
      tag = raw[0];
    if (!this.identity) {
      const identity = identitySchema.parse(value);
      equal(identity[4], this.options.context, 'context');
      equal(
        [identity[5], identity[6]],
        [this.options.model.id, this.options.model.family],
        'model/family',
      );
      let previous = -1;
      for (const id of identity[7]) {
        const index = this.options.model.partitions.findIndex((p) => p[0] === id);
        if (!this.options.authorizedSnapshots.includes(id) || index <= previous) {
          throw new Error('Unauthorized/unordered snapshot channel.');
        }
        previous = index;
      }
      if (identity[1] === 3) {
        let last = -1;
        for (const id of identity[8][4]) {
          const index = this.options.model.partitions.findIndex((p) => p[0] === id);
          if (index <= last || this.options.model.partitions[index]?.[3] !== 'aggregate') {
            throw new Error('Unauthorized/unordered sweep partition.');
          }
          last = index;
        }
      }
      this.identity = identity;
      this.events.update(identity);
      return;
    }
    if (
      (this.pendingFile && tag !== 'file-meta') ||
      (this.pendingDirectory !== null && tag !== 'dir-open') ||
      (this.closeRoot !== null && (tag !== 'dir-close' || raw[2] !== this.closeRoot))
    ) {
      throw new Error('Missing immediate metadata/close.');
    }
    if (
      this.requiredUnit !== null &&
      tag !== (this.current().purpose === 'usage' ? 'used-unit-open' : 'unit-open')
    ) {
      throw new Error('Missing recognized complete unit wrapper.');
    }
    if (tag === 'complete') {
      const complete = completeSchema.parse(value);
      if (
        this.channel ||
        this.channelIndex !== this.identity[7].length + 2 ||
        this.unit ||
        this.pendingFile ||
        this.pendingDirectory !== null
      ) {
        throw new Error('Incomplete worker channels.');
      }
      equal(complete, this.completeTuple(), 'final seal');
      await this.checkPublicationUnits();
      this.completed = true;
      return;
    }
    if (typeof tag !== 'string' || !Object.hasOwn(controls, tag)) {
      throw new Error('Unknown worker control.');
    }
    const c = controls[tag as keyof typeof controls].parse(value);
    this.sequence = add(this.sequence);
    if (c[0] === 'channel-open') {
      if (this.channel || this.pendingFile || this.pendingDirectory !== null) {
        throw new Error('Channel already open.');
      }
      equal(c.slice(1), this.declaration(this.channelIndex), 'channel declaration');
      if (
        c[2] !== 'aggregate' &&
        this.options.model.tuple[2] === 'maven' &&
        this.identity[7].length
      ) {
        const spool = await withAbort(this.options.membership.fork(c[1], this.signal), this.signal);
        this.unitProjection = { spool, digest: new Digest('usage-upserts'), count: 0 };
        this.projections.push(this.unitProjection);
      }
      this.channel = {
        cid: c[1],
        purpose: c[2],
        partition: c[3],
        tree: new TreeState(this.options.budget, this.options.maxDirectoryEntries),
        events: new Digest('channel-events'),
        counts: newCounts(),
      };
    } else {
      const channel = this.current();
      if (c[1] !== channel.cid) {
        throw new Error('Wrong input-local channel id.');
      }
      switch (c[0]) {
        case 'dir-open': {
          if (channel.purpose === 'usage') {
            if (this.pendingDirectory !== null) {
              throw new Error('Payload in usage.');
            }
          } else if (this.pendingDirectory !== c[2]) {
            throw new Error('Missing immediate directory header.');
          }
          this.releaseHeader?.();
          this.releaseHeader = null;
          this.pendingDirectory = null;
          channel.tree.open(c[2]);
          channel.counts[1] = add(channel.counts[1]);
          if (this.unit) {
            this.unit.directory(c[2], 'open');
          } else if (isWorkspaceRoot(this.options.model, c[2])) {
            this.requiredUnit = c[2];
          }
          break;
        }
        case 'dir-close': {
          if (this.unit?.unit[1] === c[2]) {
            throw new Error('Missing unit close.');
          }
          if (c[2] && channel.tree.leaf) {
            recognizedRoot(this.options.model, c[2] + '/.workspace-directory-probe');
            const owner = this.ownership(c[2] + '/.workspace-directory-probe');
            this.unit?.ownership(owner);
          }
          if (this.unit) {
            this.unit.directory(c[2], 'close');
          }
          channel.tree.close(c[2]);
          this.closeRoot = null;
          break;
        }
        case 'unit-open':
        case 'used-unit-open': {
          if (
            this.unit ||
            !channel.tree.emptyDirectory ||
            c[3] !== channel.tree.path ||
            (c[0] === 'used-unit-open') !== (channel.purpose === 'usage')
          ) {
            throw new Error('Invalid unit open boundary.');
          }
          const descriptor = unitSchema.parse([c[2], c[3], c[4]]);
          this.unit = new UnitProjection(
            this.options.model,
            descriptor,
            channel.purpose === 'usage',
          );
          this.requiredUnit = null;
          channel.counts[2] = add(channel.counts[2]);
          if (channel.purpose === 'aggregate') {
            await this.append('unit', c[3]);
          }
          if (channel.purpose === 'usage') {
            await this.usage('unit', c[3]);
          }
          if (channel.purpose !== 'aggregate' && this.unitProjection) {
            const projection = this.unitProjection;
            const member: Membership = ['member', 'unit', c[3]];
            projection.digest.update(member);
            projection.count = add(projection.count);
            await withAbort(projection.spool.append(member, this.signal), this.signal);
          }
          break;
        }
        case 'file-meta': {
          const f = this.pendingFile;
          if (!f || f.sha === undefined) {
            throw new Error('Orphan/unhashed file metadata.');
          }
          equal(c, this.fileMetaTuple(), 'file metadata');
          if (this.unit) {
            this.unit.file(f.path, f.partition, f.size, f.mode, f.time, f.sha);
          }
          channel.counts[0] = add(channel.counts[0]);
          channel.counts[4] = add(channel.counts[4], f.size);
          if (channel.purpose === 'aggregate') {
            await this.append('file', f.path);
          }
          this.releaseHeader?.();
          this.releaseHeader = null;
          this.pendingFile = null;
          break;
        }
        case 'unit-close':
        case 'used-unit-close': {
          const u = this.unit;
          if (!u || u.unit[1] !== channel.tree.path || u.usage !== (c[0] === 'used-unit-close')) {
            throw new Error('Invalid unit close boundary.');
          }
          equal(c, this.unitCloseTuple(), 'unit summary');
          if (u.unit[2] === 'direct') {
            channel.tree.endFiles();
          } else {
            this.closeRoot = u.unit[1];
          }
          this.unit = null;
          break;
        }
        case 'used': {
          if (channel.purpose !== 'usage') {
            throw new Error('Usage outside usage channel.');
          }
          const path = joinPath(channel.tree.path, c[2]);
          channel.tree.file(path);
          this.requireFileUnit(path);
          if (this.ownership(path) !== c[3]) {
            throw new Error('Wrong used partition.');
          }
          if (this.unit) {
            this.unit.file(path, c[3], 0, 420, 0, '0'.repeat(64));
          }
          channel.counts[3] = add(channel.counts[3]);
          await this.usage('file', path);
          break;
        }
        case 'channel-close': {
          if (!channel.tree.complete || this.unit || this.closeRoot !== null) {
            throw new Error('Unbalanced channel.');
          }
          equal(c, this.channelCloseTuple(), 'channel summary');
          if (channel.purpose === 'aggregate') {
            const replay = await withAbort(this.options.membership.seal(this.signal), this.signal);
            this.projections.unshift({
              spool: this.options.membership,
              digest: this.upserts,
              count: this.upsertCount,
              read: replay,
            });
            this.replay = replay()[Symbol.asyncIterator]();
            await this.advance();
          }
          if (channel.purpose !== 'aggregate' && this.unitProjection) {
            const projection = this.unitProjection;
            projection.read = await withAbort(projection.spool.seal(this.signal), this.signal);
            this.unitProjection = undefined;
          }
          if (channel.purpose === 'usage') {
            while (this.replayHead) {
              await this.advance();
            }
          }
          this.summaries.push([
            channel.cid,
            channel.purpose,
            channel.partition,
            [...channel.counts],
            channel.events.digest(),
          ]);
          countInto(this.totals, channel.counts);
          break;
        }
      }
    }
    this.events.update(c);
    if (c[0] === 'channel-close') {
      this.channel = null;
      this.channelIndex++;
    } else {
      this.current().events.update(c);
    }
  }

  // Protocol: docs/dev/cache-protocol.md#profiles-and-common-rules
  // One unit-root frontier per publication channel; never a global coordinate map.
  private async checkPublicationUnits(): Promise<void> {
    if (this.options.model.tuple[2] !== 'maven' || this.projections.length < 2) {
      return;
    }
    const frontiers = this.projections.map((p) => ({
      p,
      iterator: p.read!()[Symbol.asyncIterator](),
      head: null as Membership | null,
      previous: null as Membership | null,
      digest: new Digest('usage-upserts'),
      count: 0,
      release: null as (() => void) | null,
    }));
    const advance = async (f: (typeof frontiers)[number]) => {
      while (true) {
        const row = await withAbort(f.iterator.next(), this.signal);
        if (row.done) {
          if (f.count !== f.p.count || f.digest.digest() !== f.p.digest.digest()) {
            throw new Error('Changed publication ownership spool.');
          }
          f.head = null;
          f.previous = null;
          f.release?.();
          f.release = null;
          return;
        }
        const member = membershipSchema.parse(row.value);
        if (f.previous && compareMembership(f.previous, member) >= 0) {
          throw new Error('Unordered publication ownership spool.');
        }
        const release = this.options.budget.holdRecord(Buffer.byteLength(member[2]) + 128);
        f.release?.();
        f.release = release;
        f.previous = member;
        f.digest.update(member);
        f.count = add(f.count);
        if (member[1] === 'unit') {
          f.head = member;
          return;
        }
      }
    };
    try {
      for (const f of frontiers) {
        await advance(f);
      }
      while (true) {
        let first: (typeof frontiers)[number] | undefined;
        for (const f of frontiers) {
          if (f.head && (!first || compareMembership(f.head, first.head!) < 0)) {
            first = f;
          }
        }
        if (!first) {
          return;
        }
        if (
          frontiers.some(
            (f) => f !== first && f.head && compareMembership(f.head, first.head!) === 0,
          )
        ) {
          throw new Error('Mixed Maven publication ownership of one complete unit.');
        }
        await advance(first);
      }
    } finally {
      // Iterators must honor cancellation. Observe retirement without holding abort open.
      const retirements = frontiers.map(async (f) => {
        f.release?.();
        f.release = null;
        await f.iterator.return?.();
      });
      if (this.signal.aborted) {
        void Promise.allSettled(retirements);
      } else {
        const results = await Promise.allSettled(retirements);
        await rejectRetirement(results);
      }
    }
  }

  finish(): WorkerSummary {
    if (!this.completed || !this.identity) {
      throw new Error('Missing worker completion.');
    }
    return {
      identity: this.identity,
      counts: [...this.totals],
      channels: this.summaries,
      eventSha: this.events.digest(),
    };
  }

  async dispose(): Promise<void> {
    this.releaseReplay?.();
    this.releaseReplay = null;
    this.releaseHeader?.();
    this.releaseHeader = null;
    this.channel?.tree.dispose();
    // Closing the backing storage can interrupt an in-flight replay.next(). Always
    // dispose it even when iterator retirement fails; don't wait on aborted producers.
    try {
      const spools = new Set([this.options.membership, ...this.projections.map((p) => p.spool)]);
      const results = await Promise.allSettled([...spools].map((spool) => spool.dispose()));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') {
        throw failed.reason;
      }
    } finally {
      if (this.replay?.return) {
        const retirement = this.replay.return();
        if (this.signal.aborted) {
          void retirement.catch(() => {});
        } else {
          await retirement;
        }
      }
    }
  }
}

async function rejectRetirement(results: PromiseSettledResult<unknown>[]): Promise<void> {
  const failed = results.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason;
  }
}
