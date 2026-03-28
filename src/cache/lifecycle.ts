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

import type { BaseCacheRestoreResult } from './service';

/** Evidence required to decide whether finalize must publish a new immutable generation. */
export interface BaseCacheGenerationEvidence {
  readonly restoreStatus: BaseCacheRestoreResult['status'];
  readonly preBuildManifestDigest: string;
  readonly currentManifestDigest: string;
  readonly currentEntryCount: number;
  readonly dependentMutationCount: number;
}

/** Material-state decision made before an eligible base-cache save. */
export type BaseCacheGenerationDecision =
  | {
      readonly required: true;
      readonly reason: 'restore-miss-with-content' | 'material-change' | 'dependent-delta-change';
    }
  | {
      readonly required: false;
      readonly reason: 'unchanged' | 'empty-miss';
    };

/**
 * Decides whether the current complete managed state needs a new immutable generation.
 *
 * A material post-build change wins over dependent-delta evidence because the canonical digest is
 * the strongest available description of the final standalone state. Aggregator mutation evidence
 * covers changes that were applied before the pre-build manifest was captured.
 */
export function decideBaseCacheGeneration(
  evidence: BaseCacheGenerationEvidence,
): BaseCacheGenerationDecision {
  if (evidence.preBuildManifestDigest !== evidence.currentManifestDigest) {
    return { required: true, reason: 'material-change' };
  }

  if (evidence.dependentMutationCount > 0) {
    return { required: true, reason: 'dependent-delta-change' };
  }

  if (
    (evidence.restoreStatus === 'miss' || evidence.restoreStatus === 'feature-unavailable') &&
    evidence.currentEntryCount > 0
  ) {
    return { required: true, reason: 'restore-miss-with-content' };
  }

  return {
    required: false,
    reason:
      evidence.restoreStatus === 'miss' || evidence.restoreStatus === 'feature-unavailable'
        ? 'empty-miss'
        : 'unchanged',
  };
}
