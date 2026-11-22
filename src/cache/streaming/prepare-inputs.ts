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

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { equal } from './encoding';
import { PrepareFacts, localRecords, type PrepareSource } from './prepare-state';
import { PreparedWorkerSnapshot } from './worker-snapshot';
import type { WorkerMergeInput, WorkerSnapshotRequirement } from './worker-merge';
import type { WorkerRequest } from './worker-service';
import type { SelectedWorkerArtifact } from './worker-download';
import { VerifiedIncoming } from './install-evidence';
import type { OwnedStore } from './owned-store';
import type { BaseObjectOptions } from './base-object';

export function prepareWorkerRequests(facts: PrepareFacts): readonly WorkerRequest[] {
  PrepareFacts.assert(facts);
  const { store, bindings } = facts,
    { model, context, role, access } = store.codec.options;
  if (access === 'read-only' || role !== 'distributed-aggregator') return [];
  const required = new Set(bindings[8][10]),
    jobs = [...required],
    snapshots = new Map<string, string[]>();
  for (const p of model.partitions)
    if (p[3] === 'single-writer' && p[4] !== null && p[4] !== context[4]) {
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
export function selectedWorkers(facts: PrepareFacts): readonly SelectedWorkerArtifact[] {
  PrepareFacts.assert(facts);
  const selection = facts.selection;
  if (!selection || selection[6][0] !== 'selected')
    throw new Error('Worker discovery is not frozen.');
  const requests = prepareWorkerRequests(facts),
    selected = selection[6][1];
  let last = -1;
  for (const row of selected) {
    const index = requests.findIndex((r) => r.job === row[4][4]);
    if (index <= last) throw new Error('Selected producer is not in frozen request order.');
    equal(row[5], requests[index].authorizedSnapshots, 'selected snapshot permission');
    last = index;
  }
  for (const r of requests)
    if (r.required && !selected.some((s) => s[4][4] === r.job))
      throw new Error('Missing required frozen producer.');
  return selected.map((row) => ({
    artifact: { id: row[0], name: row[1], size: row[2], digest: row[3] },
    context: row[4],
    authorizedSnapshots: row[5],
  }));
}
export function immutableWorkerInputs(facts: PrepareFacts): readonly WorkerMergeInput[] {
  const selected = selectedWorkers(facts);
  if (selected.length !== facts.producers.length)
    throw new Error('Incomplete committed producer inventory.');
  // Index the bounded producer inventory once; do not search it for every file/unit.
  const byJob = new Map(facts.producers.map((p) => [p[3][4], p]));
  return selected.map((s) => {
    const producer = byJob.get(s.context[4]);
    if (!producer) throw new Error('Missing selected immutable archive.');
    equal(
      [producer[0], producer[1], producer[3], producer[4][3]],
      [s.artifact.name, String(s.artifact.id), s.context, s.artifact.size],
      'committed artifact identity',
    );
    if (
      producer[2] !== producer[4][4] ||
      (s.artifact.digest !== null && s.artifact.digest !== 'sha256:' + producer[4][4])
    )
      throw new Error('Committed artifact transport differs.');
    return {
      job: s.context[4],
      context: s.context,
      authorizedSnapshots: s.authorizedSnapshots,
      producerId: String(s.artifact.id),
      source: Readable.from(facts.store.read(producer[4], 'worker-archive'), {
        objectMode: false,
        highWaterMark: 65536,
      }),
    };
  });
}
export async function emptyInstallInput(
  store: OwnedStore,
  partition: string,
  options: BaseObjectOptions,
) {
  const root = store.prefix + 'install/' + partition;
  await store.makeParents(root + '/pending');
  const native = (await store.root.stat(root))!;
  const evidence = await store.writeStream(
    'native-evidence',
    { ...options, partition },
    localRecords([['directory', '', native]]),
    options.signal,
  );
  return VerifiedIncoming.verify(
    store,
    {
      partition,
      nativeRoot: root,
      evidence,
      origin: 'trusted-base',
      finishVerification: async (binding) => binding,
    },
    options,
  );
}
export async function emptyPrepareSnapshot(facts: PrepareFacts, partition: string) {
  PrepareFacts.assert(facts);
  const { selection, store, options } = facts;
  if (
    !selection ||
    (selection[5][0] !== 'miss' &&
      !(selection[5][0] === 'pinned' && selection[7]?.includes(partition)))
  )
    throw new Error('Empty prepared snapshot requires committed miss/cold evidence.');
  const origin =
    selection[5][0] === 'miss'
      ? 'miss:' + store.codec.options.invocation
      : 'cold:' + selection[5][1];
  const root = store.prefix + 'snapshots/' + randomUUID() + '/' + partition;
  await store.makeParents(root + '/pending');
  const native = (await store.root.stat(root))!;
  const evidence = await store.writeStream(
    'native-evidence',
    { ...options, partition },
    localRecords([['directory', '', native]]),
    options.signal,
  );
  return PreparedWorkerSnapshot.verify(
    store,
    {
      partition,
      nativeRoot: root,
      evidence,
      provenance: origin,
      origin: 'baseline',
      finishVerification: async (binding, signal) => {
        signal.throwIfAborted();
        equal(await store.state(), facts.state, 'empty snapshot selection');
        return binding;
      },
    },
    options.budget,
    options,
  );
}
export async function reopenPrepareSnapshots(facts: PrepareFacts) {
  const result: PreparedWorkerSnapshot[] = [];
  for (const source of facts.sources) {
    if (source[1] === 'local-writer') throw new Error('Local snapshot in prepare authority.');
    result.push(
      await PreparedWorkerSnapshot.verify(
        facts.store,
        {
          partition: source[0],
          origin: source[1],
          provenance: source[2][1],
          evidence: source[3],
          nativeRoot: source[4],
          finishVerification: async (binding, signal) => {
            signal.throwIfAborted();
            equal(await facts.store.state(), facts.state, 'retained snapshot owner');
            return binding;
          },
        },
        facts.options.budget,
        facts.options,
      ),
    );
  }
  return result;
}
export function snapshotSource(snapshot: PreparedWorkerSnapshot): PrepareSource {
  PreparedWorkerSnapshot.assertReceipt(snapshot, snapshot.store, snapshot.partition);
  return snapshot.store.codec.schemas.source.parse([
    snapshot.partition,
    snapshot.origin,
    [snapshot.origin, snapshot.provenance],
    snapshot.evidence,
    snapshot.nativeRoot,
  ]);
}
export function snapshotRequirements(
  facts: PrepareFacts,
  snapshots: readonly PreparedWorkerSnapshot[],
): readonly WorkerSnapshotRequirement[] {
  const required = new Set(facts.bindings[8][10]),
    byPartition = new Map(snapshots.map((s) => [s.partition, s]));
  return facts.store.codec.options.model.partitions
    .filter((p) => p[3] === 'single-writer')
    .map((p) => {
      const job = p[4] ?? facts.store.codec.options.context[4];
      return { partition: p[0], job, required: required.has(job), baseline: byPartition.get(p[0]) };
    });
}
