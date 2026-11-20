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
import { freezeInstallMetadata } from './install-inventory';
import { assertBaseInstallPlan, type BasePartitionInstallPlan } from './base-install-plan';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CacheModel } from './model';
import type { CutoffUpsert } from './cutoff-format';
import {
  workspaceRoot,
  inspectWorkspaceTree,
  assertWorkspaceOwnership,
  type ImmutableWorkspace,
} from './immutable-workspaces';
import { createManagedCachePathMatcher } from './manifest';
import {
  guardedPath,
  verifyParents,
  regularStat,
  type PayloadIntegrity,
  DirectoryValidationBatch,
} from './guarded-files';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';
import { readMetadata, writeMetadata, metadataPath } from './metadata-io';
import { stageGuardedFiles, moveGuardedFiles } from './staged-files';
import { portableCacheFileMode, repairCacheFileMetadata } from './file-permissions';
import { isMissingPathError } from '../util/fs';

const INTENT = '.mammoth/workspace-apply-v3/intent.json';
const MAX_BYTES = 64 * 1024 * 1024;
export interface IncomingWorkspace {
  partitionId: string;
  workspace: ImmutableWorkspace;
  entries: readonly CutoffUpsert[];
  rootDirectory: string;
}
const intentSchema = z
  .object({
    schemaVersion: z.literal(3),
    familyKey: z.string(),
    partitionId: z.string(),
    root: z.string(),
    stage: z.string(),
    allowedFiles: z.array(z.string()).max(200_000),
    allowedDirectories: z.array(z.string()).max(200_000),
  })
  .strict();
