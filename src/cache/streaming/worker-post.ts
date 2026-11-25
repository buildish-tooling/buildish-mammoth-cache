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

import { ExclusiveWindow } from './quiescence';
import { retireGradleSeed, gradleSeedPath, validateGradleSeedOwner } from './gradle-layer';
import { projectOverlay, retireOverlay, verifyOverlay, type OverlayCapture } from './overlay';
import { gradleOverlayCapture } from './gradle-overlay';
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
  const [, , , , , , , , , , , , seed, overlay] = attempt.handoff.header;
  let overlayCapture: OverlayCapture | undefined;
  let clearProjection: (() => void) | undefined;
  let overlayRetired = false;
  let overlayRetirementStarted = false;
  let seedSettled = false,
    settledConsumers = false;
  const clearCapture = () => {
    clearProjection?.();
    clearProjection = undefined;
    overlayCapture?.dispose();
    overlayCapture = undefined;
  };
  const finish = async (terminal: Parameters<PostAttempt['finish']>[0]) => {
    clearCapture();
    if (overlay) {
      attempt.assert();
      overlayRetirementStarted = true;
      await retireOverlay(store, overlay, request.overlayMount!);
      overlayRetired = true;
    }
    if (seed && !seedSettled) {
      attempt.assert();
      await retireGradleSeed(store, seed, request);
      seedSettled = true;
    }
    await attempt.finish(terminal);
  };
  let failure: unknown,
    answer: { outcome: 'abandoned' } | { outcome: 'worker-uploaded'; name: string } | undefined;
  try {
    if (
      store.codec.options.role !== 'distributed-worker' ||
      store.codec.options.access !== 'writable'
    ) {
      throw new Error('Worker post requires writable worker role.');
    }
    if (attempt.state[4] === 'completed') {
      const terminal = attempt.state[7]!;
      if (terminal[1] !== 'abandoned' && terminal[1] !== 'worker-uploaded') {
        throw new Error('Worker has no completion artifact.');
      }
      await attempt.guard();
      answer =
        terminal[1] === 'abandoned'
          ? { outcome: 'abandoned' }
          : { outcome: 'worker-uploaded', name: terminal[4]! };
    } else {
      if (seed || overlay) {
        if (seed) {
          await validateGradleSeedOwner(store, seed);
        }
        if (overlay) {
          if (!request.overlayMount) {
            throw new Error('OverlayFS mount driver unavailable in post.');
          }
          await verifyOverlay(store, overlay, request.overlayMount);
        }
        const gate = await ExclusiveWindow.establish(store, request.budget, {
          ...request,
          layeredWorker: attempt.handoff,
        });
        if (gate.status !== 'ready') {
          throw new Error(
            'Layer consumers could not settle; ' +
              (seed
                ? 'seed retained at ' + gradleSeedPath(store, seed)
                : 'OverlayFS state retained at ' + store.root.resolve(overlay![2])) +
              ': ' +
              gate.message,
          );
        }
        attempt.attachWindow(gate.window);
        settledConsumers = true;
      }
      const options = { ...request, signal: attempt.signal, attempt };
      await request.removeHooks?.();
      await attempt.guard();
      if (overlay) {
        await verifyOverlay(store, overlay, request.overlayMount!);
        overlayCapture = await gradleOverlayCapture(
          store,
          overlay,
          request.budget,
          request.maxDirectoryEntries,
          attempt.signal,
        );
        clearProjection = projectOverlay(store, overlay, overlayCapture.useMerged);
      }
      const observation = await timed(options, 'observation capture and index construction', () =>
        captureObservations(store, {
          ...options,
          retainIndex: true,
          summaries: request.summaries,
          overlayCapture,
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
        await finish(['outcome', 'abandoned', null, null, null]);
        answer = { outcome: 'abandoned' };
      } else {
        owner = await timed(options, 'GC', () => GcSurvivorOwner.execute(captured!, options));
        captured = undefined;
        const archive = await timed(options, 'worker package construction', () =>
          freezeWorkerArtifact(
            backend,
            store,
            { survivors: owner!, incompleteUsage: !!overlayCapture },
            request.budget,
            options,
          ),
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
          if (!(error instanceof WorkerUploadUnconfirmed)) {
            throw error;
          }
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
          await finish([
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
          await finish(['outcome', 'abandoned', null, null, null]);
          answer = { outcome: 'abandoned' };
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined && seed && !seedSettled) {
    if (settledConsumers) {
      try {
        attempt.assert();
        await retireGradleSeed(store, seed, request);
        seedSettled = true;
      } catch (cleanup) {
        failure = new AggregateError(
          [failure, cleanup],
          'Gradle seed retained at ' + gradleSeedPath(store, seed),
        );
      }
    }
    if (!seedSettled) {
      const message = 'Gradle seed retained at ' + gradleSeedPath(store, seed);
      try {
        request.onWarning?.(message);
      } catch (report) {
        failure = new AggregateError([failure, report], message);
      }
    }
  }
  try {
    await timed(request, 'cleanup and retirement', () =>
      settleNativeCleanup(
        [
          () => owner?.dispose(),
          () => captured?.dispose(),
          clearCapture,
          async () => {
            if (failure !== undefined && overlay && !overlayRetirementStarted && settledConsumers) {
              attempt.assert();
              await retireOverlay(store, overlay, request.overlayMount!);
              overlayRetired = true;
            }
          },
        ],
        failure,
      ),
    );
  } finally {
    try {
      if (failure !== undefined && overlay && !overlayRetired) {
        request.onWarning?.('OverlayFS state retained at ' + store.root.resolve(overlay[2]));
      }
    } finally {
      attempt.close();
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  return answer!;
}

/** Failed main may have exposed a live layer to later steps. Owning post settles it without capture or upload. */
export async function postFailedPrepareLayer(
  input: LifecycleOptions & {
    readonly anchor: InvocationAnchor;
    readonly advertisedInvocation: string;
    readonly removeHooks: () => Promise<void>;
    readonly onWarning: (message: string) => void;
  },
): Promise<void> {
  const opened = await OpenedInvocation.open(input.anchor, input.budget, input.cleanupSignal);
  if (opened.store.codec.options.invocation !== input.advertisedInvocation) {
    throw new Error('Failed-prepare layer advertisement differs from the owning invocation.');
  }
  const attempt = await PostAttempt.open(opened, input);
  const store = attempt.store,
    seed = attempt.handoff.header[12],
    overlay = attempt.handoff.header[13];
  try {
    if (
      (!seed && !overlay) ||
      store.codec.options.role !== 'distributed-worker' ||
      store.codec.options.access !== 'writable'
    ) {
      throw new Error('Failed-prepare layer cleanup requires the frozen writable worker layer.');
    }
    if (attempt.state[4] === 'completed') {
      if (attempt.state[7]?.[1] !== 'abandoned') {
        throw new Error('Unexpected failed-prepare layer completion.');
      }
      return;
    }
    if (seed) {
      await validateGradleSeedOwner(store, seed);
    } else if (overlay && input.overlayMount) {
      await verifyOverlay(store, overlay, input.overlayMount);
    } else {
      throw new Error('OverlayFS mount driver unavailable in post.');
    }
    const gate = await ExclusiveWindow.establish(store, input.budget, {
      ...input,
      layeredWorker: attempt.handoff,
    });
    if (gate.status !== 'ready') {
      throw new Error('Failed-prepare consumers could not settle: ' + gate.message);
    }
    attempt.attachWindow(gate.window);
    await input.removeHooks();
    await attempt.guard();
    if (seed) {
      await retireGradleSeed(store, seed, input);
    } else {
      await retireOverlay(store, overlay!, input.overlayMount!);
    }
    await attempt.finish(['outcome', 'abandoned', null, null, null]);
  } catch (error) {
    if (seed || overlay) {
      const message = seed
        ? 'Failed-prepare Gradle seed retained at ' + gradleSeedPath(store, seed)
        : 'Failed-prepare OverlayFS state retained at ' + store.root.resolve(overlay![2]);
      const errors = [error];
      try {
        input.onWarning(message);
      } catch (report) {
        errors.push(report);
      }
      throw new AggregateError(errors, message, { cause: error });
    }
    throw error;
  } finally {
    attempt.close();
  }
}
