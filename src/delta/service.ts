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

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { hashFileSha256 } from '../util/fs';
import { resolveNormalizedPathWithinRoot } from '../util/paths';

import {
  type CacheDeltaEntry,
  type CacheDeltaManifest,
  type CacheFileSnapshot,
  deserializeCacheDeltaManifest,
  serializeCacheDeltaManifest,
} from '../cache/manifest';
import type { CacheModel } from '../cache/model';
import type { CiJobContext } from '../ci';
import type {
  ArtifactLookupOptions,
  WorkflowArtifactBackend,
  WorkflowArtifactDescriptor,
} from './backend';
import { z } from 'zod';

import { validateNormalizedRelativePosixPath } from '../util/paths';
import { parseSerializedJson, parseWithZod } from '../util/serialization';

/** Schema version embedded in every delta artifact package metadata file. Increment on breaking format changes. */
export const DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION = 1;
/** Sentinel value used in place of the absolute Gradle user home path inside portable delta manifests. */
export const PORTABLE_CACHE_ROOT = '<portable-cache-root>';

const DELTA_ARTIFACT_NAME_PREFIX = 'buildish-mammoth-cache-delta';
const DELTA_PACKAGE_METADATA_FILE = 'delta-package.json';
const DELTA_PACKAGE_MANIFEST_FILE = 'delta-manifest.json';
const DELTA_PACKAGE_PAYLOAD_DIRECTORY = 'payload';
const DEFAULT_ARTIFACT_COMPRESSION_LEVEL = 1;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Back-compat alias for the provider-neutral artifact descriptor.
 */
export type { WorkflowArtifactDescriptor };

// ---------------------------------------------------------------------------
// Zod schemas — define once, derive both the runtime validator and the TS type
// ---------------------------------------------------------------------------

const packageRelativePathSchema = z.string().refine((val) => {
  try {
    validateNormalizedRelativePosixPath(val, '', 'the artifact package');
    return true;
  } catch {
    return false;
  }
}, 'Must be a normalized relative POSIX path inside the artifact package');

const sha256Schema = z
  .string()
  .regex(LOWERCASE_SHA256_PATTERN, 'Must be a lowercase hex SHA-256 digest');

const producerSchema = z.object({
  repository: z.string(),
  workflowName: z.string(),
  jobName: z.string(),
  runId: z.number().int().nonnegative().nullable(),
  runAttempt: z.number().int().nonnegative().nullable(),
  runnerOs: z.string(),
  runnerArch: z.string(),
  safeRefName: z.string(),
  cacheKey: z.string(),
});

const payloadEntrySchema = z.object({
  relativePath: packageRelativePathSchema,
  payloadPath: packageRelativePathSchema,
  contentSha256: sha256Schema,
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  mtimeMs: z.number().finite().nonnegative(),
});

const payloadEntriesSchema = z.array(payloadEntrySchema).superRefine((entries, ctx) => {
  let prev = '';
  for (const [i, entry] of entries.entries()) {
    if (prev.localeCompare(entry.relativePath) >= 0) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'relativePath'],
        message: 'Payload entries must be sorted by strictly increasing relativePath',
      });
    }
    prev = entry.relativePath;
  }
});

const deltaArtifactPackageMetadataSchema = z.object({
  schemaVersion: z.literal(DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION),
  artifactType: z.literal('buildish-mammoth-cache-gradle-delta'),
  artifactName: z
    .string()
    .regex(
      ARTIFACT_NAME_PATTERN,
      'Artifact name contains unsupported characters. Allowed: letters, numbers, dot, underscore, dash',
    ),
  createdAt: z.string(),
  producer: producerSchema,
  deltaManifestPath: packageRelativePathSchema,
  deltaManifestSha256: sha256Schema,
  payloadEntries: payloadEntriesSchema,
});

// ---------------------------------------------------------------------------
// Exported types (derived from schemas — single source of truth)
// ---------------------------------------------------------------------------

