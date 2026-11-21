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

import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { tuple, equal, add, type Value } from './encoding';
import { requirePostBindings } from './post-admission';
import { ObservationIndex } from './observation-index';
import { GcProgram } from './gc-program';
import { checkGcProjection } from './gc-projection';
import { WorkerSpool } from './worker-spool';
import { WorkerStage } from './worker-stage';
import { writeWorkerNativeEvidence } from './worker-native';
import { NativeReadPhase } from './native-read-phase';
import { nativeIdentity, nativeIds, sameNative, type NativeIdentity } from './native';
import { isCacheMetadataPath } from '../metadata-paths';
import { isMavenTransientFile } from '../maven-repository';
import { normalizeMode } from './tree-state';
import { verifyNativeEvidence } from './install-evidence';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';
import type { OwnedStore, Reference } from './owned-store';

const genuine = new WeakSet<object>(),
  copies = new WeakSet<object>();
type Source = ReturnType<OwnedStore['codec']['schemas']['source']['parse']>;
const values = (rows: readonly Value[]) =>
  (async function* () {
    yield* rows;
  })();

function immutable<T extends Value>(v: T): T {
  if (Array.isArray(v)) {
    for (const item of v) immutable(item);
    Object.freeze(v);
  }
  return v;
}

interface SourceScope {
  hidden: boolean;
  hiddenChild: boolean;
  visible: boolean;
}
function sourceScope(parent: SourceScope | undefined, unit: Value | undefined): SourceScope {
  const u = Array.isArray(unit) ? unit : [];
  return {
    hidden: !!parent?.hidden || (u[1] === 'subtree' && u[2] === 'delete'),
    hiddenChild: false,
    visible: false,
  };
}
function contributesEmpty(scope: SourceScope): boolean {
  return !scope.hidden && (!scope.hiddenChild || scope.visible);
}
function closeScope(parent: SourceScope | undefined, child: SourceScope) {
  if (!parent) return;
  if (!contributesEmpty(child)) parent.hiddenChild = true;
  else parent.visible = true;
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas
// and #moving-source-publication-handoff. A complete original/native co-read,
// before hashes, keys or live renames. No serialized row can mint this capability.
export class LiveNativeView {
  private readonly life = { disposed: false, busy: false, retiring: false };
  private constructor(
    readonly store: OwnedStore,
    readonly observations: Reference,
    readonly progress: Reference,
    private readonly facts: WorkerSpool,
    readonly options: BaseObjectOptions,
  ) {
    immutable(observations);
    immutable(progress);
    genuine.add(this);
    Object.freeze(this);
  }
  static assert(view: LiveNativeView, store = view.store) {
    if (!genuine.has(view) || view.store !== store || view.life.disposed || view.life.retiring)
      throw new Error('Unavailable live source view.');
    view.options.signal?.throwIfAborted();
  }
  static async capture(store: OwnedStore, input: BaseObjectOptions): Promise<LiveNativeView> {
    const options = Object.freeze({
      ...input,
      signal: input.signal ?? new AbortController().signal,
    });
    options.signal.throwIfAborted();
    await store.assertNoIntents();
    const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
      bindings = store.codec.schemas.documents.bindings.parse(
        await store.readDocument(state[5], 'bindings'),
      );
    await requirePostBindings(store, state, bindings, options);
    if (
      state[4] !== 'gc-complete' ||
      !state[6] ||
      !state[10] ||
      (state[7] !== null && state[7][1] !== 'post-sources') ||
      state[8] ||
      state[9] ||
      store.codec.options.access !== 'writable' ||
      store.codec.options.role === 'distributed-worker'
    )
      throw new Error('Live source capture requires uncommitted writable GC completion.');
    // Cold recapture cannot adopt fixed-path orphan keyed metadata from a prior
    // uncommitted freeze. Only the original process-local source may reconcile it.
    for (const p of store.codec.options.model.partitions)
      for (const name of ['tree.ndjson', 'envelope.json'])
        if (await store.root.stat(store.prefix + 'objects/' + p[0] + '/' + name))
          throw new Error('Uncommitted keyed source metadata requires abandonment.');
    const progress = store.codec.schemas.documents['gc-progress'].parse(
      await store.readDocument(state[10], 'gc-progress'),
    );
    equal(progress[3], state[6], 'live source GC observations');
    if (progress[5] !== null) throw new Error('Active GC source owner.');
    const index = await ObservationIndex.open(store, state[6], options);
    let program: GcProgram | undefined, facts: WorkerSpool | undefined, failure: unknown;
    try {
      program = await GcProgram.create(index, {}, [progress[4]]);
      equal(progress[4], program.final, 'complete original GC source cursor');
      facts = await WorkerSpool.create(store, options.budget);
      const append = (r: Value) => facts!.append(r, options.signal);
      const coordinates: { maven: boolean; protectedArtifact: boolean; contributes: boolean }[] =
        [];
      await checkGcProjection(index, progress[4][2], progress[4][2], undefined, undefined, {
        open: async (d, n) => {
          coordinates.push({
            maven: d[9]?.[1] === 'maven-directory',
            protectedArtifact: false,
            contributes: false,
          });
          await append(['dir-open', d[1], n, d[9] ? [d[9][1], d[9][3], d[9][5]] : null]);
        },
        file: async (f, n) => {
          const frame = coordinates[coordinates.length - 1],
            p = store.codec.options.model.partitions.find((p) => p[0] === f[3])!;
          frame.contributes ||=
            p[3] === 'aggregate' || p[4] === null || p[4] === store.codec.options.context[4];
          if (frame.maven && frame.contributes && frame.protectedArtifact)
            throw new Error('Incomplete Maven retained source coordinate.');
          await append(['file', f[1], n, f[3]]);
        },
        protected: async (p, e) => {
          const frame = coordinates[coordinates.length - 1];
          if (
            frame.maven &&
            e[2] !== 'directory' &&
            !isCacheMetadataPath((p ? p + '/' : '') + e[1]) &&
            !isMavenTransientFile(e[1])
          ) {
            frame.protectedArtifact = true;
            if (frame.contributes) throw new Error('Incomplete Maven retained source coordinate.');
          }
          await append(['parent-child', p, ...e.slice(1, 5)]);
        },
        close: async (d, n) => {
          coordinates.pop();
          await append(['dir-close', d[1], n]);
        },
      });
      facts.seal(options.signal);
      equal(await store.state(), state, 'live source capture state');
    } catch (e) {
      failure = e;
    }
    try {
      await settleBaseCleanup([() => program?.close(), () => index.dispose()], failure);
    } catch (e) {
      failure = e;
    }
    if (failure !== undefined) {
      await settleBaseCleanup([() => facts?.dispose()], failure);
      throw failure;
    }
    const result = new LiveNativeView(store, state[6], state[10], facts!, options);
    try {
      await result.assertStable();
      options.signal.throwIfAborted();
      return result;
    } catch (e) {
      await settleBaseCleanup([() => result.dispose()], e);
      throw e;
    }
  }
  async *rows(signal = this.options.signal ?? new AbortController().signal) {
    LiveNativeView.assert(this);
    yield* this.facts.rows(signal);
  }
  async assertStable() {
    LiveNativeView.assert(this);
    for await (const v of this.rows()) {
      const r = tuple(v);
      const path = r[0] === 'parent-child' ? (r[1] ? r[1] + '/' : '') + r[2] : String(r[1]);
      this.store.root.work.stats++;
      const raw = await lstat(this.store.root.resolve(String(path)), { bigint: true });
      if (r[0] === 'parent-child') {
        const kind = raw.isFile()
          ? 'file'
          : raw.isDirectory()
            ? 'directory'
            : raw.isSymbolicLink()
              ? 'symlink'
              : 'other';
        equal([kind, ...nativeIds(raw)], r.slice(3), 'protected live source child');
      } else if (
        (raw.isFile() && raw.nlink !== 1n) ||
        !sameNative(r[2] as NativeIdentity, nativeIdentity(raw), true)
      )
        throw new Error('Original retained live source changed.');
    }
    this.options.signal?.throwIfAborted();
  }
  async dispose() {
    if (this.life.disposed) return;
    if (this.life.busy) throw new Error('Live source retirement active.');
    this.life.busy = true;
    this.life.retiring = true;
    try {
      await this.facts.dispose();
      this.life.disposed = true;
    } finally {
      this.life.busy = false;
    }
  }
}

/** Genuine local copy/hash provenance, distinct from a prepared worker snapshot. */
export class LocalBaseSnapshot {
  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly nativeRoot: string,
    readonly evidence: Reference,
    readonly observations: Reference,
  ) {
    immutable(evidence);
    immutable(observations);
    copies.add(this);
    Object.freeze(this);
  }
  static assert(snapshot: LocalBaseSnapshot, store = snapshot.store) {
    if (!copies.has(snapshot) || snapshot.store !== store)
      throw new Error('Unbound local copy proof.');
  }
  source(): Source {
    LocalBaseSnapshot.assert(this);
    return this.store.codec.schemas.source.parse([
      this.partition,
      'local-writer',
      ['local-writer', this.store.codec.options.invocation],
      this.evidence,
      this.nativeRoot,
    ]);
  }
  static async captureAll(
    view: LiveNativeView,
  ): Promise<{ snapshots: readonly LocalBaseSnapshot[]; copyBytes: number }> {
    LiveNativeView.assert(view);
    const { store, options } = view,
      signal = options.signal ?? new AbortController().signal,
      selected = store.codec.options.model.partitions.filter(
        (p) =>
          p[3] === 'single-writer' && (p[4] === null || p[4] === store.codec.options.context[4]),
      );
    if (!selected.length) return { snapshots: [], copyBytes: 0 };
    const stage = await WorkerStage.create(store, options.budget),
      phase = new NativeReadPhase(store.root),
      scopes: SourceScope[] = [];
    let copyBytes = 0,
      failure: unknown,
      completed: { snapshots: readonly LocalBaseSnapshot[]; copyBytes: number } | undefined;
    try {
      for await (const v of view.rows()) {
        signal.throwIfAborted();
        const r = tuple(v),
          path = String(r[1]);
        if (r[0] === 'dir-open') {
          await phase.enter(path, r[2] as NativeIdentity);
          stage.enter(path);
          scopes.push(sourceScope(scopes[scopes.length - 1], r[3]));
        } else if (r[0] === 'dir-close') {
          const scope = scopes[scopes.length - 1];
          if (path && contributesEmpty(scope)) {
            let owner: string | undefined;
            try {
              owner = store.codec.options.model.owner(path + '/.workspace-directory-probe')[0];
            } catch {
              /* unowned scaffolding */
            }
            if (selected.some((p) => p[0] === owner)) await stage.ensure(owner!, signal);
          }
          if (!path) for (const p of selected) await stage.ensure(p[0], signal);
          await phase.leave(path, r[2] as NativeIdentity);
          await stage.leave(path, signal);
          scopes.pop();
          closeScope(scopes[scopes.length - 1], scope);
        } else if (
          r[0] === 'file' &&
          !scopes[scopes.length - 1].hidden &&
          selected.some((p) => p[0] === r[3])
        ) {
          scopes[scopes.length - 1].visible = true;
          const n = r[2] as NativeIdentity,
            hash = createHash('sha256'),
            size = Number(n[5]),
            mode = normalizeMode(store.codec.options.model.tuple[2], path, n[6]),
            mtimeMs = Number(BigInt(n[8]) / 1000000n);
          const pending = await stage.write(
            {
              path,
              partition: String(r[3]),
              ordinal: 0,
              header: { name: path, type: 'file', size, mode, mtimeMs },
              body: (async function* () {
                for await (const chunk of phase.read(path, n, signal)) {
                  hash.update(chunk);
                  copyBytes = add(copyBytes, chunk.length);
                  yield chunk;
                }
              })(),
            },
            signal,
          );
          try {
            await pending.finish(hash.digest('hex'), size, mode, mtimeMs);
          } finally {
            await pending.close();
          }
        } else if (r[0] === 'file' || r[0] === 'parent-child') {
          const scope = scopes[scopes.length - 1];
          if (!scope.hidden) scope.visible = true;
        }
      }
      await stage.seal(signal);
      const parts = await stage.publish('snapshot', signal),
        result: LocalBaseSnapshot[] = [];
      for (const part of parts) {
        const evidence = await writeWorkerNativeEvidence(
          store,
          part,
          options.budget,
          signal,
          options.maxDirectoryEntries,
          true,
        );
        result.push(
          new LocalBaseSnapshot(
            store,
            part.partition,
            part.nativeRoot,
            evidence,
            view.observations,
          ),
        );
      }
      await view.assertStable();
      stage.adopt(); // Retained invocation ownership; postSources commit happens below.
      completed = { snapshots: Object.freeze(result), copyBytes };
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      await settleBaseCleanup([() => stage.dispose()], failure);
    }
    signal.throwIfAborted();
    return completed!;
  }
}

