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
import { cp } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PORTABLE_CACHE_ROOT,
  createDeltaArtifactName,
  createDeltaArtifactNamePrefix,
  deserializeDeltaArtifactPackageMetadata,
  downloadAndVerifyDeltaArtifactPackage,
  selectDeltaArtifactsForProducerJobs,
  stageDeltaArtifactPackage,
  type WorkflowArtifactDescriptor,
  uploadDeltaArtifactPackage,
  verifyExtractedDeltaArtifactPackage,
} from '../../src/delta/service';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
} from '../../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../../src/cache/model';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../src/config/types';
import type { CiJobContext } from '../../src/ci/types';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../../src/delta/backend';

describe('artifact exchange service', () => {
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map(async (directory) => {
        temporaryDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it('creates a deterministic human-readable artifact name', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-artifact-name-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    const artifactName = createDeltaArtifactName(
      createFixtureCiContext(),
      cacheModel,
      deltaManifest,
    );

    expect(artifactName).toMatch(
      /^buildish-mammoth-cache-delta-gradle-worker-[a-f0-9]{8}-run-12345-attempt-2-[a-f0-9]{12}-[a-f0-9]{12}$/u,
    );
    expect(artifactName).toBe(
      createDeltaArtifactName(createFixtureCiContext(), cacheModel, deltaManifest),
    );
  });

  it('stages, uploads, locates, downloads, and verifies a portable delta artifact package', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-stage-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);
    const ciContext = createFixtureCiContext();

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    await writeGradleFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip', 'delete-me');
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    await writeGradleFile(
      gradleUserHome,
      'caches/build-cache-1/output.bin',
      'new-build-cache-entry',
    );
    await rm(path.join(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip'));
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    const stagedPackage = await stageDeltaArtifactPackage(ciContext, cacheModel, deltaManifest, {
      lifecycleIdentity: createTestLifecycleIdentity(previousManifest),
      parentDirectory: await createTempDirectory(
        temporaryDirectories,
        'buildish-mammoth-cache-stage-parent-',
      ),
    });

    expect(stagedPackage.metadata.payloadEntries).toHaveLength(2);
    expect(stagedPackage.metadata.payloadEntries.map((entry) => entry.relativePath)).toEqual([
      'caches/build-cache-1/output.bin',
      'caches/modules-2/files-2.1/org/example/module.bin',
    ]);

    const serializedPortableManifest = await readFile(stagedPackage.deltaManifestPath, 'utf8');
    expect(serializedPortableManifest).toContain(PORTABLE_CACHE_ROOT);
    expect(serializedPortableManifest).not.toContain(gradleUserHome);

    const serializedMetadata = await readFile(stagedPackage.metadataPath, 'utf8');
    const metadata = deserializeDeltaArtifactPackageMetadata(serializedMetadata);
    expect(metadata.artifactName).toBe(stagedPackage.artifactName);
    expect(metadata.cacheIdentity.familyKey).toBe(cacheModel.cacheFamilyKey);
    const rawMetadata = JSON.parse(serializedMetadata) as {
      producer: Record<string, unknown>;
    };
    expect(Object.keys(rawMetadata.producer).sort()).toEqual([
      'defaultBranch',
      'jobName',
      'repository',
      'runAttempt',
      'runId',
      'runnerArch',
      'runnerOs',
      'safeRefName',
      'sourceRevision',
      'workflowName',
    ]);
    expect(rawMetadata.producer).not.toHaveProperty('platform');
    expect(rawMetadata.producer).not.toHaveProperty('provider');

    const fakeApi = new FakeArtifactApi(
      await createTempDirectory(temporaryDirectories, 'buildish-mammoth-cache-artifact-store-'),
    );
    const uploadedPackage = await uploadDeltaArtifactPackage(fakeApi, stagedPackage);
    const [selectedArtifact] = await selectDeltaArtifactsForProducerJobs(
      fakeApi,
      [ciContext.jobName],
      ciContext,
    );
    const locatedArtifact = selectedArtifact!.artifact;
    expect(locatedArtifact.id).toBe(uploadedPackage.artifact.id);

    const downloadedPackage = await downloadAndVerifyDeltaArtifactPackage(
      fakeApi,
      locatedArtifact,
      {
        parentDirectory: await createTempDirectory(
          temporaryDirectories,
          'buildish-mammoth-cache-download-parent-',
        ),
      },
    );

    expect(downloadedPackage.deltaManifest.cacheRoot).toBe(PORTABLE_CACHE_ROOT);
    expect(downloadedPackage.metadata.deltaManifestSha256).toBe(metadata.deltaManifestSha256);
    expect(downloadedPackage.metadata.payloadEntries).toEqual(metadata.payloadEntries);
  });

  it.each([
    {
      label: 'full rerun',
      currentAttempt: 2,
      attempts: { 'worker-a': [1, 2], 'worker-b': [1, 2] },
      expected: [2, 2],
    },
    {
      label: 'failed-job rerun',
      currentAttempt: 2,
      attempts: { 'worker-a': [1, 2], 'worker-b': [1] },
      expected: [2, 1],
    },
    {
      label: 'aggregator-only rerun',
      currentAttempt: 3,
      attempts: { 'worker-a': [1, 2], 'worker-b': [1] },
      expected: [2, 1],
    },
  ])(
    'selects deterministic envelopes for a $label',
    async ({ currentAttempt, attempts, expected }) => {
      const artifacts = Object.entries(attempts).flatMap(([jobName, jobAttempts], jobIndex) =>
        jobAttempts.map((attempt, attemptIndex) =>
          createSelectionArtifact(jobName, 12345, attempt, jobIndex * 10 + attemptIndex),
        ),
      );
      artifacts.push(createSelectionArtifact('worker-a', 12345, currentAttempt + 1, 99));

      const selected = await selectDeltaArtifactsForProducerJobs(
        createListingArtifactBackend(artifacts),
        ['worker-a', 'worker-b'],
        {
          repository: 'buildish-tooling/buildish',
          workflowName: 'CI',
          runId: 12345,
          runAttempt: currentAttempt,
          sourceRevision: '0123456789abcdef0123456789abcdef01234567',
        },
      );

      expect(selected.map(({ producerAttempt }) => producerAttempt)).toEqual(expected);
    },
  );

  it('rejects duplicate artifacts for the same worker attempt as ambiguous', async () => {
    const artifacts = [
      createSelectionArtifact('worker-a', 12345, 2, 1),
      createSelectionArtifact('worker-a', 12345, 2, 2),
    ];

    await expect(
      selectDeltaArtifactsForProducerJobs(createListingArtifactBackend(artifacts), ['worker-a'], {
        repository: 'buildish-tooling/buildish',
        workflowName: 'CI',
        runId: 12345,
        runAttempt: 2,
        sourceRevision: null,
      }),
    ).rejects.toThrow(/ambiguous artifacts for attempt 2/u);
  });

  it('reports every missing or malformed configured worker in one discovery failure', async () => {
    const malformed = {
      ...createSelectionArtifact('worker-a', 12345, 1, 1),
      name: `${createDeltaArtifactNamePrefix('worker-a', 12345)}not-an-envelope`,
    };

    await expect(
      selectDeltaArtifactsForProducerJobs(
        createListingArtifactBackend([malformed]),
        ['worker-a', 'worker-b'],
        {
          repository: 'buildish-tooling/buildish',
          workflowName: 'CI',
          runId: 12345,
          runAttempt: 1,
          sourceRevision: null,
        },
      ),
    ).rejects.toThrow(/worker-a[\s\S]*worker-b/u);
  });

  it('enforces discovery metadata, candidate, and selected-size bounds before download', async () => {
    const artifact = createSelectionArtifact('worker-a', 12345, 1, 1, 11);
    const backend = createListingArtifactBackend([artifact]);
    const context = {
      repository: 'buildish-tooling/buildish',
      workflowName: 'CI',
      runId: 12345,
      runAttempt: 1,
      sourceRevision: null,
    } as const;

    await expect(
      selectDeltaArtifactsForProducerJobs(backend, ['worker-a'], context, {
        resourceLimits: { totalRunArtifacts: 0 },
      }),
    ).rejects.toThrow(/delta discovery limit of 0/u);
    await expect(
      selectDeltaArtifactsForProducerJobs(backend, ['worker-a'], context, {
        resourceLimits: { candidatesPerWorker: 0 },
      }),
    ).rejects.toThrow(/per-worker limit of 0/u);
    await expect(
      selectDeltaArtifactsForProducerJobs(backend, ['worker-a'], context, {
        resourceLimits: { selectedArtifactSizeBytes: 10 },
      }),
    ).rejects.toThrow(/exceeding the 10-byte limit/u);
  });

  it('rejects retention overrides when the artifact backend does not support them', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);

    const unsupportedArtifactBackend: WorkflowArtifactBackend = {
      capabilities: {
        ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
        supportsRetentionDays: false,
      },
      async uploadArtifact(): Promise<never> {
        throw new Error(
          'uploadArtifact should not be called when retention overrides are unsupported',
        );
      },
      async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
        return [];
      },
      async getArtifact(): Promise<never> {
        throw new Error('getArtifact should not be called in this test');
      },
      async downloadArtifact(): Promise<never> {
        throw new Error('downloadArtifact should not be called in this test');
      },
      async deleteArtifact(): Promise<void> {
        throw new Error('deleteArtifact should not be called in this test');
      },
    };

    await expect(
      uploadDeltaArtifactPackage(unsupportedArtifactBackend, stagedPackage, { retentionDays: 14 }),
    ).rejects.toThrow(/does not support retention-day overrides/u);
  });

  it('rejects cross-execution lookups when the artifact backend cannot scope queries', async () => {
    const unsupportedArtifactBackend: WorkflowArtifactBackend = {
      capabilities: {
        ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
        supportsCrossExecutionLookup: false,
      },
      async uploadArtifact(): Promise<never> {
        throw new Error('uploadArtifact should not be called in this test');
      },
      async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
        throw new Error('listArtifacts should not be called when scoped lookups are unsupported');
      },
      async getArtifact(): Promise<never> {
        throw new Error('getArtifact should not be called in this test');
      },
      async downloadArtifact(): Promise<never> {
        throw new Error('downloadArtifact should not be called in this test');
      },
      async deleteArtifact(): Promise<void> {
        throw new Error('deleteArtifact should not be called in this test');
      },
    };

    await expect(
      selectDeltaArtifactsForProducerJobs(
        unsupportedArtifactBackend,
        ['worker-a'],
        {
          repository: 'example/project',
          workflowName: 'CI',
          runId: 123,
          runAttempt: 1,
          sourceRevision: null,
        },
        {
          scope: {
            token: 'test-token',
            runId: 456,
            repository: 'example/project',
          },
        },
      ),
    ).rejects.toThrow(/does not support cross-execution scope/u);
  });

  it('rejects tampered payload content during verification', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    await writeFile(path.join(stagedPackage.rootDirectory, 'payload/000001.bin'), 'other');

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/SHA-256 verification/u);
  });

  it('rejects metadata path traversal in downloaded packages', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );

    await writeFile(
      stagedPackage.metadataPath,
      `${JSON.stringify({
        ...metadata,
        payloadEntries: [{ ...metadata.payloadEntries[0], payloadPath: '../escape.bin' }],
      })}\n`,
    );

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/normalized relative POSIX path/u);
  });

  it('rejects a delta artifact whose manifest does not use the portable cache root sentinel', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);

    // Tamper with the delta manifest by replacing the portable sentinel with a real path, then
    // update the metadata digest so the hash check passes and the sentinel check is reached.
    const originalManifest = await readFile(stagedPackage.deltaManifestPath, 'utf8');
    const tamperedManifest = originalManifest.replace(PORTABLE_CACHE_ROOT, '/home/runner/.gradle');
    await writeFile(stagedPackage.deltaManifestPath, tamperedManifest, 'utf8');

    const tamperedSha256 = createHash('sha256').update(tamperedManifest).digest('hex');
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );
    await writeFile(
      stagedPackage.metadataPath,
      `${JSON.stringify({ ...metadata, deltaManifestSha256: tamperedSha256 })}\n`,
    );

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/portable cache root sentinel/u);
  });

  it('rejects a delta artifact that contains unexpected files outside the documented layout', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);

    // Add a file that is not declared in the package metadata.
    await writeFile(path.join(stagedPackage.rootDirectory, 'unexpected.bin'), 'extra-file');

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/unexpected files outside the documented package layout/u);
  });

  it('rejects a delta artifact with duplicate payload metadata entries', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );

    // Write the first payload entry twice; the second iteration should hit the duplicate check.
    await writeFile(
      stagedPackage.metadataPath,
      `${JSON.stringify({
        ...metadata,
        payloadEntries: [metadata.payloadEntries[0], metadata.payloadEntries[0]],
      })}\n`,
    );

    // The Zod schema requires strictly increasing relativePath, so it catches the duplicate
    // before the runtime guard in verifyExtractedDeltaArtifactPackage can fire.  Both layers
    // protect against duplicate entries; this test verifies the combined rejection behaviour.
    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/strictly increasing relativePath/u);
  });

  it('rejects a delta artifact whose payload is not stored beneath the payload directory', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );

    // Override payloadPath to a valid relative path that does not start with "payload/".
    await writeFile(
      stagedPackage.metadataPath,
      `${JSON.stringify({
        ...metadata,
        payloadEntries: [{ ...metadata.payloadEntries[0], payloadPath: 'elsewhere/file.bin' }],
      })}\n`,
    );

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/must be stored beneath/u);
  });

  it('rejects a delta artifact whose payload file is a symbolic link', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const metadata = deserializeDeltaArtifactPackageMetadata(
      await readFile(stagedPackage.metadataPath, 'utf8'),
    );

    // Replace the real payload file with a symlink; the symlink check must fire before any
    // content-hash or size comparison.
    const payloadAbsolutePath = path.join(
      stagedPackage.rootDirectory,
      metadata.payloadEntries[0].payloadPath,
    );
    await rm(payloadAbsolutePath);
    await symlink('/dev/null', payloadAbsolutePath);

    // Symlinks are detected during the initial directory walk (listRelativeRegularFiles) before
    // any per-payload verification, so the error comes from the walk rather than the payload check.
    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, stagedPackage.artifactName),
    ).rejects.toThrow(/Artifact packages must not contain symbolic links/u);
  });

  it('enforces expanded-package and manifest-entry limits before package use', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);

    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, undefined, {
        resourceLimits: { expandedPackageSizeBytes: 0 },
      }),
    ).rejects.toThrow(/Expanded delta artifact exceeds the 0-byte limit/u);
    await expect(
      verifyExtractedDeltaArtifactPackage(stagedPackage.rootDirectory, undefined, {
        resourceLimits: { manifestEntries: 0 },
      }),
    ).rejects.toThrow(/exceeding the 0-entry limit/u);
  });

  it('removes its temporary directory when downloaded envelope validation fails', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const fakeApi = new FakeArtifactApi(
      await createTempDirectory(temporaryDirectories, 'buildish-mammoth-cache-cleanup-store-'),
    );
    const uploaded = await uploadDeltaArtifactPackage(fakeApi, stagedPackage);
    const downloadParent = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-cleanup-parent-',
    );

    await expect(
      downloadAndVerifyDeltaArtifactPackage(fakeApi, uploaded.artifact, {
        parentDirectory: downloadParent,
        expectedIdentity: {
          repository: stagedPackage.metadata.producer.repository,
          workflowName: stagedPackage.metadata.producer.workflowName,
          runId: stagedPackage.metadata.producer.runId,
          producerJobName: stagedPackage.metadata.producer.jobName,
          producerAttempt: stagedPackage.metadata.producer.runAttempt,
          sourceRevision: 'different-revision',
        },
      }),
    ).rejects.toThrow(/source revision/u);
    await expect(readdir(downloadParent)).resolves.toEqual([]);
  });

  it('preserves the validation failure when temporary-directory cleanup also fails', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const fakeApi = new FakeArtifactApi(
      await createTempDirectory(
        temporaryDirectories,
        'buildish-mammoth-cache-cleanup-error-store-',
      ),
    );
    const uploaded = await uploadDeltaArtifactPackage(fakeApi, stagedPackage);

    const failure = await downloadAndVerifyDeltaArtifactPackage(fakeApi, uploaded.artifact, {
      expectedIdentity: {
        repository: stagedPackage.metadata.producer.repository,
        workflowName: stagedPackage.metadata.producer.workflowName,
        runId: stagedPackage.metadata.producer.runId,
        producerJobName: stagedPackage.metadata.producer.jobName,
        producerAttempt: stagedPackage.metadata.producer.runAttempt,
        sourceRevision: 'different-revision',
      },
      async removeTemporaryDirectory(): Promise<void> {
        throw new Error('cleanup exploded');
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/source revision.*cleanup exploded/u),
      errors: [
        expect.objectContaining({ message: expect.stringMatching(/source revision/u) }),
        expect.objectContaining({ message: 'cleanup exploded' }),
      ],
    });
  });

  it('rejects every selected producer execution-identity mismatch', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const fakeApi = new FakeArtifactApi(
      await createTempDirectory(temporaryDirectories, 'buildish-mammoth-cache-identity-store-'),
    );
    const uploaded = await uploadDeltaArtifactPackage(fakeApi, stagedPackage);
    const producer = stagedPackage.metadata.producer;
    const expectedIdentity = {
      repository: producer.repository,
      workflowName: producer.workflowName,
      runId: producer.runId,
      producerJobName: producer.jobName,
      producerAttempt: producer.runAttempt,
      sourceRevision: producer.sourceRevision,
    };
    const mismatches = [
      { expected: { ...expectedIdentity, repository: 'other/repository' }, label: 'repository' },
      { expected: { ...expectedIdentity, workflowName: 'Other' }, label: 'workflow' },
      { expected: { ...expectedIdentity, runId: 999 }, label: 'run ID' },
      { expected: { ...expectedIdentity, producerJobName: 'other-worker' }, label: 'producer job' },
      { expected: { ...expectedIdentity, producerAttempt: 99 }, label: 'producer attempt' },
      {
        expected: { ...expectedIdentity, sourceRevision: 'different-revision' },
        label: 'source revision',
      },
    ] as const;

    for (const mismatch of mismatches) {
      await expect(
        downloadAndVerifyDeltaArtifactPackage(fakeApi, uploaded.artifact, {
          expectedIdentity: mismatch.expected,
        }),
      ).rejects.toThrow(mismatch.label);
    }
  });

  it('rejects backend download paths outside the requested temporary directory', async () => {
    const stagedPackage = await createStagedDeltaFixture(temporaryDirectories);
    const artifact = { id: 1, name: stagedPackage.artifactName, size: 0, digest: null };
    const baseBackend = createListingArtifactBackend([artifact]);
    const backend: WorkflowArtifactBackend = {
      ...baseBackend,
      async downloadArtifact() {
        return { downloadPath: stagedPackage.rootDirectory, digestMismatch: false };
      },
    };
    const downloadParent = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-outside-path-',
    );

    await expect(
      downloadAndVerifyDeltaArtifactPackage(backend, artifact, {
        parentDirectory: downloadParent,
      }),
    ).rejects.toThrow(/outside the requested temporary directory/u);
    await expect(readdir(downloadParent)).resolves.toEqual([]);
  });

  it('fails staging when source files drift after the delta manifest was captured', async () => {
    const gradleUserHome = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-drift-',
    );
    const cacheModel = createFixtureCacheModel(gradleUserHome);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'before',
    );
    const previousManifest = await captureCacheManifest(cacheModel);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after',
    );
    const currentManifest = await captureCacheManifest(cacheModel);
    const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

    await writeGradleFile(
      gradleUserHome,
      'caches/modules-2/files-2.1/org/example/module.bin',
      'after-but-different',
    );

    const stagingParent = await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-drift-parent-',
    );
    await expect(
      stageDeltaArtifactPackage(createFixtureCiContext(), cacheModel, deltaManifest, {
        lifecycleIdentity: createTestLifecycleIdentity(previousManifest),
        parentDirectory: stagingParent,
      }),
    ).rejects.toThrow(/captured manifest snapshot|content drift/u);
    await expect(readdir(stagingParent)).resolves.toEqual([]);
  });
});

