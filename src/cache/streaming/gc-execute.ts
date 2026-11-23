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

import { mkdir, unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tuple, canonical, type Value } from './encoding';
import { sameNative, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import { InstallParentPhase } from './install-parent-phase';
import { retireOwnedDirectory } from './owned-retirement';
import { GcProgram, type GcCursor, type GcBatch } from './gc-program';
import { ObservationIndex } from './observation-index';
import { claimCapturedObservationIndex } from './observation-capture';
import type { PostAttempt } from './lifecycle-attempt';
import type { OwnedStore } from './owned-store';
import { settleNativeCleanup, type NativeOperationOptions } from './native-operation';
export interface GcOptions extends NativeOperationOptions {
  readonly batchOperations?: number;
  readonly batchBytes?: number;
}
const defaultSignal = () => new AbortController().signal;

async function finishBatch(store: OwnedStore, phase: InstallParentPhase, signal: AbortSignal) {
  signal.throwIfAborted();
  await phase.barrier();
  signal.throwIfAborted();
  await store.fail('gc-deletions-durable');
}

async function apply(
  store: OwnedStore,
  evidence: AsyncIterable<Value>,
  index: ObservationIndex,
  phase: InstallParentPhase,
) {
  const signal = index.options.signal ?? defaultSignal();
  let marker: { row: readonly Value[]; release: () => void } | undefined;
  let maven = false;
  const target = async (r: readonly Value[]) => {
    signal.throwIfAborted();
    const path = String(r[1]),
      expected = r[3] as NativeIdentity;
    let actual = await phase.stat(path);
    if (!actual) throw new Error('Frozen GC target disappeared.');
    if (expected[2] === 'directory') {
      await phase.parents(path + '/pending'); // Checks own attributed child-directory changes before popping it.
      actual = await phase.stat(path);
      if (!actual || !sameDirectoryObject(expected, actual))
        throw new Error('GC cleanup directory changed.');
    } else if (!sameNative(expected, actual, true)) throw new Error('GC target replaced/changed.');
    await phase.parents(path);
    const now = await phase.stat(path);
    if (!now || !sameNative(actual, now, true)) throw new Error('GC target changed before unlink.');
    signal.throwIfAborted();
    if (expected[2] === 'directory') {
      await rmdir(store.root.resolve(path));
      store.root.work.directoryRemovals++;
    } else {
      await unlink(store.root.resolve(path));
      store.root.work.unlinks++;
    }
    await store.fail('gc-target-deleted');
    await phase.changed(path);
  };
  try {
    for await (const item of evidence) {
      signal.throwIfAborted();
      const r = tuple(item);
      if (r[0] === 'gc-unit-open') maven = r[1] === 'maven-directory';
      if (r[0] === 'target') {
        if (maven && String(r[1]).endsWith('/_remote.repositories')) {
          if (marker) throw new Error('Multiple Maven origin markers in one unit.');
          marker = { row: r, release: index.options.budget.holdRecord(512 + canonical(r).length) };
        } else await target(r);
      } else if (r[0] === 'gc-unit-close' && marker) {
        await target(marker.row);
        marker.release();
        marker = undefined;
      }
    }
    await finishBatch(store, phase, signal);
  } finally {
    marker?.release();
  }
}

/** Direct one-process GC; only the genuine original capture can enter. */
async function run(index: ObservationIndex, input: GcOptions, attempt: PostAttempt) {
  const store = index.store,
    options = Object.freeze({
      ...input,
      signal: AbortSignal.any([attempt.signal, ...(input.signal ? [input.signal] : [])]),
    });
  await attempt.guard();
  let program: GcProgram | undefined,
    phase: InstallParentPhase | undefined,
    container: string | undefined,
    native: NativeIdentity | null = null,
    failure: unknown;
  let cursor: GcCursor | undefined;
  try {
    const limits = {
      operations: options.batchOperations,
      bytes: options.batchBytes,
    };
    if (index.hasGcSelections) program = await GcProgram.create(index, limits);
    else {
      GcProgram.validateLimits(limits);
      cursor = await index.completedWithoutGcSelections(options.signal);
    }
    container = store.prefix + 'mutation/' + randomUUID();
    await store.makeParents(container);
    await mkdir(store.root.resolve(container));
    store.root.work.directoryCreations++;
    native = await store.root.stat(container);
    await mkdir(store.root.resolve(container + '/ledger'));
    store.root.work.directoryCreations++;
    phase = new InstallParentPhase(
      store,
      '',
      container + '/ledger/',
      options.budget,
      async (path) => {
        const lease = await index.directory(path);
        try {
          return lease.node[2];
        } finally {
          lease.release();
        }
      },
      options.signal,
      { freshLedger: true },
    );
    options.signal.throwIfAborted();
    if (program) {
      for await (const value of program.batches.rows(0, program.batches.position)) {
        options.signal.throwIfAborted();
        const batch = value as GcBatch;
        await apply(store, program.evidence(batch[1], batch[2]), index, phase);
      }
      cursor = program.final;
    } else await finishBatch(store, phase, options.signal);
    await attempt.guard();
    await program?.close();
    program = undefined;
    options.signal.throwIfAborted();
  } catch (error) {
    failure = error;
  } finally {
    phase?.release();
  }
  if (failure !== undefined) {
    await settleNativeCleanup(
      [
        () => program?.close(),
        () => index.dispose(),
        () =>
          container && native
            ? retireOwnedDirectory(store, container, native, options.budget)
            : undefined,
      ],
      failure,
    );
    throw failure;
  }
  return {
    cursor: Object.freeze(cursor!),
    phase: phase!,
    container: container!,
    native: native!,
  };
}

const survivorOwners = new WeakSet<GcSurvivorOwner>();
/** Actual completed GC owns this original hierarchy and its changed-parent ledger. */
export class GcSurvivorOwner {
  #active = true;
  #readers = 0;
  private constructor(
    readonly index: ObservationIndex,
    private readonly phase: InstallParentPhase,
    private readonly container: string,
    private readonly native: NativeIdentity,
    readonly cursor: Readonly<GcCursor>,
  ) {
    survivorOwners.add(this);
    Object.freeze(this);
  }
  static async execute(index: ObservationIndex, options: GcOptions): Promise<GcSurvivorOwner> {
    ObservationIndex.assert(index);
    if (
      index.options.budget !== options.budget ||
      (index.options.maxDirectoryEntries ?? 100000) !== (options.maxDirectoryEntries ?? 100000)
    )
      throw new Error('GC survivor original capture policy/budget mismatch.');
    const attempt = claimCapturedObservationIndex(index, index.store);
    const result = await run(index, options, attempt);
    return new GcSurvivorOwner(index, result.phase, result.container, result.native, result.cursor);
  }
  static assertReceipt(owner: GcSurvivorOwner): void {
    if (!survivorOwners.has(owner)) throw new Error('Unavailable original GC survivor receipt.');
    owner.assert();
  }
  assert(): void {
    if (!survivorOwners.has(this) || !this.#active)
      throw new Error('Unavailable GC survivor owner.');
    ObservationIndex.assert(this.index);
  }
  borrow(): () => void {
    this.assert();
    this.#readers++;
    let held = true;
    return () => {
      if (held) {
        held = false;
        this.#readers--;
      }
    };
  }
  async directoryNative(path: string): Promise<NativeIdentity> {
    this.assert();
    const actual = await this.phase.effective(path);
    if (!actual) throw new Error('Missing surviving directory.');
    return actual;
  }
  changedDirectoryNative(path: string): Promise<NativeIdentity | null> {
    this.assert();
    return this.phase.changedNative(path);
  }
  async dispose(): Promise<void> {
    if (this.#readers) throw new Error('GC survivor hierarchy still borrowed.');
    if (!this.#active) return;
    this.#active = false;
    await settleNativeCleanup([
      () => this.index.dispose(),
      () =>
        retireOwnedDirectory(
          this.index.store,
          this.container,
          this.native,
          this.index.options.budget,
        ),
    ]);
  }
}
