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
import { freezeInstallMetadata } from '../cache/install-inventory';
import { assertCompleteMavenRepositoryDirectories } from '../cache/maven-repository';
import { randomUUID } from 'node:crypto';
import { rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { CacheModel } from '../cache/model';
import type { CiJobContext } from '../ci';
import { assertCutoffPackageCompatible, type CutoffPackage } from './cutoff-service';
import { createManagedCachePathMatcher } from '../cache/manifest';
import {
  cutoffUpsertSchema,
  validateCutoffManifest,
  type CutoffUpsert,
} from '../cache/cutoff-format';
import {
  guardedPath,
  verifyParents,
  regularStat,
  DirectoryValidationBatch,
} from '../cache/guarded-files';
import { fileIdentity, sameFileIdentity, type FileIdentity } from '../cache/file-identity';
import { isReplaceTargetError } from '../util/fs';
import { stageGuardedFiles, moveGuardedFiles } from '../cache/staged-files';
import { portableCacheFileMode } from '../cache/file-permissions';
import { resolveMavenDirectoryConflicts } from './maven-directory-conflicts';
import { resolveGradleEntryConflicts } from './gradle-entry-conflicts';
import { resolveWorkspaceConflicts } from './workspace-conflicts';
import {
  prepareWorkspaceApplication,
  applyWorkspaceApplication,
  type WorkspaceApplicationPlan,
  type IncomingWorkspace,
} from '../cache/workspace-apply';
import { workspaceRoot, isWorkspaceCachePath } from '../cache/immutable-workspaces';

export interface CutoffMergedUpsert {
  partitionId: string;
  entry: CutoffUpsert;
  rootDirectory: string;
}
export interface CutoffMergePlan {
  workspaces?: IncomingWorkspace[];
  directoryConflicts?: { count: number; details: string[] };
  upserts: CutoffMergedUpsert[];
  used: string[];
  snapshots?: { partitionId: string; entries: CutoffUpsert[]; rootDirectory: string }[];
}
export function mergeCutoffPackages(
  packages: readonly CutoffPackage[],
  model: CacheModel,
  ci: CiJobContext,
  allowDuplicates = false,
  ordinaryProducers?: readonly string[],
): CutoffMergePlan {
  const upserts = new Map<string, CutoffMergedUpsert>(),
    used = new Set<string>();
  const validated = packages.map((pkg) => {
    const manifest = validateCutoffManifest(pkg.manifest);
    const candidate = { ...pkg, manifest };
    assertCutoffPackageCompatible(candidate, model, ci);
    return candidate;
  });
  const directories = resolveMavenDirectoryConflicts(
    validated.filter(
      (pkg) => !ordinaryProducers || ordinaryProducers.includes(pkg.metadata.producer.jobName),
    ),
    model,
  );
  const workspaces = resolveWorkspaceConflicts(
    validated.filter(
      (pkg) => !ordinaryProducers || ordinaryProducers.includes(pkg.metadata.producer.jobName),
    ),
    model,
  );
  const archives = resolveGradleEntryConflicts(
    validated.filter(
      (pkg) => !ordinaryProducers || ordinaryProducers.includes(pkg.metadata.producer.jobName),
    ),
    model,
  );
  for (const item of archives.chosen) upserts.set(item.entry.relativePath, item);
  for (const unit of workspaces.chosen)
    for (const entry of unit.entries)
      upserts.set(entry.relativePath, {
        partitionId: unit.partitionId,
        entry,
        rootDirectory: unit.rootDirectory,
      });
  const snapshots = new Map<
    string,
    { partitionId: string; entries: CutoffUpsert[]; rootDirectory: string }
  >();
  for (const pkg of validated) {
    const manifest = pkg.manifest;
    for (const p of manifest.partitions) {
      if (p.snapshot) {
        if (snapshots.has(p.partitionId))
          throw new Error('Multiple snapshots for a single-writer partition.');
        snapshots.set(p.partitionId, {
          partitionId: p.partitionId,
          entries: p.upserts,
          rootDirectory: pkg.rootDirectory,
        });
        continue;
      }
      if (ordinaryProducers && !ordinaryProducers.includes(pkg.metadata.producer.jobName)) continue;
      for (const name of p.usedPaths) used.add(name);
      for (const entry of p.upserts) {
        if (archives.paths.has(entry.relativePath)) continue;
        if (
          model.buildToolId === 'gradle' &&
          workspaces.roots.has(workspaceRoot(entry.relativePath) ?? '')
        )
          continue;
        const winner = directories.winners.get(path.posix.dirname(entry.relativePath));
        if (winner && winner !== pkg) continue;
        const candidate = { partitionId: p.partitionId, entry, rootDirectory: pkg.rootDirectory },
          existing = upserts.get(entry.relativePath);
        if (!existing) {
          upserts.set(entry.relativePath, candidate);
          continue;
        }
        const old = existing.entry;
        const equivalent = old.contentSha256 === entry.contentSha256 && old.size === entry.size;
        if (!equivalent && (!allowDuplicates || old.mtimeMs === entry.mtimeMs))
          throw new Error(`Conflicting worker upserts: ${entry.relativePath}`);
        const selected = entry.mtimeMs > old.mtimeMs ? candidate : existing;
        upserts.set(
          entry.relativePath,
          equivalent
            ? {
                ...selected,
                entry: { ...selected.entry, mode: portableCacheFileMode(old.mode | entry.mode) },
              }
            : selected,
        );
      }
    }
  }
  const selectedPaths = new Set(upserts.keys());
  return validateCutoffPlan(
    {
      ...(workspaces.chosen.length ? { workspaces: workspaces.chosen } : {}),
      ...(directories.count + workspaces.count + archives.count
        ? {
            directoryConflicts: {
              count: directories.count + workspaces.count + archives.count,
              details: [...directories.details, ...workspaces.details, ...archives.details],
            },
          }
        : {}),
      snapshots: [...snapshots.values()],
      upserts: [...upserts.values()].sort((a, b) =>
        a.entry.relativePath.localeCompare(b.entry.relativePath),
      ),
      used: [...used]
        .filter(
          (p) =>
            !selectedPaths.has(p) &&
            !directories.winners.has(path.posix.dirname(p)) &&
            !workspaces.roots.has(workspaceRoot(p) ?? ''),
        )
        .sort((a, b) => a.localeCompare(b)),
    },
    model,
  );
}
export async function applyCutoffPlan(
  plan: CutoffMergePlan,
  model: CacheModel,
  options: { consumeSources?: boolean } = {},
): Promise<{ upserts: string[]; used: string[] }> {
  plan = validateCutoffPlan(plan, model);
  const { workspaceFiles, seen, workspaces } = applicationPlans.get(plan)!;
  if (options.consumeSources) {
    const sources = new Set<string>();
    for (const item of [
      ...plan.upserts,
      ...(plan.snapshots ?? []).flatMap((snapshot) =>
        snapshot.entries.map((entry) => ({ entry, rootDirectory: snapshot.rootDirectory })),
      ),
    ]) {
      const source = path.resolve(item.rootDirectory, item.entry.payloadPath);
      if (sources.has(source))
        throw new Error('Disposable worker payload is shared by selected entries.');
      sources.add(source);
    }
  }
  const before = new Map<string, FileIdentity | null>();
  const preflight = new DirectoryValidationBatch(model.cacheRoot);
  // Validate every target and parent before the first mutation; never read target contents.
  for (const name of [...plan.upserts.map((e) => e.entry.relativePath), ...plan.used]) {
    if (workspaceFiles.has(name)) continue;
    await verifyParents(model.cacheRoot, path.posix.dirname(name), false, preflight);
    const stat = await regularStat(guardedPath(model.cacheRoot, name));
    before.set(name, stat ? fileIdentity(stat) : null);
  }
  await assertCompleteMavenRepositoryDirectories(model, seen);
  await applyWorkspaceApplication(workspaces, model, options.consumeSources);
  const staged = plan.upserts
    .filter((item) => !workspaceFiles.has(item.entry.relativePath))
    .map((item) => {
      const parent = path.posix.dirname(item.entry.relativePath);
      const destination =
        (parent === '.' ? '' : parent + '/') + '.mammoth/write-' + randomUUID() + '.tmp';
      return { item, destination, scratch: guardedPath(model.cacheRoot, destination) };
    });
  try {
    const stage = options.consumeSources ? moveGuardedFiles : stageGuardedFiles;
    const identities = await stage(
      model.cacheRoot,
      staged.map(({ item, destination }) => ({
        sourceRoot: item.rootDirectory,
        sourcePath: item.entry.payloadPath,
        destination,
        expected: {
          ...item.entry,
          mode: portableCacheFileMode(item.entry.mode, model.buildToolId, item.entry.relativePath),
        },
      })),
      'verified',
    );
    // Source staging may yield to external I/O; never reuse its destination evidence at commit.
    const commit = new DirectoryValidationBatch(model.cacheRoot);
    for (const { item, scratch, destination } of staged) {
      const name = item.entry.relativePath,
        target = guardedPath(model.cacheRoot, name);
      await verifyParents(
        model.cacheRoot,
        path.posix.dirname(path.relative(model.cacheRoot, scratch).split(path.sep).join('/')),
        false,
        commit,
      );
      const stagedStat = await regularStat(scratch);
      if (
        !stagedStat ||
        !sameFileIdentity(identities.get(destination)!, fileIdentity(stagedStat), true)
      )
        throw new Error('Upsert staging changed before replacement.');
      const actual = await regularStat(target),
        expected = before.get(name);
      if (
        (expected === null) !== (actual === null) ||
        (expected && actual && !sameFileIdentity(expected, fileIdentity(actual), true))
      )
        throw new Error(`Upsert target changed before replacement: ${name}`);
      try {
        await rename(scratch, target);
      } catch (error) {
        if (!actual || !isReplaceTargetError(error)) throw error;
        const again = await regularStat(target);
        if (!again || !sameFileIdentity(fileIdentity(actual), fileIdentity(again), true))
          throw new Error('Upsert target changed before replacement.', { cause: error });
        await rm(target);
        await rename(scratch, target);
      }
    }
  } finally {
    const cleanup = new DirectoryValidationBatch(model.cacheRoot);
    for (const { scratch } of staged) {
      await verifyParents(
        model.cacheRoot,
        path.posix.dirname(path.relative(model.cacheRoot, scratch).split(path.sep).join('/')),
        false,
        cleanup,
      );
      await rm(scratch, { force: true });
    }
    for (const directory of new Set(staged.map(({ scratch }) => path.dirname(scratch)))) {
      cleanup.invalidate(path.relative(model.cacheRoot, directory).split(path.sep).join('/'));
      await rmdir(directory).catch((error: unknown) => {
        if (
          !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
      });
    }
  }
  return {
    upserts: plan.upserts.map((e) => e.entry.relativePath),
    used: plan.used.filter((p) => before.get(p) !== null),
  };
}

interface ApplicationEvidence {
  binding: string;
  workspaceFiles: Set<string>;
  seen: Set<string>;
  workspaces: WorkspaceApplicationPlan;
}
const applicationPlans = new WeakMap<CutoffMergePlan, ApplicationEvidence>();
function applicationBinding(model: CacheModel): string {
  return JSON.stringify([
    model.buildToolId,
    model.cacheFamilyKey,
    model.partitionFingerprint,
    model.partitions.map((p) => [
      p.id,
      p.relativeIncludeGlobs,
      p.relativeExcludeGlobs,
      p.publication,
      p.writer,
    ]),
  ]);
}
function validateCutoffPlan(plan: CutoffMergePlan, model: CacheModel): CutoffMergePlan {
  const binding = applicationBinding(model);
  if (applicationPlans.get(plan)?.binding === binding) return plan;
  plan = {
    ...plan,
    upserts: plan.upserts.map((item) => ({ ...item, entry: cutoffUpsertSchema.parse(item.entry) })),
  };
  const owns = createManagedCachePathMatcher(model),
    seen = new Set<string>();
  for (const item of plan.upserts) {
    if (seen.has(item.entry.relativePath) || !owns(item.partitionId, item.entry.relativePath))
      throw new Error('Invalid upsert ownership/duplicate.');
    seen.add(item.entry.relativePath);
  }
  for (const name of plan.used)
    if (!model.partitions.some((p) => owns(p.id, name)))
      throw new Error('Invalid usage ownership.');
  const byPath = new Map(plan.upserts.map((e) => [e.entry.relativePath, e]));
  const workspaceFiles = new Set<string>();
  for (const unit of plan.workspaces ?? [])
    for (const entry of unit.entries) {
      const actual = byPath.get(entry.relativePath);
      if (
        !actual ||
        actual.partitionId !== unit.partitionId ||
        actual.rootDirectory !== unit.rootDirectory ||
        JSON.stringify(actual.entry) !== JSON.stringify(cutoffUpsertSchema.parse(entry))
      )
        throw new Error('Gradle replacement differs from the merged plan.');
      workspaceFiles.add(entry.relativePath);
    }
  if (
    model.buildToolId === 'gradle' &&
    plan.upserts.some(
      (e) =>
        isWorkspaceCachePath(e.entry.relativePath) && !workspaceFiles.has(e.entry.relativePath),
    )
  )
    throw new Error('Gradle upsert requires a complete workspace replacement.');
  const workspaces = prepareWorkspaceApplication(plan.workspaces ?? [], model);
  plan = freezeInstallMetadata({ ...plan, workspaces: [...workspaces.units] });
  applicationPlans.set(plan, { binding, workspaceFiles, seen, workspaces });
  return plan;
}