async function clearIntent(model: CacheModel) {
  const file = await metadataPath(model.cacheRoot, INTENT);
  await regularStat(file);
  await rm(file, { force: true });
}
async function removeScratch(model: CacheModel, relative: string) {
  const tree = await inspectWorkspaceTree(model.cacheRoot, relative, false);
  if (tree) {
    if (!tree.directories.some((directory) => directory.relativePath === relative))
      throw new Error('Unsafe workspace scratch directory.');
    await rm(guardedPath(model.cacheRoot, relative), { recursive: true });
  }
}
function allowedStage(root: string, stage: string): boolean {
  const parent = path.posix.dirname(root);
  return (
    stage.startsWith(parent + '/.mammoth/stage-') &&
    /^[a-f0-9-]{36}$/u.test(stage.slice((parent + '/.mammoth/stage-').length))
  );
}
async function targetTree(
  model: CacheModel,
  partitionId: string,
  root: string,
  owns = createManagedCachePathMatcher(model),
) {
  if (workspaceRoot(root) !== root) throw new Error('Invalid Gradle replacement root.');
  await verifyParents(model.cacheRoot, path.posix.dirname(root));
  const existing = await lstat(guardedPath(model.cacheRoot, root)).catch((error: unknown) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!existing) return null;
  const tree = await inspectWorkspaceTree(model.cacheRoot, root, false);
  if (tree && !tree.directories.some((d) => d.relativePath === root))
    throw new Error('Gradle workspace target is not a directory.');
  if (
    tree &&
    (tree.files.some((f) => !owns(partitionId, f.relativePath)) ||
      tree.directories.some(
        (d) => !owns(partitionId, d.relativePath + '/.workspace-directory-probe'),
      ))
  )
    throw new Error('Gradle replacement is obstructed by excluded or unmanaged descendants.');
  return tree;
}
async function deleteTree(
  model: CacheModel,
  root: string,
  tree: NonNullable<Awaited<ReturnType<typeof inspectWorkspaceTree>>>,
) {
  const directories = new DirectoryValidationBatch(model.cacheRoot);
  for (const entry of tree.files) {
    await verifyParents(
      model.cacheRoot,
      path.posix.dirname(entry.relativePath),
      false,
      directories,
    );
    const current = await regularStat(guardedPath(model.cacheRoot, entry.relativePath));
    if (!current || !sameFileIdentity(entry.identity, fileIdentity(current), true))
      throw new Error('Gradle replacement target changed.');
    await rm(guardedPath(model.cacheRoot, entry.relativePath));
  }
  for (const entry of [...tree.directories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  )) {
    await verifyParents(
      model.cacheRoot,
      path.posix.dirname(entry.relativePath),
      false,
      directories,
    );
    const current = await lstat(guardedPath(model.cacheRoot, entry.relativePath));
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== entry.identity.ino ||
      current.dev !== entry.identity.dev
    )
      throw new Error('Gradle replacement directory changed.');
    directories.invalidate(entry.relativePath);
    await rmdir(guardedPath(model.cacheRoot, entry.relativePath));
  }
  if (tree.directories.every((d) => d.relativePath !== root))
    throw new Error('Replacement did not inventory its root.');
}
/** A failed prepare cannot publish; the next prepare discards only its recorded partial unit. */
export async function recoverWorkspaceApplication(model: CacheModel): Promise<void> {
  for (const previous of [
    '.mammoth/groovy-apply-v1/intent.json',
    '.mammoth/workspace-apply-v2/intent.json',
  ]) {
    if ((await readMetadata(model.cacheRoot, previous, MAX_BYTES)) !== null)
      throw new Error('Incompatible previous-format workspace replacement intent.');
  }
  const raw = await readMetadata(model.cacheRoot, INTENT, MAX_BYTES);
  if (raw === null) return;
  const intent = intentSchema.parse(JSON.parse(raw));
  const owns = createManagedCachePathMatcher(model);
  if (
    intent.familyKey !== model.cacheFamilyKey ||
    model.buildToolId !== 'gradle' ||
    workspaceRoot(intent.root) !== intent.root ||
    !allowedStage(intent.root, intent.stage) ||
    !owns(intent.partitionId, intent.root + '/metadata.bin') ||
    intent.allowedFiles.some(
      (p) => !p.startsWith(intent.root + '/') || !owns(intent.partitionId, p),
    ) ||
    intent.allowedDirectories.some(
      (p) =>
        (p !== intent.root && !p.startsWith(intent.root + '/')) ||
        !owns(intent.partitionId, p + '/.workspace-directory-probe'),
    )
  )
    throw new Error('Invalid interrupted Gradle replacement intent.');
  const tree = await targetTree(model, intent.partitionId, intent.root);
  if (tree) {
    const files = new Set(intent.allowedFiles),
      dirs = new Set(intent.allowedDirectories);
    if (
      tree.files.some((f) => !files.has(f.relativePath)) ||
      tree.directories.some((d) => !dirs.has(d.relativePath))
    )
      throw new Error('Interrupted Gradle replacement has unexpected descendants.');
    await deleteTree(model, intent.root, tree);
  }
  await removeScratch(model, intent.stage);
  await clearIntent(model);
}
function treeIdentity(tree: Awaited<ReturnType<typeof inspectWorkspaceTree>>): string {
  return JSON.stringify(
    tree
      ? [...tree.files, ...tree.directories].map(({ relativePath, identity: i }) => [
          relativePath,
          i.dev,
          i.ino,
          i.mode,
          i.size,
          i.mtimeMs,
          i.ctimeMs,
        ])
      : null,
  );
}

