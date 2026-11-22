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

import { assertBaseMetadata, type BaseMetadata } from './baseline-metadata';
import type { PartitionSummaries } from './partition-summaries';
import type { OwnedStore, Reference } from './owned-store';
import { InstallScratch } from './install-scratch';
import { decodeRecords, Digest, equal, tuple, type Value } from './encoding';
import { ObservationIndex } from './observation-index';
import { lstat } from 'node:fs/promises';
import { walkNative, walkWork, type NativeChild, type WalkWork } from './native-walk';
import { sameObject, nativeIdentity, sameNative, type NativeIdentity } from './native';
import { createCacheGlobMatcher } from '../manifest';
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
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import { baseFileBytes } from './base-layout';
import { decodeGeneration } from './native-records';
import type { Unit } from './schema';

type Activity = 'none' | 'used' | 'upsert';
type Decision = 'retain' | 'delete';
// Temporary hierarchical metadata, no body bytes or durable authority.
type Node = [
  'directory' | 'file',
  string,
  NativeIdentity,
  string | null,
  Value,
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

export interface ObservationCaptureOptions extends BaseObjectOptions {
  /** Operation-local index returned only to the base post owner, never serialized. */
  readonly retainIndex?: boolean;
  /** Genuine pinned metadata retained through prepare; never a caller-supplied hash table. */
  readonly baseline?: readonly BaseMetadata[];
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

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas.
// The caller owns a current exclusive cache window. This does not stop Gradle/V5.
export async function captureObservations(
  store: OwnedStore,
  input: ObservationCaptureOptions,
): Promise<FrozenObservation> {
  if (input.baseline && input.baseline.length > 64)
    throw new Error('Observation baseline frontier exceeded.');
  const options = Object.freeze({ ...input, baseline: Object.freeze([...(input.baseline ?? [])]) }),
    signal = options.signal ?? new AbortController().signal,
    codec = store.codec,
    model = codec.options.model;
  options.summaries?.assert(model);
  const worker = codec.options.role === 'distributed-worker';
  if (worker && options.purgeWindow) throw new Error('Worker capture cannot purge.');
  const configured = model.partitions.some((p) => p[6]?.length),
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
    if (!window || window.root !== store.root || window.invocation !== codec.options.invocation)
      throw new Error('Unbound purge window.');
    if (window.assertCurrent.constructor.name === 'AsyncFunction')
      throw new Error('Purge lifetime assertion must be synchronous.');
    if (window.assertCurrent() !== undefined)
      throw new Error('Purge lifetime assertion must be synchronous.');
  };
  if (configured && options.purgeWindow) assertWindow();
  signal.throwIfAborted();
  await store.assertNoIntents();
  const initial = codec.schemas.documents['local-state'].parse(await store.state()),
    bindings = codec.schemas.documents.bindings.parse(
      await store.readDocument(initial[5], 'bindings'),
    );
  codec.checkStateBindings(initial, bindings);
  if (
    bindings[5][0] !== store.root.path ||
    !sameObject(bindings[5][1], store.root.binding) ||
    bindings[5][1][6] !== store.root.binding[6]
  )
    throw new Error('Observation root binding changed.');
  if (
    codec.options.access !== 'writable' ||
    initial[4] !== (worker ? 'build-ready' : 'quiescent') ||
    initial[6] !== null
  )
    throw new Error(
      'Observation capture requires writable quiescent base or build-ready worker state.',
    );
  if ((options.maxDirectoryEntries ?? 100000) !== bindings[8][9])
    throw new Error('Observation allowance differs from frozen policy.');
  await store.readStream(bindings[6], 'model', { ...options, partition: null }, undefined, signal);
  await store.readStream(
    bindings[10],
    'producers',
    { ...options, partition: null },
    undefined,
    signal,
  );
  await store.readStream(
    bindings[11],
    'prepare-sources',
    { ...options, partition: null },
    undefined,
    signal,
  );
  await store.readStream(
    bindings[12]!,
    'activity',
    { ...options, partition: null },
    undefined,
    signal,
  );
  if (initial[13]) {
    const q = codec.schemas.documents.quiescence.parse(
      await store.readDocument(initial[13], 'quiescence'),
    );
    await store.readStream(
      q[3],
      'installations',
      { ...options, partition: null },
      undefined,
      signal,
    );
  }
  const baseline = bindings[9]
    ? decodeGeneration(await baseFileBytes(store, bindings[9][2]), model, bindings[9][1])
    : null;
  const seen = new Set<string>();
  for (const object of options.baseline) {
    assertBaseMetadata(object, store);
    const p = object.reference[1][2],
      old = baseline?.[8].find((e) => e[1] === p);
    if (seen.has(p) || old?.[0] !== 'object')
      throw new Error('Unbound/duplicate observation baseline.');
    equal(object.reference, old[2], 'observation pinned baseline');
    seen.add(p);
  }
  const activity = new ActivityCursor(activityFacts(store, bindings[12]!, options)),
    tree = await InstallScratch.create(store, options.budget),
    frames: Frame[] = [],
    work = walkWork(),
    hard = createCacheGlobMatcher(model.tuple[3]),
    cutoff = BigInt(bindings[8][7]!) * 1000000n,
    gcCutoff = bindings[8][6] === null ? null : BigInt(bindings[8][6]) * 1000000n;
  let bases: BaselineCursor;
  try {
    bases = await BaselineCursor.open(store, options.baseline, options);
  } catch (error) {
    await settleBaseCleanup([() => tree.close()], error);
    throw error;
  }
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
    unit?: { kind: string; markers: readonly [boolean, string][]; complete: number };
  };
  let capturedIndex: ObservationIndex | undefined;
  let root: number | undefined,
    pending: Promise<'prune' | void> | undefined,
    failure: unknown,
    completed: FrozenObservation | undefined;
  const owner = (path: string) => {
    try {
      return model.owner(path);
    } catch (e) {
      if (e instanceof Error && /Unowned|Reserved\/excluded/.test(e.message)) return null;
      throw e;
    }
  };
  let workspace: { root: string; markers: [boolean, string][] } | null = null;
  const skippedLayouts = new Set<string>();
  const warnUnknownLayout = (path: string) => {
    if (!options.onWarning || skippedLayouts.size >= 10) return;
    const parts = path.split('/'),
      sample = parts
        .slice(0, parts[1]?.startsWith('transforms-') ? 3 : 4)
        .join('/')
        .slice(0, 256);
    if (skippedLayouts.has(sample)) return;
    skippedLayouts.add(sample);
    options.onWarning('Skipped unrecognized Gradle cache tree: ' + sample);
  };
  const mark = (path: string, directory: boolean) => {
    if (!workspace) return;
    const relative = path.slice(workspace.root.length + 1);
    if (markerNames.has(relative)) workspace.markers.push([directory, path]);
  };
  const child = async (c: NativeChild): Promise<'prune' | void> => {
    const frame = frames[frames.length - 1];
    if (!frame || frame.path !== c.parent)
      throw new Error('Observation child has no active parent.');
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
      if (configured && c.type === 'directory' && !isCacheMetadataPath(c.path)) {
        purge.opaqueScopes++;
        options.summaries?.opaqueScope(c.path);
        options.onOpaqueScope?.(c.path);
      }
      return 'prune';
    }
    if (c.type === 'directory') return;
    if (!owner(c.path) || (model.tuple[2] === 'maven' && isMavenTransientFile(c.name)))
      return 'prune';
    if (c.type !== 'file') throw new Error('Unsupported managed observation child.');
    // Local discovery may omit unknown layouts; imported contribution validators stay strict.
    // The existing physical child projection still protects these files from whole-tree moves.
    if (isWorkspaceScaffolding(model, c.path)) {
      warnUnknownLayout(c.path);
      return 'prune';
    }
  };
  const attach = (offset: number) => {
    const parent = frames[frames.length - 1];
    if (!parent) {
      if (root !== undefined) throw new Error('Multiple observation roots.');
      root = offset;
    } else parent.entries[parent.entries.length - 1].offset = offset;
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
      inspectChild: (c) => {
        pending = child(c);
        return pending;
      },
    },
    work,
  );
  try {
    await activity.start();
    options.summaries?.capture(!!options.purgeWindow);
    for await (const e of walk) {
      signal.throwIfAborted();
      if (e.tag === 'protected-child') continue;
      if (e.identity[3] !== store.root.binding[3] || (e.tag === 'file' && e.links !== '1'))
        throw new Error('Aliased/cross-device observation source.');
      if (e.tag === 'directory-open') {
        mark(e.path, true);
        let unitActivity: Activity = 'none';
        if (
          isWorkspaceRoot(model, e.path) ||
          (model.tuple[2] === 'maven' &&
            (e.path === 'repository' || e.path.startsWith('repository/')))
        )
          unitActivity = await activity.take('unit', e.path);
        if (isWorkspaceRoot(model, e.path)) {
          if (workspace) throw new Error('Nested observation workspace.');
          workspace = { root: e.path, markers: [] };
        }
        frames.push({
          path: e.path,
          native: e.identity,
          entries: [],
          charge: 0,
          unitActivity,
          activityTimes: e.activityTimes ?? [e.identity[8], e.identity[9]],
        });
      } else if (e.tag === 'file') {
        mark(e.path, false);
        const p = owner(e.path)!;
        const imported = await activity.take('file', e.path),
          localSnapshot =
            p[3] === 'single-writer' && (p[4] === null || p[4] === codec.options.context[4]);
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
          act === 'none' &&
          gcCutoff !== null &&
          BigInt(e.identity[8]) < gcCutoff
            ? 'delete'
            : 'retain';
        const previous = await bases.take(e.path);
        attach(
          await tree.append([
            'file',
            e.path,
            e.identity,
            p[0],
            previous,
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
        );
      } else {
        const frame = frames.pop()!;
        try {
          let act = frame.unitActivity,
            direct = frame.unitActivity,
            allDelete = true,
            directDelete = true,
            files = 0,
            directFiles = 0,
            mask = 0n,
            single = false;
          if (BigInt(frame.activityTimes[0]) >= cutoff || BigInt(frame.activityTimes[1]) >= cutoff)
            act = 'upsert';
          for (const entry of frame.entries)
            if (entry.offset !== null) {
              const lease = await tree.record(entry.offset);
              try {
                const n = lease.value as Node;
                act = maxActivity(act, n[5]);
                files += n[10];
                allDelete &&= n[6] === 'delete';
                if (n[0] === 'file') {
                  direct = maxActivity(direct, n[5]);
                  directFiles++;
                  directDelete &&= n[6] === 'delete';
                  const pi = model.partitions.findIndex((p) => p[0] === n[3]);
                  mask |= 1n << BigInt(pi);
                  single ||= model.partitions[pi][3] === 'single-writer';
                }
              } finally {
                lease.release();
              }
            }
          if (
            single &&
            (mask & (mask - 1n)) !== 0n &&
            model.tuple[2] === 'maven' &&
            e.path.startsWith('repository/')
          )
            throw new Error('Maven direct unit splits a snapshot owner.');
          let kind: string | null = null,
            complete = 1;
          if (workspace?.root === e.path) {
            kind = workspaceKind(
              e.path,
              workspace.markers.filter(([dir]) => !dir).map(([, p]) => p),
            );
            const markers = new UnitMarkers([kind, e.path, 'subtree'] as Unit);
            for (const [dir, p] of workspace.markers)
              if (dir) markers.directory(p);
              else markers.file(p);
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
          )
            kind = 'maven-directory';
          if (
            kind === 'maven-directory' &&
            frame.entries.some(
              (x) =>
                x.offset === null &&
                x.type !== 'directory' &&
                !isCacheMetadataPath(e.path + '/' + x.name) &&
                !isMavenTransientFile(x.name),
            )
          )
            directDelete = false;
          const start = tree.position;
          for (const entry of frame.entries)
            await tree.append([
              'edge',
              entry.name,
              entry.type,
              entry.device,
              entry.id,
              entry.offset,
            ]);
          // Preserve walked scaffolding too: worker replay must co-read the same tree
          // and detect late children there, without treating an unowned directory as payload.
          const end = tree.position;
          const offset = await tree.append([
            'directory',
            e.path,
            e.identity,
            null,
            null,
            act,
            files > 0 && allDelete ? 'delete' : 'retain',
            start,
            end,
            kind,
            files,
            complete,
            direct,
            directFiles > 0 && directDelete ? 'delete' : 'retain',
            directFiles,
          ]);
          attach(offset);
        } finally {
          options.budget.release(frame.charge);
        }
      }
    }
    await activity.finish();
    await bases.finish();
    if (root === undefined) throw new Error('Missing observation root.');
    const rendered = renderObservations(tree, root, signal);
    if (options.retainIndex) capturedIndex = await ObservationIndex.write(store, rendered, options);
    const reference =
      capturedIndex?.reference ??
      (await store.writeStream('observations', { ...options, partition: null }, rendered, signal));
    await store.fail('observations-candidate');
    const progress = await store.writeDocument([
      'gc-progress',
      1,
      codec.options.invocation,
      reference,
      ['cursor', reference[4], 0, 0, 0, null],
      null,
    ]);
    await store.fail('observations-progress-candidate');
    await assertCaptureStable(store, tree, root, signal);
    const state = codec.schemas.documents['local-state'].parse(await store.state());
    equal(state, initial, 'observation capture state');
    await store.assertNoIntents();
    signal.throwIfAborted();
    if (configured && options.purgeWindow) assertWindow();
    state[3]++;
    state[4] = 'observations-frozen';
    state[6] = codec.schemas.ref('observations').parse(reference);
    state[10] = codec.schemas.ref('gc-progress').parse(progress);
    await store.updateState(state);
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
    await pending?.catch(() => {});
    for (const frame of frames) options.budget.release(frame.charge);
    await settleBaseCleanup(
      [
        () => walk.return(undefined),
        () => activity.close(),
        () => bases.close(),
        () => tree.close(),
        () => (failure === undefined ? undefined : capturedIndex?.dispose()),
      ],
      failure,
    ).catch(async (error) => {
      await settleBaseCleanup([() => capturedIndex?.dispose()], error);
      throw error;
    });
  }
  try {
    signal.throwIfAborted();
    if (configured && options.purgeWindow) assertWindow();
    return completed!;
  } catch (error) {
    await settleBaseCleanup([() => capturedIndex?.dispose()], error);
    throw error;
  }
}

async function* renderObservations(
  tree: InstallScratch,
  root: number,
  signal: AbortSignal,
): AsyncGenerator<Value> {
  async function* edges(n: Node): AsyncGenerator<Edge> {
    for await (const r of tree.rows(n[7], n[8])) {
      signal.throwIfAborted();
      yield r as Edge;
    }
  }
  async function* facts(offset: number, direct: boolean): AsyncGenerator<Value> {
    const lease = await tree.record(offset),
      n = lease.value as Node;
    try {
      if (n[0] === 'file') {
        yield ['file', n[1], n[3], n[2], n[4]];
        return;
      }
      yield ['directory', n[1], n[2]];
      for await (const e of edges(n)) yield ['child', n[1], e[1], e[2], e[3], e[4]];
      for await (const e of edges(n))
        if (e[5] !== null && (e[2] === 'file' || !direct)) yield* facts(e[5], false);
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
        yield [
          'file',
          baseName(n[1]),
          n[3],
          n[2],
          n[4],
          override?.[0] ?? n[5],
          override?.[1] ?? n[6],
        ];
        return;
      }
      yield ['dir-open', n[1], n[2]];
      for await (const e of edges(n)) yield ['child', e[1], e[2], e[3], e[4]];
      const unit = n[9] !== null && !override,
        direct = n[9] === 'maven-directory';
      let selected = override,
        sha: string | undefined;
      if (unit) {
        const digest = new Digest('observation-unit');
        for await (const f of facts(offset, direct)) digest.update(f);
        sha = digest.digest();
        const act = direct ? n[12] : n[5],
          deletion =
            (direct ? n[13] : n[6]) === 'delete' && act === 'none' && n[11] === 1
              ? 'delete'
              : 'retain';
        selected = [act, deletion];
        yield ['unit-open', n[9], n[1], direct ? 'direct' : 'subtree', act, deletion, sha];
      }
      for await (const e of edges(n))
        if (e[5] !== null && (e[2] === 'file' || !direct)) yield* visit(e[5], selected);
      if (unit) yield ['unit-close', n[9], n[1], sha!];
      if (direct)
        for await (const e of edges(n))
          if (e[5] !== null && e[2] === 'directory') yield* visit(e[5], override);
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
  options: BaseObjectOptions,
): AsyncGenerator<readonly [string, 'file' | 'unit', Activity]> {
  let path = '';
  for await (const record of decodeRecords(store.read(ref, 'activity'))) {
    options.signal?.throwIfAborted();
    const release = options.budget.holdRecord(record.raw.length);
    try {
      const r = tuple(record.value);
      if (r[0] === 'dir-open') path = String(r[1]);
      else if (r[0] === 'dir-close') path = parentPath(path);
      else if (r[0] === 'unit-open') yield [String(r[2]), 'unit', r[4] as Activity];
      else if (r[0] === 'upsert' || r[0] === 'used')
        yield [path ? path + '/' + r[1] : String(r[1]), 'file', r[0]];
    } finally {
      release();
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
      if (c > 0) return 'none';
      this.head = await this.iterator.next();
      if (c === 0) return h[2];
    }
    return 'none';
  }
  async finish() {
    while (this.head && !this.head.done) this.head = await this.iterator.next();
  }
  async close() {
    await this.iterator.return?.();
  }
}
class BaselineCursor {
  private constructor(
    private readonly cursors: {
      iterator: AsyncIterator<readonly [string, Value]>;
      head: IteratorResult<readonly [string, Value]>;
    }[],
  ) {}
  static async open(
    store: OwnedStore,
    objects: readonly BaseMetadata[],
    options: BaseObjectOptions,
  ): Promise<BaselineCursor> {
    const cursors: BaselineCursor['cursors'] = [];
    async function* files(object: BaseMetadata): AsyncGenerator<readonly [string, Value]> {
      let path = '';
      for await (const row of decodeRecords(store.read(object.tree, 'native-tree'))) {
        options.signal?.throwIfAborted();
        const release = options.budget.holdRecord(row.raw.length);
        try {
          const r = tuple(row.value);
          if (r[0] === 'dir-open') path = String(r[1]);
          else if (r[0] === 'dir-close') path = parentPath(path);
          else if (r[0] === 'file')
            yield [path ? path + '/' + r[1] : String(r[1]), ['portable', ...r.slice(2, 6)]];
        } finally {
          release();
        }
      }
    }
    try {
      for (const object of objects) {
        const iterator = files(object)[Symbol.asyncIterator]();
        cursors.push({ iterator, head: await iterator.next() });
      }
      return new BaselineCursor(cursors);
    } catch (e) {
      await settleBaseCleanup(
        cursors.map((c) => () => c.iterator.return?.()),
        e,
      );
      throw e;
    }
  }
  async take(path: string): Promise<Value> {
    let found: Value = null;
    for (const c of this.cursors) {
      while (!c.head.done && compare(c.head.value[0], path) < 0) c.head = await c.iterator.next();
      if (!c.head.done && c.head.value[0] === path) {
        if (found !== null) throw new Error('Overlapping baseline projections.');
        found = c.head.value[1];
        c.head = await c.iterator.next();
      }
    }
    return found;
  }
  async finish() {
    for (const c of this.cursors) while (!c.head.done) c.head = await c.iterator.next();
  }
  async close() {
    await settleBaseCleanup(this.cursors.map((c) => () => c.iterator.return?.()));
  }
}

async function assertCaptureStable(
  store: OwnedStore,
  tree: InstallScratch,
  root: number,
  signal: AbortSignal,
): Promise<void> {
  const visit = async (offset: number): Promise<void> => {
    signal.throwIfAborted();
    const r = await tree.record(offset),
      n = r.value as Node;
    try {
      if (n[0] === 'file') return;
      store.root.work.stats++;
      const before = nativeIdentity(await lstat(store.root.resolve(n[1]), { bigint: true }));
      if (!before || !sameNative(n[2], before, true))
        throw new Error('Observation source changed before pointer commit.');
      if (n[0] === 'directory') {
        for await (const value of tree.rows(n[7], n[8])) {
          signal.throwIfAborted();
          const edge = value as Edge;
          if (edge[5] !== null && edge[2] === 'directory') await visit(edge[5]);
        }
        store.root.work.stats++;
        const after = nativeIdentity(await lstat(store.root.resolve(n[1]), { bigint: true }));
        if (!after || !sameNative(n[2], after, true))
          throw new Error('Observation directory changed before pointer commit.');
      }
    } finally {
      r.release();
    }
  };
  await visit(root);
  signal.throwIfAborted();
}
