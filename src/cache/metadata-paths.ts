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

export const CACHE_METADATA_DIRECTORY = '.mammoth';
export const CUTOFF_STATE_DIRECTORY = '.mammoth/cutoff-state-v1';
export const EMPTY_GENERATION_PATH = '.mammoth/empty-generation-v1';
export function isCacheMetadataPath(relativePath: string): boolean {
  return relativePath.split('/').some((part) => /^\.mammoth(?:[ .]|$)/iu.test(part));
}
