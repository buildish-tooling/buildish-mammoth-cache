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
import { assertCompleteMavenRepositoryDirectories } from '../cache/maven-repository';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, opendir, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  cutoffManifestSchema,
  cutoffDigestSchema,
  CUTOFF_PACKAGE_SCHEMA_VERSION,
  type CutoffManifest,
} from '../cache/cutoff-format';
import {
  persistCutoffJournal,
  loadCutoffJournal,
  cutoffJournalPath,
  type CutoffJournal,
  cutoffExecutionSchema,
} from '../cache/cutoff-state';
import { createManagedCachePathMatcher } from '../cache/manifest';
import { copyGuardedFile, verifyParents, regularStat, guardedPath } from '../cache/guarded-files';
import type { CacheModel } from '../cache/model';
import { CUTOFF_STATE_DIRECTORY } from '../cache/metadata-paths';
import { metadataPath } from '../cache/metadata-io';
import { hashStableFileSha256 } from '../util/fs';
import type { WorkflowArtifactBackend, WorkflowArtifactDescriptor } from './backend';
import { createDeltaArtifactNamePrefix, DELTA_ARTIFACT_RESOURCE_LIMITS } from './discovery';
import type { CiJobContext } from '../ci';

const MAX_JSON = 64 * 1024 * 1024;
const META = 'delta-package.json',
  MANIFEST = 'delta-manifest.json';
const key = z.string().min(1).max(512);
const packageSchema = z
  .object({
    schemaVersion: z.literal(CUTOFF_PACKAGE_SCHEMA_VERSION),
    artifactType: z.literal('buildish-mammoth-cache-upserts'),
    artifactName: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
    producer: cutoffExecutionSchema
      .extend({ runnerOs: key, runnerArch: key, safeRefName: key, defaultBranch: key })
      .strict(),
    cacheIdentity: z
      .object({
        familyKey: key,
        refLineagePrefix: key,
        restoredGenerationKey: key.nullable(),
        partitionFingerprint: key,
        partitionIds: z.array(key),
      })
      .strict(),
    manifestSha256: cutoffDigestSchema,
  })
  .strict();
