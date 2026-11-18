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
export const GROOVY_WORKSPACE_LIMIT = 200_000;
const prefix = /^caches\/[^/]+\/groovy-dsl(?:\/|$)/u;
const rootPattern = /^(caches\/[^/]+\/groovy-dsl\/[a-f0-9]{32})(?:\/|$)/u;
export const isGroovyCachePath = (name: string): boolean => prefix.test(name);
export const groovyWorkspaceRoot = (name: string): string | null =>
  rootPattern.exec(name)?.[1] ?? null;
export const isGroovyPartition = (p: CachePartitionDefinition): boolean =>
  p.relativeIncludeGlobs.length > 0 && p.relativeIncludeGlobs.every(isGroovyCachePath);
export const hasGroovyPartitions = (model: CacheModel): boolean =>
  model.buildToolId === 'gradle' && model.partitions.some(isGroovyPartition);
export function isGroovyBookkeeping(name: string): boolean {
  return (
    isCacheMetadataPath(name) ||
    name.endsWith('.lock') ||
    path.posix.basename(name) === 'gc.properties'
  );
}
const workspacePath = z.string().refine((name) => {
  try {
    validateNormalizedRelativePosixPath(name, 'Groovy workspace path', 'cache root');
    return groovyWorkspaceRoot(name) !== null && !isGroovyBookkeeping(name);
  } catch {
    return false;
  }
});
const orderedPaths = z
  .array(workspacePath)
  .max(GROOVY_WORKSPACE_LIMIT)
  .superRefine((paths, ctx) => {
    if (paths.some((p, i) => i > 0 && paths[i - 1]!.localeCompare(p) >= 0))
      ctx.addIssue({ code: 'custom', message: 'Workspace paths must be sorted and unique.' });
  });
export const groovyWorkspaceSchema = z
  .object({
    root: workspacePath.refine((name) => groovyWorkspaceRoot(name) === name),
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
    if (!files.has(unit.root + '/metadata.bin') || !files.has(unit.root + '/metadata/metadata.bin'))
      ctx.addIssue({ code: 'custom', message: 'Workspace requires both metadata files.' });
    for (const directory of ['classes', 'instrumented', 'metadata']) {
      const name = unit.root + '/' + directory;
      if (
        ![...files, ...directories].some((p) => directories.has(name) || p.startsWith(name + '/'))
      )
        ctx.addIssue({ code: 'custom', message: 'Workspace structure is incomplete.' });
    }
  });
