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

import { add, equal, type Value } from './encoding';
import type { LocalStreamOptions } from './local-stream';
import type { OwnedStore, Reference } from './owned-store';

export type InstallCursor = ['cursor', string, number, number, number, null];
export interface InstallSpan {
  readonly start: InstallCursor;
  readonly end: InstallCursor;
  readonly operations: number;
  readonly bytes: number;
  readonly units: number;
}
export interface BatchTargets {
  readonly operations?: number;
  readonly bytes?: number;
}

// Protocol: docs/dev/cache-lifecycle-protocol.md#durable-replacement-and-cursors
// and #install-batches-and-recovery. All yielded spans are provisional until verified EOF.
// Admission may spool them sequentially, but cannot grant live execution early.
export async function* installUnits(
  store: OwnedStore,
  plan: Reference,
  options: Omit<LocalStreamOptions, 'codec' | 'partition'>,
  signal = new AbortController().signal,
): AsyncGenerator<InstallSpan> {
  let start: InstallCursor | undefined,
    operations = 0,
    boundary = 0;
  for await (const row of store.rows(
    plan,
    'install-plan',
    { ...options, partition: null },
    signal,
  )) {
    const value = row.value as readonly Value[];
    if (value[0] === 'install-unit-open') {
      start = ['cursor', plan[4], row.start, row.record, boundary, null];
      operations = 0;
    } else if (value[0] === 'install' || value[0] === 'install-parent')
      operations = add(operations);
    else if (value[0] === 'install-unit-close') {
      if (!start) throw new Error('Install close without open.');
      const end: InstallCursor = ['cursor', plan[4], row.end, row.record + 1, ++boundary, null];
      yield { start, end, operations, bytes: end[2] - start[2], units: 1 };
      start = undefined;
    }
  }
}

/** Candidate thresholds only. An indivisible oversized unit is never split or rejected. */
export async function* installBatches(
  units: AsyncIterable<InstallSpan>,
  targets: BatchTargets = {},
): AsyncGenerator<InstallSpan> {
  const operations = targets.operations ?? 16384,
    bytes = targets.bytes ?? 8 * 1024 * 1024;
  if (![operations, bytes].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid install batch targets.');
  let current: InstallSpan | undefined;
  for await (const unit of units) {
    if (current) {
      equal(current.end, unit.start, 'consecutive install unit cursor');
      if (
        add(current.operations, unit.operations) > operations ||
        add(current.bytes, unit.bytes) > bytes
      ) {
        yield current;
        current = undefined;
      }
    }
    current = current
      ? {
          start: current.start,
          end: unit.end,
          operations: add(current.operations, unit.operations),
          bytes: add(current.bytes, unit.bytes),
          units: add(current.units, 1),
        }
      : unit;
  }
  if (current) yield current;
}

/** Verify progress plus one pending intent's start/end in one full bound-stream read. */
export async function validateInstallCursors(
  store: OwnedStore,
  plan: Reference,
  cursors: readonly Value[],
  options: Omit<LocalStreamOptions, 'codec' | 'partition'>,
  signal = new AbortController().signal,
): Promise<InstallCursor[]> {
  if (cursors.length < 1 || cursors.length > 3)
    throw new Error('Expected bounded install cursor set.');
  const candidates = cursors.map((cursor) => store.codec.schemas.cursor.parse(cursor));
  if (candidates.some((cursor) => cursor[1] !== plan[4] || cursor[5] !== null))
    throw new Error('Install cursor binding mismatch.');
  const found = candidates.map(() => false);
  let boundary = 0;
  for await (const row of store.rows(
    plan,
    'install-plan',
    { ...options, partition: null },
    signal,
  )) {
    const value = row.value as readonly Value[];
    if (value[0] === 'install-unit-close') ++boundary;
    if (value[0] === 'install-context' || value[0] === 'install-unit-close') {
      for (let i = 0; i < candidates.length; i++) {
        const cursor = candidates[i];
        if (cursor[2] === row.end && cursor[3] === row.record + 1 && cursor[4] === boundary)
          found[i] = true;
      }
    }
  }
  if (found.some((present) => !present))
    throw new Error('Install cursor is not an actual complete-unit boundary.');
  return candidates as InstallCursor[];
}
export async function validateInstallCursor(
  store: OwnedStore,
  plan: Reference,
  cursor: Value,
  options: Omit<LocalStreamOptions, 'codec' | 'partition'>,
  signal = new AbortController().signal,
): Promise<InstallCursor> {
  return (await validateInstallCursors(store, plan, [cursor], options, signal))[0];
}