function createSelectionArtifact(
  jobName: string,
  runId: number,
  attempt: number,
  unique: number,
  size = 0,
): WorkflowArtifactDescriptor {
  return {
    id: unique + 1,
    name:
      `${createDeltaArtifactNamePrefix(jobName, runId)}attempt-${attempt}-` +
      `${unique.toString(16).padStart(12, '0')}-` +
      `${(unique + 1).toString(16).padStart(12, '0')}`,
    size,
    digest: null,
  };
}

function createListingArtifactBackend(
  artifacts: readonly WorkflowArtifactDescriptor[],
): WorkflowArtifactBackend {
  return {
    capabilities: STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
    async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
      return artifacts;
    },
    async uploadArtifact(): Promise<never> {
      throw new Error('uploadArtifact should not be called during discovery');
    },
    async getArtifact(): Promise<never> {
      throw new Error('getArtifact should not be called during discovery');
    },
    async downloadArtifact(): Promise<never> {
      throw new Error('downloadArtifact should not be called during discovery');
    },
    async deleteArtifact(): Promise<never> {
      throw new Error('deleteArtifact should not be called during discovery');
    },
  };
}

class FakeArtifactApi implements WorkflowArtifactBackend {
  readonly capabilities = STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES;

  private nextId = 1;

