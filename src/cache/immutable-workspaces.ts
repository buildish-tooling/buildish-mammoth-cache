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
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CacheModel, CachePartitionDefinition } from './model';
import { fileIdentity, fileIdentitySchema, sameFileIdentity } from './file-identity';
import { guardedPath, verifyParents } from './guarded-files';
import { isCacheMetadataPath } from './metadata-paths';
import { isMissingPathError } from '../util/fs';
import { validateNormalizedRelativePosixPath } from '../util/paths';

export const GROOVY_WORKSPACE_METADATA = '.mammoth/groovy-workspaces-v1.json';
export const WORKSPACE_LIMIT = 200_000;
const prefix = /^caches\/[^/]+\/(?:groovy-dsl|kotlin-dsl)(?:\/|$)/u;
const rootPattern =
  /^(caches\/[^/]+\/(?:groovy-dsl\/[a-f0-9]{32}|kotlin-dsl\/(?:scripts\/[a-f0-9]{32}|accessors\/[a-f0-9]{32}(?:-PS)?)))(?:\/|$)/u;
export const isWorkspaceCachePath = (name: string): boolean => prefix.test(name);
export const workspaceRoot = (name: string): string | null => rootPattern.exec(name)?.[1] ?? null;
const partitionPath = (name: string): boolean =>
  /^caches\/[^/]+\/(?:groovy-dsl|kotlin-dsl|scripts|generated-gradle-jars)\//u.test(name);
export const isWorkspacePartition = (p: CachePartitionDefinition): boolean =>
  p.relativeIncludeGlobs.length > 0 && p.relativeIncludeGlobs.every(partitionPath);
export const hasWorkspacePartitions = (model: CacheModel): boolean =>
  model.buildToolId === 'gradle' && model.partitions.some(isWorkspacePartition);
export function workspaceKind(root: string, files: readonly string[] = []) {
  if (root.includes('/groovy-dsl/')) return 'groovy' as const;
  if (root.includes('/kotlin-dsl/scripts/')) return 'kotlin-script' as const;
  if (root.endsWith('-PS')) return 'kotlin-plugin-spec-accessors' as const;
  return files.some((p) => p === root + '/classes.jar' || p === root + '/sources.jar')
    ? ('kotlin-accessor-jars' as const)
    : ('kotlin-accessor-directories' as const);
}
export function isWorkspaceBookkeeping(name: string): boolean {
  return (
    isCacheMetadataPath(name) ||
    name.endsWith('.lock') ||
    path.posix.basename(name) === 'gc.properties'
  );
}
const workspacePath = z.string().refine((name) => {
  try {
    validateNormalizedRelativePosixPath(name, 'Gradle workspace path', 'cache root');
    return workspaceRoot(name) !== null && !isWorkspaceBookkeeping(name);
  } catch {
    return false;
  }
});
const orderedPaths = z
  .array(workspacePath)
  .max(WORKSPACE_LIMIT)
  .superRefine((paths, ctx) => {
    if (paths.some((p, i) => i > 0 && paths[i - 1]!.localeCompare(p) >= 0))
      ctx.addIssue({ code: 'custom', message: 'Workspace paths must be sorted and unique.' });
  });
export const workspaceSchema = z
  .object({
    kind: z.enum([
      'groovy',
      'kotlin-script',
      'kotlin-accessor-jars',
      'kotlin-accessor-directories',
      'kotlin-plugin-spec-accessors',
    ]),
    root: workspacePath.refine((name) => workspaceRoot(name) === name),
    files: orderedPaths,
    emptyDirectories: orderedPaths,
  })
  .strict()
  .superRefine((unit, ctx) => {
    const files = new Set(unit.files);
    const directories = new Set(unit.emptyDirectories);
    for (const name of [...unit.files, ...unit.emptyDirectories]) {
      if (!name.startsWith(unit.root + '/')) {
        ctx.addIssue({ code: 'custom', message: 'Workspace member is outside its root.' });
        continue;
      }
      let parent = path.posix.dirname(name);
      while (parent !== unit.root) {
        if (files.has(parent) || directories.has(parent))
          ctx.addIssue({ code: 'custom', message: 'Workspace file/directory collision.' });
        parent = path.posix.dirname(parent);
      }
      if (files.has(name) && directories.has(name))
        ctx.addIssue({ code: 'custom', message: 'Workspace file/directory collision.' });
    }
    if (unit.kind !== workspaceKind(unit.root, unit.files))
      ctx.addIssue({ code: 'custom', message: 'Workspace kind/root mismatch.' });
    const requiredFiles =
      unit.kind === 'groovy'
        ? ['metadata.bin', 'metadata/metadata.bin']
        : unit.kind === 'kotlin-accessor-jars'
          ? ['metadata.bin', 'classes.jar', 'sources.jar']
          : ['metadata.bin'];
    if (requiredFiles.some((p) => !files.has(unit.root + '/' + p)))
      ctx.addIssue({ code: 'custom', message: 'Workspace required files are missing.' });
    const requiredDirectories =
      unit.kind === 'groovy'
        ? ['classes', 'instrumented', 'metadata']
        : unit.kind === 'kotlin-script'
          ? ['classes', 'instrumented/classes']
          : unit.kind === 'kotlin-plugin-spec-accessors' ||
              unit.kind === 'kotlin-accessor-directories'
            ? ['classes', 'sources']
            : [];
    for (const directory of requiredDirectories) {
      const name = unit.root + '/' + directory;
      if (
        ![...files, ...directories].some((p) => directories.has(name) || p.startsWith(name + '/'))
      )
        ctx.addIssue({ code: 'custom', message: 'Workspace structure is incomplete.' });
    }
  });