export type CutoffPackageMetadata = z.infer<typeof packageSchema>;
export interface CutoffPackage {
  metadata: CutoffPackageMetadata;
  manifest: CutoffManifest;
  rootDirectory: string;
}
export interface DownloadedCutoffPackage extends CutoffPackage {
  artifact: WorkflowArtifactDescriptor;
  temporaryDirectory: string;
}
export interface StagedCutoffPackage extends CutoffPackage {
  files: string[];
}
export function cutoffHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function artifactName(
  job: string,
  runId: number | null,
  attempt: number | null,
  family: string,
  digest: string,
): string {
  return `${createDeltaArtifactNamePrefix(job, runId)}${attempt === null ? 'attempt-unknown' : `attempt-${attempt}`}-${cutoffHash(family).slice(0, 12)}-${digest.slice(0, 12)}`;
}
function serialize(value: unknown): string {
  return JSON.stringify(value) + '\n';
}
export function cutoffPackageIdentity(pkg: Pick<CutoffPackage, 'metadata' | 'manifest'>): string {
  return cutoffHash(serialize({ metadata: pkg.metadata, manifest: pkg.manifest }));
}
function checkManifestBounds(manifest: CutoffManifest): void {
  const count = manifest.partitions.reduce((n, p) => n + p.upserts.length + p.usedPaths.length, 0);
  const bytes = manifest.partitions.reduce(
    (n, p) => n + p.upserts.reduce((s, e) => s + e.size, 0),
    0,
  );
  if (
    count > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries ||
    bytes > DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes ||
    Buffer.byteLength(serialize(manifest)) > MAX_JSON
  )
    throw new Error('Cutoff package exceeds resource budget.');
}
function packageMetadata(
  state: CutoffJournal,
  ci: CiJobContext,
  manifest: CutoffManifest,
): CutoffPackageMetadata {
  const digest = cutoffHash(serialize(manifest));
  return packageSchema.parse({
    schemaVersion: 4,
    artifactType: 'buildish-mammoth-cache-upserts',
    artifactName: artifactName(
      ci.jobName,
      ci.runId,
      ci.runAttempt,
      state.model.cacheFamilyKey,
      digest,
    ),
    producer: {
      ...state.execution,
      runnerOs: ci.runnerOs,
      runnerArch: ci.runnerArch,
      safeRefName: ci.safeRefName,
      defaultBranch: ci.defaultBranch,
    },
    cacheIdentity: {
      familyKey: state.model.cacheFamilyKey,
      refLineagePrefix: state.model.currentRefLineagePrefix,
      restoredGenerationKey: state.restoredKey,
      partitionFingerprint: state.model.partitionFingerprint,
      partitionIds: state.model.partitions.map((p) => p.id),
    },
    manifestSha256: digest,
  });
}
export async function stageCutoffPackage(
  state: CutoffJournal,
  ci: CiJobContext,
): Promise<StagedCutoffPackage> {
  const durable = await loadCutoffJournal(
    state.model,
    cutoffJournalPath(state.invocation),
    state.invocation,
  );
  Object.assign(state, durable);
  if (!state.selection) throw new Error('Payload staging needs frozen observations.');
  await assertCompleteMavenRepositoryDirectories(
    state.model,
    state.selection.upserts.map((e) => e.relativePath),
  );
  // Staging inside the excluded namespace also protects overlapping RUNNER_TEMP/custom includes.
  const marker = await metadataPath(
    state.model.cacheRoot,
    `${CUTOFF_STATE_DIRECTORY}/staging/reserved`,
    true,
  );
  const directory = await mkdtemp(path.join(path.dirname(marker), 'package-'));
  try {
    await mkdir(path.join(directory, 'payload'));
    const owns = createManagedCachePathMatcher(state.model);
    let manifest: CutoffManifest = {
      schemaVersion: 3,
      buildToolId: state.model.buildToolId,
      partitions: state.model.partitions.map((p) => ({
        partitionId: p.id,
        upserts: [],
        usedPaths: state.selection!.used.filter((name) => owns(p.id, name)),
      })),
    };
    let index = 0;
    const total = state.selection.upserts.reduce((n, e) => n + e.identity.size, 0);
    if (total > DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes)
      throw new Error('Payload expanded-byte budget exceeded.');
    const projected: CutoffManifest = {
      ...manifest,
      partitions: manifest.partitions.map((p) => ({ ...p, upserts: [] })),
    };
    let projectedIndex = 0;
    for (const target of state.selection.upserts)
      projected.partitions
        .find((p) => p.partitionId === target.partitionId)!
        .upserts.push({
          relativePath: target.relativePath,
          payloadPath: `payload/${String(++projectedIndex).padStart(6, '0')}.bin`,
          contentSha256: 'f'.repeat(64),
          size: target.identity.size,
          mode: target.identity.mode & 0o777,
          mtimeMs: Math.trunc(target.identity.mtimeMs),
        });
    const predicted = cutoffManifestSchema.parse(projected);
    checkManifestBounds(predicted);
    if (
      total +
        Buffer.byteLength(serialize(predicted)) +
        Buffer.byteLength(serialize(packageMetadata(state, ci, predicted))) >
      DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes
    )
      throw new Error('Expanded package metadata+payload budget exceeded.');
    for (const target of state.selection.upserts) {
      const payloadPath = `payload/${String(++index).padStart(6, '0')}.bin`;
      const entry = {
        relativePath: target.relativePath,
        payloadPath,
        size: target.identity.size,
        mode: target.identity.mode & 0o777,
        mtimeMs: Math.trunc(target.identity.mtimeMs),
      };
      const digest = await copyGuardedFile(
        state.model.cacheRoot,
        target.relativePath,
        path.join(directory, payloadPath),
        entry,
        target.identity,
      );
      manifest.partitions
        .find((p) => p.partitionId === target.partitionId)!
        .upserts.push({ ...entry, contentSha256: digest });
    }
    manifest = cutoffManifestSchema.parse(manifest);
    checkManifestBounds(manifest);
    const metadata = packageMetadata(state, ci, manifest);
    const seal = {
      manifest,
      identity: cutoffPackageIdentity({ metadata, manifest }),
      artifactName: metadata.artifactName,
    };
    if (state.seal && JSON.stringify(state.seal) !== JSON.stringify(seal))
      throw new Error('Regenerated package differs from the sealed identity.');
    const candidate = { ...state, seal, phase: 'package-sealed' as const };
    await persistCutoffJournal(candidate);
    Object.assign(state, candidate);
    await writeFile(path.join(directory, MANIFEST), serialize(manifest));
    await writeFile(path.join(directory, META), serialize(metadata));
    return {
      metadata,
      manifest,
      rootDirectory: directory,
      files: [
        path.join(directory, META),
        path.join(directory, MANIFEST),
        ...manifest.partitions.flatMap((p) =>
          p.upserts.map((e) => path.join(directory, e.payloadPath)),
        ),
      ],
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function uploadCutoffPackage(
  backend: WorkflowArtifactBackend,
  pkg: StagedCutoffPackage,
): Promise<WorkflowArtifactDescriptor> {
  if (!backend.capabilities.supportsRetentionDays)
    throw new Error('Artifact backend lacks retention support.');
  return backend.uploadArtifact(pkg.metadata.artifactName, pkg.files, pkg.rootDirectory, {
    retentionDays: 7,
    compressionLevel: 1,
  });
}
async function readBounded(root: string, relative: string): Promise<string> {
  const file = guardedPath(root, relative);
  await verifyParents(root, path.posix.dirname(relative));
  const st = await regularStat(file);
  if (!st || st.size > MAX_JSON) throw new Error('Package JSON is missing or oversized.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fd = await handle.stat();
    if (fd.ino !== st.ino || fd.dev !== st.dev || !fd.isFile())
      throw new Error('Package JSON replaced.');
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const data of handle.createReadStream({ autoClose: false })) {
      const b = Buffer.from(data);
      count += b.length;
      if (count > MAX_JSON) throw new Error('Package JSON grew beyond limit.');
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}
export async function verifyCutoffPackage(
  root: string,
  expectedName?: string,
): Promise<CutoffPackage> {
  await verifyParents(root, '');
  const files = new Set<string>();
  let bytes = 0;
  for (const directory of ['', 'payload']) {
    const absolute = directory ? path.join(root, directory) : root;
    const dirStat = await lstat(absolute).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && directory) return null;
      throw e;
    });
    if (!dirStat) continue;
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
      throw new Error('Invalid package directory.');
    for await (const item of await opendir(absolute)) {
      if (directory === '' && item.name === 'payload') continue;
      const relative = directory ? `${directory}/${item.name}` : item.name;
      const st = await regularStat(guardedPath(root, relative));
      if (!st) throw new Error('Package entry disappeared.');
      files.add(relative);
      bytes += st.size;
      if (
        files.size > DELTA_ARTIFACT_RESOURCE_LIMITS.manifestEntries + 2 ||
        bytes > DELTA_ARTIFACT_RESOURCE_LIMITS.expandedPackageSizeBytes
      )
        throw new Error('Expanded package exceeds resource budget.');
    }
  }
  const metadata = packageSchema.parse(JSON.parse(await readBounded(root, META)));
  const serialized = await readBounded(root, MANIFEST);
  if (cutoffHash(serialized) !== metadata.manifestSha256)
    throw new Error('Package manifest digest mismatch.');
  const manifest = cutoffManifestSchema.parse(JSON.parse(serialized));
  checkManifestBounds(manifest);
  const name = artifactName(
    metadata.producer.jobName,
    metadata.producer.runId,
    metadata.producer.runAttempt,
    metadata.cacheIdentity.familyKey,
    metadata.manifestSha256,
  );
  if (metadata.artifactName !== name || (expectedName && name !== expectedName))
    throw new Error('Package artifact identity mismatch.');
  if (
    JSON.stringify(metadata.cacheIdentity.partitionIds) !==
    JSON.stringify(manifest.partitions.map((p) => p.partitionId))
  )
    throw new Error('Package partition identity mismatch.');
  const expectedFiles = new Set([META, MANIFEST]);
  for (const p of manifest.partitions)
    for (const e of p.upserts) {
      expectedFiles.add(e.payloadPath);
      const file = guardedPath(root, e.payloadPath),
        st = await regularStat(file);
      if (!st || st.size !== e.size || (await hashStableFileSha256(file, st)) !== e.contentSha256)
        throw new Error('Package payload size/SHA-256 mismatch.');
    }
  if (files.size !== expectedFiles.size || [...files].some((p) => !expectedFiles.has(p)))
    throw new Error('Unexpected package entries.');
  return { rootDirectory: root, metadata, manifest };
}
export async function downloadCutoffPackage(
  backend: WorkflowArtifactBackend,
  artifact: WorkflowArtifactDescriptor,
  parent: string,
  expected: {
    repository: string;
    workflowName: string;
    runId: number | null;
    producerJobName: string;
    producerAttempt: number | null;
    sourceRevision: string | null;
  },
): Promise<DownloadedCutoffPackage> {
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'download-'));
  try {
    if (artifact.size > DELTA_ARTIFACT_RESOURCE_LIMITS.selectedArtifactSizeBytes)
      throw new Error('Artifact exceeds download size budget.');
    const result = await backend.downloadArtifact(artifact.id, {
      path: directory,
      expectedHash: artifact.digest ?? undefined,
    });
    const relative = path.relative(directory, path.resolve(result.downloadPath));
    if (
      result.digestMismatch ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error('Unsafe artifact download result.');
    await verifyParents(directory, relative);
    const pkg = await verifyCutoffPackage(result.downloadPath, artifact.name),
      p = pkg.metadata.producer;
    if (
      p.repository !== expected.repository ||
      p.workflowName !== expected.workflowName ||
      p.runId !== expected.runId ||
      p.jobName !== expected.producerJobName ||
      p.runAttempt !== expected.producerAttempt ||
      (expected.sourceRevision !== null && p.sourceRevision !== expected.sourceRevision)
    )
      throw new Error('Selected producer identity mismatch.');
    return { ...pkg, artifact, temporaryDirectory: directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export function assertCutoffPackageCompatible(
  pkg: CutoffPackage,
  model: CacheModel,
  ci: CiJobContext,
): void {
  const id = pkg.metadata.cacheIdentity,
    p = pkg.metadata.producer;
  if (
    id.familyKey !== model.cacheFamilyKey ||
    id.refLineagePrefix !== model.currentRefLineagePrefix ||
    id.partitionFingerprint !== model.partitionFingerprint ||
    JSON.stringify(id.partitionIds) !== JSON.stringify(model.partitions.map((p) => p.id)) ||
    pkg.manifest.buildToolId !== model.buildToolId ||
    p.runnerOs !== ci.runnerOs ||
    p.runnerArch !== ci.runnerArch ||
    p.safeRefName !== ci.safeRefName ||
    p.defaultBranch !== ci.defaultBranch
  )
    throw new Error('Worker package cache/runner/ref identity mismatch.');
  const owns = createManagedCachePathMatcher(model);
  for (const partition of pkg.manifest.partitions)
    for (const name of [...partition.usedPaths, ...partition.upserts.map((e) => e.relativePath)])
      if (!owns(partition.partitionId, name))
        throw new Error('Worker path is outside its managed partition.');
}
