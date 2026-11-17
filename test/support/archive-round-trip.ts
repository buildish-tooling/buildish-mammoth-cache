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

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/** Local gzip/GNU-tar command shape used by @actions/cache; not a hosted backend test. */
export async function packCacheFiles(
  root: string,
  files: readonly string[],
  archiveRoot: string,
): Promise<string> {
  await mkdir(archiveRoot, { recursive: true });
  const manifest = path.join(archiveRoot, 'manifest.txt');
  await writeFile(manifest, files.join('\n'));
  const archive = path.join(archiveRoot, 'cache.tgz');
  await promisify(execFile)('tar', [
    '--posix',
    '-cf',
    archive,
    '-P',
    '-C',
    root,
    '--files-from',
    manifest,
    '-z',
  ]);
  return archive;
}
export async function unpackCacheFiles(root: string, archive: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await promisify(execFile)('tar', ['-xf', archive, '-P', '-C', root, '-z']);
}
