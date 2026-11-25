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
import { ownsLocalSnapshot } from './model';
import { tuple, type Value } from './encoding';
import type { OwnedStore } from './owned-store';
import type { NativeIdentity } from './native';
import { NativeReadPhase } from './native-read-phase';
import { walkWork } from './native-walk';
import { GcSurvivorOwner } from './gc-execute';
import { ObservationIndex, type ObservedDirectory, type ObservedFile } from './observation-index';
import { isWorkspaceScaffolding, baseName, normalizeMode, type WorkingBudget } from './tree-state';
import { unitSchema, type Unit } from './schema';
import { isCacheMetadataPath } from '../metadata-paths';
import { isMavenTransientFile } from '../maven-repository';
import { WorkerSpool } from './worker-spool';
import type { WorkerEvent } from './worker-codec';

export interface WorkerSourceView {
  readonly survivors: GcSurvivorOwner;
  readonly incompleteUsage?: boolean;
}

interface Frame {
  path: string;
  native: NativeIdentity;
  open: Set<number>;
  release: () => void;
}

interface ActiveUnit {
  descriptor: Unit;
  channels: Set<number>;
  protectedArtifact: boolean;
  deleting: boolean;
}

/** One shared original hierarchy pass selects actual delta channel work; no new native inventory. */
export class WorkerSources {
  readonly work = walkWork();
  private disposed = false;

  private constructor(
    private readonly store: OwnedStore,
    private readonly budget: WorkingBudget,
    private readonly owner: GcSurvivorOwner,
    private readonly channels: WorkerSpool[],
    readonly snapshots: readonly string[],
    private readonly releaseOwner: () => void,
  ) {}

