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

import { OpenedInvocation, type InvocationAnchor } from './invocation';
import { reconcileInvocation, type RecoveryOptions } from './recovery';
import { PrepareFacts, localRecords } from './prepare-state';
import { assertLifecycleWindow } from './post-admission';
import { captureObservations } from './observation-capture';
import { executeGc } from './gc-execute';
import { freezeWorkerArtifact, uploadWorkerArtifact } from './worker-service';
import { rawWorkerBackend } from './worker-artifact-identity';
import { FrozenWorkerArchive } from './worker-package';
import type { Failpoint } from './native';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { PartitionSummaries } from './partition-summaries';

export interface WorkerPostRequest extends RecoveryOptions {
  readonly anchor: InvocationAnchor;
  readonly fail?: Failpoint;
  readonly removeHooks?: () => Promise<void>;
  readonly artifactBackend: () => Promise<WorkflowArtifactBackend>;
  readonly summaries?: PartitionSummaries;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#object-and-worker-receipts.
export async function postStreamingWorker(input: WorkerPostRequest) {
  const caller = Object.freeze({ ...input }),
    opened = await OpenedInvocation.open(caller.anchor, caller.budget, caller.cleanupSignal),
    request = Object.freeze({ ...caller, maxDirectoryEntries: opened.bindings[8][9] }),
    store = await reconcileInvocation(opened, 'resume', request),
    facts = await PrepareFacts.open(store, request);
  try {
    if (
      store.codec.options.role !== 'distributed-worker' ||
      store.codec.options.access !== 'writable'
    )
      throw new Error('Worker post requires writable worker role.');
    if (!facts.selection) throw new Error('Missing frozen prepare selection.');
    const guard = () => assertLifecycleWindow(store, facts.bindings, request);
    if (facts.state[4] === 'completed') {
      await guard();
      if (facts.state[14] !== 'worker-uploaded')
        throw new Error('Worker has no completion artifact.');
      return { outcome: 'worker-uploaded' as const, name: facts.state[12]![1] };
    }
    if (facts.state[4] === 'worker-uploaded') {
      await guard();
      await store.assertNoIntents();
      const state = store.codec.schemas.documents['local-state'].parse(await store.state());
      state[3]++;
      state[4] = 'completed';
      state[14] = 'worker-uploaded';
      await store.updateState(state);
      await guard();
      return { outcome: 'worker-uploaded' as const, name: state[12]![1] };
    }
    if (facts.state[4] === 'prepare-pending') {
      await reconcileInvocation(
        await OpenedInvocation.open(request.anchor, request.budget),
        'abandon',
        request,
      );
      throw new Error('Worker cannot upload failed prepare.');
    }
    await guard();
    if (!facts.state[6]) {
      await request.removeHooks?.();
      await guard();
      await captureObservations(store, { ...request, summaries: request.summaries });
    }
    // Raw/retention capability admission follows observation freeze, precedes GC/body traversal.
    const backend = await request.artifactBackend();
    rawWorkerBackend(backend);
    if (!backend.capabilities.supportsRetentionDays)
      throw new Error('Worker backend lacks requested retention support.');
    await guard();
    let state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (state[4] === 'observations-frozen') {
      await executeGc(store, request);
      state = store.codec.schemas.documents['local-state'].parse(await store.state());
    }
    let archive: FrozenWorkerArchive;
    if (state[4] === 'gc-complete') {
      if (!state[7]) {
        const rows = store.codec.options.model.partitions
          .filter((p) => p[3] === 'single-writer' && p[4] === store.codec.options.context[4])
          .map((p) => ['worker-snapshot', p[0], state[6]]);
        const sources = await store.writeStream(
          'worker-sources',
          { ...request, partition: null },
          localRecords(rows),
          request.signal,
        );
        await guard();
        state[3]++;
        state[7] = store.codec.schemas.ref('worker-sources').parse(sources);
        await store.updateState(state);
        await store.fail('worker-sources-pointer');
      }
      await guard();
      archive = await freezeWorkerArtifact(
        backend,
        store,
        { observations: state[6]!, gcProgress: state[10], workerSources: state[7]! },
        request.budget,
        request,
      );
      await guard();
      state[3]++;
      state[4] = 'package-frozen';
      state[12] = [
        store.codec.schemas.ref('worker-archive').parse(archive.reference),
        archive.name,
        archive.sha,
        null,
      ];
      await request.fail?.('worker-package-before-pointer');
      await store.updateState(state);
      await store.fail('worker-package-pointer');
      await request.fail?.('worker-package-pointer');
    } else archive = await FrozenWorkerArchive.reopen(store, request.budget, request);
    await guard();
    state = store.codec.schemas.documents['local-state'].parse(await store.state());
    if (!state[12]![3]) {
      const receipt = await uploadWorkerArtifact(backend, archive, {
        signal: request.signal,
        retentionDays: facts.selection[4][3],
      });
      await guard();
      state[3]++;
      state[4] = 'worker-uploaded';
      state[12]![3] = [
        'artifact-receipt',
        String(receipt.artifact.id),
        receipt.artifact.name,
        archive.sha,
      ];
      await store.updateState(state);
      await store.fail('worker-receipt-pointer');
      await request.fail?.('worker-receipt-pointer');
    }
    await guard();
    await store.assertNoIntents();
    state[3]++;
    state[4] = 'completed';
    state[14] = 'worker-uploaded';
    await store.updateState(state);
    await guard();
    return { outcome: 'worker-uploaded' as const, name: archive.name };
  } finally {
    facts.close();
  }
}
