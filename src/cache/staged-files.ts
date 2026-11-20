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
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  copyGuardedFile,
  prepareGuardedMove,
  moveGuardedFile,
  copyTrustedBaseFile,
  DirectoryValidationBatch,
  guardedPath,
  regularStat,
  type PayloadIntegrity,
} from './guarded-files';
import { repairCacheFileMetadata } from './file-permissions';
import { fileIdentity, sameFileIdentity, type FileIdentity } from './file-identity';

export const STAGING_BATCH_SIZE = 64;
export interface StagedFile {
  sourceRoot: string;
  sourcePath: string;
  destination: string;
  expected: { size: number; contentSha256?: string; mode: number; mtimeMs: number };
  native?: FileIdentity;
}
/** Open a bounded set of outputs before source I/O; writes/repairs never follow mutable paths. */
export async function stageGuardedFiles(
  root: string,
  files: readonly StagedFile[],
  integrity: PayloadIntegrity,
): Promise<Map<string, FileIdentity>> {
  const result = new Map<string, FileIdentity>();
  for (let offset = 0; offset < files.length; offset += STAGING_BATCH_SIZE) {
    const directories = new DirectoryValidationBatch(root);
    const sources = new Map<string, DirectoryValidationBatch>();
    const opened: { file: StagedFile; handle: FileHandle }[] = [];
    try {
      for (const file of files.slice(offset, offset + STAGING_BATCH_SIZE)) {
        await directories.verify(path.posix.dirname(file.destination), true);
        const handle = await open(guardedPath(root, file.destination), 'wx', 0o600);
        opened.push({ file, handle });
      }
      for (const { file, handle } of opened) {
        let sourceBatch = sources.get(file.sourceRoot);
        if (!sourceBatch)
          sources.set(
            file.sourceRoot,
            (sourceBatch = new DirectoryValidationBatch(file.sourceRoot)),
          );
        const copy = integrity === 'trusted-base' ? copyTrustedBaseFile : copyGuardedFile;
        await copy(
          file.sourceRoot,
          file.sourcePath,
          guardedPath(root, file.destination),
          { size: file.expected.size, contentSha256: file.expected.contentSha256 },
          file.native,
          sourceBatch,
          handle,
        );
        await handle.chmod(file.expected.mode);
        await handle.utimes(new Date(file.expected.mtimeMs), new Date(file.expected.mtimeMs));
        result.set(file.destination, fileIdentity(await handle.stat()));
      }
    } finally {
      await Promise.all(opened.map(({ handle }) => handle.close()));
    }
    const commit = new DirectoryValidationBatch(root);
    for (const { file } of opened) {
      await commit.verify(path.posix.dirname(file.destination));
      const current = await regularStat(guardedPath(root, file.destination));
      if (!current || !sameFileIdentity(result.get(file.destination)!, fileIdentity(current), true))
        throw new Error('Staged file changed before installation.');
    }
  }
  return result;
}

/** Verify a bounded source batch, then consume it without payload reads on the rename path. */
export async function moveGuardedFiles(
  root: string,
  files: readonly StagedFile[],
  integrity: PayloadIntegrity,
): Promise<Map<string, FileIdentity>> {
  const result = new Map<string, FileIdentity>();
  for (let offset = 0; offset < files.length; offset += STAGING_BATCH_SIZE) {
    const batch = files.slice(offset, offset + STAGING_BATCH_SIZE);
    const selected = [];
    for (const file of batch)
      selected.push(
        await prepareGuardedMove(file.sourceRoot, file.sourcePath, file.expected, integrity),
      );
    for (const [index, file] of batch.entries())
      if (file.native && !sameFileIdentity(file.native, selected[index]!.identity, true))
        throw new Error('Source changed after installation inventory.');
    const destinations = new DirectoryValidationBatch(root);
    const sources = new Map<string, DirectoryValidationBatch>();
    for (const [index, file] of batch.entries()) {
      await destinations.verify(path.posix.dirname(file.destination), true);
      const destination = guardedPath(root, file.destination);
      if (await regularStat(destination))
        throw new Error('Move staging destination already exists.');
      let sourceBatch = sources.get(file.sourceRoot);
      if (!sourceBatch)
        sources.set(file.sourceRoot, (sourceBatch = new DirectoryValidationBatch(file.sourceRoot)));
      const moved = await moveGuardedFile(
        file.sourceRoot,
        file.sourcePath,
        destination,
        file.expected,
        root,
        integrity,
        sourceBatch,
        selected[index],
      );
      if (moved.copied) {
        // Copying yielded to source I/O: its destination evidence cannot survive into another move.
        destinations.invalidate();
        for (const source of sources.values()) source.invalidate();
        await destinations.verify(path.posix.dirname(file.destination));
      }
      const repaired = await repairCacheFileMetadata(destination, moved.identity, file.expected);
      if (repaired) {
        const stat = await regularStat(destination);
        if (!stat) throw new Error('Moved staging disappeared.');
        result.set(file.destination, fileIdentity(stat));
      } else result.set(file.destination, moved.identity);
    }
  }
  return result;
}
