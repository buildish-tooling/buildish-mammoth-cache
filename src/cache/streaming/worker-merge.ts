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

import type { Readable } from 'node:stream';
import { withAbort } from './abort';
import { contextSchema, nameSchema, unitSchema, type Context } from './schema';
import { add, tuple, type Value } from './encoding';
import type { OwnedStore } from './owned-store';
import { ordinaryOrder, reduceOrdinary, type Candidate } from './reduction';
import { baseName, compareName, joinPath, normalizeMode, type WorkingBudget } from './tree-state';
import { globalChannelKey, type WorkerSummary } from './worker-state';
import { DiskMembership } from './worker-spool';
import { WorkerFrontier, type FrontierItem } from './worker-frontier';
import { WorkerStage, type StagedPartition } from './worker-stage';
import { ActivityProjection } from './worker-activity';
import { mergeCompleteUnit } from './worker-units';

export interface WorkerMergeInput {
  readonly job: string;
  readonly source: Readable;
  readonly context: Context;
  readonly authorizedSnapshots?: readonly string[];
  readonly producerId?: string;
}
import { MetadataSnapshot } from './metadata-snapshot';
export interface WorkerSnapshotRequirement {
  readonly partition: string;
  readonly job: string;
  readonly required: boolean;
  readonly baseline?: MetadataSnapshot;
}
export interface WorkerMergeOptions {
  readonly budget: WorkingBudget;
  readonly ordinaryOrder: readonly string[];
  readonly ordinaryPolicy: 'strict' | 'newer-mtime';
  readonly snapshots?: readonly WorkerSnapshotRequirement[];
  readonly maxDirectoryEntries?: number;
  readonly signal?: AbortSignal;
}
export interface WorkerMergeResult {
  readonly stage: WorkerStage;
  readonly partitions: readonly StagedPartition[];
  readonly summaries: readonly WorkerSummary[];
  readonly readers: readonly WorkerFrontier[];
  readonly activity: readonly ActivityProjection[];
  readonly inheritedSnapshots: readonly MetadataSnapshot[];
  readonly selectedSnapshots: readonly string[];
  readonly snapshotOrigins: readonly { partition: string; producerId: string }[];
  readonly warnings: Readonly<{ count: number; details: readonly string[] }>;
  dispose(): Promise<void>;
}
export interface WorkerMergeCursor {
  input: WorkerMergeInput;
  reader: WorkerFrontier;
  head: FrontierItem | null;
  snapshots: readonly string[];
}
const control = (c: WorkerMergeCursor): readonly Value[] =>
  c.head?.type === 'control' ? tuple(c.head.value) : [];
const completedInputs = new WeakMap<
  object,
  {
    store: OwnedStore;
    disposed: boolean;
    claimed: boolean;
    policy: string;
    order: readonly string[];
    max: number;
  }
