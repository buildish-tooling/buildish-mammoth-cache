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

import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { decodeRecords, equal, tuple, type Value } from './encoding';
import type { OwnedStore, Reference } from './owned-store';
import { missing, nativeIdentity, sameNative, sameObject, type NativeIdentity } from './native';
import { NativeReadPhase } from './native-read-phase';
import { walkNative, walkWork, type WalkEvent } from './native-walk';
import { compareName, joinPath, normalizeMode, type WorkingBudget } from './tree-state';
import { unitSchema, type Unit } from './schema';
import { InstallScratch } from './install-scratch';
import { isCacheMetadataPath } from '../metadata-paths';
import { isMavenTransientFile } from '../maven-repository';
import { WorkerSpool } from './worker-spool';
import type { WorkerEvent } from './worker-codec';

export interface WorkerSourceView {
  readonly observations: Reference;
  /** Required when the frozen decisions remove anything; must reach the final root boundary. */
  readonly gcProgress: Reference | null;
  readonly workerSources: Reference;
  /** Same projection used to capture observations, never a fresh selection/GC policy. */
  readonly prune?: (path: string) => boolean;
}
interface Frame {
  path: string;
  before: NativeIdentity;
  actual: NativeIdentity | null;
  affected: boolean;
  hasMembers: boolean;
  open: Set<number>;
  release: () => void;
  maven: { payload: boolean; protectedArtifact: boolean } | null;
  projection: number;
  end: number;
  omitted: number;
  planned: number;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas.
// One co-read/listing phase, then metadata-only guards and direct live-body reads.
export class WorkerSources {
  readonly work = walkWork();
  private snapshotIds: readonly string[] = [];
  get snapshots(): readonly string[] {
    return this.snapshotIds;
  }
  private constructor(
    private readonly store: OwnedStore,
    private readonly budget: WorkingBudget,
    private readonly channels: WorkerSpool[],
    private readonly guards: WorkerSpool,
  ) {}
  static async create(
    store: OwnedStore,
    view: WorkerSourceView,
    budget: WorkingBudget,
    signal = new AbortController().signal,
    maxDirectoryEntries = 100000,
  ): Promise<WorkerSources> {
    // Pin caller-owned tuples before the first await; every subsequent phase uses
    // exactly the Q that passed the complete metadata validation gate.
    view = Object.freeze({
      ...view,
      observations: Object.freeze(
        store.codec.schemas.ref('observations').parse(view.observations),
      ) as Reference,
      workerSources: Object.freeze(
        store.codec.schemas.ref('worker-sources').parse(view.workerSources),
      ) as Reference,
      gcProgress:
        view.gcProgress === null
          ? null
          : (Object.freeze(
              store.codec.schemas.ref('gc-progress').parse(view.gcProgress),
            ) as Reference),
    });
    const snapshotIds: string[] = [];
    const guards = await WorkerSpool.create(store, budget),
      channels: WorkerSpool[] = [];
    const result = new WorkerSources(store, budget, channels, guards);
    try {
      await store.readStream(
        view.workerSources,
        'worker-sources',
        { budget, partition: null },
        async (value) => {
          const r = tuple(value);
          if (r[0] === 'worker-snapshot') {
            equal(r[2], view.observations, 'worker snapshot observations');
            snapshotIds.push(String(r[1]));
          }
        },
        signal,
      );
      result.snapshotIds = Object.freeze(snapshotIds);
      for (let i = 0; i < 2 + result.snapshots.length; i++)
        channels.push(await WorkerSpool.create(store, budget));
      await result.capture(view, signal, maxDirectoryEntries);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      await result.dispose();
      throw error;
    }
  }
  private async capture(
    view: WorkerSourceView,
    signal: AbortSignal,
    maxDirectoryEntries: number,
  ): Promise<void> {
    // Validate once without a second live name table, then co-read immutable canonical
    // bytes. The extra sequential metadata read is counted; no extra tree listing.
    await this.store.readStream(
      view.observations,
      'observations',
      { budget: this.budget, partition: null, maxDirectoryEntries },
      undefined,
      signal,
    );
    const projections = await InstallScratch.create(this.store, this.budget);
    const frames: Frame[] = [],
      model = this.store.codec.options.model;
    let unit: {
      descriptor: Unit;
      activity: string;
      decision: string;
      channels: Set<number>;
    } | null = null;
    let removed = false,
      finalEnd = 0,
      finalRecord = 0;
    const absent = async (path: string) => {
      this.store.root.work.stats++;
      try {
        await lstat(this.store.root.resolve(path));
        return false;
      } catch (error) {
        if (missing(error)) return true;
        throw error;
      }
    };
    const projectionNext = async (f: Frame) => {
      if (f.projection === f.end) return null;
      const row = await projections.record(f.projection);
      try {
        f.projection += row.bytes;
        return tuple(row.value);
      } finally {
        row.release();
      }
    };
    const inspect: NonNullable<Parameters<typeof walkNative>[2]['inspectChild']> = async (
      child,
    ) => {
      const f = frames[frames.length - 1];
      if (!f || child.parent !== f.path) throw new Error('Missing frozen physical projection.');
      while (true) {
        const expected = await projectionNext(f);
        if (!expected) throw new Error('Unexpected physical source child.');
        const cmp =
          Number(expected[2] === 'directory') - Number(child.type === 'directory') ||
          compareName(String(expected[1]), child.name);
        if (cmp < 0) {
          f.omitted++;
          continue;
        }
        if (cmp > 0) throw new Error('Unexpected physical source child.');
        equal(
          expected.slice(1),
          [child.name, child.type, child.device, child.fileId],
          'frozen physical child',
        );
        if (
          child.pruned &&
          child.type !== 'directory' &&
          model.tuple[2] === 'maven' &&
          f.maven !== null &&
          !isCacheMetadataPath(child.path) &&
          !isMavenTransientFile(child.name)
        ) {
          f.maven!.protectedArtifact = true;
          if (f.maven!.payload) throw new Error('Incomplete Maven direct-file contribution.');
        }
        return;
      }
    };
    const live = walkNative(
      this.store.root,
      '',
      {
        budget: this.budget,
        signal,
        maxDirectoryEntries,
        metadata: 'exclude',
        prune: view.prune,
        inspectChild: inspect,
      },
      this.work,
    )[Symbol.asyncIterator]();
    let head: IteratorResult<WalkEvent> | undefined;
    const peek = async () => {
      while (true) {
        head ??= await live.next();
        if (head.done || head.value.tag !== 'protected-child') return head;
        head = undefined;
      }
    };
    const next = async (tag: WalkEvent['tag'], path: string) => {
      const n = await peek();
      if (n.done || n.value.tag !== tag || n.value.path !== path)
        throw new Error('Frozen source projection changed.');
      head = undefined;
      return n.value;
    };
    const append = (c: number, r: Value) => this.channels[c].append(r, signal);
    const ensure = async (c: number) => {
      for (const f of frames)
        if (!f.open.has(c)) {
          if (!f.actual) throw new Error('Cannot emit missing directory.');
          await append(c, ['dir-open', f.path, f.actual]);
          f.open.add(c);
        }
    };
    const routes = (partition: string, activity: string) => {
      const p = model.partitions.find((p) => p[0] === partition)!,
        output: number[] = [];
      if (p[3] === 'aggregate' && activity !== 'none') output.push(activity === 'upsert' ? 0 : 1);
      const snapshot = this.snapshots.indexOf(partition);
      if (snapshot >= 0) output.push(snapshot + 2);
      return output;
    };
    try {
      for await (const raw of decodeRecords(this.store.read(view.observations, 'observations'))) {
        signal.throwIfAborted();
        const release = this.budget.holdRecord(raw.raw.length);
        try {
          const r = tuple(raw.value),
            tag = r[0];
          if (tag === 'local-stream' || tag === 'local-end') continue;
          if (tag === 'child') {
            await projections.append(raw.value);
            frames[frames.length - 1].end = projections.position;
            continue;
          }
          if (tag === 'dir-open') {
            const path = String(r[1]),
              before = r[2] as NativeIdentity,
              parent = frames[frames.length - 1];
            let actual: NativeIdentity | null = null;
            if (!parent || parent.actual) {
              const upcoming = await peek();
              if (
                !upcoming.done &&
                upcoming.value.tag === 'directory-open' &&
                upcoming.value.path === path
              ) {
                const e = await next('directory-open', path);
                if (e.tag !== 'directory-open') throw new Error('Expected directory.');
                actual = e.identity;
                if (!sameObject(before, actual) || before[6] !== actual[6])
                  throw new Error('Frozen directory replaced.');
                if (parent) parent.hasMembers = true;
              } else {
                if (!(await absent(path))) throw new Error('Frozen directory changed shape.');
                if (parent) {
                  parent.planned++;
                  parent.affected = true;
                }
                removed = true;
                if (unit && unit.decision !== 'delete')
                  throw new Error('Missing retained subtree.');
              }
            } else {
              parent.planned++;
            }
            frames.push({
              path,
              before,
              actual,
              affected: false,
              hasMembers: false,
              open: new Set(),
              release: this.budget.holdRecord(1024 + Buffer.byteLength(path)),
              maven: null,
              projection: projections.position,
              end: projections.position,
              omitted: 0,
              planned: 0,
            });
            if (unit && unit.decision !== 'delete') for (const c of unit.channels) await ensure(c);
          } else if (tag === 'unit-open') {
            unit = {
              descriptor: unitSchema.parse(r.slice(1, 4)),
              activity: String(r[4]),
              decision: String(r[5]),
              channels: new Set(),
            };
            const f = frames[frames.length - 1];
            if (unit.descriptor[0] === 'maven-directory')
              f.maven = { payload: false, protectedArtifact: false };
            if (!f.actual && (unit.decision !== 'delete' || unit.descriptor[2] !== 'subtree'))
              throw new Error('Missing retained unit root.');
            if (unit.decision !== 'delete' && unit.descriptor[2] === 'subtree') {
              const partition = model.owner(unit.descriptor[1] + '/.workspace-directory-probe')[0];
              for (const c of routes(partition, unit.activity)) {
                await ensure(c);
                await append(c, [c === 1 ? 'used-unit-open' : 'unit-open', unit.descriptor]);
                unit.channels.add(c);
              }
            }
          } else if (tag === 'file') {
            const f = frames[frames.length - 1],
              path = joinPath(f.path, String(r[1]));
            if (r[6] === 'delete') {
              removed = true;
              if (f.actual) {
                if (!(await absent(path)))
                  throw new Error('Planned source removal has not completed.');
                f.affected = true;
              }
              f.planned++;
              continue;
            }
            if (!f.actual) throw new Error('Retained file under removed directory.');
            const event = await next('file', path);
            if (
              event.tag !== 'file' ||
              event.links !== '1' ||
              !sameNative(r[3] as NativeIdentity, event.identity, true)
            )
              throw new Error('Retained frozen file changed.');
            f.hasMembers = true;
            await this.guards.append(['file', path, event.identity], signal);
            for (const c of routes(String(r[2]), String(r[5]))) {
              await ensure(c);
              if (unit && !unit.channels.has(c)) {
                await append(c, [c === 1 ? 'used-unit-open' : 'unit-open', unit.descriptor]);
                unit.channels.add(c);
              }
              await append(c, c === 1 ? ['used', String(r[1])] : ['file', path, event.identity]);
            }
          } else if (tag === 'unit-close') {
            if (!unit) throw new Error('Missing observed unit.');
            const maven = frames[frames.length - 1].maven;
            if (maven) {
              maven.payload = [...unit.channels].some((c) => c !== 1);
              if (maven.payload && maven.protectedArtifact)
                throw new Error('Incomplete Maven direct-file contribution.');
            }
            for (const c of unit.channels)
              await append(c, [c === 1 ? 'used-unit-close' : 'unit-close']);
            // A deleted unit may leave protected files/directories. They are verified
            // by the original projection, but contribute no worker payload.
            frames[frames.length - 1].hasMembers = true;
            unit = null;
          } else if (tag === 'dir-close') {
            const f = frames[frames.length - 1];
            if (f.actual) {
              await next('directory-close', f.path);
              while (await projectionNext(f)) f.omitted++;
              if (f.omitted !== f.planned) throw new Error('Unexplained physical source omission.');
              if (!f.affected && !sameNative(f.before, f.actual, true))
                throw new Error('Unexplained directory change.');
              await this.guards.append(['directory', f.path, f.actual], signal);
              if (f.path && !f.hasMembers && !unit) {
                let partition: string | undefined;
                try {
                  partition = model.owner(f.path + '/.workspace-directory-probe')[0];
                } catch {
                  /* Unowned scaffolding. */
                }
                if (partition !== undefined)
                  for (const c of routes(partition, 'upsert')) await ensure(c);
              }
              if (f.path === '') for (let c = 0; c < this.channels.length; c++) await ensure(c);
              for (const c of f.open) await append(c, ['dir-close', f.path, f.actual]);
            } else {
              while (await projectionNext(f)) f.omitted++;
              if (f.omitted !== f.planned)
                throw new Error('Protected child removed with deleted subtree.');
              if (!unit && !f.hasMembers)
                throw new Error('Missing directory without deleted unit.');
            }
            frames.pop()!.release();
            if (f.path === '') {
              finalEnd = raw.end;
              finalRecord = raw.index;
            }
          }
        } finally {
          release();
        }
      }
      if (!(await peek()).done) throw new Error('Unexpected live source member.');
      if (removed) {
        if (!view.gcProgress) throw new Error('Missing completed GC progress.');
        const p = tuple(await this.store.readDocument(view.gcProgress, 'gc-progress'));
        equal(p[3], view.observations, 'GC source observations');
        const c = tuple(p[4]);
        if (
          p[5] !== null ||
          c[2] !== finalEnd ||
          c[3] !== finalRecord ||
          c[5] !== null ||
          (await this.store.readFixed(this.store.prefix + 'gc-intent.json')) !== null
        )
          throw new Error('GC progress is not at the final source boundary.');
      }
      for (const spool of [...this.channels, this.guards]) spool.seal(signal);
    } finally {
      await live.return?.(undefined);
      for (const f of frames) f.release();
      await projections.close();
    }
  }
  async assertStable(signal: AbortSignal): Promise<void> {
    for await (const row of this.guards.rows(signal)) {
      const r = tuple(row),
        path = String(r[1]),
        expected = r[2] as NativeIdentity;
      this.store.root.work.stats++;
      const raw = await lstat(path ? this.store.root.resolve(path) : this.store.root.path, {
        bigint: true,
      });
      if ((raw.isFile() && raw.nlink !== 1n) || !sameNative(expected, nativeIdentity(raw), true))
        throw new Error('Frozen source changed before package sealing.');
    }
    await this.store.root.verifyRoot();
    signal.throwIfAborted();
  }
  async *events(signal: AbortSignal): AsyncGenerator<WorkerEvent> {
    for (const spool of this.channels) {
      const phase = new NativeReadPhase(this.store.root);
      yield { type: 'channel-open' };
      for await (const value of spool.rows(signal)) {
        const r = tuple(value),
          type = String(r[0]);
        if (type === 'dir-open' || type === 'dir-close') {
          const path = String(r[1]),
            native = r[2] as NativeIdentity;
          if (type === 'dir-open') await phase.enter(path, native);
          else await phase.leave(path, native);
          yield { type, path };
        } else if (type === 'file') {
          const path = String(r[1]),
            native = r[2] as NativeIdentity;
          yield {
            type,
            path,
            size: z.coerce.number().int().nonnegative().safe().parse(native[5]),
            mode: normalizeMode(this.store.codec.options.model.tuple[2], path, native[6]),
            mtimeMs: Number(BigInt(native[8]) / 1000000n),
            bytes: phase.read(path, native, signal),
            assertStable: async (s) => {
              s.throwIfAborted();
            },
          };
        } else if (type === 'used') yield { type, name: String(r[1]) };
        else if (type === 'unit-open' || type === 'used-unit-open')
          yield { type, unit: unitSchema.parse(r[1]) };
        else if (type === 'unit-close' || type === 'used-unit-close') yield { type };
        else throw new Error('Invalid source event.');
      }
      yield { type: 'channel-close' };
    }
  }
  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.channels, this.guards].map((s) => s.dispose()),
    );
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        'Source spool cleanup failed.',
      );
  }
}
