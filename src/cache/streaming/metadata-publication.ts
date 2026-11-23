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

import { timed } from '../../util/timing';
import type { PartitionSummaries } from './partition-summaries';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rmdir, unlink, chmod } from 'node:fs/promises';
import type { BaseCacheBackend } from '../backend';
import {
  type MetadataPublicationSource,
  MetadataPublicationSet,
} from './metadata-publication-source';
import { InstallScratch } from './install-scratch';
import { nodeMask, partitionBit } from './install-index';
import {
  createMetadataDescriptor,
  createMetadataGeneration,
  type MetadataGeneration,
} from './metadata-base-records';
import { metadataBaseObjectPaths } from './metadata-base-source';
import { encodeRecord } from './encoding';
import { sameNative, sameObject, sameRename, type NativeIdentity } from './native';
import { joinPath, parentPath, compareMembership } from './tree-state';
import { RecoveryGroups, type ObjectRef, type GenerationEntry } from './native-records';

export type MetadataPublicationChoice =
  readonly ['new', string] | readonly ['empty', string] | readonly ['reuse', string, ObjectRef];
export interface MetadataPublicationRequest {
  readonly lineage: string;
  readonly writer: string;
  readonly decision: string;
  /** LS4 supplies provenance-checked choices; default is new for nonempty selected sources. */
  readonly choices?: readonly MetadataPublicationChoice[];
  readonly groups?: readonly (readonly string[])[];
  readonly onWarning?: (message: string) => void;
  readonly summaries?: PartitionSummaries;
}
export type MetadataPublicationOutcome =
  | { readonly outcome: 'published'; readonly generation: MetadataGeneration }
  | { readonly outcome: 'abandoned'; readonly generation: null };
type Move = readonly [
  'move',
  number | null,
  string,
  string,
  NativeIdentity,
  NativeIdentity,
  NativeIdentity,
];
type Shell = readonly ['shell', number | null, string, NativeIdentity];
interface PartitionPlan {
  partition: string;
  root: string;
  head: number | null;
  count: number;
  reference: ObjectRef;
}