  static async create(
    store: OwnedStore,
    view: WorkerSourceView,
    budget: WorkingBudget,
    signal = new AbortController().signal,
    maxDirectoryEntries = 100000,
  ): Promise<WorkerSources> {
    const owner = view.survivors;
    GcSurvivorOwner.assertReceipt(owner);
    if (
      owner.index.store !== store ||
      owner.index.options.budget !== budget ||
      (owner.index.options.maxDirectoryEntries ?? 100000) !== maxDirectoryEntries
    ) {
      throw new Error('Worker source original owner/store/policy mismatch.');
    }
    const release = owner.borrow(),
      channels: WorkerSpool[] = [],
      snapshots = Object.freeze(
        store.codec.options.model.partitions
          .filter((p) => ownsLocalSnapshot(p, store.codec.options))
          .map((p) => p[0]),
      ),
      result = new WorkerSources(store, budget, owner, channels, snapshots, release);
    try {
      for (let i = 0; i < 2 + snapshots.length; i++) {
        channels.push(await WorkerSpool.create(store, budget));
      }
      await result.capture(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      try {
        await result.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Worker source selection cleanup failed.', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }

  private async capture(signal: AbortSignal): Promise<void> {
    const index = this.owner.index,
      model = this.store.codec.options.model,
      frames: Frame[] = [];
    const append = (channel: number, value: Value) => this.channels[channel].append(value, signal);
    const ensure = async (channel: number) => {
      for (const frame of frames) {
        if (!frame.open.has(channel)) {
          await append(channel, ['dir-open', frame.path, frame.native]);
          frame.open.add(channel);
        }
      }
    };
    const routes = (partition: string, activity: string): number[] => {
      const part = model.partitions.find((p) => p[0] === partition)!;
      const channels: number[] = [];
      if (part[3] === 'aggregate' && activity !== 'none') {
        channels.push(activity === 'upsert' ? 0 : 1);
      }
      const snapshot = this.snapshots.indexOf(partition);
      if (snapshot >= 0) {
        channels.push(snapshot + 2);
      }
      return channels;
    };
    const openUnit = async (channel: number, unit: ActiveUnit) => {
      await ensure(channel);
      if (!unit.channels.has(channel)) {
        if (channel !== 1 && unit.protectedArtifact) {
          throw new Error('Incomplete Maven direct-file contribution.');
        }
        await append(channel, [channel === 1 ? 'used-unit-open' : 'unit-open', unit.descriptor]);
        unit.channels.add(channel);
      }
    };
    const file = async (node: ObservedFile, unit: ActiveUnit | null) => {
      if (node[5] === 'delete') {
        return;
      }
      for (const channel of routes(node[3], node[4])) {
        if (unit) {
          await openUnit(channel, unit);
        } else {
          await ensure(channel);
        }
        await append(
          channel,
          channel === 1 ? ['used', baseName(node[1])] : ['file', node[1], node[2]],
        );
      }
    };
    const visit = async (offset: number, inherited: ActiveUnit | null = null): Promise<void> => {
      signal.throwIfAborted();
      this.owner.assert();
      ObservationIndex.assert(index, this.store);
      const lease = await index.node(offset);
      try {
        if (lease.node[0] === 'observed-file') {
          await file(lease.node, inherited);
          return;
        }
        const directory: ObservedDirectory = lease.node;
        if (directory[10][5]) {
          return;
        }
        const frame: Frame = {
          path: directory[1],
          native: await this.owner.directoryNative(directory[1]),
          open: new Set(),
          release: this.budget.holdRecord(1024 + Buffer.byteLength(directory[1])),
        };
        frames.push(frame);
        let unit = inherited,
          localUnit = false;
        const declaration = directory[9];
        if (declaration) {
          if (unit) {
            throw new Error('Nested observed worker unit.');
          }
          const descriptor = unitSchema.parse(declaration.slice(1, 4));
          let protectedArtifact = false;
          if (descriptor[0] === 'maven-directory') {
            for await (const edge of index.children(directory)) {
              if (
                edge[5] === null &&
                edge[2] !== 'directory' &&
                !isCacheMetadataPath(directory[1] + '/' + edge[1]) &&
                !isMavenTransientFile(edge[1])
              ) {
                protectedArtifact = true;
              }
            }
          }
          unit = {
            descriptor,
            channels: new Set(),
            protectedArtifact,
            deleting: declaration[5] === 'delete',
          };
          localUnit = true;
          if (declaration[5] !== 'delete' && descriptor[2] === 'subtree') {
            let partition: string | undefined;
            try {
              partition = model.owner(descriptor[1] + '/.workspace-directory-probe')[0];
            } catch {
              /* unowned scaffold */
            }
            if (partition) {
              for (const channel of routes(partition, declaration[4])) {
                await openUnit(channel, unit);
              }
            }
          }
        }
        let members = 0;
        for await (const edge of index.children(directory)) {
          if (edge[5] !== null && !edge[6] && edge[2] === 'file') {
            members++;
            await visit(edge[5], unit);
          }
        }
        if (localUnit && unit!.descriptor[2] === 'direct') {
          for (const channel of unit!.channels) {
            await append(channel, [channel === 1 ? 'used-unit-close' : 'unit-close']);
          }
          unit = inherited;
        }
        for await (const edge of index.children(directory)) {
          if (edge[5] !== null && !edge[6] && edge[2] === 'directory') {
            members++;
            await visit(edge[5], unit);
          }
        }
        if (localUnit && declaration![3] === 'subtree') {
          for (const channel of unit!.channels) {
            await append(channel, [channel === 1 ? 'used-unit-close' : 'unit-close']);
          }
        }
        if (
          !members &&
          !unit?.deleting &&
          !(localUnit && declaration![5] === 'delete') &&
          directory[1] &&
          !isWorkspaceScaffolding(model, directory[1])
        ) {
          let partition: string | undefined;
          try {
            partition = model.owner(directory[1] + '/.workspace-directory-probe')[0];
          } catch {
            /* unowned scaffold */
          }
          if (partition) {
            // Empty descendants follow the complete unit's existing selection, including usage.
            const channels =
              unit?.descriptor[2] === 'subtree' ? unit.channels : routes(partition, 'upsert');
            for (const channel of channels) {
              await ensure(channel);
            }
          }
        }
        if (!directory[1]) {
          for (let channel = 0; channel < this.channels.length; channel++) {
            await ensure(channel);
          }
        }
        for (const channel of frame.open) {
          await append(channel, ['dir-close', frame.path, frame.native]);
        }
        frames.pop();
        frame.release();
      } finally {
        lease.release();
      }
    };
    try {
      await visit(index.root);
      for (const channel of this.channels) {
        channel.seal(signal);
      }
    } finally {
      for (const frame of frames) {
        frame.release();
      }
    }
  }

  async assertStable(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.owner.assert();
    // NativeReadPhase already checks every emitted directory and every forward-read
    // body at its consuming boundary. The original phase does not support concurrent writers.
  }

  async *events(signal: AbortSignal): AsyncGenerator<WorkerEvent> {
    for (const spool of this.channels) {
      this.owner.assert();
      const phase = new NativeReadPhase(this.store.root);
      yield { type: 'channel-open' };
      for await (const value of spool.rows(signal)) {
        const row = tuple(value),
          type = String(row[0]);
        if (type === 'dir-open' || type === 'dir-close') {
          const path = String(row[1]),
            native = row[2] as NativeIdentity;
          if (type === 'dir-open') {
            await phase.enter(path, native);
          } else {
            await phase.leave(path, native);
          }
          yield { type, path };
        } else if (type === 'file') {
          const path = String(row[1]),
            native = row[2] as NativeIdentity;
          yield {
            type,
            path,
            size: z.coerce.number().int().nonnegative().safe().parse(native[5]),
            mode: normalizeMode(this.store.codec.options.model.tuple[2], path, native[6]),
            mtimeMs: Number(BigInt(native[8]) / 1000000n),
            bytes: phase.read(path, native, signal),
            assertStable: async (s) => {
              s.throwIfAborted();
              this.owner.assert();
            },
          };
        } else if (type === 'used') {
          yield { type, name: String(row[1]) };
        } else if (type === 'unit-open' || type === 'used-unit-open') {
          yield { type, unit: unitSchema.parse(row[1]) };
        } else if (type === 'unit-close' || type === 'used-unit-close') {
          yield { type };
        } else {
          throw new Error('Invalid selected worker source event.');
        }
      }
      yield { type: 'channel-close' };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      const results = await Promise.allSettled(this.channels.map((channel) => channel.dispose()));
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed.length) {
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Worker channel cleanup failed.',
        );
      }
    } finally {
      this.releaseOwner();
    }
  }
}