/** Preflight every destination before changing any unit; publish only complete staged trees. */
async function applyWorkspaceUnits(
  units: readonly IncomingWorkspace[],
  model: CacheModel,
  consumeSources = false,
  integrity: PayloadIntegrity = 'verified',
  basePlan?: BasePartitionInstallPlan,
  metadataValidated = false,
): Promise<void> {
  if (units.length && model.buildToolId !== 'gradle')
    throw new Error('Gradle replacement requires a Gradle cache.');
  const owns = createManagedCachePathMatcher(model);
  const roots = new Set<string>();
  const before = new Map<string, string>();
  for (const unit of units) {
    if (!basePlan && !metadataValidated)
      assertWorkspaceOwnership(unit.workspace, unit.partitionId, owns);
    if (roots.has(unit.workspace.root)) throw new Error('Duplicate Gradle replacement root.');
    roots.add(unit.workspace.root);
    if (
      !basePlan &&
      !metadataValidated &&
      JSON.stringify(unit.entries.map((e) => e.relativePath).sort((a, b) => a.localeCompare(b))) !==
        JSON.stringify(unit.workspace.files)
    )
      throw new Error('Incomplete Gradle replacement payload.');
    before.set(
      unit.workspace.root,
      treeIdentity(await targetTree(model, unit.partitionId, unit.workspace.root, owns)),
    );
  }
  for (const unit of units) {
    const root = unit.workspace.root,
      parent = path.posix.dirname(root);
    const stage = parent + '/.mammoth/stage-' + randomUUID();
    let nativeStaged = false;
    const nativeDirectories = basePlan?.workspaceDirectories.get(root);
    if (basePlan) {
      await prepareNativeWorkspace(basePlan, unit, model, nativeDirectories!);
      const old = await targetTree(model, unit.partitionId, root, owns);
      if (treeIdentity(old) !== before.get(root))
        throw new Error('Gradle replacement target changed during staging.');
      await verifyParents(model.cacheRoot, parent, true);
      await nativeStageTree(
        basePlan,
        unit,
        { ...model, cacheRoot: unit.rootDirectory },
        root,
        nativeDirectories!,
        false,
      );
      try {
        if (!old) {
          if (await pathExists(guardedPath(model.cacheRoot, root)))
            throw new Error('Gradle replacement root was recreated.');
          await rename(guardedPath(unit.rootDirectory, root), guardedPath(model.cacheRoot, root));
          continue;
        }
        await verifyParents(model.cacheRoot, path.posix.dirname(stage), true);
        await rename(guardedPath(unit.rootDirectory, root), guardedPath(model.cacheRoot, stage));
        nativeStaged = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      }
    }

    const staging = new DirectoryValidationBatch(model.cacheRoot);
    if (!nativeStaged) await verifyParents(model.cacheRoot, stage, true, staging);
    let intentWritten = false;
    try {
      if (!nativeStaged) {
        for (const directory of unit.workspace.emptyDirectories)
          await verifyParents(model.cacheRoot, stage + directory.slice(root.length), true, staging);
        const stageFiles = consumeSources ? moveGuardedFiles : stageGuardedFiles;
        await stageFiles(
          model.cacheRoot,
          unit.entries.map((entry) => ({
            sourceRoot: unit.rootDirectory,
            sourcePath: entry.payloadPath,
            destination: stage + entry.relativePath.slice(root.length),
            native: basePlan?.inventory.files.get(entry.payloadPath),
            expected: {
              ...entry,
              mode: portableCacheFileMode(entry.mode, 'gradle', entry.relativePath),
            },
          })),
          integrity,
        );
      }
      const old = await targetTree(model, unit.partitionId, root, owns);
      if (treeIdentity(old) !== before.get(root))
        throw new Error('Gradle replacement target changed during staging.');
      const staged =
        nativeStaged && basePlan
          ? await nativeStageTree(basePlan, unit, model, stage, nativeDirectories!)
          : await inspectWorkspaceTree(model.cacheRoot, stage, false);
      if (!staged) throw new Error('Gradle replacement staging disappeared.');
      if (
        JSON.stringify(staged.files.map((f) => root + f.relativePath.slice(stage.length))) !==
          JSON.stringify(unit.workspace.files) ||
        JSON.stringify(staged.emptyDirectories.map((d) => root + d.slice(stage.length))) !==
          JSON.stringify(unit.workspace.emptyDirectories)
      )
        throw new Error('Gradle staging membership changed.');
      if (!old) {
        await verifyParents(model.cacheRoot, parent, true);
        if (await pathExists(guardedPath(model.cacheRoot, root)))
          throw new Error('Gradle replacement root was recreated.');
        await rename(guardedPath(model.cacheRoot, stage), guardedPath(model.cacheRoot, root));
        continue;
      }
      await writeMetadata(
        model.cacheRoot,
        INTENT,
        intentSchema.parse({
          schemaVersion: 3,
          familyKey: model.cacheFamilyKey,
          partitionId: unit.partitionId,
          root,
          stage,
          allowedFiles: [
            ...new Set([...(old?.files.map((e) => e.relativePath) ?? []), ...unit.workspace.files]),
          ],
          allowedDirectories: [
            ...new Set([
              ...(old?.directories.map((e) => e.relativePath) ?? []),
              ...staged.directories.map((d) => root + d.relativePath.slice(stage.length)),
            ]),
          ],
        }),
        MAX_BYTES,
      );
      intentWritten = true;
      if (old) await deleteTree(model, root, old);
      await verifyParents(model.cacheRoot, parent, true);
      // Nonempty directories are never replaced in place: the destination was fully preflighted and removed.
      const occupied = await lstat(guardedPath(model.cacheRoot, root)).catch((e: unknown) => {
        if (isMissingPathError(e)) return null;
        throw e;
      });
      if (occupied) throw new Error('Gradle replacement root was recreated.');
      await rename(guardedPath(model.cacheRoot, stage), guardedPath(model.cacheRoot, root));
      await clearIntent(model);
      intentWritten = false;
    } finally {
      if (!intentWritten) await removeScratch(model, stage);
    }
  }
}