export type ImmutableWorkspace = z.infer<typeof workspaceSchema>;
export const workspaceObservationSchema = z
  .object({
    partitionId: z.string(),
    workspace: workspaceSchema,
    directories: z
      .array(z.object({ relativePath: workspacePath, identity: fileIdentitySchema }).strict())
      .max(WORKSPACE_LIMIT),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const names = observation.directories.map((d) => d.relativePath);
    if (
      !names.includes(observation.workspace.root) ||
      new Set(names).size !== names.length ||
      names.some(
        (p, i) =>
          workspaceRoot(p) !== observation.workspace.root ||
          (i > 0 && names[i - 1]!.localeCompare(p) >= 0),
      ) ||
      observation.workspace.emptyDirectories.some((p) => !names.includes(p))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid frozen workspace directory membership.' });
  });
export type WorkspaceObservation = z.infer<typeof workspaceObservationSchema>;
export function assertWorkspaceOwnership(
  unit: ImmutableWorkspace,
  partitionId: string,
  owns: (id: string, name: string) => boolean,
): void {
  workspaceSchema.parse(unit);
  if (
    unit.files.some((p) => !owns(partitionId, p)) ||
    unit.emptyDirectories.some((p) => !owns(partitionId, p + '/.workspace-directory-probe'))
  )
    throw new Error('Gradle workspace cannot have partial or ambiguous partition ownership.');
}

/** A no-follow, metadata-only inventory; directory identities freeze topology as well as files. */
export async function inspectWorkspaceTree(
  cacheRoot: string,
  root: string,
  ignoreBookkeeping = true,
) {
  guardedPath(cacheRoot, root);
  await verifyParents(cacheRoot, path.posix.dirname(root));
  const files: { relativePath: string; identity: ReturnType<typeof fileIdentity> }[] = [];
  const directories: WorkspaceObservation['directories'] = [];
  const emptyDirectories: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 100 || files.length + directories.length >= WORKSPACE_LIMIT)
      throw new Error('Gradle workspace exceeds traversal limits.');
    const st = await lstat(guardedPath(cacheRoot, relative));
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      throw new Error('Gradle workspace contains a link or special file.');
    if (st.isFile()) {
      files.push({ relativePath: relative, identity: fileIdentity(st) });
      return;
    }
    const before = fileIdentity(st);
    const children = (await readdir(guardedPath(cacheRoot, relative))).filter(
      (p) => !ignoreBookkeeping || !isWorkspaceBookkeeping(relative + '/' + p),
    );
    directories.push({ relativePath: relative, identity: before });
    if (!children.length) emptyDirectories.push(relative);
    for (const child of children) await visit(relative + '/' + child, depth + 1);
    if (
      !sameFileIdentity(before, fileIdentity(await lstat(guardedPath(cacheRoot, relative))), true)
    )
      throw new Error('Gradle workspace directory changed during inventory.');
  };
  try {
    await visit(root, 0);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return null;
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  directories.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  emptyDirectories.sort((a, b) => a.localeCompare(b));
  return { files, directories, emptyDirectories };
}

