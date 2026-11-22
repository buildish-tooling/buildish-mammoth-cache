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

import { unlink, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tuple, equal, canonical, encodeRecord, type Value } from './encoding';
import { sameNative, type NativeIdentity } from './native';
import { sameDirectoryObject } from './install-member';
import { requirePostBindings } from './post-admission';
import { InstallParentPhase } from './install-parent-phase';
import { retireOwnedDirectory } from './owned-retirement';
import { GcProgram, type GcCursor, type GcBatch } from './gc-program';
import { ObservationIndex } from './observation-index';
import { checkSharedGcMetadata } from './gc-metadata';
import { checkGcProjection, type GcProjectionWork } from './gc-projection';
import type { OwnedStore, Reference } from './owned-store';
import { settleBaseCleanup, type BaseObjectOptions } from './base-object';

export interface GcOptions extends BaseObjectOptions {
  readonly batchOperations?: number;
  readonly batchBytes?: number;
}
const defaultSignal = () => new AbortController().signal;
type Intent = ReturnType<OwnedStore['codec']['schemas']['documents']['gc-intent']['parse']>;

async function admission(store: OwnedStore, options: GcOptions, recovering: boolean) {
  options.signal?.throwIfAborted();
  const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    bindings = store.codec.schemas.documents.bindings.parse(
      await store.readDocument(state[5], 'bindings'),
    );
  await requirePostBindings(store, state, bindings, options);
  if (
    store.codec.options.access !== 'writable' ||
    !['observations-frozen', 'gc-complete'].includes(state[4]) ||
    !state[6] ||
    !state[10]
  )
    throw new Error('GC requires a bound writable frozen observation.');
  if (state[8] || state[9] || state[7] || state[11])
    throw new Error('GC cannot follow source/publication/install commitment.');
  // The caller must re-establish the exclusive cache window on every invocation.
  // A persisted quiescence document is never a lock or permission to stop a process.
  const saved = store.codec.schemas.documents['gc-progress'].parse(
    await store.readDocument(state[10], 'gc-progress'),
  );
  equal(saved[3], state[6], 'GC observations');
  const raw = await store.readFixed(store.prefix + 'gc-intent.json'),
    intent = raw ? store.codec.schemas.documents['gc-intent'].parse(raw) : null;
  await store.assertNoIntents(recovering && intent ? intent : undefined);
  if (saved[5] !== null && (!intent || saved[5] !== store.prefix + 'gc-intent.json'))
    throw new Error('Missing GC intent owner.');
  if (intent) {
    equal(intent[3], state[6], 'GC intent observations');
    if (
      !canonical(saved[4]).equals(canonical(intent[4])) &&
      !canonical(saved[4]).equals(canonical(intent[5]))
    )
      throw new Error('GC intent/progress disagreement.');
  }
  return { state, saved, intent };
}
async function commit(
  store: OwnedStore,
  observations: Reference,
  cursor: GcCursor,
  complete: boolean,
) {
  const state = store.codec.schemas.documents['local-state'].parse(await store.state()),
    old = state[10];
  equal(state[6], observations, 'unchanged GC observation');
  if (state[4] !== 'observations-frozen' && state[4] !== 'gc-complete')
    throw new Error('GC phase changed.');
  const ref = await store.writeDocument([
    'gc-progress',
    1,
    store.codec.options.invocation,
    observations,
    cursor,
    null,
  ]);
  await store.fail('gc-progress-candidate');
  state[3]++;
  state[10] = store.codec.schemas.ref('gc-progress').parse(ref);
  if (complete) state[4] = 'gc-complete';
  await store.updateState(state);
  await store.fail('gc-progress-pointer');
  if (old) await store.retireReplacedDocument(old);
}
async function retireStack(store: OwnedStore, old: GcCursor, current: GcCursor) {
  if (old[5] && old[5][2] !== current[5]?.[2]) await store.retireGcMetadata(old[5]);
}
async function apply(
  store: OwnedStore,
  evidence: Reference,
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
    if (!actual) return; // Complete original/native admission already proved this exact allowed omission.
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
    for await (const item of store.rows(
      evidence,
      'gc-evidence',
      { ...index.options, partition: null, gcMode: 'shared' },
      signal,
    )) {
      signal.throwIfAborted();
      const r = tuple(item.value);
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
    signal.throwIfAborted();
    await phase.barrier();
    signal.throwIfAborted();
    await store.fail('gc-deletions-durable');
  } finally {
    marker?.release();
  }
}
async function exactEvidence(program: GcProgram, intent: Intent) {
  let start = program.units.position,
    end = start;
  // A single sequential metadata range reconstruction on reload; never per target/batch.
  let at = 0,
    found = false;
  for await (const v of program.units.rows(0, program.units.position)) {
    const r = tuple(v),
      size = encodeRecord(v).length;
    if (Number(r[2]) > intent[4][2] && Number(r[2]) <= intent[5][2]) {
      if (!found) {
        start = at;
        found = true;
      }
      end = at + size;
    }
    at += size;
  }
  const expected = program.evidence(start, end);
  try {
    for await (const item of program.index.store.rows(
      intent[6],
      'gc-evidence',
      { ...program.index.options, partition: null, gcMode: 'shared' },
      program.index.options.signal,
    )) {
      const r = tuple(item.value);
      if (r[0] === 'local-stream' || r[0] === 'local-end') continue;
      const next = await expected.next();
      if (next.done) throw new Error('Extra active GC evidence.');
      equal(r, next.value, 'exact active GC evidence range');
    }
    if (!(await expected.next()).done) throw new Error('Incomplete active GC evidence.');
  } finally {
    await expected.return(undefined);
  }
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas.
// Recovery completes ONLY the discoverable active range. Forward execution may
// subsequently continue the frozen suffix, without recapturing policy/timestamps.
async function run(store: OwnedStore, input: GcOptions, recovering: boolean) {
  const options = Object.freeze({ ...input, signal: input.signal ?? defaultSignal() }),
    { state, saved, intent } = await admission(store, options, recovering),
    index = await ObservationIndex.open(store, state[6]!, options);
  let program: GcProgram | undefined,
    phase: InstallParentPhase | undefined,
    container: string | undefined,
    native: NativeIdentity | null = null;
  const work: GcProjectionWork = { directories: 0, entries: 0 };
  let failure: unknown;
  let completedResult:
    { cursor: GcCursor; complete: boolean; work: Readonly<GcProjectionWork> } | undefined;
  try {
    program = await GcProgram.create(
      index,
      { operations: options.batchOperations, bytes: options.batchBytes },
      [saved[4], ...(intent ? [intent[4], intent[5]] : [])],
    );
    if (intent) {
      await checkSharedGcMetadata(index, intent[6]);
      await exactEvidence(program, intent);
    }
    container = store.prefix + 'mutation/' + randomUUID();
    await store.makeParents(container + '/ledger/pending');
    native = await store.root.stat(container);
    phase = new InstallParentPhase(
      store,
      '',
      container + '/ledger/',
      options.budget,
      async () => null,
      options.signal,
    );
    const committed = intent && canonical(saved[4]).equals(canonical(intent[5]));
    await checkGcProjection(index, saved[4][2], intent ? intent[5][2] : saved[4][2], phase, work);
    options.signal.throwIfAborted();
    await phase.barrier(); // Parent checkpoints precede any recovered cursor/cleanup.
    options.signal.throwIfAborted();
    let cursor: GcCursor = saved[4];
    if (intent) {
      if (!committed) {
        await apply(store, intent[6], index, phase);
        await commit(store, index.reference, intent[5], intent[5][2] === program.final[2]);
      }
      await store.clearIntent(intent);
      await store.fail('gc-intent-retired');
      await store.retireGcMetadata(intent[6]);
      await retireStack(store, intent[4], intent[5]);
      cursor = intent[5];
    }
    if (!recovering) {
      for await (const value of program.batches.rows(0, program.batches.position)) {
        options.signal.throwIfAborted();
        const b = value as GcBatch;
        if (b[3] <= cursor[2]) continue;
        const end = await program.cursor(b);
        // The normal path follows its genuine program batches. A previous recovery
        // endpoint can cut a newly grouped batch: filter only its completed units.
        let from = b[1];
        if (cursor[2]) {
          for await (const row of program.units.rows(b[1], b[2])) {
            if (Number(tuple(row)[2]) > cursor[2]) break;
            from += encodeRecord(row).length;
          }
        }
        if (from === b[2]) {
          await commit(store, index.reference, end, end[2] === program.final[2]);
          await retireStack(store, cursor, end);
          cursor = end;
          continue;
        }
        const q = await store.writeStream(
          'gc-evidence',
          { ...options, partition: null, gcMode: 'shared' },
          program.evidence(from, b[2]),
          options.signal,
        );
        await checkSharedGcMetadata(index, q);
        await store.fail('gc-evidence-published');
        const marker = store.codec.schemas.documents['gc-intent'].parse([
          'gc-intent',
          1,
          store.codec.options.invocation,
          index.reference,
          cursor,
          end,
          q,
        ]);
        await store.publishIntent(marker);
        await store.fail('gc-intent-published');
        await apply(store, q, index, phase);
        await commit(store, index.reference, end, end[2] === program.final[2]);
        await store.clearIntent(marker);
        await store.fail('gc-intent-retired');
        await store.retireGcMetadata(q);
        await retireStack(store, cursor, end);
        cursor = end;
      }
    }
    // Final absence/projection consumer also detects recreation of completed paths.
    await checkGcProjection(index, cursor[2], cursor[2], undefined, work);
    completedResult = Object.freeze({
      cursor,
      complete: cursor[2] === program.final[2],
      work: Object.freeze(work),
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    phase?.release();
    await settleBaseCleanup(
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
  }
  options.signal.throwIfAborted();
  return completedResult!;
}
export const executeGc = (store: OwnedStore, options: GcOptions) => run(store, options, false);
export const recoverGc = (store: OwnedStore, options: GcOptions) => run(store, options, true);
