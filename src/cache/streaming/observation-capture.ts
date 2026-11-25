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

import { ownsLocalSnapshot, type Partition } from './model';
import type { PostAttempt } from './lifecycle-attempt';
import { PartitionSummaries } from './partition-summaries';
import type { OwnedStore, Reference } from './owned-store';
import { InstallScratch } from './install-scratch';
import { Digest, equal, tuple, type Value } from './encoding';
import { ObservationIndex } from './observation-index';
import { walkNative, walkWork, type NativeChild, type WalkWork } from './native-walk';
import { type NativeIdentity } from './native';
import { createCacheGlobMatcher } from '../glob';
import { isCacheMetadataPath } from '../metadata-paths';
import { isMavenTransientFile } from '../maven-repository';
import { workspaceKind } from '../immutable-workspaces';
import { UnitMarkers } from './unit-markers';
import {
  baseName,
  parentPath,
  compareMembership,
  isWorkspaceRoot,
  isWorkspaceScaffolding,
} from './tree-state';
import { settleNativeCleanup, type NativeOperationOptions } from './native-operation';
import type { Unit } from './schema';

type Activity = 'none' | 'used' | 'upsert';

type Decision = 'retain' | 'delete';

// Temporary hierarchical metadata, no body bytes or durable authority.
type Node = [
  'directory' | 'file',
  string,
  NativeIdentity,
  string | null,
  Activity,
  Decision,
  number,
  number,
  string | null,
  number,
  number,
  Activity,
  Decision,
  number,
];

type Edge = ['edge', string, NativeChild['type'], string, string, number | null];

const rank = (a: Activity) => (a === 'upsert' ? 2 : a === 'used' ? 1 : 0);
const maxActivity = (a: Activity, b: Activity): Activity => (rank(a) >= rank(b) ? a : b);
const compare = (a: string, b: string, ak = 'file', bk = 'file') =>
  compareMembership(['member', ak, a], ['member', bk, b]);
const markerNames = new Set([
  'metadata.bin',
  'results.bin',
  'classes.jar',
  'sources.jar',
  'metadata/metadata.bin',
  'transformed',
  'classes',
  'instrumented',
  'metadata',
  'instrumented/classes',
  'sources',
]);

export interface ObservationCaptureOptions extends NativeOperationOptions {
  /** Operation-local index returned only to the base post owner, never serialized. */
  readonly retainIndex?: boolean;
  readonly attempt: PostAttempt;
  readonly summaries?: PartitionSummaries;
  /** Verified by the trusted lifecycle caller, not by persisted quiescence. Synchronous lifetime assertions only. */
  readonly purgeWindow?: {
    readonly root: OwnedStore['root'];
    readonly invocation: string;
    assertCurrent(): undefined;
  };
  /** Operation-local progress, including completed deletions if capture subsequently fails. No logs per file. */
  readonly onPurge?: (partition: string, outcome: 'deleted' | 'missing' | 'unsupported') => void;
  readonly onOpaqueScope?: (path: string) => void;
  readonly onCaptureInfo?: (message: string) => void;
  readonly onWarning?: (message: string) => void;
}

export interface FrozenObservation {
  readonly index?: ObservationIndex;
  readonly reference: Reference;
  readonly work: Readonly<WalkWork>;
  readonly purge: {
    readonly status: 'not-configured' | 'skipped' | 'executed';
    readonly deleted: number;
    readonly missing: number;
    readonly unsupported: number;
    readonly opaqueScopes: number;
  };
}

const capturedIndexes = new WeakMap<ObservationIndex, PostAttempt>();
/** Same-process original native capture only; serialized observations cannot recreate this loan. */
export function claimCapturedObservationIndex(
  index: ObservationIndex,
  store: OwnedStore,
): PostAttempt {
  ObservationIndex.assert(index, store);
  const attempt = capturedIndexes.get(index);
  if (!attempt) {
    throw new Error('Absent/consumed original observation capture.');
  }
  attempt.assert();
  capturedIndexes.delete(index);
  return attempt;
}

