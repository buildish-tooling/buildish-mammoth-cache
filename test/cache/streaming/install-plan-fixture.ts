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

import {
  createMetadataGeneration,
  createMetadataDescriptor,
} from '../../../src/cache/streaming/metadata-base-records';
import { MetadataInstallContext } from '../../../src/cache/streaming/metadata-install-context';
import { freezeMetadataInstallPlan } from '../../../src/cache/streaming/install-plan';
import type { OwnedStore } from '../../../src/cache/streaming/owned-store';
import type { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import type { ObjectRef, GenerationEntry } from '../../../src/cache/streaming/native-records';
export { assertFrozenInstall, type FrozenInstall } from '../../../src/cache/streaming/install-plan';
const contexts = new WeakMap<OwnedStore, Set<MetadataInstallContext>>();
export async function closeFixtureInstallPlans(store: OwnedStore): Promise<void> {
  const values = contexts.get(store);
  contexts.delete(store);
  for (const context of values ?? []) await context.dispose();
}
export interface FixtureIncoming {
  partition: string;
  nativeRoot: string;
  objectRoot: string;
  reference: ObjectRef;
}
/** Test offers are data until the actual one-pass metadata admission, exactly like completed SDK extraction. */
export async function freezeInstallPlan(
  store: OwnedStore,
  offers: readonly FixtureIncoming[],
  budget: WorkingBudget,
  options: { signal?: AbortSignal; maxDirectoryEntries?: number; pruneAggregates?: boolean } = {},
) {
  if (new Set(offers.map((offer) => offer.partition)).size !== offers.length)
    throw new Error('Duplicate source partition projection.');
  const model = store.codec.options.model;
  const entries: GenerationEntry[] = model.partitions.map((p) => {
    const offer = offers.find((offer) => offer.partition === p[0]);
    const reference =
      offer?.reference ??
      createMetadataDescriptor(model, [
        model.family,
        model.id,
        p[0],
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
      ]).reference;
    return ['object', p[0], reference];
  });
  const generation = createMetadataGeneration(
    model,
    'a'.repeat(64),
    'b'.repeat(64),
    'c'.repeat(64),
    entries,
    model.partitions.map((p) => [p[0]]),
  );
  const context = await MetadataInstallContext.discover(
    store,
    generation,
    offers.map((offer) => ({ partition: offer.partition, root: offer.objectRoot })),
    { budget, ...options },
  );
  if (!contexts.has(store)) contexts.set(store, new Set());
  contexts.get(store)!.add(context);
  return freezeMetadataInstallPlan(store, context, budget, options);
}