/**
 * Metadata entry describing one copied payload file inside a staged delta artifact.
 *
 * `payloadPath` is always a generated path beneath `payload/`; it never reuses the original Gradle
 * cache relative path. This prevents path traversal and keeps archive extraction deterministic.
 */
export type DeltaArtifactPayloadEntry = z.infer<typeof payloadEntrySchema>;

/**
 * Top-level metadata file stored alongside each staged delta artifact package.
 */
export type DeltaArtifactPackageMetadata = z.infer<typeof deltaArtifactPackageMetadataSchema>;

// ---------------------------------------------------------------------------

/**
 * Result of staging a delta artifact package on disk before upload.
 */
export interface StagedDeltaArtifactPackage {
  readonly artifactName: string;
  readonly stagingDirectory: string;
  readonly rootDirectory: string;
  readonly files: readonly string[];
  readonly metadataPath: string;
  readonly deltaManifestPath: string;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}

/**
 * Result of uploading a previously staged delta artifact package.
 */
export interface UploadedDeltaArtifactPackage {
  readonly artifact: WorkflowArtifactDescriptor;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly stagingDirectory: string;
}

/**
 * Result of downloading and verifying a delta artifact package.
 */
export interface DownloadedDeltaArtifactPackage {
  readonly artifact: WorkflowArtifactDescriptor;
  readonly downloadDirectory: string;
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}

/**
 * Optional overrides used when staging a delta artifact package.
 */
export interface StageDeltaArtifactPackageOptions {
  /** Parent directory beneath which a temporary staging directory should be created. */
  readonly parentDirectory?: string;
  /** Explicit artifact name override. Defaults to the deterministic name derived from job metadata. */
  readonly artifactName?: string;
}

/**
 * Optional overrides used when uploading a staged delta artifact package.
 */
export interface UploadDeltaArtifactPackageOptions {
  /** Optional retention override passed to the artifact service. */
  readonly retentionDays?: number;
  /** Optional compression override. Defaults to a low-cost level that still compresses JSON well. */
  readonly compressionLevel?: number;
}

/**
 * Optional overrides used when downloading and verifying a delta artifact package.
 */
export interface DownloadDeltaArtifactPackageOptions extends ArtifactLookupOptions {
  /** Parent directory beneath which a temporary extraction directory should be created. */
  readonly parentDirectory?: string;
}

/**
 * Creates the deterministic artifact-name prefix used to locate one worker delta by job identity.
 */
export function createDeltaArtifactNamePrefix(
  jobName: string,
  runId: number | null,
  runAttempt: number | null,
): string {
  const sanitizedJobName = sanitizeArtifactToken(jobName, 'job name', 48);
  const runSegment = runId === null ? 'run-unknown' : `run-${runId}`;
  const attemptSegment = runAttempt === null ? 'attempt-unknown' : `attempt-${runAttempt}`;
  return `${DELTA_ARTIFACT_NAME_PREFIX}-${sanitizedJobName}-${runSegment}-${attemptSegment}-`;
}

/**
 * Creates the final deterministic artifact name for one worker delta package.
 *
 * The hash suffix folds in the cache key and portable delta-manifest digest, keeping names stable,
 * human-readable, and unique for the supported distributed-job model where each worker job name is
 * unique within one distributed execution.
 */
export function createDeltaArtifactName(
  ciContext: CiJobContext,
  cacheModel: CacheModel,
  deltaManifest: CacheDeltaManifest,
): string {
  const portableManifest = createPortableDeltaManifest(deltaManifest);
  const deltaDigest = sha256Hex(serializeCacheDeltaManifest(portableManifest)).slice(0, 12);
  const cacheDigest = sha256Hex(cacheModel.cacheKey).slice(0, 12);
  const artifactName = `${createDeltaArtifactNamePrefix(ciContext.jobName, ciContext.runId, ciContext.runAttempt)}${cacheDigest}-${deltaDigest}`;

  if (!ARTIFACT_NAME_PATTERN.test(artifactName)) {
    throw new Error(`Derived artifact name '${artifactName}' contains unsupported characters.`);
  }

  return artifactName;
}

