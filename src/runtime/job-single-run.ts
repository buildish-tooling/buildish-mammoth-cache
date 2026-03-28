/*
 * Copyright 2026 The Apache Software Foundation
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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CiJobContext } from '../ci';

/** CI state key used to persist the UUID owner token written by the prepare phase. */
export const JOB_SINGLE_RUN_OWNER_TOKEN_STATE =
  'buildish-mammoth-cache-gradle-job-single-run-owner-token';
/** CI state key set to `'true'` when the prepare phase was rejected as a duplicate. */
export const JOB_SINGLE_RUN_DUPLICATE_STATE =
  'buildish-mammoth-cache-gradle-job-single-run-duplicate';

const JOB_SINGLE_RUN_DIRECTORY = 'buildish-mammoth-cache-gradle-job-guards';

type JobSingleRunCiIdentity = Pick<
  CiJobContext,
  'repository' | 'workflowName' | 'jobName' | 'runId' | 'runAttempt' | 'tempDirectory'
>;

/** Injectable dependencies for single-run guard operations. */
export interface JobSingleRunDependencies {
  readonly ciContext: JobSingleRunCiIdentity;
  readonly saveState: (name: string, value: string) => void;
  /** State reader used during finalize; defaults to a no-op that returns an empty string. */
  readonly getState?: (name: string) => string;
  /** Factory for the owner token UUID; defaults to `crypto.randomUUID()`. */
  readonly createOwnerToken?: () => string;
}

/** Result of a single-run prepare-phase claim attempt. */
export interface JobSingleRunClaimResult {
  /** `true` when this invocation successfully claimed ownership of the current CI job. */
  readonly accepted: boolean;
  readonly message: string;
}

/** Decision produced by the finalize phase about whether it should execute. */
export interface JobSingleRunPostDecision {
  /** `true` when the finalize phase should proceed; `false` when it must be skipped. */
  readonly shouldRun: boolean;
  readonly message: string;
}

/**
 * Attempts to claim single-run ownership for the current CI job.
 *
 * Writes a guard file using `O_EXCL` (atomic create) semantics so concurrent action
 * invocations within the same job cannot both succeed. On success, persists the owner token
 * in CI state for the finalize phase to verify. On conflict, marks the invocation as a
 * duplicate so its finalize phase is skipped.
 *
 * @throws When the guard file cannot be created for a reason other than `EEXIST`.
 */
