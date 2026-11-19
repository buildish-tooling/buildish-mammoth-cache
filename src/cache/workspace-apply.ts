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
import { randomUUID } from 'node:crypto';
import { chmod, lstat, rename, rm, rmdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CacheModel } from './model';
import type { CutoffUpsert } from './cutoff-format';
import {
  workspaceRoot,
  workspaceSchema,
  inspectWorkspaceTree,
  assertWorkspaceOwnership,
  type ImmutableWorkspace,
} from './immutable-workspaces';
import { createManagedCachePathMatcher } from './manifest';
import {
  guardedPath,
  verifyParents,
  regularStat,
  copyGuardedFile,
  moveGuardedFile,
} from './guarded-files';
import { fileIdentity, sameFileIdentity } from './file-identity';
import { readMetadata, writeMetadata, metadataPath } from './metadata-io';
import { portableCacheFileMode } from './file-permissions';
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
  if (tree) await rm(guardedPath(model.cacheRoot, relative), { recursive: true });
}
function allowedStage(root: string, stage: string): boolean {
  const parent = path.posix.dirname(root);
  return (
    stage.startsWith(parent + '/.mammoth/stage-') &&
    /^[a-f0-9-]{36}$/u.test(stage.slice((parent + '/.mammoth/stage-').length))
  );
}
async function targetTree(model: CacheModel, partitionId: string, root: string) {
  if (workspaceRoot(root) !== root) throw new Error('Invalid Gradle replacement root.');
  const tree = await inspectWorkspaceTree(model.cacheRoot, root, false);
  const owns = createManagedCachePathMatcher(model);
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
  for (const entry of tree.files) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath));
    const current = await regularStat(guardedPath(model.cacheRoot, entry.relativePath));
    if (!current || !sameFileIdentity(entry.identity, fileIdentity(current), true))
      throw new Error('Gradle replacement target changed.');
    await rm(guardedPath(model.cacheRoot, entry.relativePath));
  }
  for (const entry of [...tree.directories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length,
  )) {
    await verifyParents(model.cacheRoot, path.posix.dirname(entry.relativePath));
    const current = await lstat(guardedPath(model.cacheRoot, entry.relativePath));
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== entry.identity.ino ||
      current.dev !== entry.identity.dev
    )
      throw new Error('Gradle replacement directory changed.');
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
export async function applyWorkspaces(
  units: readonly IncomingWorkspace[],
  model: CacheModel,
  consumeSources = false,
): Promise<void> {
  if (units.length && model.buildToolId !== 'gradle')
    throw new Error('Gradle replacement requires a Gradle cache.');
  const owns = createManagedCachePathMatcher(model);
  const roots = new Set<string>();
  const before = new Map<string, string>();
  for (const unit of units) {
    workspaceSchema.parse(unit.workspace);
    assertWorkspaceOwnership(unit.workspace, unit.partitionId, owns);
    if (roots.has(unit.workspace.root)) throw new Error('Duplicate Gradle replacement root.');
    roots.add(unit.workspace.root);
    if (
      JSON.stringify(unit.entries.map((e) => e.relativePath).sort((a, b) => a.localeCompare(b))) !==
      JSON.stringify(unit.workspace.files)
    )
      throw new Error('Incomplete Gradle replacement payload.');
    before.set(
      unit.workspace.root,
      treeIdentity(await targetTree(model, unit.partitionId, unit.workspace.root)),
    );
  }
  for (const unit of units) {
    const root = unit.workspace.root,
      parent = path.posix.dirname(root);
    const stage = parent + '/.mammoth/stage-' + randomUUID();
    await verifyParents(model.cacheRoot, stage, true);
    let intentWritten = false;
    try {
      for (const directory of unit.workspace.emptyDirectories)
        await verifyParents(model.cacheRoot, stage + directory.slice(root.length), true);
      for (const entry of unit.entries) {
        const destination = stage + entry.relativePath.slice(root.length);
        await verifyParents(model.cacheRoot, path.posix.dirname(destination), true);
        const target = guardedPath(model.cacheRoot, destination);
        const expected = { size: entry.size, contentSha256: entry.contentSha256 };
        if (consumeSources)
          await moveGuardedFile(
            unit.rootDirectory,
            entry.payloadPath,
            target,
            expected,
            model.cacheRoot,
          );
        else await copyGuardedFile(unit.rootDirectory, entry.payloadPath, target, expected);
        await chmod(target, portableCacheFileMode(entry.mode, 'gradle', entry.relativePath));
        await utimes(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
      }
      const old = await targetTree(model, unit.partitionId, root);
      if (treeIdentity(old) !== before.get(root))
        throw new Error('Gradle replacement target changed during staging.');
      const staged = await inspectWorkspaceTree(model.cacheRoot, stage, false);
      if (!staged) throw new Error('Gradle replacement staging disappeared.');
      if (
        JSON.stringify(staged.files.map((f) => root + f.relativePath.slice(stage.length))) !==
          JSON.stringify(unit.workspace.files) ||
        JSON.stringify(staged.emptyDirectories.map((d) => root + d.slice(stage.length))) !==
          JSON.stringify(unit.workspace.emptyDirectories)
      )
        throw new Error('Gradle staging membership changed.');
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
