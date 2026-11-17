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
import { metadataPath, readMetadata, writeMetadata } from './metadata-io';
import { EMPTY_GENERATION_PATH } from './metadata-paths';

/** Constant transport marker; contains no activity, inventory, or recovery state. */
export async function setEmptyGeneration(root: string, empty: boolean): Promise<void> {
  const existing = await readMetadata(root, EMPTY_GENERATION_PATH, 128);
  if (existing !== null && JSON.parse(existing) !== 'mammoth-empty-v1')
    throw new Error('Invalid empty-generation marker.');
  if (empty) await writeMetadata(root, EMPTY_GENERATION_PATH, 'mammoth-empty-v1', 128);
  else if (existing !== null) await rm(await metadataPath(root, EMPTY_GENERATION_PATH));
}