export async function claimSingleRunPrepareExecution(
  dependencies: JobSingleRunDependencies,
): Promise<JobSingleRunClaimResult> {
  const guardFilePath = resolveSingleRunGuardFilePath(dependencies.ciContext);
  const ownerToken = createSingleRunOwnerToken(dependencies.createOwnerToken);
  await mkdir(path.dirname(guardFilePath), { recursive: true });

  try {
    // Write the guard file atomically with O_EXCL semantics instead of checking first, so concurrent
    // action invocations racing within the same CI job cannot both observe the guard as absent.
    await writeFile(
      guardFilePath,
      `${createSingleRunGuardContents(dependencies.ciContext, ownerToken)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      persistSingleRunPostState(dependencies.saveState, null, true);
      return {
        accepted: false,
        message:
          'This action may run only once per CI job. Another Apache Buildish Mammoth Cache for Gradle invocation already claimed this job, so this duplicate usage is rejected and its finalize execution will be skipped.',
      };
    }

    throw new Error(
      `Unable to create the per-job single-run guard at '${guardFilePath}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  persistSingleRunPostState(dependencies.saveState, ownerToken, false);
  return {
    accepted: true,
    message:
      'Claimed Apache Buildish Mammoth Cache for Gradle single-run ownership for this CI job.',
  };
}

/**
 * Reads the CI state written by the prepare phase and decides whether the finalize phase
 * should execute.
 *
 * Returns `shouldRun: false` when the prepare phase was rejected as a duplicate or when no
 * owner token is present (meaning prepare never ran for this invocation).
 */
export function decideSingleRunFinalizeExecution(
  dependencies: Pick<JobSingleRunDependencies, 'getState'> = {},
): JobSingleRunPostDecision {
  const getState = dependencies.getState ?? (() => '');
  if (getState(JOB_SINGLE_RUN_DUPLICATE_STATE) === 'true') {
    return {
      shouldRun: false,
      message:
        'Skipping finalize execution for this Apache Buildish Mammoth Cache for Gradle invocation because its prepare execution was rejected as a duplicate usage in the same CI job.',
    };
  }

  if (getState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE).trim().length === 0) {
    return {
      shouldRun: false,
      message:
        'Skipping finalize execution because this Apache Buildish Mammoth Cache for Gradle invocation did not claim single-run ownership for the current CI job.',
    };
  }

  return {
    shouldRun: true,
    message:
      'Running finalize execution for the owning Apache Buildish Mammoth Cache for Gradle invocation in this CI job.',
  };
}

/**
 * Derives the absolute path of the per-job guard file for the given CI execution context.
 *
 * The file name is a SHA-256 hash of the composite job identity (repository, workflow, job name,
 * run ID, run attempt) so distinct jobs never share a guard file even if they run concurrently
 * on the same runner.
 */
export function resolveSingleRunGuardFilePath(ciContext: JobSingleRunCiIdentity): string {
  const guardRoot = resolveGuardRoot(ciContext);
  const jobIdentity = [
    normalizeJobIdentityPart(ciContext.repository, 'unknown-repository'),
    normalizeJobIdentityPart(ciContext.workflowName, 'unknown-workflow'),
    normalizeJobIdentityPart(ciContext.jobName, 'unknown-job'),
    normalizeOptionalIntegerIdentityPart(ciContext.runId, 'unknown-run-id'),
    normalizeOptionalIntegerIdentityPart(ciContext.runAttempt, 'unknown-run-attempt'),
  ].join('\n');
  const guardFileName = `${createHash('sha256').update(jobIdentity).digest('hex')}.json`;

  return path.join(path.resolve(guardRoot), JOB_SINGLE_RUN_DIRECTORY, guardFileName);
}

function createSingleRunGuardContents(
  ciContext: JobSingleRunCiIdentity,
  ownerToken: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: normalizeJobIdentityPart(ciContext.repository, 'unknown-repository'),
    workflowName: normalizeJobIdentityPart(ciContext.workflowName, 'unknown-workflow'),
    jobName: normalizeJobIdentityPart(ciContext.jobName, 'unknown-job'),
    runId: normalizeOptionalIntegerIdentityPart(ciContext.runId, 'unknown-run-id'),
    runAttempt: normalizeOptionalIntegerIdentityPart(ciContext.runAttempt, 'unknown-run-attempt'),
    ownerToken,
  });
}

function createSingleRunOwnerToken(createOwnerToken: (() => string) | undefined): string {
  const ownerToken = (createOwnerToken ?? randomUUID)().trim();
  if (ownerToken.length === 0) {
    throw new Error('Job single-run owner tokens must not be empty.');
  }
  return ownerToken;
}

function resolveGuardRoot(ciContext: JobSingleRunCiIdentity): string {
  const tempDirectory = ciContext.tempDirectory?.trim();
  return path.resolve(tempDirectory && tempDirectory.length > 0 ? tempDirectory : os.tmpdir());
}

function normalizeJobIdentityPart(value: string, fallback: string): string {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : fallback;
}

function normalizeOptionalIntegerIdentityPart(value: number | null, fallback: string): string {
  return value === null ? fallback : String(value);
}

function persistSingleRunPostState(
  saveState: (name: string, value: string) => void,
  ownerToken: string | null,
  duplicate: boolean,
): void {
  saveState(JOB_SINGLE_RUN_DUPLICATE_STATE, duplicate ? 'true' : 'false');
  saveState(JOB_SINGLE_RUN_OWNER_TOKEN_STATE, ownerToken ?? '');
}

function isAlreadyExistsError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