/** One native publication attempt under the selected operation-owned hierarchy. */
export async function publishMetadataBase(
  input: MetadataPublicationSource | MetadataPublicationSet,
  backend: BaseCacheBackend,
  request: MetadataPublicationRequest,
): Promise<MetadataPublicationOutcome> {
  request = Object.freeze({
    ...request,
    choices: request.choices?.map((choice) => structuredClone(choice)),
    groups: request.groups?.map((group) => [...group]),
  });
  const source =
    input instanceof MetadataPublicationSet ? input : MetadataPublicationSet.select(input);
  source.claim();
  try {
    return await publishAttempt(source, backend, request);
  } finally {
    source.release();
  }
}
async function publishAttempt(
  source: MetadataPublicationSet,
  backend: BaseCacheBackend,
  request: MetadataPublicationRequest,
): Promise<MetadataPublicationOutcome> {
  const { store, options } = source,
    model = store.codec.options.model,
    signal = options.signal ?? new AbortController().signal;
  const warn = (where: string) =>
    request.onWarning?.('Cache publication abandoned: ' + where + '.');
  const unavailable = (): boolean =>
    !backend.capabilities.supportsExplicitSave ||
    !backend.isFeatureAvailable() ||
    backend.canConfirmSave?.() === false;
  signal.throwIfAborted();
  let available: boolean;
  try {
    available = !unavailable();
  } catch {
    warn('outgoing cache availability failed');
    return { outcome: 'abandoned', generation: null };
  }
  if (!available) {
    warn('outgoing cache confirmation unavailable');
    return { outcome: 'abandoned', generation: null };
  }
  request.summaries?.assert(model);
  const choices =
    request.choices?.map((c) => structuredClone(c)) ??
    model.partitions.map(
      (p) =>
        [
          source.summary(p[0])[3] === 0 && source.summary(p[0])[4] === 0 ? 'empty' : 'new',
          p[0],
        ] as MetadataPublicationChoice,
    );
  if (
    choices.length !== model.partitions.length ||
    choices.some((c, i) => c[1] !== model.partitions[i][0])
  )
    throw new Error('Incomplete/out-of-order metadata publication choices.');
  for (const choice of choices) {
    request.summaries?.choice(choice[1], choice[0]);
    const summary = source.summary(choice[1]);
    if (choice[0] === 'empty' && (summary[3] !== 0 || summary[4] !== 0))
      throw new Error('Nonempty source declared empty.');
  }
  const stage = store.prefix + 'base/' + randomUUID(),
    scratch = await InstallScratch.create(store, options.budget);
  let shells: number | null = null,
    cleanupSafe = true,
    shellCleanupFailed = false,
    failure: unknown,
    result: MetadataPublicationOutcome | undefined;
  const plans = new Map<string, PartitionPlan>();
  let release = () => {};
  const errors: Error[] = [];
  let failures = 0;
  const localFailure = (message: string) => {
    failures++;
    if (errors.length < 8) errors.push(new Error(message.slice(0, 4096)));
  };
  async function created(name: string): Promise<NativeIdentity> {
    signal.throwIfAborted();
    await store.root.parents(name);
    await mkdir(store.root.resolve(name));
    store.root.work.directoryCreations++;
    const native = await store.root.stat(name);
    if (!native || native[2] !== 'directory' || native[3] !== store.root.binding[3])
      throw new Error('Unresolved staging directory at ' + store.root.resolve(name));
    shells = await scratch.append(['shell', shells, name, native]);
    return native;
  }
  async function control(name: string, bytes: Buffer): Promise<void> {
    await store.root.parents(name);
    store.root.work.opens++;
    const handle = await open(store.root.resolve(name), 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      store.root.work.controlWriteCalls++;
      store.root.work.writeBytes += bytes.length;
    } finally {
      await handle.close();
    }
    const native = await store.root.stat(name);
    if (!native) throw new Error('Unresolved control file at ' + store.root.resolve(name));
    shells = await scratch.append(['shell', shells, name, native]);
  }
  async function readMove(offset: number): Promise<{ row: Move; release: () => void }> {
    const row = await scratch.record(offset);
    try {
      const release = options.budget.holdRecord(512 + encodeRecord(row.value).length * 4);
      try {
        return { row: structuredClone(row.value) as Move, release };
      } catch (error) {
        release();
        throw error;
      }
    } finally {
      row.release();
    }
  }
  async function endpoints(
    row: Move,
  ): Promise<{ original: NativeIdentity | null; staged: NativeIdentity | null }> {
    const originalParent = await store.root.stat(parentPath(row[2])),
      stageParent = await store.root.stat(parentPath(row[3]));
    if (
      !originalParent ||
      !sameObject(row[5], originalParent) ||
      !stageParent ||
      !sameObject(row[6], stageParent)
    )
      throw new Error('Move source/target parent changed.');
    return { original: await store.root.stat(row[2]), staged: await store.root.stat(row[3]) };
  }
  async function returnRoots(plan: PartitionPlan, attempted: number): Promise<void> {
    let cursor = plan.head;
    for (let n = 0; n < attempted && cursor !== null; n++) {
      const held = await readMove(cursor),
        row = held.row;
      cursor = row[1];
      try {
        let e = await endpoints(row);
        if (e.original && sameRename(row[4], e.original) && !e.staged) continue;
        if (e.original || !e.staged || !sameRename(row[4], e.staged))
          throw new Error('Occupied/changed return endpoint.');
        // The immutable row already owns this reverse attempt before awaiting rename/after-stat.
        try {
          await store.root.renameAbsent(row[3], row[2], e.staged);
        } catch (error) {
          e = await endpoints(row);
          if (!e.original || !sameRename(row[4], e.original) || e.staged) throw error;
        }
        await store.fail('metadata-source-returned');
      } catch {
        cleanupSafe = false;
        localFailure(
          'Source return failed; retained stage ' +
            store.root.resolve(stage) +
            '; original ' +
            store.root.resolve(row[2]) +
            '; staged root ' +
            store.root.resolve(row[3]),
        );
      } finally {
        held.release();
      }
    }
  }
  async function cleanShells(): Promise<void> {
    await scratch.flush();
    let cursor = shells;
    while (cursor !== null) {
      const entry = await scratch.record(cursor);
      let row: Shell;
      try {
        row = structuredClone(entry.value) as Shell;
      } finally {
        entry.release();
      }
      cursor = row[1];
      const current = await store.root.stat(row[2]);
      if (
        !current ||
        !(row[3][2] === 'file' ? sameNative(row[3], current, true) : sameObject(row[3], current))
      )
        throw new Error('Known staging shell changed: ' + store.root.resolve(row[2]));
      // Only known control files and empty directories. Unknown members make rmdir fail and remain intact.
      if (current[2] === 'file') {
        await unlink(store.root.resolve(row[2]));
        store.root.work.unlinks++;
        store.root.work.cleanupFiles++;
      } else {
        await rmdir(store.root.resolve(row[2]));
        store.root.work.directoryRemovals++;
        store.root.work.cleanupDirectories++;
      }
      shells = row[1];
      await store.fail('metadata-shell-retired');
    }
  }
  try {
    const groups = await timed(options, 'shared publication staging planning', async () => {
      release = options.budget.holdRecord(36864 + model.partitions.length * 4096);
      await store.makeParents(stage);
      if (choices.some((choice) => choice[0] === 'new')) await created(stage);
      const stageParents = new Map<string, NativeIdentity>();
      for (const c of choices)
        if (c[0] === 'new') {
          const descriptor = createMetadataDescriptor(model, [
              model.family,
              model.id,
              c[1],
              request.lineage,
              request.writer,
              request.decision,
            ]),
            root = stage + '/' + c[1];
          await created(root);
          stageParents.set(c[1], await created(root + '/payload'));
          await control(root + '/envelope.json', descriptor.bytes);
          plans.set(c[1], {
            partition: c[1],
            root,
            head: null,
            count: 0,
            reference: descriptor.reference,
          });
        }
      const components = source.components(),
        coordinates: (number | null)[] = [],
        groups = new RecoveryGroups(model);
      const deriveGroups = request.groups === undefined && model.tuple[2] === 'maven';
      for (const component of components) {
        if (!deriveGroups && !component.partitions.some((p) => plans.has(p))) continue;
        const physical = component.source,
          selected = component.partitions.reduce((mask, p) => mask | partitionBit(model, p), 0n);
        let coordinateHead: number | null = null;
        async function select(
          offset: number,
          originalParent: NativeIdentity,
          parents: ReadonlyMap<string, NativeIdentity>,
          suppressed: bigint,
          direct?: Set<string>,
        ): Promise<void> {
          signal.throwIfAborted();
          physical.assert();
          const entry = await physical.node(offset);
          let releaseFrame = () => {};
          try {
            releaseFrame = options.budget.holdRecord(512 + parents.size * 128);
            const n = entry.node,
              originalMask = nodeMask(n),
              mask = originalMask & selected,
              native = n[3] as NativeIdentity;
            if (n[1] === 'protected' || !mask) return;
            if (n[1] === 'file') direct?.add(model.owner(n[2])[0]);
            const remaining = new Map<string, NativeIdentity>();
            let next = suppressed;
            for (const [p, parent] of parents) {
              const bit = partitionBit(model, p);
              if (!(mask & bit) || suppressed & bit) continue;
              const plan = plans.get(p)!,
                target = plan.root + '/payload/' + n[2];
              if (originalMask === bit && n[6] === 0) {
                plan.head = await scratch.append([
                  'move',
                  plan.head,
                  joinPath(physical.nativeRoot, n[2]),
                  target,
                  native,
                  originalParent,
                  parent,
                ]);
                plan.count++;
                request.summaries?.root(p, n[1] === 'file' ? 'file' : 'directory');
                next |= bit;
              } else if (n[1] === 'directory') {
                if (n[6] > 0)
                  request.summaries?.hint(p, 'excluded or unmanaged entries remain', n[2]);
                if (originalMask !== bit)
                  request.summaries?.hint(p, 'mixed partition ownership', n[2]);
                if ((originalMask & ~selected) !== 0n)
                  request.summaries?.hint(p, 'unselected contents', n[2]);
                remaining.set(p, await created(target));
              }
            }
            if (
              n[1] === 'directory' &&
              (remaining.size ||
                (deriveGroups && (components.length > 1 || (mask & (mask - 1n)) !== 0n)))
            ) {
              const owners = new Set<string>();
              for await (const edge of physical.children(n))
                if (edge[1] === 'file') await select(edge[2], native, remaining, next, owners);
              if (
                deriveGroups &&
                owners.size &&
                (n[2] === 'repository' || n[2].startsWith('repository/'))
              )
                coordinateHead = await scratch.append([
                  'coordinate',
                  coordinateHead,
                  n[2],
                  [...owners],
                ]);
              for await (const edge of physical.children(n))
                if (edge[1] === 'directory') await select(edge[2], native, remaining, next);
              for (const [p] of remaining) {
                await chmod(
                  store.root.resolve(plans.get(p)!.root + '/payload/' + n[2]),
                  native[6] & 0o777,
                );
                store.root.work.modeChanges++;
              }
            }
          } finally {
            releaseFrame();
            entry.release();
          }
        }
        const rootEntry = await physical.node(physical.index);
        try {
          const parents = new Map(
            [...stageParents].filter(([p]) => component.partitions.includes(p)),
          );
          // Coordinate rows are preorder and linked backwards, giving descending directory paths.
          const owners = new Set<string>();
          for await (const edge of physical.children(rootEntry.node))
            await select(edge[2], rootEntry.node[3] as NativeIdentity, parents, 0n, owners);
        } finally {
          rootEntry.release();
        }
        coordinates.push(coordinateHead);
      }
      await scratch.flush();
      if (deriveGroups) {
        type Coordinate = readonly ['coordinate', number | null, string, string[]];
        const heads: (Coordinate | null)[] = [],
          charges: (() => void)[] = coordinates.map(() => () => {});
        async function coordinate(
          offset: number | null,
          index: number,
        ): Promise<Coordinate | null> {
          charges[index]();
          charges[index] = () => {};
          if (offset === null) return null;
          const row = await scratch.record(offset);
          try {
            charges[index] = options.budget.holdRecord(512 + encodeRecord(row.value).length * 4);
            return structuredClone(row.value) as Coordinate;
          } finally {
            row.release();
          }
        }
        try {
          for (const [i, offset] of coordinates.entries()) heads.push(await coordinate(offset, i));
          while (heads.some((head) => head !== null)) {
            let path: string | undefined;
            for (const head of heads)
              if (
                head &&
                (path === undefined ||
                  compareMembership(['member', 'unit', head[2]], ['member', 'unit', path]) > 0)
              )
                path = head[2];
            const owners: string[] = [];
            for (let i = 0; i < heads.length; i++)
              if (heads[i]?.[2] === path) {
                owners.push(...heads[i]![3]);
                heads[i] = await coordinate(heads[i]![1], i);
              }
            groups.observe(owners);
          }
        } finally {
          for (const release of charges) release();
        }
      }
      await scratch.flush();
      return groups;
    });
    let confirmed = true;
    for (const plan of plans.values()) {
      let eligible = false;
      try {
        eligible = !unavailable();
      } catch {
        /* Unavailable outgoing backend. */
      }
      if (!eligible) {
        confirmed = false;
        warn('outgoing cache confirmation unavailable');
        break;
      }
      let attempted = 0,
        cursor = plan.head;
      try {
        await timed(options, `partition staging [partition=${plan.partition}]`, async () => {
          while (cursor !== null) {
            signal.throwIfAborted();
            source.assertPartition(plan.partition);
            const held = await readMove(cursor),
              row = held.row;
            try {
              const e = await endpoints(row);
              if (!e.original || !sameNative(row[4], e.original, true) || e.staged)
                throw new Error('Evacuation endpoint changed.');
              attempted++; // Own the actual native attempt before rename and its after-stat.
              await store.root.renameAbsent(row[2], row[3], row[4]);
              cursor = row[1];
              await store.fail('metadata-source-evacuated');
            } finally {
              held.release();
            }
          }
        });
        signal.throwIfAborted();
        // Never race SDK source readers against foreground cancellation.
        const paths = metadataBaseObjectPaths(store, plan.root),
          archiveRoot = store.root.resolve(plan.root);
        let id: number | undefined;
        try {
          id = await timed(
            options,
            `base SDK save [partition=${plan.partition}]`,
            () => backend.saveCache(paths, plan.reference[2], { archiveRoot }),
            (id) => (Number.isSafeInteger(id) && id! > 0 ? 'confirmed' : 'abandoned/unconfirmed'),
            () => 'abandoned/unconfirmed',
          );
        } catch {
          confirmed = false;
        }
        if (!Number.isSafeInteger(id) || id! <= 0) confirmed = false;
      } finally {
        await timed(
          { ...options, signal: undefined },
          `source return [partition=${plan.partition}]`,
          () => returnRoots(plan, attempted),
          () => (failures ? 'failed' : 'success'),
        );
      }
      if (failures)
        throw new AggregateError(
          errors,
          'Metadata source returns failed (' +
            failures +
            '); retained stage ' +
            store.root.resolve(stage),
        );
      signal.throwIfAborted();
      if (!confirmed) {
        warn('object save unconfirmed');
        break;
      }
    }
    if (confirmed) {
      source.assert();
      // Source staging and all empty-shell retirement must succeed before the record attempt.
      try {
        await timed({ ...options, signal: undefined }, 'staging cleanup', () => cleanShells());
      } catch (error) {
        shellCleanupFailed = true;
        throw new Error('Staging cleanup failed; retained ' + store.root.resolve(stage), {
          cause: error,
        });
      }
      await created(stage);
      const entries: GenerationEntry[] = choices.map((c) =>
        c[0] === 'empty'
          ? ['empty', c[1]]
          : ['object', c[1], c[0] === 'reuse' ? c[2] : plans.get(c[1])!.reference],
      );
      const generation = createMetadataGeneration(
        model,
        request.lineage,
        request.writer,
        request.decision,
        entries,
        (request.groups ?? groups.groups()).map((g) => [...g]),
      );
      await control(stage + '/record.json', encodeRecord(generation));
      await scratch.flush();
      signal.throwIfAborted();
      const recordPath = store.root.resolve(stage + '/record.json'),
        archiveRoot = store.root.resolve(stage);
      let id: number | undefined;
      try {
        if (!unavailable())
          id = await timed(
            options,
            'generation SDK save',
            () => backend.saveCache([recordPath], generation[11], { archiveRoot }),
            (id) => (Number.isSafeInteger(id) && id! > 0 ? 'confirmed' : 'abandoned/unconfirmed'),
            () => 'abandoned/unconfirmed',
          );
      } catch {
        /* A lost response may already have published remotely; never discover/read it back. */
      }
      if (Number.isSafeInteger(id) && id! > 0) result = { outcome: 'published', generation };
      else warn('final record save unconfirmed');
    }
    result ??= { outcome: 'abandoned', generation: null };
  } catch (error) {
    failure = error;
  }
  if (cleanupSafe && !shellCleanupFailed) {
    try {
      await timed({ ...options, signal: undefined }, 'staging cleanup', () => cleanShells());
    } catch (error) {
      localFailure('Staging cleanup failed; retained ' + store.root.resolve(stage));
      failure = new AggregateError(
        [...(failure === undefined ? [] : [failure]), error],
        errors.at(-1)?.message ?? 'Staging cleanup failed.',
      );
    }
  }
  try {
    await scratch.close();
  } catch (error) {
    failure = new AggregateError(
      [...(failure === undefined ? [] : [failure]), error],
      'Publication scratch cleanup failed.',
    );
  }
  release();
  if (failure !== undefined) throw failure;
  if (failures) throw new AggregateError(errors, 'Metadata publication local failures.');
  return result!;
}
