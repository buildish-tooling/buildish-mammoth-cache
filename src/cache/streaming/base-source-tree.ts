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

import { tuple, type Value } from './encoding';
import { InstallScratch } from './install-scratch';
import { NativeTreeState, type TreeSeal } from './native-tree';
import { WorkerSpool } from './worker-spool';
import {
  UnitProjection,
  isWorkspaceRoot,
  recognizedRoot,
  baseName,
  parentPath,
  joinPath,
} from './tree-state';
import { workspaceKind } from '../immutable-workspaces';
import type { Unit } from './schema';
import type { OwnedStore } from './owned-store';
import type { BaseObjectOptions } from './base-object';

// Protocol: docs/dev/native-base-protocol.md#native-tree-grammar.
// Common metadata-only complete-unit framing for prepared and moving sources.
export class BaseSourceTree {
  private unit: { descriptor: Unit; start: number; jars: boolean } | null = null;
  private units?: InstallScratch;
  private completed?: TreeSeal;
  get summary(): TreeSeal {
    if (!this.completed) throw new Error('Unsealed source tree summary.');
    return structuredClone(this.completed);
  }
  private constructor(
    readonly store: OwnedStore,
    readonly partition: string,
    readonly events: WorkerSpool,
    readonly options: BaseObjectOptions,
    private readonly projection: NativeTreeState,
  ) {}
  static async create(store: OwnedStore, partition: string, options: BaseObjectOptions) {
    const projection = new NativeTreeState({
      ...options,
      model: store.codec.options.model,
      partition,
    });
    try {
      return new BaseSourceTree(
        store,
        partition,
        await WorkerSpool.create(store, options.budget),
        options,
        projection,
      );
    } catch (error) {
      projection.dispose();
      throw error;
    }
  }

  private emit(row: Value, signal: AbortSignal): void | Promise<void> {
    signal.throwIfAborted();
    this.projection.accept(row);
    if (!this.events.tryAppend(row, signal)) return this.events.append(row, signal);
  }
  private async append(row: Value, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.unit) {
      if (this.units!.tryAppend(row) === null) await this.units!.append(row);
    } else await this.emit(row, signal);
    signal.throwIfAborted();
  }
  private async begin(descriptor: Unit) {
    this.units ??= await InstallScratch.create(this.store, this.options.budget);
    return { descriptor, start: this.units.position, jars: false };
  }
  private async closeUnit(signal: AbortSignal) {
    if (!this.unit) return;
    const u = this.unit,
      model = this.store.codec.options.model;
    if (u.descriptor[2] === 'subtree')
      u.descriptor[0] = workspaceKind(
        u.descriptor[1],
        u.jars ? [u.descriptor[1] + '/classes.jar'] : [],
      );
    const projection = new UnitProjection(model, u.descriptor, false, this.partition);
    const end = this.units!.position;
    let current = u.descriptor[1];
    for await (const batch of this.units!.batches(u.start, end, signal))
      for (const value of batch) {
        signal.throwIfAborted();
        const r = tuple(value.value);
        if (r[0] === 'dir-open') {
          current = String(r[1]);
          projection.directory(current, 'open');
        } else if (r[0] === 'dir-close') {
          projection.directory(current, 'close');
          current = parentPath(current);
        } else
          projection.file(
            joinPath(current, String(r[1])),
            this.partition,
            Number(r[2]),
            Number(r[3]),
            Number(r[4]),
            String(r[5]),
          );
      }
    const s = projection.finish();
    await this.emit(
      ['unit-open', ...u.descriptor, 'partition-projection', s.counts, s.semantic, s.comparison],
      signal,
    );
    for await (const batch of this.units!.batches(u.start, end, signal))
      for (const row of batch) {
        const write = this.emit(row.value, signal);
        if (write) await write;
      }
    await this.emit(
      ['unit-close', u.descriptor[0], u.descriptor[1], s.counts, s.semantic, s.comparison],
      signal,
    );
    this.unit = null;
  }
  async open(path: string, signal: AbortSignal) {
    if (this.unit?.descriptor[2] === 'direct') await this.closeUnit(signal);
    await this.append(['dir-open', path], signal);
    if (!this.unit && isWorkspaceRoot(this.store.codec.options.model, path))
      this.unit = await this.begin([workspaceKind(path), path, 'subtree']);
  }
  async close(path: string, signal: AbortSignal) {
    if (this.unit?.descriptor[1] === path) await this.closeUnit(signal);
    await this.append(['dir-close', path], signal);
  }
  async file(
    path: string,
    size: number,
    mode: number,
    mtime: number,
    sha: string,
    signal: AbortSignal,
  ) {
    const model = this.store.codec.options.model;
    if (model.owner(path)[0] !== this.partition) throw new Error('Wrong source tree owner.');
    if (!this.unit && recognizedRoot(model, path) !== null) {
      if (model.tuple[2] !== 'maven') throw new Error('Missing native workspace root.');
      this.unit = await this.begin(['maven-directory', parentPath(path), 'direct']);
    }
    if (
      this.unit &&
      (path === this.unit.descriptor[1] + '/classes.jar' ||
        path === this.unit.descriptor[1] + '/sources.jar')
    )
      this.unit.jars = true;
    await this.append(['file', baseName(path), size, mode, mtime, sha], signal);
  }
  async seal(signal: AbortSignal) {
    if (this.unit) throw new Error('Unclosed source tree unit.');
    // Units share one unpublished backing file. Check its original identity once
    // before completed events escape; never create/read a separate file per unit.
    await this.units?.assertStable();
    await this.units?.close();
    this.units = undefined;
    signal.throwIfAborted();
    this.projection.accept(this.projection.end());
    this.completed = this.projection.finish();
    this.events.seal(signal);
  }
  async disposeUnit() {
    this.projection.dispose();
    await this.units?.close();
    this.units = undefined;
    this.unit = null;
  }
}
