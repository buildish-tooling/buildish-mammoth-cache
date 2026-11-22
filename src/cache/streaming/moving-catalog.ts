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

import { unlink } from 'node:fs/promises';
import type { FrozenMovingPublication } from './base-moving-publication';
import { type MovingCell } from './base-moving-publication';
import { equal, type Value } from './encoding';
import { sameNative } from './native';
import { relocationLog } from './relocation-log';
import type { Reference } from './owned-store';

// P-bounded control table replacement, not a file catalogue or per-root checkpoint.
export async function updateMovingCatalog(
  pub: FrozenMovingPublication,
  change: (cells: MovingCell[]) => void,
  phase?: 'sources-returned' | 'object-saved',
) {
  const catalog = await pub.cells(),
    before = await pub.state();
  try {
    change(catalog.rows);
    const q = await pub.store.writeStream(
      'partition-state',
      { ...pub.options, partition: null },
      (async function* () {
        yield* catalog.rows;
      })(),
      pub.options.signal,
    );
    await pub.store.fail('moving-catalog-candidate');
    equal(await pub.state(), before, 'unchanged moving catalog root');
    before[3]++;
    if (phase) before[4] = phase;
    const previous = before[9]!;
    before[9] = pub.store.codec.schemas.ref('partition-state').parse(q);
    await pub.store.updateState(before);
    await pub.store.fail('moving-catalog-pointer');
    return previous;
  } finally {
    catalog.release();
  }
}
function contains(value: Value, ref: Reference): boolean {
  return (
    Array.isArray(value) &&
    ((value[0] === 'ref' && value[2] === ref[2]) || value.some((v) => contains(v, ref)))
  );
}
export async function retireMovingMetadata(
  pub: FrozenMovingPublication,
  partition: string,
  reference: Reference,
) {
  if (!['partition-state', 'adjustments', 'stage-evidence'].includes(reference[1]))
    throw new Error('Not moving-owned retirement metadata.');
  const ref = pub.store.codec.schemas.ref(reference[1]).parse(reference),
    state = await pub.state();
  if (contains(state, ref)) throw new Error('Moving metadata remains root referenced.');
  if (ref[1] !== 'partition-state') {
    const catalog = await pub.cells();
    try {
      if (catalog.rows.some((c) => contains(c, ref)))
        throw new Error('Moving metadata remains catalog referenced.');
    } finally {
      catalog.release();
    }
    const marker = await pub.store.readFixed(
      pub.store.prefix + 'relocation/' + partition + '.json',
    );
    if (marker && contains(marker, ref)) throw new Error('Moving metadata still has an owner.');
  }
  const native = await pub.store.root.stat(ref[2]);
  if (!native) return;
  for await (const bytes of pub.store.read(ref, ref[1])) {
    pub.options.signal?.throwIfAborted();
    void bytes;
  }
  const after = await pub.store.root.stat(ref[2]);
  if (!after || !sameNative(native, after, true))
    throw new Error('Moving retirement bytes changed.');
  equal(await pub.state(), state, 'retirement root pointer');
  await unlink(pub.store.root.resolve(ref[2]));
  pub.store.root.work.unlinks++;
}
export async function retireReturnedPrefixes(pub: FrozenMovingPublication, value: Value) {
  const marker = pub.store.codec.schemas.documents.relocation.parse(value),
    p = marker[3];
  if (
    marker[7] !== 'sources-returned' ||
    (await pub.store.readFixed(pub.store.prefix + 'relocation/' + p + '.json'))
  )
    throw new Error('Prefix still owned.');
  const cells = await pub.cells();
  try {
    const cell = cells.rows.find((c) => c[1] === p)!;
    equal(cell[3], marker[13], 'returned adjustment pointer');
    if (cell[6] !== null) throw new Error('Returned marker hint remains.');
  } finally {
    cells.release();
  }
  for (const prefix of [marker[11], marker[12]])
    if (prefix) {
      const native = await pub.store.root.stat(prefix[2]);
      if (!native) continue;
      const checked = await relocationLog(pub.store, prefix, p, pub.options);
      await checked.close();
      const after = await pub.store.root.stat(prefix[2]);
      if (!after || !sameNative(native, after, true)) throw new Error('Retired prefix changed.');
      await unlink(pub.store.root.resolve(prefix[2]));
      pub.store.root.work.unlinks++;
    }
}
export async function movingMarker(pub: FrozenMovingPublication) {
  let found: ReturnType<typeof pub.store.codec.schemas.documents.relocation.parse> | null = null;
  for (const choice of pub.choices) {
    const raw = await pub.store.readFixed(pub.store.prefix + 'relocation/' + choice[1] + '.json');
    if (!raw) continue;
    const marker = pub.store.codec.schemas.documents.relocation.parse(raw);
    if (choice[0] !== 'new' || found) throw new Error('Unexpected concurrent moving ownership.');
    equal(marker[5], choice[6], 'discoverable frozen relocation plan');
    found = marker;
  }
  await pub.store.assertNoIntents(found ?? undefined);
  return found;
}
