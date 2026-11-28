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

import type { TimingOptions } from '../../util/timing';
import path from 'node:path';
import type {
  ArtifactLookupScope,
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from '../../delta/backend';
import type { OwnedStore } from './owned-store';
import type { WorkingBudget } from './tree-state';
import { contextSchema, nameSchema, uintSchema, type Context } from './schema';
import { FrozenWorkerArchive } from './worker-package';
import type { WorkerSourceView } from './worker-walk';
import {
  rawWorkerBackend,
  workerSnapshotAuthorization,
  workerScope,
  workerDescriptor,
  workerDigest,
  workerArtifactPrefix,
  workerArtifactName,
  workerArtifactAttempt,
} from './worker-artifact-identity';
import { DownloadedWorkerArchive, type SelectedWorkerArtifact } from './worker-download';
import type { ResolvedModel } from './model';
import type { Value } from './encoding';
import { MATRIX_JOBS_DOCS_URL } from '../../util/docs-links';
export { DownloadedWorkerArchive } from './worker-download';
export { workerArtifactName, workerArtifactPrefix } from './worker-artifact-identity';
export interface WorkerRequest {
  readonly job: string;
  readonly required: boolean;
  readonly authorizedSnapshots: readonly string[];
}

/** Check backend support before creating the current operation’s immutable upload package. */
export async function freezeWorkerArtifact(
  backend: WorkflowArtifactBackend,
  store: OwnedStore,
  view: WorkerSourceView,
  budget: WorkingBudget,
  options: { readonly signal?: AbortSignal; readonly maxDirectoryEntries?: number } = {},
): Promise<FrozenWorkerArchive> {
  rawWorkerBackend(backend);
  const name = workerArtifactName(store.codec.options.model, store.codec.options.context, view);
  return FrozenWorkerArchive.package(store, view, name, budget, options);
}
// Protocol: docs/dev/cache-protocol.md#worker-artifact-names-and-discovery.
// Eligibility/ambiguity follows delta/discovery.ts: greatest attempt <= selected
// execution attempt, optional ONLY when no candidate exists. A required producer is skipped
// the same way when missing producers are allowed. No legacy file/byte caps.
export async function discoverWorkerArtifacts(
  backend: WorkflowArtifactBackend,
  model: ResolvedModel,
  execution: Context,
  requests: readonly WorkerRequest[],
  options: {
    readonly timing?: TimingOptions['timing'];
    readonly scope?: ArtifactLookupScope;
    readonly signal?: AbortSignal;
    readonly allowMissingRequired?: boolean;
  } = {},
): Promise<readonly SelectedWorkerArtifact[]> {
  if (requests.length > 16) {
    throw new Error('Worker discovery producer admission exceeded.');
  }
  execution = Object.freeze(contextSchema.parse(execution)) as Context;
  requests = Object.freeze(
    requests.map((r) =>
      Object.freeze({
        ...r,
        authorizedSnapshots: workerSnapshotAuthorization(model, r.job, r.authorizedSnapshots),
      }),
    ),
  );
  if (requests.length > 16 || new Set(requests.map((r) => r.job)).size !== requests.length) {
    throw new Error('Worker discovery producer admission exceeded/duplicated.');
  }
  const scope = workerScope(options.scope, execution),
    signal = options.signal ?? new AbortController().signal;
  rawWorkerBackend(backend, scope);
  signal.throwIfAborted();
  const state = requests.map((request) => {
    nameSchema.parse(request.job);
    const context = [...execution] as Context;
    context[4] = request.job;
    return {
      request,
      context,
      prefix: workerArtifactPrefix(model, context),
      candidate: false,
      best: null as WorkflowArtifactDescriptor | null,
      attempt: 0,
      ambiguous: false,
    };
  });
  const artifacts = await backend.listArtifacts({ latest: false, scope });
  signal.throwIfAborted();
  for (const artifact of artifacts) {
    for (const s of state) {
      const attempt = workerArtifactAttempt(artifact.name, s.prefix);
      if (attempt === null) {
        continue;
      }
      s.candidate = true;
      if (attempt > execution[5]) {
        continue;
      }
      if (attempt > s.attempt) {
        s.best = Object.freeze({ ...artifact });
        s.attempt = attempt;
        s.ambiguous = false;
      } else if (attempt === s.attempt) {
        s.ambiguous = true;
      }
    }
  }
  const result: SelectedWorkerArtifact[] = [];
  for (const s of state) {
    if (!s.best) {
      if ((!s.request.required || options.allowMissingRequired) && !s.candidate) {
        continue;
      }
      throw new Error('Worker has no artifact at or before the selected attempt: ' + s.request.job);
    }
    if (s.ambiguous) {
      throw new Error(
        'Ambiguous raw worker artifacts for ' +
          s.request.job +
          ': several workers uploaded under this producer name in the same attempt. ' +
          'Matrix cells share their job ID; give each cell its own `github-job-name` and ' +
          'list those names in `dependent-jobs`. See ' +
          MATRIX_JOBS_DOCS_URL,
      );
    }
    s.context[5] = s.attempt;
    result.push(
      Object.freeze({
        artifact: workerDescriptor(s.best),
        context: Object.freeze(s.context) as Context,
        authorizedSnapshots: s.request.authorizedSnapshots,
      }),
    );
  }
  return Object.freeze(result);
}
/** Acquire immutable native handles; caller retains them while producer-set refs or retries need their Qs. */
export async function acquireWorkerArtifacts(
  store: OwnedStore,
  backend: WorkflowArtifactBackend,
  selections: readonly SelectedWorkerArtifact[],
  options: {
    readonly timing?: TimingOptions['timing'];
    readonly scope?: ArtifactLookupScope;
    readonly signal?: AbortSignal;
  } = {},
): Promise<readonly DownloadedWorkerArchive[]> {
  const downloads: DownloadedWorkerArchive[] = [];
  if (selections.length > 16) {
    throw new Error('Worker acquisition admission exceeded.');
  }
  selections = Object.freeze(
    selections.map((s) =>
      Object.freeze({
        ...s,
        artifact: workerDescriptor(s.artifact),
        context: Object.freeze(contextSchema.parse(s.context)) as Context,
        authorizedSnapshots: workerSnapshotAuthorization(
          store.codec.options.model,
          s.context[4],
          s.authorizedSnapshots,
        ),
      }),
    ),
  );
  options = Object.freeze({
    ...options,
    scope: options.scope ? Object.freeze({ ...options.scope }) : undefined,
  });
  try {
    for (const selection of selections) {
      downloads.push(await DownloadedWorkerArchive.download(store, backend, selection, options));
    }
    return Object.freeze(downloads);
  } catch (error) {
    const settled = await Promise.allSettled(downloads.map((d) => d.dispose())),
      failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) {
      throw new AggregateError(
        [error, ...failed.map((r) => r.reason)],
        'Worker acquisition cleanup failed.',
        { cause: error },
      );
    }
    throw error;
  }
}
export interface WorkerUploadReceipt {
  readonly artifact: Readonly<WorkflowArtifactDescriptor>;
  readonly receipt: Value;
}