export interface WorkspaceApplicationPlan {
  readonly units: readonly IncomingWorkspace[];
}
const workspacePlans = new WeakMap<WorkspaceApplicationPlan, string>();
function workspaceModelBinding(model: CacheModel): string {
  return JSON.stringify([
    model.buildToolId,
    model.cacheFamilyKey,
    model.partitionFingerprint,
    model.partitions.map((p) => [p.id, p.relativeIncludeGlobs, p.relativeExcludeGlobs]),
  ]);
}
export function prepareWorkspaceApplication(
  units: readonly IncomingWorkspace[],
  model: CacheModel,
): WorkspaceApplicationPlan {
  const copy = structuredClone(units);
  const owns = createManagedCachePathMatcher(model),
    roots = new Set<string>();
  for (const unit of copy) {
    assertWorkspaceOwnership(unit.workspace, unit.partitionId, owns);
    if (roots.has(unit.workspace.root)) throw new Error('Duplicate Gradle replacement root.');
    roots.add(unit.workspace.root);
    if (
      JSON.stringify(
        unit.entries.map((entry) => entry.relativePath).sort((a, b) => a.localeCompare(b)),
      ) !== JSON.stringify(unit.workspace.files)
    )
      throw new Error('Incomplete Gradle replacement payload.');
  }
  const plan = freezeInstallMetadata({ units: copy });
  workspacePlans.set(plan, workspaceModelBinding(model));
  return plan;
}
export async function applyWorkspaceApplication(
  plan: WorkspaceApplicationPlan,
  model: CacheModel,
  consumeSources = false,
  integrity: PayloadIntegrity = 'verified',
): Promise<void> {
  if (workspacePlans.get(plan) !== workspaceModelBinding(model))
    throw new Error('Invalid workspace installation plan/model.');
  await applyWorkspaceUnits(plan.units, model, consumeSources, integrity, undefined, true);
}
export async function applyWorkspaces(
  units: readonly IncomingWorkspace[],
  model: CacheModel,
  consumeSources = false,
  integrity: PayloadIntegrity = 'verified',
): Promise<void> {
  await applyWorkspaceApplication(
    prepareWorkspaceApplication(units, model),
    model,
    consumeSources,
    integrity,
  );
}
export async function applyBaseWorkspaces(
  plan: BasePartitionInstallPlan,
  model: CacheModel,
): Promise<void> {
  assertBaseInstallPlan(plan, model);
  const byPath = new Map(plan.descriptor.files.map((entry) => [entry.relativePath, entry]));
  await applyWorkspaceUnits(
    plan.descriptor.workspaces.map((workspace) => ({
      partitionId: plan.descriptor.identity.partitionId,
      workspace,
      entries: workspace.files.map((name) => byPath.get(name)!),
      rootDirectory: plan.rootDirectory,
    })),
    model,
    true,
    'trusted-base',
    plan,
  );
}
async function pathExists(name: string): Promise<boolean> {
  return lstat(name).then(
    () => true,
    (error: unknown) => {
      if (isMissingPathError(error)) return false;
      throw error;
    },
  );
}
async function prepareNativeWorkspace(
  plan: BasePartitionInstallPlan,
  unit: IncomingWorkspace,
  model: CacheModel,
  directories: ReadonlyMap<string, FileIdentity>,
): Promise<void> {
  const root = unit.workspace.root;
  await verifyParents(unit.rootDirectory, path.posix.dirname(root));
  for (const [name, identity] of directories) {
    const stat = await lstat(guardedPath(unit.rootDirectory, name));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !sameFileIdentity(identity, fileIdentity(stat), true)
    )
      throw new Error('Native workspace directory changed.');
  }
  for (const entry of unit.entries) {
    const source = guardedPath(unit.rootDirectory, entry.payloadPath);
    const current = await regularStat(source);
    if (
      !current ||
      !sameFileIdentity(plan.inventory.files.get(entry.payloadPath)!, fileIdentity(current), true)
    )
      throw new Error('Native workspace source changed.');
    const repaired = await repairCacheFileMetadata(source, fileIdentity(current), {
      mode: portableCacheFileMode(entry.mode, model.buildToolId, entry.relativePath),
      mtimeMs: entry.mtimeMs,
    });
    if (repaired) plan.inventory.files.set(entry.payloadPath, fileIdentity(await lstat(source)));
  }
}
async function nativeStageTree(
  plan: BasePartitionInstallPlan,
  unit: IncomingWorkspace,
  model: CacheModel,
  stage: string,
  sourceDirectories: ReadonlyMap<string, FileIdentity>,
  renamed = true,
) {
  const root = unit.workspace.root;
  const files = [],
    directories = [];
  await verifyParents(model.cacheRoot, path.posix.dirname(stage));
  for (const entry of unit.entries) {
    const relativePath = stage + entry.relativePath.slice(root.length);
    const stat = await regularStat(guardedPath(model.cacheRoot, relativePath));
    if (
      !stat ||
      !sameFileIdentity(plan.inventory.files.get(entry.payloadPath)!, fileIdentity(stat), true)
    )
      throw new Error('Native workspace staging changed.');
    files.push({ relativePath, identity: fileIdentity(stat) });
  }
  for (const [name, identity] of sourceDirectories) {
    const relativePath = stage + name.slice(root.length);
    const stat = await lstat(guardedPath(model.cacheRoot, relativePath));
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (name === root && renamed
        ? stat.dev !== identity.dev ||
          stat.ino !== identity.ino ||
          stat.mode !== identity.mode ||
          stat.size !== identity.size ||
          stat.mtimeMs !== identity.mtimeMs
        : !sameFileIdentity(identity, fileIdentity(stat), true))
    )
      throw new Error('Native workspace staging directory changed.');
    directories.push({ relativePath, identity: fileIdentity(stat) });
  }
  return {
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    directories: directories.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    emptyDirectories: unit.workspace.emptyDirectories.map(
      (name) => stage + name.slice(root.length),
    ),
  };
}

