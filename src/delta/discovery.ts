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

import { createHash } from 'node:crypto';

import type { CiJobContext } from '../ci';
import type {
  ArtifactLookupOptions,
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from './backend';

const DELTA_ARTIFACT_NAME_PREFIX = 'buildish-mammoth-cache-delta';

/** Public resource limits enforced before a downloaded delta can mutate the cache. */
export const DELTA_ARTIFACT_RESOURCE_LIMITS = {
  totalRunArtifacts: 1_000,
  candidatesPerWorker: 100,
  selectedArtifactSizeBytes: 2 * 1024 * 1024 * 1024,
  expandedPackageSizeBytes: 4 * 1024 * 1024 * 1024,
  manifestEntries: 200_000,
} as const;

/** Complete set of action-owned delta discovery and package resource limits. */
export interface DeltaArtifactResourceLimits {
  readonly totalRunArtifacts: number;
  readonly candidatesPerWorker: number;
  readonly selectedArtifactSizeBytes: number;
  readonly expandedPackageSizeBytes: number;
  readonly manifestEntries: number;
}

/** Optional stricter resource limits. Values cannot raise the action-owned limits. */
export interface DeltaArtifactResourceLimitOptions {
  readonly resourceLimits?: Partial<DeltaArtifactResourceLimits>;
}

/** Artifact selected for one configured producer after bounded current-run discovery. */
export interface SelectedDeltaArtifact {
  readonly producerJobName: string;
  readonly producerAttempt: number | null;
  readonly artifact: WorkflowArtifactDescriptor;
}

/** Creates the stable artifact-name prefix used to locate one worker across rerun attempts. */
export function createDeltaArtifactNamePrefix(jobName: string, runId: number | null): string {
  const jobToken = `${sanitizeArtifactToken(jobName, 'job name', 24)}-${sha256Hex(jobName.trim()).slice(0, 8)}`;
  const runSegment = runId === null ? 'run-unknown' : `run-${runId}`;
  return `${DELTA_ARTIFACT_NAME_PREFIX}-${jobToken}-${runSegment}-`;
}

/** Selects one deterministic artifact per configured worker from all artifacts in the current run. */
export async function selectDeltaArtifactsForProducerJobs(
  artifactBackend: WorkflowArtifactBackend,
  producerJobNames: readonly string[],
  ciContext: Pick<
    CiJobContext,
    'repository' | 'workflowName' | 'runId' | 'runAttempt' | 'sourceRevision'
  >,
  options: ArtifactLookupOptions & DeltaArtifactResourceLimitOptions = {},
): Promise<readonly SelectedDeltaArtifact[]> {
  assertArtifactLookupScopeSupport(artifactBackend, options.scope);
  const limits = resolveDeltaArtifactResourceLimits(options.resourceLimits);
  const artifacts = await artifactBackend.listArtifacts({ latest: false, scope: options.scope });
  if (artifacts.length > limits.totalRunArtifacts) {
    throw new Error(
      `Current workflow run exposes ${artifacts.length} artifacts, exceeding the delta discovery limit of ${limits.totalRunArtifacts}.`,
    );
  }

  const duplicateProducerNames = producerJobNames.filter(
    (jobName, index) => producerJobNames.indexOf(jobName) !== index,
  );
  if (duplicateProducerNames.length > 0) {
    throw new Error(
      `Dependent delta artifact discovery failed:\n- configured producer job names must be unique: ${[...new Set(duplicateProducerNames)].join(', ')}`,
    );
  }

  const selected: SelectedDeltaArtifact[] = [];
  const failures: string[] = [];
  for (const producerJobName of producerJobNames) {
    const prefix = createDeltaArtifactNamePrefix(producerJobName, ciContext.runId);
    const candidates = artifacts.flatMap((artifact) => {
      if (!artifact.name.startsWith(prefix)) {
        return [];
      }
      const match = /^attempt-(unknown|\d+)-[a-f0-9]{12}-[a-f0-9]{12}$/u.exec(
        artifact.name.slice(prefix.length),
      );
      if (!match) {
        failures.push(`job '${producerJobName}' has malformed candidate '${artifact.name}'`);
        return [];
      }
      const attempt = match[1] === 'unknown' ? null : Number(match[1]);
      if (attempt !== null && !Number.isSafeInteger(attempt)) {
        failures.push(`job '${producerJobName}' has malformed candidate '${artifact.name}'`);
        return [];
      }
      return [{ artifact, attempt }];
    });

    if (candidates.length > limits.candidatesPerWorker) {
      failures.push(
        `job '${producerJobName}' has ${candidates.length} candidates, exceeding the per-worker limit of ${limits.candidatesPerWorker}`,
      );
      continue;
    }

    const eligible = candidates.filter(({ attempt }) =>
      ciContext.runAttempt === null
        ? attempt === null
        : attempt !== null && attempt <= ciContext.runAttempt,
    );
    if (eligible.length === 0) {
      failures.push(
        `job '${producerJobName}' has no artifact at or before the current run attempt`,
      );
      continue;
    }

    const newestAttempt = eligible.reduce<number | null>((newest, candidate) => {
      if (candidate.attempt === null) return newest;
      return newest === null ? candidate.attempt : Math.max(newest, candidate.attempt);
    }, null);
    const newest = eligible.filter((candidate) => candidate.attempt === newestAttempt);
    if (newest.length !== 1) {
      failures.push(
        `job '${producerJobName}' has ${newest.length} ambiguous artifacts for attempt ${newestAttempt ?? 'unknown'}`,
      );
      continue;
    }

    const candidate = newest[0]!;
    if (candidate.artifact.size > limits.selectedArtifactSizeBytes) {
      failures.push(
        `job '${producerJobName}' selected artifact '${candidate.artifact.name}' of ${candidate.artifact.size} bytes, exceeding the ${limits.selectedArtifactSizeBytes}-byte limit`,
      );
      continue;
    }
    selected.push({
      producerJobName,
      producerAttempt: candidate.attempt,
      artifact: candidate.artifact,
    });
  }

  if (failures.length > 0) {
    throw new Error(
      `Dependent delta artifact discovery failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  }
  return selected;
}

/** Resolves caller overrides without allowing them to raise action-owned resource limits. */
export function resolveDeltaArtifactResourceLimits(
  overrides: Partial<DeltaArtifactResourceLimits> | undefined,
): DeltaArtifactResourceLimits {
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Delta artifact resource limit '${name}' must be a non-negative safe integer.`,
      );
    }
  }
  return {
    totalRunArtifacts: bounded('totalRunArtifacts', overrides),
    candidatesPerWorker: bounded('candidatesPerWorker', overrides),
    selectedArtifactSizeBytes: bounded('selectedArtifactSizeBytes', overrides),
    expandedPackageSizeBytes: bounded('expandedPackageSizeBytes', overrides),
    manifestEntries: bounded('manifestEntries', overrides),
  };
}

function bounded(
  name: keyof DeltaArtifactResourceLimits,
  overrides: Partial<DeltaArtifactResourceLimits> | undefined,
): number {
  return Math.min(
    DELTA_ARTIFACT_RESOURCE_LIMITS[name],
    overrides?.[name] ?? Number.MAX_SAFE_INTEGER,
  );
}

function assertArtifactLookupScopeSupport(
  artifactBackend: WorkflowArtifactBackend,
  scope: ArtifactLookupOptions['scope'],
): void {
  if (scope && !artifactBackend.capabilities.supportsCrossExecutionLookup) {
    throw new Error('Artifact backend does not support cross-execution scope for artifact lookup.');
  }
}

function sanitizeArtifactToken(token: string, label: string, maxLength: number): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) throw new Error(`Artifact ${label} must not be empty.`);
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, maxLength)
    .replace(/^-|-$/gu, '');
  if (sanitized.length === 0) {
    throw new Error(`Artifact ${label} did not contain any supported characters.`);
  }
  return sanitized;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