export type GroovyWorkspace = z.infer<typeof groovyWorkspaceSchema>;
export const groovyObservationSchema = z
  .object({
    partitionId: z.string(),
    workspace: groovyWorkspaceSchema,
    directories: z
      .array(z.object({ relativePath: workspacePath, identity: fileIdentitySchema }).strict())
      .max(GROOVY_WORKSPACE_LIMIT),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const names = observation.directories.map((d) => d.relativePath);
    if (
      !names.includes(observation.workspace.root) ||
      new Set(names).size !== names.length ||
      names.some(
        (p, i) =>
          groovyWorkspaceRoot(p) !== observation.workspace.root ||
          (i > 0 && names[i - 1]!.localeCompare(p) >= 0),
      ) ||
      observation.workspace.emptyDirectories.some((p) => !names.includes(p))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid frozen workspace directory membership.' });
  });
export type GroovyObservation = z.infer<typeof groovyObservationSchema>;
export function assertGroovyOwnership(
  unit: GroovyWorkspace,
  partitionId: string,
  owns: (id: string, name: string) => boolean,
): void {
  groovyWorkspaceSchema.parse(unit);
  if (
    unit.files.some((p) => !owns(partitionId, p)) ||
    unit.emptyDirectories.some((p) => !owns(partitionId, p + '/.groovy-directory-probe'))
  )
    throw new Error('Groovy workspace cannot have partial or ambiguous partition ownership.');
}

/** A no-follow, metadata-only inventory; directory identities freeze topology as well as files. */
export async function inspectGroovyTree(cacheRoot: string, root: string, ignoreBookkeeping = true) {
  guardedPath(cacheRoot, root);
  await verifyParents(cacheRoot, path.posix.dirname(root));
  const files: { relativePath: string; identity: ReturnType<typeof fileIdentity> }[] = [];
  const directories: GroovyObservation['directories'] = [];
  const emptyDirectories: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 100 || files.length + directories.length >= GROOVY_WORKSPACE_LIMIT)
      throw new Error('Groovy workspace exceeds traversal limits.');
    const st = await lstat(guardedPath(cacheRoot, relative));
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      throw new Error('Groovy workspace contains a link or special file.');
    if (st.isFile()) {
      files.push({ relativePath: relative, identity: fileIdentity(st) });
      return;
    }
    const before = fileIdentity(st);
    const children = (await readdir(guardedPath(cacheRoot, relative))).filter(
      (p) => !ignoreBookkeeping || !isGroovyBookkeeping(relative + '/' + p),
    );
    directories.push({ relativePath: relative, identity: before });
    if (!children.length) emptyDirectories.push(relative);
    for (const child of children) await visit(relative + '/' + child, depth + 1);
    if (
      !sameFileIdentity(before, fileIdentity(await lstat(guardedPath(cacheRoot, relative))), true)
    )
      throw new Error('Groovy workspace directory changed during inventory.');
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
export async function captureGroovyWorkspaces<T extends { relativePath: string }>(
  model: CacheModel,
  partitions: { partitionId: string; entries: T[] }[],
  owns: (id: string, name: string) => boolean,
  warnings: string[] = [],
): Promise<GroovyObservation[]> {
  if (model.buildToolId !== 'gradle') return [];
  const warn = (message: string) => {
    if (warnings.length < 10) warnings.push(message);
  };
  for (const partition of partitions) {
    const definition = model.partitions.find((p) => p.id === partition.partitionId)!;
    if (
      !isGroovyPartition(definition) &&
      partition.entries.some((e) => isGroovyCachePath(e.relativePath))
    )
      throw new Error('Groovy workspace content requires a dedicated partition.');
  }
  const unknown = new Set(
    partitions.flatMap((p) =>
      p.entries
        .filter((e) => isGroovyCachePath(e.relativePath) && !groovyWorkspaceRoot(e.relativePath))
        .map((e) => e.relativePath.split('/').slice(0, 4).join('/')),
    ),
  );
  for (const root of unknown) warn('Skipped unrecognized Groovy cache tree: ' + root.slice(0, 256));
  const roots = new Set(
    partitions.flatMap((p) =>
      p.entries
        .map((e) => groovyWorkspaceRoot(e.relativePath))
        .filter((p): p is string => p !== null),
    ),
  );
  const acceptedFiles = new Set<string>();
  const observations: GroovyObservation[] = [];
  for (const root of [...roots].sort((a, b) => a.localeCompare(b))) {
    const tree = await inspectGroovyTree(model.cacheRoot, root);
    if (!tree) {
      warn('Skipped vanished Groovy workspace: ' + root);
      continue;
    }
    const unit = {
      root,
      files: tree.files.map((f) => f.relativePath),
      emptyDirectories: tree.emptyDirectories,
    };
    if (
      !groovyWorkspaceSchema.safeParse(unit).success ||
      tree.files.some(
        (f) =>
          (f.relativePath === root + '/metadata.bin' ||
            f.relativePath === root + '/metadata/metadata.bin') &&
          f.identity.size === 0,
      )
    ) {
      warn('Skipped structurally incomplete Groovy workspace: ' + root);
      continue;
    }
    const owners = model.partitions.filter((p) => unit.files.some((f) => owns(p.id, f)));
    if (owners.length !== 1) throw new Error('Groovy workspace has ambiguous partition ownership.');
    const owner = owners[0]!;
    if (!isGroovyPartition(owner))
      throw new Error('Groovy workspaces require a dedicated partition.');
    if ((owner.publication ?? 'aggregate') !== 'aggregate')
      throw new Error('Groovy workspace partitions must use aggregate publication.');
    assertGroovyOwnership(unit, owner.id, owns);
    const selected = new Set(
      partitions.find((p) => p.partitionId === owner.id)!.entries.map((e) => e.relativePath),
    );
    if (unit.files.some((f) => !selected.has(f)))
      throw new Error('Groovy workspace includes/excludes must select a complete workspace.');
    for (const file of unit.files) acceptedFiles.add(file);
    observations.push({ partitionId: owner.id, workspace: unit, directories: tree.directories });
  }
  for (const partition of partitions)
    partition.entries = partition.entries.filter(
      (e) => !isGroovyCachePath(e.relativePath) || acceptedFiles.has(e.relativePath),
    );
  return observations;
}

/** Every transported Groovy upsert belongs to an explicitly complete workspace view. */
export function assertGroovyContributions(
  model: CacheModel,
  partitions: readonly {
    partitionId: string;
    snapshot?: boolean;
    upserts: readonly { relativePath: string; size: number }[];
    workspaces?: readonly GroovyWorkspace[];
  }[],
  owns: (id: string, name: string) => boolean,
): void {
  const seen = new Set<string>();
  for (const partition of partitions) {
    const units = partition.workspaces ?? [];
    const files = partition.upserts.filter(
      (e) => model.buildToolId === 'gradle' && isGroovyCachePath(e.relativePath),
    );
    const definition = model.partitions.find((p) => p.id === partition.partitionId);
    if (
      units.length &&
      (model.buildToolId !== 'gradle' ||
        partition.snapshot ||
        !definition ||
        !isGroovyPartition(definition) ||
        (definition.publication ?? 'aggregate') !== 'aggregate')
    )
      throw new Error('Invalid Groovy workspace publication.');
    const byRoot = new Map<string, { relativePath: string; size: number }[]>();
    for (const file of files) {
      const root = groovyWorkspaceRoot(file.relativePath) ?? '';
      const entries = byRoot.get(root) ?? [];
      entries.push(file);
      byRoot.set(root, entries);
    }
    const unitRoots = new Set(units.map((u) => u.root));
    for (const unit of units) {
      if (seen.has(unit.root)) throw new Error('Duplicate Groovy workspace contribution.');
      seen.add(unit.root);
      assertGroovyOwnership(unit, partition.partitionId, owns);
      const entries = byRoot.get(unit.root) ?? [];
      const paths = entries.map((e) => e.relativePath).sort((a, b) => a.localeCompare(b));
      if (
        JSON.stringify(paths) !== JSON.stringify(unit.files) ||
        entries.some(
          (e) =>
            (e.relativePath === unit.root + '/metadata.bin' ||
              e.relativePath === unit.root + '/metadata/metadata.bin') &&
            e.size === 0,
        )
      )
        throw new Error('Incomplete Groovy workspace contribution.');
    }
    if (files.some((e) => !unitRoots.has(groovyWorkspaceRoot(e.relativePath) ?? '')))
      throw new Error('Groovy file delta lacks a complete workspace descriptor.');
  }
}