/** Only SDK/direct-response failures use this type; local source/cleanup failures remain hard. */
export class WorkerUploadUnconfirmed extends Error {
  constructor(
    readonly retainedPath: string,
    hint?: string,
  ) {
    super(
      'Raw worker upload unconfirmed; retain immutable package at ' +
        retainedPath +
        (hint ? '. ' + hint : ''),
    );
  }
}
/** The artifact service answers 409 when the run already has an artifact with this name. */
function duplicateProducerHint(error: unknown): string | undefined {
  return error instanceof Error && /\(409\)/.test(error.message)
    ? 'The workflow run already has a worker artifact with this name, usually because matrix ' +
        'cells share their job ID. Give each cell its own `github-job-name` and list those names ' +
        'in `dependent-jobs`. See ' +
        MATRIX_JOBS_DOCS_URL
    : undefined;
}
/** One direct attempt consumes ONLY the immutable package; no discovery or readback. */
export async function uploadWorkerArtifact(
  backend: WorkflowArtifactBackend,
  archive: FrozenWorkerArchive,
  options: {
    readonly retentionDays?: number;
    readonly timing?: TimingOptions['timing'];
    readonly scope?: ArtifactLookupScope;
    readonly signal?: AbortSignal;
  } = {},
): Promise<WorkerUploadReceipt> {
  options = Object.freeze({ ...options });
  const context = archive.summary.identity[4],
    scope = workerScope(options.scope, context),
    signal = options.signal ?? new AbortController().signal;
  rawWorkerBackend(backend, scope);
  if (options.retentionDays !== undefined) {
    uintSchema.parse(options.retentionDays);
    if (!backend.capabilities.supportsRetentionDays) {
      throw new Error('Worker backend lacks requested retention support.');
    }
  }
  if (
    workerArtifactAttempt(
      archive.name,
      workerArtifactPrefix(archive.store.codec.options.model, context),
    ) !== context[5]
  ) {
    throw new Error('Frozen raw archive has noncanonical producer naming.');
  }
  await archive.assertStable(signal);
  const file = archive.file,
    root = path.dirname(file);
  archive.claimUpload();
  let artifact: Readonly<WorkflowArtifactDescriptor>;
  try {
    const response = await backend.uploadArtifact(archive.name, [file], root, {
      skipArchive: true,
      compressionLevel: 0,
      ...(options.retentionDays === undefined ? {} : { retentionDays: options.retentionDays }),
    });
    artifact = workerDescriptor(response, archive.name);
    if (
      artifact.size !== archive.bytes ||
      (workerDigest(artifact.digest) !== null && workerDigest(artifact.digest) !== archive.sha)
    ) {
      throw new Error('Worker service size/digest differs from frozen package.');
    }
  } catch (error) {
    // SDK rejection does not expose closure of inaccessible readers. Keep this exact package.
    archive.settleUpload(false);
    throw new WorkerUploadUnconfirmed(file, duplicateProducerHint(error));
  }
  signal.throwIfAborted();
  await archive.assertStable(signal);
  archive.settleUpload(true);
  return Object.freeze({
    artifact: artifact,
    receipt: Object.freeze(['artifact-receipt', String(artifact.id), artifact.name, archive.sha]),
  });
}