export interface LivePartitionSource {
  readonly partition: string;
  /** Empty string denotes an aggregate projection of the frozen live tree. */
  readonly nativeRoot: string;
  readonly evidence: Reference;
  readonly snapshot: Source | null;
}
const inputs = new WeakSet<object>();
/** Hash each new aggregate once; copy/hash each selected local snapshot once. */
export class LiveBaseInputs {
  private constructor(
    readonly view: LiveNativeView,
    readonly postSources: Reference,
    readonly partitions: readonly LivePartitionSource[],
    readonly work: Readonly<{ hashBytes: number; copyBytes: number }>,
  ) {
    immutable(postSources);
    for (const p of partitions) {
      immutable(p.evidence);
      if (p.snapshot) immutable(p.snapshot);
    }
    inputs.add(this);
    Object.freeze(this);
  }
  static assert(input: LiveBaseInputs, store = input.view.store) {
    if (!inputs.has(input) || input.view.store !== store)
      throw new Error('Unbound live base inputs.');
    LiveNativeView.assert(input.view, store);
  }
  static async capture(store: OwnedStore, options: BaseObjectOptions): Promise<LiveBaseInputs> {
    options = Object.freeze({ ...options });
    const view = await LiveNativeView.capture(store, options),
      signal = view.options.signal ?? new AbortController().signal,
      spools: WorkerSpool[] = [],
      partitions: LivePartitionSource[] = [],
      frames: (SourceScope & {
        path: string;
        native: NativeIdentity;
        open: Set<number>;
        release: () => void;
      })[] = [];
    let hashBytes = 0,
      result: LiveBaseInputs | undefined,
      failure: unknown;
    try {
      const initial = store.codec.schemas.documents['local-state'].parse(await store.state()),
        bindings = store.codec.schemas.documents.bindings.parse(
          await store.readDocument(initial[5], 'bindings'),
        ),
        committed = initial[7] ? store.codec.schemas.ref('post-sources').parse(initial[7]) : null,
        local = committed
          ? { snapshots: [] as readonly LocalBaseSnapshot[], copyBytes: 0 }
          : await LocalBaseSnapshot.captureAll(view),
        inherited: Source[] = [];
      await store.readStream(
        committed ?? bindings[11],
        committed ? 'post-sources' : 'prepare-sources',
        { ...view.options, partition: null },
        async (v) => {
          const r = tuple(v);
          if (r[0] === 'snapshot-source') inherited.push(store.codec.schemas.source.parse(r[1]));
        },
        signal,
      );
      const aggregate = store.codec.options.model.partitions.filter((p) => p[3] === 'aggregate');
      for (let i = 0; i < aggregate.length; i++)
        spools.push(await WorkerSpool.create(store, options.budget));
      const phase = new NativeReadPhase(store.root),
        ensure = async (i: number) => {
          for (const f of frames)
            if (!f.open.has(i)) {
              await spools[i].append(['directory', f.path, f.native], signal);
              f.open.add(i);
            }
        };
      for await (const v of view.rows()) {
        const r = tuple(v),
          path = String(r[1]);
        if (r[0] === 'dir-open') {
          await phase.enter(path, r[2] as NativeIdentity);
          const scope = sourceScope(frames[frames.length - 1], r[3]);
          frames.push({
            ...scope,
            path,
            native: r[2] as NativeIdentity,
            open: new Set(),
            release: options.budget.holdRecord(512 + Buffer.byteLength(path)),
          });
        } else if (r[0] === 'file') {
          const scope = frames[frames.length - 1];
          if (scope.hidden) continue;
          scope.visible = true;
          const i = aggregate.findIndex((p) => p[0] === r[3]);
          if (i >= 0) {
            const n = r[2] as NativeIdentity;
            await ensure(i);
            const sha = await phase.hash(path, n, null, signal);
            hashBytes = add(hashBytes, Number(n[5]));
            await spools[i].append(['file', path, n, sha], signal);
          }
        } else if (r[0] === 'dir-close') {
          const scope = frames[frames.length - 1];
          if (path && contributesEmpty(scope)) {
            let owner: string | undefined;
            try {
              owner = store.codec.options.model.owner(path + '/.workspace-directory-probe')[0];
            } catch {
              /* unowned scaffolding */
            }
            const i = aggregate.findIndex((p) => p[0] === owner);
            if (i >= 0) await ensure(i);
          }
          if (!path) for (let i = 0; i < spools.length; i++) await ensure(i);
          await phase.leave(path, r[2] as NativeIdentity);
          frames.pop()!.release();
          closeScope(frames[frames.length - 1], scope);
        } else if (r[0] === 'parent-child') {
          const scope = frames[frames.length - 1];
          if (!scope.hidden) scope.visible = true;
        }
      }
      for (let i = 0; i < aggregate.length; i++) {
        spools[i].seal(signal);
        const evidence = await store.writeStream(
          'native-evidence',
          { ...view.options, partition: aggregate[i][0] },
          spools[i].rows(signal),
          signal,
        );
        partitions.push(
          Object.freeze({ partition: aggregate[i][0], nativeRoot: '', evidence, snapshot: null }),
        );
      }
      const sources: Source[] = [];
      for (const p of store.codec.options.model.partitions) {
        if (p[3] !== 'single-writer') continue;
        const source =
          local.snapshots.find((s) => s.partition === p[0])?.source() ??
          inherited.find((s) => s[0] === p[0]);
        if (!source) throw new Error('Missing authoritative post source for ' + p[0]);
        await verifyNativeEvidence(store, source[3], source[4], source[0], view.options);
        sources.push(source);
        partitions.push(
          Object.freeze({
            partition: p[0],
            nativeRoot: source[4],
            evidence: source[3],
            snapshot: source,
          }),
        );
      }
      const postSources =
        committed ??
        (await store.writeStream(
          'post-sources',
          { ...view.options, partition: null },
          values(sources.map((s) => ['snapshot-source', s])),
          signal,
        ));
      await view.assertStable();
      const state = store.codec.schemas.documents['local-state'].parse(await store.state());
      equal(state, initial, 'post source capture state');
      if (!committed) {
        state[3]++;
        state[7] = store.codec.schemas.ref('post-sources').parse(postSources);
        await store.updateState(state);
        await store.fail('post-sources-pointer');
      }
      await view.assertStable();
      for (const source of sources)
        await verifyNativeEvidence(store, source[3], source[4], source[0], view.options);
      result = new LiveBaseInputs(
        view,
        postSources,
        Object.freeze(
          store.codec.options.model.partitions.map((p) =>
            partitions.find((s) => s.partition === p[0])!,
          ),
        ),
        Object.freeze({ hashBytes, copyBytes: local.copyBytes }),
      );
    } catch (e) {
      failure = e;
    } finally {
      for (const f of frames) f.release();
    }
    try {
      await settleBaseCleanup(
        spools.map((s) => () => s.dispose()),
        failure,
      );
    } catch (e) {
      failure = e;
    }
    if (failure !== undefined) {
      await settleBaseCleanup([() => view.dispose()], failure);
      throw failure;
    }
    try {
      signal.throwIfAborted();
      return result!;
    } catch (e) {
      await settleBaseCleanup([() => view.dispose()], e);
      throw e;
    }
  }
  async dispose() {
    await this.view.dispose();
  }
}
