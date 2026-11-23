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

import { GcSurvivorOwner } from './gc-execute';
import { z } from 'zod';
import type {
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
  ArtifactLookupScope,
} from '../../delta/backend';
import { H, encodeRecord } from './encoding';
import {
  contextSchema,
  familySchema,
  nameSchema,
  positiveSchema,
  uintSchema,
  type Context,
} from './schema';
import { ownsLocalSnapshot, type ResolvedModel } from './model';
import type { WorkerSourceView } from './worker-walk';
// Protocol: docs/dev/cache-protocol.md#worker-artifact-names-and-discovery.
export function workerArtifactPrefix(model: ResolvedModel, context: Context): string {
  const c = contextSchema.parse(context);
  if (c[7] !== model.tuple[2]) throw new Error('Worker artifact build tool mismatch.');
  familySchema.parse(model.family);
  const producer = ['producer', c[0], c[1], c[2], c[3], c[4], c[6], c[7]] as const;
  encodeRecord(producer);
  return model.family + '-w' + H('worker-producer', producer) + '-a';
}
export function workerArtifactName(
  model: ResolvedModel,
  context: Context,
  view: WorkerSourceView,
): string {
  const survivor = view.survivors;
  GcSurvivorOwner.assertReceipt(survivor);
  const owner = survivor.index.store.codec.options;
  if (
    owner.model.id !== model.id ||
    owner.model.family !== model.family ||
    !encodeRecord(owner.context).equals(encodeRecord(context))
  )
    throw new Error('Worker artifact source identity mismatch.');
  const decision = H('worker-decision', [
    'decision',
    survivor.index.reference[4],
    model.partitions.filter((p) => ownsLocalSnapshot(p, owner)).map((p) => p[0]),
  ]);
  return workerArtifactPrefix(model, context) + context[5] + '-d' + decision + '.tar.gz';
}
export function workerArtifactAttempt(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const match = /^([1-9][0-9]*)-d[a-f0-9]{64}\.tar\.gz$/.exec(name.slice(prefix.length));
  if (!match) throw new Error('Malformed raw worker artifact candidate.');
  return positiveSchema.parse(Number(match[1]));
}
export function workerDigest(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(?:sha256:)?([a-fA-F0-9]{64})$/.exec(value);
  if (!match) throw new Error('Unsupported worker artifact digest.');
  return match[1].toLowerCase();
}
const descriptorSchema = z.object({
  id: positiveSchema,
  name: nameSchema,
  size: uintSchema,
  digest: z.string().nullable(),
});
export function workerDescriptor(
  input: WorkflowArtifactDescriptor,
  expectedName?: string,
): Readonly<WorkflowArtifactDescriptor> {
  const d = descriptorSchema.parse(input),
    hash = workerDigest(d.digest);
  if (expectedName !== undefined && d.name !== expectedName)
    throw new Error('Worker artifact service name mismatch.');
  return Object.freeze({ ...d, digest: hash === null ? null : 'sha256:' + hash });
}
export function rawWorkerBackend(
  backend: WorkflowArtifactBackend,
  scope?: ArtifactLookupScope,
): void {
  if (backend.capabilities.supportsRawWorkerArchives !== true)
    throw new Error('Artifact backend must explicitly support raw worker archives.');
  if (scope && !backend.capabilities.supportsCrossExecutionLookup)
    throw new Error('Artifact backend lacks cross-execution lookup support.');
}
export function workerScope(
  scope: ArtifactLookupScope | undefined,
  context: Context,
): ArtifactLookupScope | undefined {
  if (!scope) return undefined;
  const result = Object.freeze({ ...scope, repository: scope.repository.trim() });
  nameSchema.parse(result.token);
  positiveSchema.parse(result.runId);
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(result.repository) ||
    result.repository !== context[1] ||
    String(result.runId) !== context[3]
  )
    throw new Error('Worker artifact lookup scope differs from expected execution.');
  return result;
}

/** Bound authorization before copying caller lists or making any transport request. */
export function workerSnapshotAuthorization(
  model: ResolvedModel,
  job: string,
  input: readonly string[],
): readonly string[] {
  if (input.length > 64) throw new Error('Worker snapshot authorization admission exceeded.');
  const seen = new Set<string>();
  for (const id of input) {
    const partition = model.partitions.find((p) => p[0] === id);
    if (
      seen.has(id) ||
      !partition ||
      partition[3] !== 'single-writer' ||
      (partition[4] !== null && partition[4] !== job)
    )
      throw new Error('Invalid worker snapshot authorization/owner.');
    seen.add(id);
  }
  return Object.freeze([...input]);
}
