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

import { ownsLocalSnapshot } from './model';
import type { MetadataSnapshot } from './metadata-snapshot';
import type { Policy } from './local-schema';
import type { OwnedStore } from './owned-store';
import type { WorkerRequest } from './worker-service';
import type { WorkerSnapshotRequirement } from './worker-merge';

export function metadataWorkerRequests(
  store: OwnedStore,
  policy: Policy,
): readonly WorkerRequest[] {
  const { model, context, role, access } = store.codec.options;
  if (access === 'read-only' || role !== 'distributed-aggregator') return [];
  const required = new Set(policy[10]),
    jobs = [...required],
    snapshots = new Map<string, string[]>();
  for (const p of model.partitions)
    if (p[3] === 'single-writer' && p[4] !== null && !ownsLocalSnapshot(p, store.codec.options)) {
      if (!snapshots.has(p[4])) snapshots.set(p[4], []);
      snapshots.get(p[4])!.push(p[0]);
      if (!jobs.includes(p[4])) jobs.push(p[4]);
    }
  if (jobs.length > 16 || jobs.includes(context[4]))
    throw new Error('Invalid prepare producer requests.');
  return jobs.map((job) => ({
    job,
    required: required.has(job),
    authorizedSnapshots: snapshots.get(job) ?? [],
  }));
}
export function metadataSnapshotRequirements(
  store: OwnedStore,
  required: ReadonlySet<string>,
  snapshots: ReadonlyMap<string, MetadataSnapshot>,
): readonly WorkerSnapshotRequirement[] {
  return store.codec.options.model.partitions
    .filter(
      (p) =>
        p[3] === 'single-writer' && p[4] !== null && !ownsLocalSnapshot(p, store.codec.options),
    )
    .map((p) => ({
      partition: p[0],
      job: p[4]!,
      required: required.has(p[4]!),
      baseline: snapshots.get(p[0]),
    }));
}