export async function captureObservations(
  store: OwnedStore,
  input: ObservationCaptureOptions,
): Promise<FrozenObservation> {
  const fallback =
    !input.summaries && input.onWarning
      ? new PartitionSummaries(store.codec.options.model, input.budget, false)
      : undefined;
  const summaries = input.summaries ?? fallback;
  let complete = false;
  try {
    const result = await capture(store, { ...input, summaries });
    complete = true;
    return result;
  } finally {
    summaries?.finishCapture(complete, input.onCaptureInfo, input.onWarning);
    fallback?.dispose();
  }
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas.
// The caller owns a current exclusive cache window. This does not stop Gradle/V5.
async function capture(
  store: OwnedStore,
  input: ObservationCaptureOptions,
): Promise<FrozenObservation> {
  input.attempt.assert();
  if (input.attempt.store !== store) {
    throw new Error('Observation attempt/store mismatch.');
  }
  input.attempt.claimCapture();
  const options = Object.freeze({
      ...input,
      signal: AbortSignal.any([input.attempt.signal, ...(input.signal ? [input.signal] : [])]),
    }),
    signal = options.signal ?? new AbortController().signal,
    codec = store.codec,
    model = codec.options.model;
  options.summaries?.assert(model);
  const worker = codec.options.role === 'distributed-worker';
  if (worker && options.purgeWindow) {
    throw new Error('Worker capture cannot purge.');
  }
  const configured = model.partitions.some((p) => p[7]?.length),
    purge = {
      status: !configured
        ? ('not-configured' as const)
        : options.purgeWindow
          ? ('executed' as const)
          : ('skipped' as const),
      deleted: 0,
      missing: 0,
      unsupported: 0,
      opaqueScopes: 0,
    };
  const assertWindow = (): undefined => {
    signal.throwIfAborted();
    const window = options.purgeWindow;
    if (!window || window.root !== store.root || window.invocation !== codec.options.invocation) {
      throw new Error('Unbound purge window.');
    }
    if (window.assertCurrent.constructor.name === 'AsyncFunction') {
      throw new Error('Purge lifetime assertion must be synchronous.');
    }
    if (window.assertCurrent() !== undefined) {
      throw new Error('Purge lifetime assertion must be synchronous.');
    }
  };
  if (configured && options.purgeWindow) {
    assertWindow();
  }
  signal.throwIfAborted();
  await store.assertNoIntents();
  const initial = options.attempt.state,
    bindings = options.attempt.bindings;
  if ((options.maxDirectoryEntries ?? 100000) !== bindings[8][9]) {
    throw new Error('Observation allowance differs from frozen policy.');
  }
  await options.attempt.guard();
  const importedActivity = options.attempt.handoff.header[9];
  const activity = new ActivityCursor(activityFacts(store, importedActivity, options)),
    tree = await InstallScratch.create(store, options.budget),
    frames: Frame[] = [],
    work = walkWork(),
    hard = createCacheGlobMatcher(model.tuple[3]),
    cutoff = BigInt(bindings[8][7]!) * 1000000n,
    gcCutoff = bindings[8][6] === null ? null : BigInt(bindings[8][6]) * 1000000n;
  type Entry = {
    name: string;
    type: NativeChild['type'];
    device: string;
    id: string;
    offset: number | null;
  };
  type Frame = {
    path: string;
    native: NativeIdentity;
    entries: Entry[];
    charge: number;
    unitActivity: Activity;
    activityTimes: readonly [string, string];
    activity: Activity;
    allDelete: boolean;
    files: number;
    directActivity: Activity;
    directDelete: boolean;
    directFiles: number;
    directMask: bigint;
    directSingleWriter: boolean;
  };
  let capturedIndex: ObservationIndex | undefined;
  let root: number | undefined, failure: unknown, completed: FrozenObservation | undefined;
  const owner = (path: string) => {
    try {
      return model.owner(path);
    } catch (e) {
      if (e instanceof Error && /Unowned|Reserved\/excluded/.test(e.message)) {
        return null;
      }
      throw e;
    }
  };
  let workspace: { root: string; markers: [boolean, string][] } | null = null;
  const summaries = options.summaries;
  // Only label known cleanup marker locations, and only after an existing omission decision.
  const housekeeping = (c: NativeChild) =>
    c.type === 'file' &&
    c.name === 'gc.properties' &&
    model.tuple[2] === 'gradle' &&
    /^caches\/(?:modules-[^/]+\/(?:.*\/)?|transforms-[^/]+\/|[^/]+\/(?:kotlin-dsl|groovy-dsl|transforms)\/)gc\.properties$/u.test(
      c.path,
    );
  const mark = (path: string, directory: boolean) => {
    if (!workspace) {
      return;
    }
    const relative = path.slice(workspace.root.length + 1);
    if (markerNames.has(relative)) {
      workspace.markers.push([directory, path]);
    }
  };
  const child = (c: NativeChild): 'prune' | void => {
    const frame = frames[frames.length - 1];
    if (!frame || frame.path !== c.parent) {
      throw new Error('Observation child has no active parent.');
    }
    const charge = 160 + 4 * (Buffer.byteLength(c.name) + c.device.length + c.fileId.length);
    options.budget.retain(charge);
    frame.charge += charge;
    frame.entries.push({
      name: c.name,
      type: c.type,
      device: c.device,
      id: c.fileId,
      offset: null,
    });
    if (c.pruned || hard(c.path) || hard(c.path + '/.workspace-directory-probe')) {
      summaries?.excluded(c.type, undefined, housekeeping(c));
      if (c.type === 'directory') {
        summaries?.prunedDirectory(c.path);
        if (configured && !isCacheMetadataPath(c.path)) {
          purge.opaqueScopes++;
          options.onOpaqueScope?.(c.path);
        }
      }
      return 'prune';
    }
    if (c.type === 'directory') {
      return;
    }
    const partition = owner(c.path);
    if (!partition || (model.tuple[2] === 'maven' && isMavenTransientFile(c.name))) {
      summaries?.excluded(c.type, partition?.[0], housekeeping(c));
      return 'prune';
    }
    if (c.type !== 'file') {
      throw new Error('Unsupported managed observation child.');
    }
    // Local discovery may omit unknown layouts; imported contribution validators stay strict.
    // The existing physical child projection still protects these files from whole-tree moves.
    if (isWorkspaceScaffolding(model, c.path)) {
      if (housekeeping(c)) {
        summaries?.excluded('file', partition[0], true);
      } else {
        summaries?.unsupportedLayout(partition[0], c.path);
      }
      return 'prune';
    }
  };
  const attach = (
    offset: number,
    act: Activity,
    decision: Decision,
    files: number,
    directOwner?: Partition,
  ) => {
    const parent = frames[frames.length - 1];
    if (!parent) {
      if (root !== undefined) {
        throw new Error('Multiple observation roots.');
      }
      root = offset;
      return;
    }
    parent.entries[parent.entries.length - 1].offset = offset;
    parent.activity = maxActivity(parent.activity, act);
    parent.files += files;
    parent.allDelete &&= decision === 'delete';
    if (directOwner) {
      parent.directActivity = maxActivity(parent.directActivity, act);
      parent.directFiles++;
      parent.directDelete &&= decision === 'delete';
      const pi = model.partitions.findIndex((p) => p[0] === directOwner[0]);
      parent.directMask |= 1n << BigInt(pi);
      parent.directSingleWriter ||= model.partitions[pi][3] === 'single-writer';
    }
  };
  const walk = walkNative(
    store.root,
    '',
    {
      ...options,
      metadata: 'exclude',
      purge:
        configured && options.purgeWindow
          ? {
              claim: (path) => model.purge(path),
              assertCurrent: assertWindow,
              outcome: (partition, outcome) => {
                purge[outcome]++;
                options.summaries?.purge(partition, outcome);
                options.onPurge?.(partition, outcome);
              },
              checkpoint: (phase) => store.fail('observation-purge-' + phase),
            }
          : undefined,
      inspectChild: child,
    },
    work,
  );
  try {
    summaries?.capture(!!options.purgeWindow);
    await activity.start();
    for await (const e of walk) {
      signal.throwIfAborted();
      if (e.tag === 'protected-child') {
        continue;
      }
      if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1')) {
        throw new Error('Aliased/cross-device observation source.');
      }
      if (e.tag === 'directory-open') {
        mark(e.path, true);
        let unitActivity: Activity = 'none';
        if (
          isWorkspaceRoot(model, e.path) ||
          (model.tuple[2] === 'maven' &&
            (e.path === 'repository' || e.path.startsWith('repository/')))
        ) {
          unitActivity = await activity.take('unit', e.path);
        }
        if (isWorkspaceRoot(model, e.path)) {
          if (workspace) {
            throw new Error('Nested observation workspace.');
          }
          workspace = { root: e.path, markers: [] };
        }
        const charge = 128; // Per-directory reduction state.
        options.budget.retain(charge);
        frames.push({
          path: e.path,
          native: e.identity,
          entries: [],
          charge,
          unitActivity,
          activityTimes: e.activityTimes ?? [e.identity[8], e.identity[9]],
          activity: unitActivity,
          allDelete: true,
          files: 0,
          directActivity: unitActivity,
          directDelete: true,
          directFiles: 0,
          directMask: 0n,
          directSingleWriter: false,
        });
      } else if (e.tag === 'file') {
        mark(e.path, false);
        const p = owner(e.path)!;
        const imported = await activity.take('file', e.path),
          localSnapshot = ownsLocalSnapshot(p, codec.options);
        const act: Activity =
          localSnapshot ||
          imported === 'upsert' ||
          BigInt(e.identity[8]) >= cutoff ||
          BigInt(e.identity[9]) >= cutoff
            ? 'upsert'
            : imported === 'used' || BigInt(e.identity[7]) >= cutoff
              ? 'used'
              : 'none';
        const decision: Decision =
          p[3] === 'aggregate' &&
          !(model.dependencyCacheLayer && !worker && p[6] === 1) &&
          act === 'none' &&
          gcCutoff !== null &&
          BigInt(e.identity[8]) < gcCutoff
            ? 'delete'
            : 'retain';
        attach(
          await tree.append([
            'file',
            e.path,
            e.identity,
            p[0],
            act,
            decision,
            0,
            0,
            null,
            1,
            1,
            act,
            decision,
            1,
          ]),
          act,
          decision,
          1,
          p,
        );
        summaries?.capturedFile(p[0], e.identity[5]);
      } else {
        const frame = frames.pop()!;
        try {
          const { files, directFiles, directMask } = frame,
            act =
              BigInt(frame.activityTimes[0]) >= cutoff || BigInt(frame.activityTimes[1]) >= cutoff
                ? 'upsert'
                : frame.activity,
            decision = files > 0 && frame.allDelete ? 'delete' : 'retain';
          let directDelete = frame.directDelete;
          if (
            frame.directSingleWriter &&
            (directMask & (directMask - 1n)) !== 0n &&
            model.tuple[2] === 'maven' &&
            e.path.startsWith('repository/')
          ) {
            throw new Error('Maven direct unit splits a snapshot owner.');
          }
          let kind: string | null = null,
            complete = 1;
          if (workspace?.root === e.path) {
            kind = workspaceKind(
              e.path,
              workspace.markers.filter(([dir]) => !dir).map(([, p]) => p),
            );
            const markers = new UnitMarkers([kind, e.path, 'subtree'] as Unit);
            for (const [dir, p] of workspace.markers) {
              if (dir) {
                markers.directory(p);
              } else {
                markers.file(p);
              }
            }
            try {
              markers.finish();
            } catch {
              complete = 0;
            }
            workspace = null;
          } else if (
            model.tuple[2] === 'maven' &&
            (e.path === 'repository' || e.path.startsWith('repository/')) &&
            (directFiles || frame.unitActivity !== 'none')
          ) {
            kind = 'maven-directory';
          }
          if (
            kind === 'maven-directory' &&
            frame.entries.some(
              (x) =>
                x.offset === null &&
                x.type !== 'directory' &&
                !isCacheMetadataPath(e.path + '/' + x.name) &&
                !isMavenTransientFile(x.name),
            )
          ) {
            directDelete = false;
          }
          const start = tree.position;
          for (const entry of frame.entries) {
            await tree.append([
              'edge',
              entry.name,
              entry.type,
              entry.device,
              entry.id,
              entry.offset,
            ]);
          }
          // Preserve walked scaffolding too: worker replay must co-read the same tree
          // and detect late children there, without treating an unowned directory as payload.
          const end = tree.position;
          const offset = await tree.append([
            'directory',
            e.path,
            e.identity,
            null,
            act,
            decision,
            start,
            end,
            kind,
            files,
            complete,
            frame.directActivity,
            directFiles > 0 && directDelete ? 'delete' : 'retain',
            directFiles,
          ]);
          attach(offset, act, decision, files);
        } finally {
          options.budget.release(frame.charge);
        }
      }
    }
    await activity.finish();
    if (root === undefined) {
      throw new Error('Missing observation root.');
    }
    const rendered = renderObservations(tree, root, signal);
    if (options.retainIndex) {
      capturedIndex = await ObservationIndex.write(store, rendered, options);
    }
    const reference =
      capturedIndex?.reference ??
      (await store.writeStream('observations', { ...options, partition: null }, rendered, signal));
    await store.fail('observations-candidate');
    const state = codec.schemas.documents['local-state'].parse(await store.state());
    equal(state, initial, 'observation capture state');
    await store.assertNoIntents();
    signal.throwIfAborted();
    if (configured && options.purgeWindow) {
      assertWindow();
    }
    await options.attempt.guard();
    await store.fail('observations-pointer');
    signal.throwIfAborted();
    completed = Object.freeze({
      reference: Object.freeze(reference) as Reference,
      work: Object.freeze({ ...work }),
      purge: Object.freeze({ ...purge }),
      ...(capturedIndex ? { index: capturedIndex } : {}),
    });
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    for (const frame of frames) {
      options.budget.release(frame.charge);
    }
    await settleNativeCleanup(
      [
        () => walk.return(undefined),
        () => activity.close(),
        () => tree.close(),
        () => (failure === undefined ? undefined : capturedIndex?.dispose()),
      ],
      failure,
    ).catch(async (error) => {
      await settleNativeCleanup([() => capturedIndex?.dispose()], error);
      throw error;
    });
  }
  try {
    signal.throwIfAborted();
    if (configured && options.purgeWindow) {
      assertWindow();
    }
    if (capturedIndex) {
      capturedIndexes.set(capturedIndex, options.attempt);
    }
    return completed!;
  } catch (error) {
    await settleNativeCleanup([() => capturedIndex?.dispose()], error);
    throw error;
  }
}