  private readonly artifacts = new Map<
    number,
    { descriptor: WorkflowArtifactDescriptor; directory: string }
  >();

  constructor(private readonly storageRoot: string) {}

  async uploadArtifact(
    name: string,
    _files: readonly string[],
    rootDirectory: string,
  ): Promise<WorkflowArtifactDescriptor> {
    const id = this.nextId++;
    const directory = path.join(this.storageRoot, String(id));
    await cp(rootDirectory, directory, { recursive: true });

    const descriptor: WorkflowArtifactDescriptor = {
      id,
      name,
      size: 0,
      digest: createHash('sha256').update(`${name}:${id}`).digest('hex'),
    };
    this.artifacts.set(id, { descriptor, directory });
    return descriptor;
  }

  async listArtifacts(): Promise<readonly WorkflowArtifactDescriptor[]> {
    return [...this.artifacts.values()].map((artifact) => artifact.descriptor);
  }

  async getArtifact(name: string): Promise<WorkflowArtifactDescriptor> {
    const artifact = [...this.artifacts.values()].find(
      (candidate) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }

    return artifact.descriptor;
  }

  async downloadArtifact(
    artifactId: number,
    options?: { readonly path?: string; readonly expectedHash?: string },
  ): Promise<{ readonly downloadPath: string; readonly digestMismatch: boolean }> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    const parentDirectory = options?.path ?? this.storageRoot;
    const downloadPath = path.join(parentDirectory, `artifact-${artifactId}`);
    await cp(artifact.directory, downloadPath, { recursive: true });

