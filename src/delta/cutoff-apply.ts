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
import { randomUUID } from 'node:crypto';
import { chmod, utimes, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { CacheModel } from '../cache/model';
import type { CiJobContext } from '../ci';
import { assertCutoffPackageCompatible, type CutoffPackage } from './cutoff-service';
import { createManagedCachePathMatcher } from '../cache/manifest';
import {
  cutoffUpsertSchema,
  cutoffManifestSchema,
  type CutoffUpsert,
} from '../cache/cutoff-format';
import { guardedPath, verifyParents, regularStat, copyGuardedFile } from '../cache/guarded-files';
import { fileIdentity, sameFileIdentity, type FileIdentity } from '../cache/file-identity';
import { isReplaceTargetError } from '../util/fs';
import { portableCacheFileMode } from '../cache/file-permissions';
import { resolveMavenDirectoryConflicts } from './maven-directory-conflicts';
import { resolveGroovyWorkspaceConflicts } from './groovy-workspace-conflicts';
import { applyGroovyWorkspaces, type IncomingGroovyWorkspace } from '../cache/groovy-apply';
import { groovyWorkspaceRoot, isGroovyCachePath } from '../cache/groovy-workspaces';

export interface CutoffMergedUpsert {
  partitionId: string;
  entry: CutoffUpsert;
  rootDirectory: string;
}
export interface CutoffMergePlan {
  groovyWorkspaces?: IncomingGroovyWorkspace[];
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
    const manifest = cutoffManifestSchema.parse(pkg.manifest);
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
  const groovy = resolveGroovyWorkspaceConflicts(
    validated.filter(
      (pkg) => !ordinaryProducers || ordinaryProducers.includes(pkg.metadata.producer.jobName),
    ),
    model,
  );
  for (const unit of groovy.chosen)
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
        if (
          model.buildToolId === 'gradle' &&
          groovy.roots.has(groovyWorkspaceRoot(entry.relativePath) ?? '')
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
  return {
    ...(groovy.chosen.length ? { groovyWorkspaces: groovy.chosen } : {}),
    ...(directories.count + groovy.count
      ? {
          directoryConflicts: {
            count: directories.count + groovy.count,
            details: [...directories.details, ...groovy.details],
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
          !groovy.roots.has(groovyWorkspaceRoot(p) ?? ''),
      )
      .sort((a, b) => a.localeCompare(b)),
  };
}
export async function applyCutoffPlan(
  plan: CutoffMergePlan,
  model: CacheModel,
): Promise<{ upserts: string[]; used: string[] }> {
  plan = {
    ...plan,
    upserts: plan.upserts.map((item) => ({ ...item, entry: cutoffUpsertSchema.parse(item.entry) })),
  };
  const owns = createManagedCachePathMatcher(model),
    seen = new Set<string>();
  for (const item of plan.upserts) {
    cutoffUpsertSchema.parse(item.entry);
    if (seen.has(item.entry.relativePath) || !owns(item.partitionId, item.entry.relativePath))
      throw new Error('Invalid upsert ownership/duplicate.');
    seen.add(item.entry.relativePath);
  }
  for (const name of plan.used)
    if (!model.partitions.some((p) => owns(p.id, name)))
      throw new Error('Invalid usage ownership.');
  const byPath = new Map(plan.upserts.map((e) => [e.entry.relativePath, e]));
  const groovyFiles = new Set<string>();
  for (const unit of plan.groovyWorkspaces ?? [])
    for (const entry of unit.entries) {
      const actual = byPath.get(entry.relativePath);
      if (
        !actual ||
        actual.partitionId !== unit.partitionId ||
        actual.rootDirectory !== unit.rootDirectory ||
        JSON.stringify(actual.entry) !== JSON.stringify(cutoffUpsertSchema.parse(entry))
      )
        throw new Error('Groovy replacement differs from the merged plan.');
      groovyFiles.add(entry.relativePath);
    }
  if (
    model.buildToolId === 'gradle' &&
    plan.upserts.some(
      (e) => isGroovyCachePath(e.entry.relativePath) && !groovyFiles.has(e.entry.relativePath),
    )
  )
    throw new Error('Groovy upsert requires a complete workspace replacement.');
  const before = new Map<string, FileIdentity | null>();
  // Validate every target and parent before the first mutation; never read target contents.
  for (const name of [...plan.upserts.map((e) => e.entry.relativePath), ...plan.used]) {
    if (groovyFiles.has(name)) continue;
    await verifyParents(model.cacheRoot, path.posix.dirname(name));
    const stat = await regularStat(guardedPath(model.cacheRoot, name));
    before.set(name, stat ? fileIdentity(stat) : null);
  }
  await assertCompleteMavenRepositoryDirectories(model, seen);
  await applyGroovyWorkspaces(plan.groovyWorkspaces ?? [], model);
  for (const item of plan.upserts) {
    if (groovyFiles.has(item.entry.relativePath)) continue;
    const name = item.entry.relativePath,
      target = guardedPath(model.cacheRoot, name),
      parent = path.posix.dirname(name);
    // A reserved subdirectory on the target filesystem permits atomic rename across mounted partitions.
    const scratchRelative = parent === '.' ? '.mammoth' : `${parent}/.mammoth`;
    await verifyParents(model.cacheRoot, scratchRelative, true);
    const scratch = guardedPath(model.cacheRoot, `${scratchRelative}/write-${randomUUID()}.tmp`);
    try {
      await copyGuardedFile(item.rootDirectory, item.entry.payloadPath, scratch, {
        size: item.entry.size,
        contentSha256: item.entry.contentSha256,
      });
      await chmod(
        scratch,
        portableCacheFileMode(item.entry.mode, model.buildToolId, item.entry.relativePath),
      );
      await utimes(scratch, new Date(item.entry.mtimeMs), new Date(item.entry.mtimeMs));
      await verifyParents(model.cacheRoot, parent);
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
    } finally {
      await rm(scratch, { force: true });
      await rmdir(path.dirname(scratch)).catch((error: unknown) => {
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
