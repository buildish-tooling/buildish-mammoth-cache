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

import { describe, expect, it } from 'vitest';

import { decideBaseCacheGeneration } from '../../src/cache/lifecycle';

const PRE_BUILD_DIGEST = 'a'.repeat(64);

describe('decideBaseCacheGeneration', () => {
  it('does not create a duplicate generation after an unchanged lineage hit', () => {
    expect(
      decideBaseCacheGeneration({
        restoreStatus: 'current-lineage-hit',
        preBuildManifestDigest: PRE_BUILD_DIGEST,
        currentManifestDigest: PRE_BUILD_DIGEST,
        currentEntryCount: 1,
        dependentMutationCount: 0,
      }),
    ).toEqual({ required: false, reason: 'unchanged' });
  });

  it('creates a first generation after a miss when managed content exists', () => {
    expect(
      decideBaseCacheGeneration({
        restoreStatus: 'miss',
        preBuildManifestDigest: PRE_BUILD_DIGEST,
        currentManifestDigest: PRE_BUILD_DIGEST,
        currentEntryCount: 1,
        dependentMutationCount: 0,
      }),
    ).toEqual({ required: true, reason: 'restore-miss-with-content' });
  });

  it('does not create an empty first generation after a miss', () => {
    expect(
      decideBaseCacheGeneration({
        restoreStatus: 'miss',
        preBuildManifestDigest: PRE_BUILD_DIGEST,
        currentManifestDigest: PRE_BUILD_DIGEST,
        currentEntryCount: 0,
        dependentMutationCount: 0,
      }),
    ).toEqual({ required: false, reason: 'empty-miss' });
  });

  it('creates a generation when post-build material state changed', () => {
    expect(
      decideBaseCacheGeneration({
        restoreStatus: 'fallback-lineage-hit',
        preBuildManifestDigest: PRE_BUILD_DIGEST,
        currentManifestDigest: 'b'.repeat(64),
        currentEntryCount: 1,
        dependentMutationCount: 0,
      }),
    ).toEqual({ required: true, reason: 'material-change' });
  });

  it('creates an aggregator generation for applied dependent mutations', () => {
    expect(
      decideBaseCacheGeneration({
        restoreStatus: 'current-lineage-hit',
        preBuildManifestDigest: PRE_BUILD_DIGEST,
        currentManifestDigest: PRE_BUILD_DIGEST,
        currentEntryCount: 1,
        dependentMutationCount: 2,
      }),
    ).toEqual({ required: true, reason: 'dependent-delta-change' });
  });
});