/**
 * Stages one delta artifact package on disk using generated payload paths under `payload/`.
 *
 * The staged package intentionally serializes a *portable* delta manifest whose `cacheRoot`
 * field is redacted to a constant sentinel. Worker absolute filesystem paths should not leave the
 * worker machine in distributed mode.
 */
export async function stageDeltaArtifactPackage(
  ciContext: CiJobContext,
  cacheModel: CacheModel,
  deltaManifest: CacheDeltaManifest,
  options: StageDeltaArtifactPackageOptions = {},
): Promise<StagedDeltaArtifactPackage> {
  const stagingParent = options.parentDirectory ?? os.tmpdir();
  const stagingDirectory = await mkdtemp(
    path.join(stagingParent, 'buildish-mammoth-cache-delta-artifact-'),
  );
  const rootDirectory = stagingDirectory;
  const artifactName =
    options.artifactName ?? createDeltaArtifactName(ciContext, cacheModel, deltaManifest);
  const portableDeltaManifest = createPortableDeltaManifest(deltaManifest);
  const serializedPortableDeltaManifest = serializeCacheDeltaManifest(portableDeltaManifest);
  const deltaManifestSha256 = sha256Hex(serializedPortableDeltaManifest);
  const deltaManifestPath = path.join(rootDirectory, DELTA_PACKAGE_MANIFEST_FILE);
  const metadataPath = path.join(rootDirectory, DELTA_PACKAGE_METADATA_FILE);
  const payloadDirectory = path.join(rootDirectory, DELTA_PACKAGE_PAYLOAD_DIRECTORY);

  if (!ARTIFACT_NAME_PATTERN.test(artifactName)) {
    throw new Error(
      `Artifact name '${artifactName}' contains unsupported characters. Allowed: letters, numbers, dot, underscore, dash.`,
    );
  }
  await mkdir(payloadDirectory, { recursive: true });

  const payloadEntries = await stagePayloadEntries(deltaManifest, payloadDirectory);
  const metadata: DeltaArtifactPackageMetadata = {
    schemaVersion: DELTA_ARTIFACT_PACKAGE_SCHEMA_VERSION,
    artifactType: 'buildish-mammoth-cache-gradle-delta',
    artifactName,
    createdAt: new Date().toISOString(),
    producer: {
      repository: ciContext.repository,
      workflowName: ciContext.workflowName,
      jobName: ciContext.jobName,
      runId: ciContext.runId,
      runAttempt: ciContext.runAttempt,
      runnerOs: ciContext.runnerOs,
      runnerArch: ciContext.runnerArch,
      safeRefName: ciContext.safeRefName,
      cacheKey: cacheModel.cacheKey,
    },
    deltaManifestPath: DELTA_PACKAGE_MANIFEST_FILE,
    deltaManifestSha256,
    payloadEntries,
  };

  await writeFile(deltaManifestPath, serializedPortableDeltaManifest, 'utf8');
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');

  return {
    artifactName,
    stagingDirectory,
    rootDirectory,
    files: (await listRelativeRegularFiles(rootDirectory)).map((relativePath) =>
      path.join(rootDirectory, relativePath),
    ),
    metadataPath,
    deltaManifestPath,
    metadata,
    deltaManifest: portableDeltaManifest,
  };
}

/**
 * Uploads a previously staged delta artifact package using the supplied artifact API.
 */
