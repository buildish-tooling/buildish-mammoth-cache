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

import type { BaseCacheBackend } from '../backend';
import { FrozenMovingPublication, movingObjectRef } from './base-moving-publication';
import { MovingWindow } from './moving-window';
import { RelocationEpoch } from './relocation-epoch';
import { NativeObjectSave, NativeObjectDownload } from './base-transport';
import { saveNativeRecord } from './base-record-save';
import {
  updateMovingCatalog,
  retireMovingMetadata,
  retireReturnedPrefixes,
  movingMarker,
} from './moving-catalog';
import { baselineGeneration } from './base-publication';
import { equal, canonical, type Value } from './encoding';
import type { Reference } from './owned-store';
import type { BatchTargets } from './install-batches';

export interface MovingPublishOptions extends BatchTargets {
  /** Independent, interruptible source-return context after foreground cancellation. */
  readonly cleanupSignal?: AbortSignal;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
// Internal live-source publisher. SDK outcomes stay provisional through physical
// return and catalog commitment; no Action/bootstrap or daemon discovery here.
export class MovingBasePublication {
  private busy = false;
  private closed = false;
  private window: MovingWindow | undefined;
  private heldEpoch: RelocationEpoch | undefined;
  private cleanupPublication: FrozenMovingPublication | undefined;
  private constructor(
    readonly frozen: FrozenMovingPublication,
    private readonly options: MovingPublishOptions,
  ) {}
  static open(frozen: FrozenMovingPublication, options: MovingPublishOptions = {}) {
    FrozenMovingPublication.assert(frozen);
    return new MovingBasePublication(frozen, Object.freeze({ ...options }));
  }
  private async operation<T>(work: () => Promise<T>) {
    if (this.closed || this.busy) throw new Error('Moving publisher unavailable/active.');
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  private async sourceWindow() {
    if (!this.window) this.window = await MovingWindow.open(this.frozen, this.options);
    return this.window;
  }
  private async finishReturn(epoch: RelocationEpoch, window: MovingWindow) {
    const pub = window.publication,
      candidate = await epoch.returnSources(),
      marker = epoch.current!,
      proof = await window.checkCandidate(epoch, candidate);
    await proof.close();
    // Cleaning the owned shell remains discoverable until the marker is retired.
    await epoch.cleanupStage();
    const cells = await pub.cells();
    let committed = false;
    try {
      const cell = cells.rows.find((c) => c[1] === epoch.partition)!;
      if (JSON.stringify(cell[3]) === JSON.stringify(candidate) && cell[6] === null)
        committed = true;
      else {
        equal(cell[3], marker[6], 'old returned adjustment cell');
        if (
          cell[6] !== null &&
          cell[6] !== pub.store.prefix + 'relocation/' + epoch.partition + '.json'
        )
          throw new Error('Unexpected return marker hint.');
      }
    } finally {
      cells.release();
    }
    let oldCatalog: Reference | undefined;
    if (!committed)
      oldCatalog = await updateMovingCatalog(pub, (rows) => {
        const cell = rows.find((c) => c[1] === epoch.partition)!;
        cell[3] = pub.store.codec.schemas.ref('adjustments').parse(candidate);
        cell[6] = null;
      });
    await pub.store.fail('moving-adjustment-pointer');
    await window.adopt(epoch.partition, candidate);
    await window.verifyPart(epoch.partition);
    // Close all prefix/stage handles before native Windows retirement.
    await epoch.close();
    if (this.heldEpoch === epoch) this.heldEpoch = undefined;
    await pub.store.clearIntent(marker);
    await pub.store.fail('moving-relocation-retired');
    if (oldCatalog) await retireMovingMetadata(pub, epoch.partition, oldCatalog);
    if (marker[6]) await retireMovingMetadata(pub, epoch.partition, marker[6]);
    if (marker[14]) await retireMovingMetadata(pub, epoch.partition, marker[14]);
    await retireReturnedPrefixes(pub, marker);
  }
  private async recoverCurrent(window: MovingWindow) {
    const marker = await movingMarker(window.publication);
    if (!marker) {
      if (!window.verified) await window.verify();
      return;
    }
    const epoch = await RelocationEpoch.open(window.publication, marker[3], this.options, window);
    this.heldEpoch = epoch;
    let primary: unknown;
    try {
      await this.finishReturn(epoch, window);
    } catch (error) {
      primary = error;
    }
    let closeFailure: unknown;
    try {
      await epoch.close();
    } catch (error) {
      closeFailure = error;
    }
    if (closeFailure !== undefined) {
      if (primary !== undefined)
        throw new AggregateError(
          [primary, closeFailure],
          'Source recovery and resource cleanup failed.',
          { cause: primary },
        );
      throw closeFailure;
    }
    if (this.heldEpoch === epoch) this.heldEpoch = undefined;
    if (primary !== undefined) throw primary;
  }
  private async closeResources() {
    const errors: unknown[] = [];
    try {
      await this.heldEpoch?.close();
      this.heldEpoch = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.window?.close();
      this.window = undefined;
    } catch (error) {
      errors.push(error);
    }
    if (!this.window && !this.heldEpoch) {
      this.cleanupPublication?.dispose();
      this.cleanupPublication = undefined;
    }
    if (errors.length)
      throw new AggregateError(errors, 'Moving resource cleanup remains incomplete.');
  }
  private async recoverAfterFailure(primary: unknown) {
    // SDK settlement precedes this path. Never borrow a second source window
    // until every old resource owner has released its exclusive lease.
    const errors: unknown[] = [];
    try {
      await this.closeResources();
      if (!(await movingMarker(this.frozen))) return;
      const pub = await FrozenMovingPublication.resume(this.frozen.store, {
        ...this.frozen.options,
        signal: this.options.cleanupSignal ?? new AbortController().signal,
      });
      this.cleanupPublication = pub;
      this.window = await MovingWindow.open(pub, this.options);
      await this.recoverCurrent(this.window);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await this.closeResources();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        [primary, ...errors],
        'Moving save failed; cleanup could not complete independent source recovery. Durable ownership is not discarded.',
        { cause: primary },
      );
  }
  async recoverSources(): Promise<void> {
    return this.operation(async () => this.recoverCurrent(await this.sourceWindow()));
  }
  async saveObjects(backend: BaseCacheBackend): Promise<void> {
    return this.operation(async () => {
      const pub = this.frozen;
      if ((await pub.state())[4] === 'record-saved') return;
      if (!backend.capabilities.supportsExplicitSave || !backend.isFeatureAvailable())
        throw new Error('Moving base backend cannot save.');
      let epoch: RelocationEpoch | undefined;
      try {
        const window = await this.sourceWindow();
        await this.recoverCurrent(window);
        for (const row of pub.choices) {
          if (row[0] !== 'new') continue;
          const cells = await pub.cells();
          let confirmed = false;
          try {
            confirmed = cells.rows.find((c) => c[1] === row[1])![5] !== null;
          } finally {
            cells.release();
          }
          if (confirmed) continue;
          epoch = await RelocationEpoch.open(pub, row[1], this.options, window);
          this.heldEpoch = epoch;
          const marker = await epoch.reserve();
          const oldCatalog = await updateMovingCatalog(pub, (rows) => {
            rows.find((c) => c[1] === row[1])![6] =
              pub.store.prefix + 'relocation/' + row[1] + '.json';
          });
          await retireMovingMetadata(pub, row[1], oldCatalog);
          equal(marker[5], row[6], 'reserved upload plan');
          const object = await epoch.evacuate();
          const saved = await NativeObjectSave.save(backend, object, pub.options);
          pub.options.signal?.throwIfAborted();
          await this.finishReturn(epoch, window);
          epoch = undefined;
          let confirmation: Value | undefined;
          if (saved.serviceId !== null && !saved.barrierError)
            confirmation = ['save', String(saved.serviceId)];
          else {
            // An unconfirmed same-key object may come from an interrupted earlier
            // epoch with unknown stage guards. Strong readback is conditional here.
            const readback = await NativeObjectDownload.restore(
              pub.store,
              backend,
              movingObjectRef(row),
              pub.options,
              true,
            );
            try {
              if (readback.object) confirmation = ['readback', row[3]];
            } finally {
              await readback.dispose();
            }
          }
          if (!confirmation) throw new Error('Moving object save remains unconfirmed.');
          await window.verifyPart(row[1]);
          const old = await updateMovingCatalog(
            pub,
            (rows) => {
              const cell = rows.find((c) => c[1] === row[1])!;
              if (cell[6] !== null) throw new Error('Source ownership remains active.');
              cell[5] = pub.store.codec.schemas.documents['object-receipt'].parse([
                'object-receipt',
                1,
                row[1],
                row[3],
                row[4][4],
                pub.generation[7],
                confirmation!,
              ]);
            },
            'object-saved',
          );
          await retireMovingMetadata(pub, row[1], old);
          await pub.store.fail('moving-object-receipt');
        }
        const state = await pub.state();
        state[3]++;
        state[4] = 'sources-returned';
        await pub.store.updateState(state);
        pub.options.signal?.throwIfAborted();
      } catch (error) {
        await this.recoverAfterFailure(error);
        throw error;
      }
    });
  }
  /** Exact reuse still needs the complete source-return and final live barrier. */
  async verifyUnchanged(): Promise<boolean> {
    return this.operation(async () => {
      const pub = this.frozen,
        state = await pub.state();
      if (state[4] !== 'sources-returned') return false;
      const b = pub.store.codec.schemas.documents.bindings.parse(
          await pub.store.readDocument(state[5], 'bindings'),
        ),
        prior = await baselineGeneration(pub.store, b);
      if (
        !prior ||
        pub.choices.some((c) => c[0] === 'new') ||
        !canonical([prior[5], prior[8], prior[9]]).equals(
          canonical([pub.generation[5], pub.generation[8], pub.generation[9]]),
        )
      )
        return false;
      if (await movingMarker(pub)) throw new Error('Unchanged publication still owns sources.');
      await (await this.sourceWindow()).verify();
      equal(await pub.state(), state, 'unchanged final source barrier');
      pub.options.signal?.throwIfAborted();
      return true;
    });
  }
  async publish(backend: BaseCacheBackend) {
    return this.operation(async () => {
      const pub = this.frozen,
        state = await pub.state();
      if (state[4] === 'record-saved') return pub.generation;
      if (!['sources-returned', 'final-source-barrier'].includes(state[4]))
        throw new Error('Moving generation requires completed source returns.');
      const catalog = await pub.cells();
      try {
        for (const row of pub.choices)
          if (row[0] === 'new') {
            const cell = catalog.rows.find((c) => c[1] === row[1])!;
            if (!cell[5] || cell[6] !== null)
              throw new Error('Moving generation has unconfirmed ownership/objects.');
          }
      } finally {
        catalog.release();
      }
      if (await movingMarker(pub)) throw new Error('Moving generation still owns sources.');
      state[3]++;
      state[4] = 'final-source-barrier';
      await pub.store.updateState(state);
      const window = await this.sourceWindow();
      await window.verify();
      await saveNativeRecord(pub.store, backend, pub.record, pub.generation[11], pub.options);
      const current = await pub.state();
      equal(current, state, 'record-save moving lifecycle');
      current[3]++;
      current[4] = 'record-saved';
      await pub.store.updateState(current);
      pub.options.signal?.throwIfAborted();
      return pub.generation;
    });
  }
  async close() {
    if (this.busy) throw new Error('Moving publisher operation active.');
    if (this.closed) return;
    await this.closeResources();
    this.closed = true;
  }
}
