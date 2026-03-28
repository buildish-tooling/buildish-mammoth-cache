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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  calculateCanonicalCacheManifestDigest,
  type CacheManifest,
} from '../../../src/cache/manifest';
import type { BaseCacheRestoreResult } from '../../../src/cache/service';
import {
  CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
  CACHE_LIFECYCLE_RECORD_STATE,
  getPersistedCacheLifecycleRecord,
  loadPersistedPreBuildCacheManifest,
  persistCacheLifecycleRecord,
  persistPreBuildCacheManifest,
  type PersistedCacheLifecycleRecord,
} from '../../../src/phases/finalize/state';

describe('post-action state helpers', () => {
  it('persists a pre-build manifest under RUNNER_TEMP and loads it back', async () => {
    await withWorkspace(async (workspace) => {
      const runnerTemp = path.join(workspace, 'runner-temp');
      const persisted = await persistPreBuildCacheManifest(SAMPLE_MANIFEST, {
        env: { RUNNER_TEMP: runnerTemp },
      });

      expect(persisted.manifestPath.startsWith(path.resolve(runnerTemp) + path.sep)).toBe(true);
      expect(persisted.manifestDigest).toBe(calculateCanonicalCacheManifestDigest(SAMPLE_MANIFEST));
      await expect(readFile(persisted.manifestPath, 'utf8')).resolves.toContain('"cacheRoot"');
      await expect(loadPersistedPreBuildCacheManifest(persisted.manifestPath)).resolves.toEqual(
        SAMPLE_MANIFEST,
      );
    });
  });

  it('uses the tempDirectory option when no explicit parentDirectory is provided', async () => {
    await withWorkspace(async (workspace) => {
      const tempDirectory = path.join(workspace, 'ci-temp');
      const persisted = await persistPreBuildCacheManifest(SAMPLE_MANIFEST, { tempDirectory });

      expect(persisted.manifestPath.startsWith(path.resolve(tempDirectory) + path.sep)).toBe(true);
    });
  });

  it('falls back to os.tmpdir() when no state parent is configured', async () => {
    const persisted = await persistPreBuildCacheManifest(SAMPLE_MANIFEST);
    await rm(path.dirname(persisted.manifestPath), { recursive: true, force: true });

    expect(persisted.manifestPath.startsWith(os.tmpdir() + path.sep)).toBe(true);
  });

  it('prefers an explicit parent directory over RUNNER_TEMP', async () => {
    await withWorkspace(async (workspace) => {
      const parentDirectory = path.join(workspace, 'custom-parent');
      const persisted = await persistPreBuildCacheManifest(SAMPLE_MANIFEST, {
        env: { RUNNER_TEMP: path.join(workspace, 'runner-temp') },
        parentDirectory,
      });

      expect(persisted.manifestPath.startsWith(path.resolve(parentDirectory) + path.sep)).toBe(
        true,
      );
    });
  });

  it('persists and reloads one complete cache lifecycle record', () => {
    const savedState = new Map<string, string>();
    const record = createSampleLifecycleRecord();

    persistCacheLifecycleRecord(record, savedState.set.bind(savedState));

    expect(savedState.get(CACHE_LIFECYCLE_RECORD_STATE)).toContain('current-lineage-hit');
    expect(getPersistedCacheLifecycleRecord((name: string) => savedState.get(name) ?? '')).toEqual(
      record,
    );
  });

  it('keeps execution identity and dependent mutation evidence inside the lifecycle record', () => {
    const record = getPersistedCacheLifecycleRecord(() =>
      JSON.stringify(createSampleLifecycleRecord()),
    );

    expect(record?.executionIdentity).toEqual({
      jobName: 'check',
      runId: 123,
      runAttempt: 1,
    });
    expect(record?.dependentDelta).toEqual({
      requestedJobs: ['worker-a'],
      artifactNames: ['artifact-a'],
      addedCount: 1,
      modifiedCount: 2,
      deletedCount: 3,
      totalChangedCount: 6,
    });
  });

  it('rejects malformed or internally inconsistent lifecycle state', () => {
    expect(() => getPersistedCacheLifecycleRecord(() => 'not-json')).toThrow(
      /Could not parse serialized/u,
    );
    expect(() =>
      getPersistedCacheLifecycleRecord(() =>
        JSON.stringify({
          ...createSampleLifecycleRecord(),
          cacheFamilyKey: 'different-family',
        }),
      ),
    ).toThrow(/Restore result cache family must match/u);
    expect(() =>
      getPersistedCacheLifecycleRecord(() =>
        JSON.stringify({
          ...createSampleLifecycleRecord(),
          dependentDelta: {
            ...createSampleLifecycleRecord().dependentDelta,
            totalChangedCount: 99,
          },
        }),
      ),
    ).toThrow(/totalChangedCount must equal/u);
    expect(() =>
      getPersistedCacheLifecycleRecord(() =>
        JSON.stringify({
          ...createSampleLifecycleRecord(),
          restoreResult: {
            ...createSampleLifecycleRecord().restoreResult,
            status: 'miss',
          },
        }),
      ),
    ).toThrow(/hit status and matched generation fields must agree/u);
    expect(() =>
      getPersistedCacheLifecycleRecord(() =>
        JSON.stringify({
          ...createSampleLifecycleRecord(),
          plannedGenerationId: '../unsupported',
        }),
      ),
    ).toThrow(/Invalid cache lifecycle record state/u);
    expect(() =>
      getPersistedCacheLifecycleRecord(() =>
        JSON.stringify({
          ...createSampleLifecycleRecord(),
          preBuildManifestPath: '../relative-manifest.json',
        }),
      ),
    ).toThrow(/manifest path must be absolute/u);
  });
});

