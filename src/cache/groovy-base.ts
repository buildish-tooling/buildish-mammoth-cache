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
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { CacheModel } from './model';
import {
  GROOVY_WORKSPACE_METADATA,
  hasGroovyPartitions,
  inspectGroovyTree,
} from './groovy-workspaces';
import { readMetadata, metadataPath } from './metadata-io';

// Remove only known previous-format local transport; new objects use partition-owned staging.
const GROOVY_BASE_DIRECTORY = '.mammoth/groovy-base-v1';
const MAX_BYTES = 64 * 1024 * 1024;
export async function resetGroovyBaseTransport(model: CacheModel): Promise<void> {
  if (!hasGroovyPartitions(model)) return;
  const tree = await inspectGroovyTree(model.cacheRoot, GROOVY_BASE_DIRECTORY, false);
  if (tree) await rm(path.join(model.cacheRoot, GROOVY_BASE_DIRECTORY), { recursive: true });
  const old = await metadataPath(model.cacheRoot, GROOVY_WORKSPACE_METADATA).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  if (old) {
    await readMetadata(model.cacheRoot, GROOVY_WORKSPACE_METADATA, MAX_BYTES);
    await rm(old, { force: true });
  }
}