>();
export function assertCompletedWorkerInputs(store: OwnedStore, result: WorkerMergeResult) {
  const binding = completedInputs.get(result);
  if (!binding || binding.store !== store || binding.disposed)
    throw new Error('Unbound/retired worker merge inputs.');
  return Object.freeze({ policy: binding.policy, order: binding.order, max: binding.max });
}
export function claimCompletedWorkerInputs(store: OwnedStore, result: WorkerMergeResult) {
  const evidence = assertCompletedWorkerInputs(store, result),
    binding = completedInputs.get(result)!;
  if (binding.claimed) throw new Error('Worker merge already claimed.');
  binding.claimed = true;
  return evidence;
}
// Protocol: docs/dev/cache-protocol.md#streaming-merge-and-acceptance.
// This is the only worker merge engine. Complete archive success grants provisional
// staging/activity; final native index acceptance and original-part transfer grant authority.
export async function mergeWorkerArchives(
  store: OwnedStore,
  inputs: readonly WorkerMergeInput[],
  options: WorkerMergeOptions,
): Promise<WorkerMergeResult> {
  let order: string[], stage: WorkerStage;
  const cursors: WorkerMergeCursor[] = [],
    projections: ActivityProjection[] = [],
    controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const snapshotRequirements = new Map<string, WorkerSnapshotRequirement>(),
    selectedSnapshots = new Set<string>(),
    inheritedSnapshots: MetadataSnapshot[] = [];
  const warnings = { count: 0, details: [] as string[] };
  let detailBytes = 0;
  const warning = (message: string) => {
    warnings.count = add(warnings.count);
    if (warnings.details.length < 10 && detailBytes + Buffer.byteLength(message) <= 32768) {
      warnings.details.push(message);
      detailBytes += Buffer.byteLength(message);
    }
  };
  try {
    options = Object.freeze({
      ...options,
      ordinaryOrder: Object.freeze([...options.ordinaryOrder]),
      snapshots: Object.freeze((options.snapshots ?? []).map((s) => Object.freeze({ ...s }))),
    });
    inputs = Object.freeze(
      inputs.map((input) =>
        Object.freeze({
          ...input,
          context: Object.freeze(contextSchema.parse(input.context)) as Context,
          authorizedSnapshots: Object.freeze([...(input.authorizedSnapshots ?? [])]),
        }),
      ),
    );
    if (inputs.length > 16) throw new Error('Worker merge producer admission exceeded.');
    order = ordinaryOrder(options.ordinaryOrder);
    const jobs = new Set<string>();
    for (const req of options.snapshots!) {
      const partition = store.codec.options.model.partitions.find((p) => p[0] === req.partition);
      if (
        !partition ||
        partition[3] !== 'single-writer' ||
        (partition[4] !== null && partition[4] !== req.job) ||
        snapshotRequirements.has(req.partition)
      )
        throw new Error('Invalid snapshot writer selection.');
      nameSchema.parse(req.job);
      if (req.baseline) MetadataSnapshot.assertReceipt(req.baseline, store, req.partition);
      snapshotRequirements.set(req.partition, req);
    }
    if (
      store.codec.options.model.partitions.some(
        (p) =>
          p[3] === 'single-writer' &&
          p[4] !== null &&
          p[4] !== store.codec.options.context[4] &&
          !snapshotRequirements.has(p[0]),
      )
    )
      throw new Error('Missing complete snapshot writer selection.');
    for (const input of inputs) {
      nameSchema.parse(input.job);
      if (jobs.has(input.job) || input.job !== input.context[4])
        throw new Error('Unbound/duplicate merge producer.');
      jobs.add(input.job);
      for (const id of input.authorizedSnapshots!)
        if (snapshotRequirements.get(id)?.job !== input.job)
          throw new Error('Snapshot authorization mismatch.');
    }
    signal.throwIfAborted();
    const max = options.maxDirectoryEntries ?? 100000;
    if (!Number.isSafeInteger(max) || max < 1)
      throw new Error('Invalid directory entry allowance.');
    stage = await WorkerStage.create(store, options.budget);
  } catch (error) {
    for (const input of inputs) input.source.destroy();
    throw error;
  }
  const advance = async (c: WorkerMergeCursor) => {
    c.head = await c.reader.next();
  };
  const expectControl = (c: WorkerMergeCursor, tag: string, path?: string) => {
    const r = control(c);
    if (r[0] !== tag || (path !== undefined && r[2] !== path))
      throw new Error('Unexpected merge frontier ' + tag);
    return r;
  };
  let selected: (c: WorkerMergeCursor) => boolean = () => false;
  let activity: ActivityProjection;
  const files = async (group: WorkerMergeCursor[], path: string) => {
    const eligible = group.filter(selected),
      partition = store.codec.options.model.owner(path),
      handling = partition[5];
    const sorted = [...eligible].sort((a, b) => {
        if (handling === 'choose-worker-entry')
          return a.input.job < b.input.job ? -1 : a.input.job > b.input.job ? 1 : 0;
        const ah = a.head,
          bh = b.head;
        if (ah?.type !== 'file' || bh?.type !== 'file') throw new Error('Missing file frontier.');
        return (
          bh.file.header.mtimeMs - ah.file.header.mtimeMs ||
          order.indexOf(a.input.job) - order.indexOf(b.input.job)
        );
      }),
      chosen = sorted[0],
      candidates: Candidate[] = [];
    let pending: Awaited<ReturnType<WorkerStage['write']>> | undefined;
    try {
      for (const c of group) {
        const h = c.head;
        if (h?.type !== 'file' || h.file.path !== path) throw new Error('Unaligned merge file.');
        const header = h.file.header;
        if (c === chosen) pending = await stage.write(h.file, signal);
        else
          for await (const b of h.file.body) {
            void b;
            signal.throwIfAborted();
          }
        // Body acknowledgement precedes the independently validated metadata rendezvous.
        await advance(c);
        const meta = expectControl(c, 'file-meta');
        if (selected(c))
          candidates.push([c.input.job, String(meta[3]), header.size, header.mtimeMs, header.mode]);
      }
      if (chosen) {
        const launcher = normalizeMode(store.codec.options.model.tuple[2], path, 0o644) === 0o755;
        const reduced =
          handling === 'choose-worker-entry' || partition[3] === 'single-writer'
            ? candidates.find((c) => c[0] === chosen.input.job)!
            : reduceOrdinary(candidates, order, options.ordinaryPolicy, launcher);
        if (!reduced || !pending) throw new Error('Missing selected ordinary file.');
        if (
          handling === 'choose-worker-entry' &&
          candidates.some((c) => c[1] !== reduced[1] || c[2] !== reduced[2])
        )
          warning('Selected worker entry at ' + path);
        await pending.finish(reduced[1], reduced[2], reduced[4], reduced[3]);
        await activity.member('upsert', path, partition[0], signal);
      }
      for (const c of group) await advance(c);
    } finally {
      await pending?.close();
    }
  };
  const directory = async (group: WorkerMergeCursor[], path: string): Promise<void> => {
    stage.enter(path);
    await activity.enter(path, signal);
    for (const c of group) {
      expectControl(c, 'dir-open', path);
      await advance(c);
    }
    const emptySelected =
      path !== '' && group.some((c) => selected(c) && control(c)[0] === 'dir-close');
    const units = group.filter((c) => control(c)[0] === 'unit-open');
    if (units.length) {
      await mergeCompleteUnit(units, path, {
        store,
        stage,
        activity,
        budget: options.budget,
        signal,
        advance,
        selected,
        warning,
      });
    }
    while (true) {
      const ready = group.filter((c) => c.head?.type === 'file');
      if (!ready.length) break;
      const path = ready
        .map((c) => (c.head!.type === 'file' ? c.head!.file.path : ''))
        .sort((a, b) => compareName(baseName(a), baseName(b)))[0];
      await files(
        ready.filter((c) => c.head?.type === 'file' && c.head.file.path === path),
        path,
      );
    }
    while (true) {
      const ready = group.filter((c) => control(c)[0] === 'dir-open');
      if (!ready.length) break;
      const child = ready
        .map((c) => String(control(c)[2]))
        .sort((a, b) => compareName(baseName(a), baseName(b)))[0];
      await directory(
        ready.filter((c) => control(c)[2] === child),
        child,
      );
    }
    for (const c of group) expectControl(c, 'dir-close', path);
    if (emptySelected) {
      await stage.ensure(
        store.codec.options.model.owner(path + '/.workspace-directory-probe')[0],
        signal,
      );
      await activity.ensure(signal);
    }
    for (const c of group) await advance(c);
    await stage.leave(path, signal);
    await activity.leave(path, signal);
  };
  const usage = async (c: WorkerMergeCursor) => {
    let projection: ActivityProjection | undefined;
    const stack: string[] = [];
    if (order.includes(c.input.job)) {
      projection = await ActivityProjection.create(
        store,
        options.budget,
        options.maxDirectoryEntries,
        'used',
      );
      projections.push(projection);
    }
    while (control(c)[0] !== 'channel-close') {
      const r = control(c);
      signal.throwIfAborted();
      if (r[0] === 'dir-open') {
        stack.push(String(r[2]));
        await projection?.enter(String(r[2]), signal);
      } else if (r[0] === 'dir-close') {
        const path = stack.pop();
        if (path !== r[2]) throw new Error('Unbalanced usage projection.');
        await projection?.leave(path, signal);
      } else if (r[0] === 'used-unit-open')
        await projection?.unitOpen(unitSchema.parse(r.slice(2, 5)), 'used', signal);
      else if (r[0] === 'used-unit-close') await projection?.unitClose(signal);
      else if (r[0] === 'used')
        await projection?.member(
          'used',
          joinPath(stack[stack.length - 1], String(r[2])),
          String(r[3]),
          signal,
        );
      else throw new Error('Unexpected usage frontier.');
      await advance(c);
    }
    if (stack.length) throw new Error('Incomplete usage projection.');
    projection?.seal(signal);
  };
  try {
    for (const input of inputs) {
      const membership = await DiskMembership.create(store, options.budget),
        reader = new WorkerFrontier(
          input.source,
          {
            model: store.codec.options.model,
            context: input.context,
            authorizedSnapshots: input.authorizedSnapshots!,
            budget: options.budget,
            membership,
            maxDirectoryEntries: options.maxDirectoryEntries,
          },
          signal,
        );
      void reader.completion.catch((error) => controller.abort(error));
      const c: WorkerMergeCursor = { input, reader, head: null, snapshots: [] };
      cursors.push(c);
      await advance(c);
      const identity = expectControl(c, 'identity');
      c.snapshots = identity[7] as readonly string[];
      await advance(c);
    }
    while (cursors.some((c) => c.head)) {
      const ready = cursors.filter((c) => control(c)[0] === 'channel-open');
      if (!ready.length) throw new Error('Invalid global channel frontier.');
      const key = Math.min(
          ...ready.map((c) =>
            globalChannelKey(store.codec.options.model, c.snapshots, Number(control(c)[1])),
          ),
        ),
        group = ready.filter(
          (c) =>
            globalChannelKey(store.codec.options.model, c.snapshots, Number(control(c)[1])) === key,
        );
      const partition = key < 2 ? null : store.codec.options.model.partitions[key - 2][0];
      selected =
        key === 0
          ? (c) => order.includes(c.input.job)
          : (c) => snapshotRequirements.get(partition!)?.job === c.input.job;
      if (partition) {
        if (group.filter(selected).length !== 1)
          throw new Error('Ambiguous snapshot writer contribution.');
        selectedSnapshots.add(partition);
      }
      for (const c of group) await advance(c);
      if (key === 1) {
        for (const c of group) await usage(c);
      } else {
        activity = await ActivityProjection.create(
          store,
          options.budget,
          options.maxDirectoryEntries,
        );
        projections.push(activity);
        await directory(group, '');
        activity.seal(signal);
        if (partition && !stage.hasPartition(partition)) {
          stage.enter('');
          await stage.ensure(partition, signal);
          await stage.leave('', signal);
        }
      }
      for (const c of group) {
        expectControl(c, 'channel-close');
        await advance(c);
        if (control(c)[0] === 'complete') {
          await advance(c);
          if (c.head) throw new Error('Trailing archive event.');
        }
      }
    }
    const summaries = await Promise.all(cursors.map((c) => c.reader.completion));
    for (const req of snapshotRequirements.values())
      if (!selectedSnapshots.has(req.partition)) {
        if (inputs.some((input) => input.job === req.job))
          throw new Error('Admitted snapshot writer omitted selected partition ' + req.partition);
        if (req.required) throw new Error('Missing required snapshot writer ' + req.job);
        if (!req.baseline || req.baseline.partition !== req.partition)
          throw new Error('Missing prepared optional snapshot baseline.');
        await withAbort(
          req.baseline.verify(signal, options.budget, options.maxDirectoryEntries),
          signal,
        );
        inheritedSnapshots.push(req.baseline);
      }
    const partitions = await stage.seal(signal);
    signal.throwIfAborted();
    const result: WorkerMergeResult = {
      stage,
      partitions,
      summaries,
      readers: cursors.map((c) => c.reader),
      activity: Object.freeze(projections),
      inheritedSnapshots: Object.freeze(inheritedSnapshots),
      selectedSnapshots: Object.freeze([...selectedSnapshots]),
      snapshotOrigins: Object.freeze(
        [...selectedSnapshots].map((partition) => {
          const job = snapshotRequirements.get(partition)!.job;
          return Object.freeze({
            partition,
            producerId: inputs.find((input) => input.job === job)!.producerId ?? job,
          });
        }),
      ),
      warnings: Object.freeze({ count: warnings.count, details: Object.freeze(warnings.details) }),
      dispose: async () => {
        completedInputs.get(result)!.disposed = true;
        const results = await Promise.allSettled(projections.map((p) => p.dispose()));
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason);
        try {
          await stage.dispose();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Worker merge cleanup failed.');
      },
    };
    completedInputs.set(result, {
      store,
      disposed: false,
      claimed: false,
      policy: options.ordinaryPolicy,
      order: Object.freeze([...order]),
      max: options.maxDirectoryEntries ?? 100000,
    });
    return Object.freeze(result);
  } catch (error) {
    controller.abort(error);
    for (const input of inputs) input.source.destroy();
    await Promise.all(cursors.map((c) => c.reader.close()));
    const cleanups = await Promise.allSettled(projections.map((p) => p.dispose()));
    const failures = cleanups
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);
    try {
      await stage.dispose();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], 'Worker merge failed; cleanup blocked.', {
        cause: error,
      });
    throw error;
  }
}