    return {
      downloadPath,
      digestMismatch:
        options?.expectedHash !== undefined && options.expectedHash !== artifact.descriptor.digest,
    };
  }

  async deleteArtifact(name: string): Promise<void> {
    const artifact = [...this.artifacts.entries()].find(
      ([, candidate]) => candidate.descriptor.name === name,
    );
    if (!artifact) {
      throw new Error(`Artifact '${name}' not found.`);
    }

    this.artifacts.delete(artifact[0]);
  }
}

async function createStagedDeltaFixture(temporaryDirectories: Set<string>) {
  const gradleUserHome = await createTempDirectory(
    temporaryDirectories,
    'buildish-mammoth-cache-fixture-',
  );
  const cacheModel = createFixtureCacheModel(gradleUserHome);

  await writeGradleFile(
    gradleUserHome,
    'caches/modules-2/files-2.1/org/example/module.bin',
    'before',
  );
  const previousManifest = await captureCacheManifest(cacheModel);

  await writeGradleFile(
    gradleUserHome,
    'caches/modules-2/files-2.1/org/example/module.bin',
    'after',
  );
  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);

  return stageDeltaArtifactPackage(createFixtureCiContext(), cacheModel, deltaManifest, {
    lifecycleIdentity: createTestLifecycleIdentity(previousManifest),
    parentDirectory: await createTempDirectory(
      temporaryDirectories,
      'buildish-mammoth-cache-fixture-parent-',
    ),
  });
}