export async function uploadDeltaArtifactPackage(
  artifactBackend: WorkflowArtifactBackend,
  stagedPackage: StagedDeltaArtifactPackage,
  options: UploadDeltaArtifactPackageOptions = {},
): Promise<UploadedDeltaArtifactPackage> {
  assertArtifactRetentionSupport(artifactBackend, options.retentionDays);
  const artifact = await artifactBackend.uploadArtifact(
    stagedPackage.artifactName,
    stagedPackage.files,
    stagedPackage.rootDirectory,
    {
      retentionDays: options.retentionDays,
      compressionLevel: options.compressionLevel ?? DEFAULT_ARTIFACT_COMPRESSION_LEVEL,
    },
  );

  return {
    artifact,
    metadata: stagedPackage.metadata,
    stagingDirectory: stagedPackage.stagingDirectory,
  };
}

/**
 * Locates the single delta artifact produced by one worker job in one distributed execution.
 */
export async function findDeltaArtifactByProducerJob(
  artifactBackend: WorkflowArtifactBackend,
  producerJobName: string,
  runId: number | null,
  runAttempt: number | null,
  options: ArtifactLookupOptions = {},
): Promise<WorkflowArtifactDescriptor> {
  assertArtifactLookupScopeSupport(artifactBackend, options.scope, 'artifact lookup');
  const expectedPrefix = createDeltaArtifactNamePrefix(producerJobName, runId, runAttempt);
  const matches = (
    await artifactBackend.listArtifacts({ latest: true, scope: options.scope })
  ).filter((artifact) => artifact.name.startsWith(expectedPrefix));

  if (matches.length === 0) {
    throw new Error(
      `No delta artifact found for job '${producerJobName}' with prefix '${expectedPrefix}'.`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple delta artifacts matched job '${producerJobName}' with prefix '${expectedPrefix}'. Distributed jobs must use unique producer job names.`,
    );
  }

  return matches[0];
}

/**
 * Downloads an artifact by descriptor, verifies the reported content hash when available, and
 * validates the package.
 */
export async function downloadAndVerifyDeltaArtifactPackage(
  artifactBackend: WorkflowArtifactBackend,
  artifact: WorkflowArtifactDescriptor,
  options: DownloadDeltaArtifactPackageOptions = {},
): Promise<DownloadedDeltaArtifactPackage> {
  assertArtifactLookupScopeSupport(artifactBackend, options.scope, 'artifact download');
  const parentDirectory = options.parentDirectory ?? os.tmpdir();
  const downloadDirectory = await mkdtemp(
    path.join(parentDirectory, 'buildish-mammoth-cache-gradle-delta-download-'),
  );
  const downloadResult = await artifactBackend.downloadArtifact(artifact.id, {
    path: downloadDirectory,
    expectedHash: artifact.digest ?? undefined,
    scope: options.scope,
  });

  if (downloadResult.digestMismatch) {
    throw new Error(`Downloaded artifact '${artifact.name}' did not match the expected hash.`);
  }

  const verified = await verifyExtractedDeltaArtifactPackage(
    downloadResult.downloadPath,
    artifact.name,
  );

  return {
    artifact,
    downloadDirectory: downloadResult.downloadPath,
    metadata: verified.metadata,
    deltaManifest: verified.deltaManifest,
  };
}

function assertArtifactRetentionSupport(
  artifactBackend: WorkflowArtifactBackend,
  retentionDays: number | undefined,
): void {
  if (retentionDays === undefined || artifactBackend.capabilities.supportsRetentionDays) {
    return;
  }

  throw new Error(
    `Artifact backend does not support retention-day overrides (requested ${retentionDays}).`,
  );
}

function assertArtifactLookupScopeSupport(
  artifactBackend: WorkflowArtifactBackend,
  scope: ArtifactLookupOptions['scope'],
  operationName: string,
): void {
  if (!scope || artifactBackend.capabilities.supportsCrossExecutionLookup) {
    return;
  }

  throw new Error(`Artifact backend does not support cross-execution scope for ${operationName}.`);
}

/**
 * Verifies a previously extracted delta artifact package and returns the parsed metadata.
 */
export async function verifyExtractedDeltaArtifactPackage(
  extractedDirectory: string,
  expectedArtifactName?: string,
): Promise<{
  readonly metadata: DeltaArtifactPackageMetadata;
  readonly deltaManifest: CacheDeltaManifest;
}> {
  const actualFiles = await listRelativeRegularFiles(extractedDirectory);
  const metadataPath = path.join(extractedDirectory, DELTA_PACKAGE_METADATA_FILE);
  const metadata = deserializeDeltaArtifactPackageMetadata(await readFile(metadataPath, 'utf8'));

  if (expectedArtifactName && metadata.artifactName !== expectedArtifactName) {
    throw new Error(
      `Downloaded package metadata expected artifact name '${expectedArtifactName}', but found '${metadata.artifactName}'.`,
    );
  }

  const manifestRelativePath = validatePackageRelativePath(
    metadata.deltaManifestPath,
    'delta artifact metadata deltaManifestPath',
  );
  const manifestPath = resolveArtifactPackagePath(extractedDirectory, manifestRelativePath);
  const serializedDeltaManifest = await readFile(manifestPath, 'utf8');
  const deltaManifestSha256 = sha256Hex(serializedDeltaManifest);

  if (deltaManifestSha256 !== metadata.deltaManifestSha256) {
    throw new Error('Downloaded delta manifest did not match the packaged manifest digest.');
  }

  const deltaManifest = deserializeCacheDeltaManifest(serializedDeltaManifest);
  if (deltaManifest.cacheRoot !== PORTABLE_CACHE_ROOT) {
    throw new Error('Downloaded delta artifact must use the portable Gradle user home sentinel.');
  }

  const expectedPayloads = collectExpectedPayloadSnapshots(deltaManifest);
  const seenRelativePaths = new Set<string>();
  const expectedFiles = new Set<string>([DELTA_PACKAGE_METADATA_FILE, manifestRelativePath]);

  for (const payloadEntry of metadata.payloadEntries) {
    if (seenRelativePaths.has(payloadEntry.relativePath)) {
      throw new Error(
        `Downloaded delta artifact contains duplicate payload metadata for '${payloadEntry.relativePath}'.`,
      );
    }
    seenRelativePaths.add(payloadEntry.relativePath);

    const expectedSnapshot = expectedPayloads.get(payloadEntry.relativePath);
    if (!expectedSnapshot) {
      throw new Error(
        `Downloaded delta artifact payload '${payloadEntry.relativePath}' does not correspond to an added or modified delta entry.`,
      );
    }

    verifyPayloadEntryMatchesSnapshot(payloadEntry, expectedSnapshot, payloadEntry.relativePath);

    const payloadRelativePath = validatePackageRelativePath(
      payloadEntry.payloadPath,
      `delta artifact payload path for '${payloadEntry.relativePath}'`,
    );
    if (!payloadRelativePath.startsWith(`${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/`)) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must be stored beneath '${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/'.`,
      );
    }

    expectedFiles.add(payloadRelativePath);

    const payloadAbsolutePath = resolveArtifactPackagePath(extractedDirectory, payloadRelativePath);
    const payloadStat = await lstat(payloadAbsolutePath);
    if (payloadStat.isSymbolicLink()) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must not be a symbolic link.`,
      );
    }
    if (!payloadStat.isFile()) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' must be a regular file.`,
      );
    }
    if (payloadStat.size !== payloadEntry.size) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' size does not match metadata.`,
      );
    }

    const payloadDigest = await hashFileSha256(payloadAbsolutePath);
    if (payloadDigest !== payloadEntry.contentSha256) {
      throw new Error(
        `Delta artifact payload '${payloadEntry.relativePath}' failed SHA-256 verification.`,
      );
    }
  }

  if (expectedPayloads.size !== metadata.payloadEntries.length) {
    throw new Error(
      'Downloaded delta artifact payload metadata count does not match the delta manifest.',
    );
  }

  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((relativePath) => !expectedFiles.has(relativePath))
  ) {
    throw new Error(
      'Downloaded delta artifact contains unexpected files outside the documented package layout.',
    );
  }

  return {
    metadata,
    deltaManifest,
  };
}