/** Inspect only reserved stage namespaces in supported, managed Gradle layout parents. */
export async function recoverWorkspaceScratch(model: CacheModel): Promise<void> {
  if (model.buildToolId !== 'gradle') return;
  const owns = createManagedCachePathMatcher(model);
  await verifyParents(model.cacheRoot, 'caches');
  const versions = await readdir(guardedPath(model.cacheRoot, 'caches'), {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (isMissingPathError(error)) return [];
    throw error;
  });
  if (versions.length > 200_000) throw new Error('Workspace scratch discovery exceeds bounds.');
  const parents = new Set(['caches/transforms-4']);
  for (const entry of versions) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const version = entry.name;
    for (const suffix of ['groovy-dsl', 'transforms', 'kotlin-dsl/scripts', 'kotlin-dsl/accessors'])
      parents.add('caches/' + version + '/' + suffix);
  }
  for (const parent of parents) {
    const probe = parent + '/' + 'a'.repeat(32) + '/metadata.bin';
    if (!model.partitions.some((partition) => owns(partition.id, probe))) continue;
    const reserved = parent + '/.mammoth';
    await verifyParents(model.cacheRoot, reserved);
    const names = await readdir(guardedPath(model.cacheRoot, reserved)).catch((error: unknown) => {
      if (isMissingPathError(error)) return [];
      throw error;
    });
    if (names.length > 200_000) throw new Error('Workspace scratch discovery exceeds bounds.');
    for (const name of names) {
      if (!/^stage-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(name)) continue;
      await removeScratch(model, reserved + '/' + name);
    }
  }
}