function createTestLifecycleIdentity(
  previousManifest: Parameters<typeof calculateCanonicalCacheManifestDigest>[0],
) {
  return {
    restoredGenerationKey: null,
    preBuildManifestDigest: calculateCanonicalCacheManifestDigest(previousManifest),
  };
}

function createFixtureCacheModel(gradleUserHome: string): CacheModel {
  const adapter = new GradleBuildToolAdapter({ gradleUserHome } as NormalizedGradleConfig);
  const partitions = createCachePartitions(
    gradleUserHome,
    [],
    adapter.getBuiltInPartitionPresets(),
    adapter.getHardCacheExcludeGlobs(),
  );

  return {
    buildToolId: adapter.getBuildToolId(),
    cacheRoot: gradleUserHome,
    cacheFamilyKey: 'test-family',
    currentRefToken: 'main-aaaaaaaaaaaa',
    currentRefLineagePrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'run-1-attempt-1-job-aaaaaaaaaaaa',
    cacheKey: 'test-family-ref-main-aaaaaaaaaaaa-gen-',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'fixture-partitions',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

function createFixtureCiContext(): CiJobContext {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'buildish-tooling/buildish',
    workflowName: 'CI',
    jobName: 'Gradle Worker',
    runId: 12345,
    runAttempt: 2,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    tempDirectory: null,
    workspace: '/tmp/workspace',
    actionPath: null,
  };
}

async function createTempDirectory(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
