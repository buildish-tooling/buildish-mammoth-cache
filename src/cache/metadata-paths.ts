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

import path from 'node:path';

export const CACHE_METADATA_DIRECTORY = '.mammoth';
export const CACHE_METADATA_VERSION_DIRECTORY = `${CACHE_METADATA_DIRECTORY}/v1`;
export const CACHE_METADATA_LOCATOR_NAME = 'current.json';
export const CACHE_METADATA_LOCATOR = `${CACHE_METADATA_VERSION_DIRECTORY}/${CACHE_METADATA_LOCATOR_NAME}`;

export function cacheInvocationPrefix(invocation: string): string {
  return `${CACHE_METADATA_VERSION_DIRECTORY}/${invocation}/`;
}

export function cacheInvocationStatePath(invocation: string): string {
  return `${cacheInvocationPrefix(invocation)}state.json`;
}

export function cacheInvocationSeedPrefix(invocation: string): string {
  return `${cacheInvocationPrefix(invocation)}seed/`;
}

export function cacheInvocationSnapshotPrefix(invocation: string): string {
  return `${cacheInvocationPrefix(invocation)}snapshots/`;
}

export function cacheMetadataDirectory({
  managedRoot,
}: {
  managedRoot: string;
  buildTool: 'gradle' | 'maven' | undefined;
}): string {
  return path.join(managedRoot, CACHE_METADATA_DIRECTORY);
}

const reservedComponent = new RegExp(
  `^${CACHE_METADATA_DIRECTORY.replace('.', '\\.')}(?:[ .]|$)`,
  'iu',
);

export function isCacheMetadataPath(relativePath: string): boolean {
  return relativePath.split('/').some((part) => reservedComponent.test(part));
}