const SAMPLE_MANIFEST: CacheManifest = {
  schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
  buildToolId: 'gradle',
  cacheRoot: '/tmp/gradle-home',
  partitions: [
    {
      partitionId: 'modules',
      entries: [
        {
          relativePath: 'caches/modules-2/files-2.1/example/module.bin',
          contentSha256: 'a'.repeat(64),
          size: 5,
          mode: 0o100644,
          atimeMs: 1000,
          mtimeMs: 2000,
        },
      ],
    },
  ],
};

const SAMPLE_BASE_CACHE_RESTORE_RESULT: BaseCacheRestoreResult = {
  operation: 'restore',
  status: 'current-lineage-hit',
  cacheFamilyKey: 'buildish-cache-family',
  currentRefLineagePrefix: 'buildish-cache-family-ref-main-aaaaaaaaaaaa-gen-',
  matchedKey:
    'buildish-cache-family-ref-main-aaaaaaaaaaaa-gen-run-1-attempt-1-job-aaaaaaaaaaaa-bbbbbbbbbbbb',
  matchedLineagePrefix: 'buildish-cache-family-ref-main-aaaaaaaaaaaa-gen-',
  restoreCandidates: [
    { lineage: 'current-ref', keyPrefix: 'buildish-cache-family-ref-main-aaaaaaaaaaaa-gen-' },
    {
      lineage: 'default-branch',
      keyPrefix: 'buildish-cache-family-ref-trunk-bbbbbbbbbbbb-gen-',
    },
  ],
  paths: ['/tmp/workspace/.gradle/caches'],
  message: 'Restored current lineage.',
};

function createSampleLifecycleRecord(): PersistedCacheLifecycleRecord {
  return {
    lifecycleSchemaVersion: CACHE_LIFECYCLE_RECORD_SCHEMA_VERSION,
    cacheSchemaVersion: 2,
    buildToolId: 'gradle',
    cacheFamilyKey: 'buildish-cache-family',
    currentRefLineagePrefix: 'buildish-cache-family-ref-main-aaaaaaaaaaaa-gen-',
    fallbackRefLineagePrefixes: ['buildish-cache-family-ref-trunk-bbbbbbbbbbbb-gen-'],
    plannedGenerationId: 'run-123-attempt-1-job-aaaaaaaaaaaa',
    restoreResult: {
      ...SAMPLE_BASE_CACHE_RESTORE_RESULT,
      restoreCandidates: SAMPLE_BASE_CACHE_RESTORE_RESULT.restoreCandidates.map((candidate) => ({
        ...candidate,
      })),
      paths: [...SAMPLE_BASE_CACHE_RESTORE_RESULT.paths],
    },
    preBuildManifestPath: '/tmp/pre-build-cache-manifest.json',
    preBuildManifestDigest: calculateCanonicalCacheManifestDigest(SAMPLE_MANIFEST),
    executionIdentity: {
      jobName: 'check',
      runId: 123,
      runAttempt: 1,
    },
    sourceRevision: null,
    dependentDelta: {
      requestedJobs: ['worker-a'],
      artifactNames: ['artifact-a'],
      addedCount: 1,
      modifiedCount: 2,
      deletedCount: 3,
      totalChangedCount: 6,
    },
  };
}

async function withWorkspace(testBody: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-post-state-'));
  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