async function* renderObservations(
  tree: InstallScratch,
  root: number,
  signal: AbortSignal,
): AsyncGenerator<Value> {
  async function* edges(n: Node): AsyncGenerator<Edge> {
    for await (const r of tree.rows(n[6], n[7])) {
      signal.throwIfAborted();
      yield r as Edge;
    }
  }
  async function* facts(offset: number, direct: boolean): AsyncGenerator<Value> {
    const lease = await tree.record(offset),
      n = lease.value as Node;
    try {
      if (n[0] === 'file') {
        yield ['file', n[1], n[3], n[2]];
        return;
      }
      yield ['directory', n[1], n[2]];
      for await (const e of edges(n)) {
        yield ['child', n[1], e[1], e[2], e[3], e[4]];
      }
      for await (const e of edges(n)) {
        if (e[5] !== null && (e[2] === 'file' || !direct)) {
          yield* facts(e[5], false);
        }
      }
    } finally {
      lease.release();
    }
  }
  async function* visit(
    offset: number,
    override?: readonly [Activity, Decision],
  ): AsyncGenerator<Value> {
    signal.throwIfAborted();
    const lease = await tree.record(offset),
      n = lease.value as Node;
    try {
      if (n[0] === 'file') {
        yield ['file', baseName(n[1]), n[3], n[2], override?.[0] ?? n[4], override?.[1] ?? n[5]];
        return;
      }
      yield ['dir-open', n[1], n[2]];
      for await (const e of edges(n)) {
        yield ['child', e[1], e[2], e[3], e[4]];
      }
      const unit = n[8] !== null && !override,
        direct = n[8] === 'maven-directory';
      let selected = override,
        sha: string | undefined;
      if (unit) {
        const digest = new Digest('observation-unit');
        for await (const f of facts(offset, direct)) {
          digest.update(f);
        }
        sha = digest.digest();
        const act = direct ? n[11] : n[4],
          deletion =
            (direct ? n[12] : n[5]) === 'delete' && act === 'none' && n[10] === 1
              ? 'delete'
              : 'retain';
        selected = [act, deletion];
        yield ['unit-open', n[8], n[1], direct ? 'direct' : 'subtree', act, deletion, sha];
      }
      for await (const e of edges(n)) {
        if (e[5] !== null && (e[2] === 'file' || !direct)) {
          yield* visit(e[5], selected);
        }
      }
      if (unit) {
        yield ['unit-close', n[8], n[1], sha!];
      }
      if (direct) {
        for await (const e of edges(n)) {
          if (e[5] !== null && e[2] === 'directory') {
            yield* visit(e[5], override);
          }
        }
      }
      yield ['dir-close', n[1]];
    } finally {
      lease.release();
    }
  }
  yield* visit(root);
}

