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

import { timed } from '../../util/timing';
import { OpenedInvocation, type InvocationAnchor } from './invocation';
import type { LifecycleOptions } from './lifecycle-options';
import { PostAttempt } from './lifecycle-attempt';
import { captureObservations } from './observation-capture';
import type { ObservationIndex } from './observation-index';
import { GcSurvivorOwner } from './gc-execute';
import {
  freezeWorkerArtifact,
  uploadWorkerArtifact,
  WorkerUploadUnconfirmed,
} from './worker-service';
import type { Failpoint } from './native';
import type { WorkflowArtifactBackend } from '../../delta/backend';
import type { PartitionSummaries } from './partition-summaries';
import { settleNativeCleanup } from './native-operation';

export interface WorkerPostRequest extends LifecycleOptions {
  readonly anchor: InvocationAnchor;
  readonly fail?: Failpoint;
  readonly removeHooks?: () => Promise<void>;
  readonly artifactBackend: () => Promise<WorkflowArtifactBackend>;
  readonly summaries?: PartitionSummaries;
  readonly onCaptureInfo?: (message: string) => void;
  readonly onWarning?: (message: string) => void;
}
/** One fresh post operation; no source/package pointer can authorize replay or upload retry. */
export async function postStreamingWorker(input: WorkerPostRequest) {
  const opened = await OpenedInvocation.open(input.anchor, input.budget, input.cleanupSignal),
    request = Object.freeze({ ...input, maxDirectoryEntries: opened.bindings[8][9] }),
    attempt = await PostAttempt.open(opened, request),
    store = attempt.store;
  let captured: ObservationIndex | undefined, owner: GcSurvivorOwner | undefined;
  let failure: unknown,
    answer: { outcome: 'abandoned' } | { outcome: 'worker-uploaded'; name: string } | undefined;
  try {
    if (
      store.codec.options.role !== 'distributed-worker' ||
      store.codec.options.access !== 'writable'
    )
      throw new Error('Worker post requires writable worker role.');
    if (attempt.state[4] === 'completed') {
      const terminal = attempt.state[7]!;
      if (terminal[1] !== 'abandoned' && terminal[1] !== 'worker-uploaded')
        throw new Error('Worker has no completion artifact.');
      await attempt.guard();
      answer =
        terminal[1] === 'abandoned'
          ? { outcome: 'abandoned' }
          : { outcome: 'worker-uploaded', name: terminal[4]! };
    } else {
      const options = { ...request, signal: attempt.signal, attempt };
      await request.removeHooks?.();
      await attempt.guard();
      const observation = await timed(options, 'observation capture and index construction', () =>
        captureObservations(store, {
          ...options,
          retainIndex: true,
          summaries: request.summaries,
        }),
      );
      captured = observation.index!;
      let backend: WorkflowArtifactBackend | undefined;
      try {
        backend = await request.artifactBackend();
      } catch {
        /* outgoing provider unavailable */
      }
      if (
        !backend ||
        !backend.capabilities.supportsRawWorkerArchives ||
        !backend.capabilities.supportsRetentionDays
      ) {
        request.onWarning?.(
          'Worker publication abandoned: raw upload/retention backend unavailable.',
        );
        await captured.dispose();
        captured = undefined;
        await attempt.finish(['outcome', 'abandoned', null, null, null]);
        answer = { outcome: 'abandoned' };
      } else {
        owner = await timed(options, 'GC', () => GcSurvivorOwner.execute(captured!, options));
        captured = undefined;
        const archive = await timed(options, 'worker package construction', () =>
          freezeWorkerArtifact(backend, store, { survivors: owner! }, request.budget, options),
        );
        await attempt.guard();
        let receipt: Awaited<ReturnType<typeof uploadWorkerArtifact>> | undefined;
        try {
          receipt = await timed(
            options,
            'outgoing worker SDK save',
            () =>
              uploadWorkerArtifact(backend, archive, {
                signal: attempt.signal,
                retentionDays: attempt.handoff.header[5],
              }),
            () => 'confirmed',
            (e) =>
              e instanceof WorkerUploadUnconfirmed
                ? 'abandoned/unconfirmed'
                : options.signal?.aborted
                  ? 'cancelled'
                  : 'failed',
          );
        } catch (error) {
          if (!(error instanceof WorkerUploadUnconfirmed)) throw error;
          request.onWarning?.(error.message);
        }
        if (receipt) {
          await attempt.guard();
          await timed(
            { timing: request.timing, signal: request.cleanupSignal },
            'worker package retirement',
            () => archive.retireUploaded(),
          );
          await owner.dispose();
          owner = undefined;
          await attempt.finish([
            'outcome',
            'worker-uploaded',
            null,
            receipt.artifact.id,
            receipt.artifact.name,
          ]);
          answer = { outcome: 'worker-uploaded', name: receipt.artifact.name };
        } else {
          await owner.dispose();
          owner = undefined;
          await attempt.finish(['outcome', 'abandoned', null, null, null]);
          answer = { outcome: 'abandoned' };
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    await timed(request, 'cleanup and retirement', () =>
      settleNativeCleanup([() => owner?.dispose(), () => captured?.dispose()], failure),
    );
  } finally {
    attempt.close();
  }
  if (failure !== undefined) throw failure;
  return answer!;
}