/** Strip incomplete/local trees from discovery, and reject partial views of complete units. */
export async function captureImmutableWorkspaces<T extends { relativePath: string }>(
  model: CacheModel,
  partitions: { partitionId: string; entries: T[] }[],
  owns: (id: string, name: string) => boolean,
  warnings: string[] = [],
): Promise<WorkspaceObservation[]> {
  if (model.buildToolId !== 'gradle') return [];
  const warn = (message: string) => {
    if (warnings.length < 10) warnings.push(message);
  };
  const selectedPaths = new Map<string, Set<string>>();
  for (const partition of partitions) {
    const definition = model.partitions.find((p) => p.id === partition.partitionId)!;
    if (!isWorkspacePartition(definition)) {
      if (partition.entries.some((e) => isWorkspaceCachePath(e.relativePath)))
        throw new Error('Gradle workspace content requires a dedicated partition.');
      continue;
    }
    const selected = new Set<string>();
    for (const entry of partition.entries) selected.add(entry.relativePath);
    selectedPaths.set(partition.partitionId, selected);
  }
  const unknown = new Set(
    partitions.flatMap((p) =>
      p.entries
        .filter((e) => isWorkspaceCachePath(e.relativePath) && !workspaceRoot(e.relativePath))
        .map((e) => e.relativePath.split('/').slice(0, 4).join('/')),
    ),
  );
  for (const root of unknown) warn('Skipped unrecognized Gradle cache tree: ' + root.slice(0, 256));
  const roots = new Set(
    partitions.flatMap((p) =>
      p.entries.map((e) => workspaceRoot(e.relativePath)).filter((p): p is string => p !== null),
    ),
  );
  const acceptedFiles = new Set<string>();
  const observations: WorkspaceObservation[] = [];
  for (const root of [...roots].sort((a, b) => a.localeCompare(b))) {
    const tree = await inspectWorkspaceTree(model.cacheRoot, root);
    if (!tree) {
      warn('Skipped vanished Gradle workspace: ' + root);
      continue;
    }
    const unit = {
      kind: workspaceKind(
        root,
        tree.files.map((f) => f.relativePath),
      ),
      root,
      files: tree.files.map((f) => f.relativePath),
      emptyDirectories: tree.emptyDirectories,
    };
    if (
      !workspaceSchema.safeParse(unit).success ||
      tree.files.some(
        (f) =>
          (f.relativePath === root + '/metadata.bin' ||
            f.relativePath === root + '/metadata/metadata.bin' ||
            (unit.kind === 'kotlin-accessor-jars' &&
              /\/(?:classes|sources)\.jar$/u.test(f.relativePath))) &&
          f.identity.size === 0,
      )
    ) {
      warn('Skipped structurally incomplete Gradle workspace: ' + root);
      continue;
    }
    const owners = model.partitions.filter((p) => unit.files.some((f) => owns(p.id, f)));
    if (owners.length !== 1) throw new Error('Gradle workspace has ambiguous partition ownership.');
    const owner = owners[0]!;
    if (!isWorkspacePartition(owner))
      throw new Error('Gradle workspaces require a dedicated partition.');
    if ((owner.publication ?? 'aggregate') !== 'aggregate')
      throw new Error('Gradle workspace partitions must use aggregate publication.');
    assertWorkspaceOwnership(unit, owner.id, owns);
    const selected = selectedPaths.get(owner.id)!;
    if (unit.files.some((f) => !selected.has(f)))
      throw new Error('Gradle workspace includes/excludes must select a complete workspace.');
    for (const file of unit.files) acceptedFiles.add(file);
    observations.push({ partitionId: owner.id, workspace: unit, directories: tree.directories });
  }
  for (const partition of partitions)
    partition.entries = partition.entries.filter(
      (e) => !isWorkspaceCachePath(e.relativePath) || acceptedFiles.has(e.relativePath),
    );
  return observations;
}

/** Every transported Gradle upsert belongs to an explicitly complete workspace view. */
export function assertWorkspaceContributions(
  model: CacheModel,
  partitions: readonly {
    partitionId: string;
    snapshot?: boolean;
    upserts: readonly { relativePath: string; size: number }[];
    workspaces?: readonly ImmutableWorkspace[];
  }[],
  owns: (id: string, name: string) => boolean,
): void {
  const seen = new Set<string>();
  for (const partition of partitions) {
    const units = partition.workspaces ?? [];
    const files = partition.upserts.filter(
      (e) => model.buildToolId === 'gradle' && isWorkspaceCachePath(e.relativePath),
    );
    const definition = model.partitions.find((p) => p.id === partition.partitionId);
    if (
      units.length &&
      (model.buildToolId !== 'gradle' ||
        partition.snapshot ||
        !definition ||
        !isWorkspacePartition(definition) ||
        (definition.publication ?? 'aggregate') !== 'aggregate')
    )
      throw new Error('Invalid Gradle workspace publication.');
    const byRoot = new Map<string, { relativePath: string; size: number }[]>();
    for (const file of files) {
      const root = workspaceRoot(file.relativePath) ?? '';
      const entries = byRoot.get(root) ?? [];
      entries.push(file);
      byRoot.set(root, entries);
    }
    const unitRoots = new Set(units.map((u) => u.root));
    for (const unit of units) {
      if (seen.has(unit.root)) throw new Error('Duplicate Gradle workspace contribution.');
      seen.add(unit.root);
      assertWorkspaceOwnership(unit, partition.partitionId, owns);
      const entries = byRoot.get(unit.root) ?? [];
      const paths = entries.map((e) => e.relativePath).sort((a, b) => a.localeCompare(b));
      if (
        JSON.stringify(paths) !== JSON.stringify(unit.files) ||
        entries.some(
          (e) =>
            (e.relativePath === unit.root + '/metadata.bin' ||
              e.relativePath === unit.root + '/metadata/metadata.bin' ||
              (unit.kind === 'kotlin-accessor-jars' &&
                /\/(?:classes|sources)\.jar$/u.test(e.relativePath))) &&
            e.size === 0,
        )
      )
        throw new Error('Incomplete Gradle workspace contribution.');
    }
    if (files.some((e) => !unitRoots.has(workspaceRoot(e.relativePath) ?? '')))
      throw new Error('Gradle file delta lacks a complete workspace descriptor.');
  }
}