/**
 * Parses and validates a serialized delta-package metadata file.
 */
export function deserializeDeltaArtifactPackageMetadata(
  serializedMetadata: string,
): DeltaArtifactPackageMetadata {
  return parseWithZod(
    deltaArtifactPackageMetadataSchema,
    parseSerializedJson(serializedMetadata, 'delta artifact metadata'),
    'delta artifact metadata',
  );
}

async function stagePayloadEntries(
  deltaManifest: CacheDeltaManifest,
  payloadDirectory: string,
): Promise<DeltaArtifactPayloadEntry[]> {
  const payloadEntries: DeltaArtifactPayloadEntry[] = [];
  const changedEntries = collectChangedEntries(deltaManifest);

  for (const [index, { entry, currentSnapshot }] of changedEntries.entries()) {
    const payloadPath = `${DELTA_PACKAGE_PAYLOAD_DIRECTORY}/${formatPayloadFileName(index)}`;
    const destinationPath = path.join(payloadDirectory, formatPayloadFileName(index));
    const sourcePath = resolveGradleCachePath(deltaManifest.cacheRoot, entry.relativePath);
    await copyAndVerifySourceFile(sourcePath, destinationPath, entry.relativePath, currentSnapshot);
    payloadEntries.push({
      relativePath: entry.relativePath,
      payloadPath,
      contentSha256: currentSnapshot.contentSha256,
      size: currentSnapshot.size,
      mode: currentSnapshot.mode,
      mtimeMs: currentSnapshot.mtimeMs,
    });
  }

  return payloadEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function createPortableDeltaManifest(deltaManifest: CacheDeltaManifest): CacheDeltaManifest {
  return {
    ...deltaManifest,
    cacheRoot: PORTABLE_CACHE_ROOT,
  };
}

function collectChangedEntries(deltaManifest: CacheDeltaManifest): readonly {
  readonly entry: CacheDeltaEntry;
  readonly currentSnapshot: CacheFileSnapshot;
}[] {
  const changedEntries: Array<{ entry: CacheDeltaEntry; currentSnapshot: CacheFileSnapshot }> = [];

  for (const partition of deltaManifest.partitions) {
    for (const entry of partition.entries) {
      if (entry.changeType === 'deleted') {
        continue;
      }

      if (!entry.current) {
        throw new Error(`Delta entry '${entry.relativePath}' is missing its current snapshot.`);
      }

      changedEntries.push({
        entry,
        currentSnapshot: entry.current,
      });
    }
  }

  return changedEntries;
}

function collectExpectedPayloadSnapshots(
  deltaManifest: CacheDeltaManifest,
): Map<string, CacheFileSnapshot> {
  const snapshots = new Map<string, CacheFileSnapshot>();

  for (const { entry, currentSnapshot } of collectChangedEntries(deltaManifest)) {
    snapshots.set(entry.relativePath, currentSnapshot);
  }

  return snapshots;
}

function verifyPayloadEntryMatchesSnapshot(
  payloadEntry: DeltaArtifactPayloadEntry,
  snapshot: CacheFileSnapshot,
  relativePath: string,
): void {
  if (
    payloadEntry.contentSha256 !== snapshot.contentSha256 ||
    payloadEntry.size !== snapshot.size ||
    payloadEntry.mode !== snapshot.mode ||
    payloadEntry.mtimeMs !== snapshot.mtimeMs
  ) {
    throw new Error(
      `Delta artifact payload metadata for '${relativePath}' does not match the delta manifest snapshot.`,
    );
  }
}

async function copyAndVerifySourceFile(
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  expectedSnapshot: CacheFileSnapshot,
): Promise<void> {
  const beforeStat = await lstat(sourcePath);

  if (beforeStat.isSymbolicLink()) {
    throw new Error(`Delta artifact packaging does not support symbolic links: '${relativePath}'.`);
  }
  if (!beforeStat.isFile()) {
    throw new Error(`Delta artifact packaging only supports regular files: '${relativePath}'.`);
  }

  assertStatMatchesSnapshot(beforeStat, expectedSnapshot, relativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  const hash = createHash('sha256');
  let copiedBytes = 0;
  const input = createReadStream(sourcePath);
  input.on('data', (chunk: Buffer) => {
    copiedBytes += chunk.length;
    hash.update(chunk);
  });

  await pipeline(input, createWriteStream(destinationPath));

  const afterStat = await lstat(sourcePath);
  if (afterStat.isSymbolicLink() || !afterStat.isFile()) {
    throw new Error(`Delta artifact packaging observed an unstable source file '${relativePath}'.`);
  }

  const copiedDigest = hash.digest('hex');
  if (copiedBytes !== expectedSnapshot.size || copiedDigest !== expectedSnapshot.contentSha256) {
    throw new Error(
      `Delta artifact packaging observed content drift for '${relativePath}'. Recompute the delta manifest before uploading.`,
    );
  }

  if (
    beforeStat.size !== afterStat.size ||
    beforeStat.mode !== afterStat.mode ||
    beforeStat.mtimeMs !== afterStat.mtimeMs ||
    beforeStat.ctimeMs !== afterStat.ctimeMs
  ) {
    throw new Error(
      `Delta artifact packaging observed source-file races for '${relativePath}'. Recompute the delta manifest before uploading.`,
    );
  }
}

function assertStatMatchesSnapshot(
  fileStat: Awaited<ReturnType<typeof lstat>>,
  snapshot: CacheFileSnapshot,
  relativePath: string,
): void {
  if (
    fileStat.size !== snapshot.size ||
    fileStat.mode !== snapshot.mode ||
    fileStat.mtimeMs !== snapshot.mtimeMs
  ) {
    throw new Error(
      `Delta artifact packaging source file '${relativePath}' no longer matches the captured manifest snapshot.`,
    );
  }
}

async function listRelativeRegularFiles(rootDirectory: string): Promise<readonly string[]> {
  const relativePaths: string[] = [];
  await walkDirectory(rootDirectory, '', relativePaths);
  return relativePaths.sort((left, right) => left.localeCompare(right));
}

async function walkDirectory(
  absoluteDirectory: string,
  relativeDirectory: string,
  collector: string[],
): Promise<void> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const childAbsolutePath = path.join(absoluteDirectory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Artifact packages must not contain symbolic links: '${childRelativePath}'.`);
    }

    if (entry.isDirectory()) {
      await walkDirectory(childAbsolutePath, childRelativePath, collector);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(
        `Artifact packages only support regular files, but found '${childRelativePath}'.`,
      );
    }

    collector.push(childRelativePath);
  }
}

function formatPayloadFileName(index: number): string {
  return `${String(index + 1).padStart(6, '0')}.bin`;
}

function resolveGradleCachePath(gradleUserHome: string, relativePath: string): string {
  return resolveNormalizedPathWithinRoot(
    gradleUserHome,
    validatePackageRelativePath(relativePath, 'delta relativePath'),
    `Delta relative path '${relativePath}' escapes the Gradle user home.`,
  );
}

function resolveArtifactPackagePath(rootDirectory: string, relativePath: string): string {
  return resolveNormalizedPathWithinRoot(
    rootDirectory,
    validatePackageRelativePath(relativePath, 'artifact package relative path'),
    `Artifact package path '${relativePath}' escapes the extracted root directory.`,
  );
}

function sanitizeArtifactToken(token: string, label: string, maxLength = 64): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error(`Artifact ${label} must not be empty.`);
  }

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

function validatePackageRelativePath(relativePath: string, label: string): string {
  return validateNormalizedRelativePosixPath(relativePath, label, 'the artifact package');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