async function* activityFacts(
  store: OwnedStore,
  ref: Reference,
  options: NativeOperationOptions,
): AsyncGenerator<readonly [string, 'file' | 'unit', Activity]> {
  let path = '';
  for await (const record of store.rows(
    ref,
    'activity',
    { ...options, partition: null },
    options.signal,
  )) {
    options.signal?.throwIfAborted();
    const row = tuple(record.value);
    if (row[0] === 'dir-open') {
      path = String(row[1]);
    } else if (row[0] === 'dir-close') {
      path = parentPath(path);
    } else if (row[0] === 'unit-open') {
      yield [String(row[2]), 'unit', row[4] as Activity];
    } else if (row[0] === 'upsert' || row[0] === 'used') {
      yield [path ? path + '/' + row[1] : String(row[1]), 'file', row[0]];
    }
  }
}
class ActivityCursor {
  private readonly iterator: AsyncIterator<readonly [string, 'file' | 'unit', Activity]>;
  private head?: IteratorResult<readonly [string, 'file' | 'unit', Activity]>;

  constructor(source: AsyncIterable<readonly [string, 'file' | 'unit', Activity]>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async start() {
    this.head = await this.iterator.next();
  }

  async take(kind: 'file' | 'unit', path: string): Promise<Activity> {
    while (this.head && !this.head.done) {
      const h = this.head.value,
        c = compare(h[0], path, h[1], kind);
      if (c > 0) {
        return 'none';
      }
      this.head = await this.iterator.next();
      if (c === 0) {
        return h[2];
      }
    }
    return 'none';
  }

  async finish() {
    while (this.head && !this.head.done) {
      this.head = await this.iterator.next();
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}
