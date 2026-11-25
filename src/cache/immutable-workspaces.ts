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
import type { CachePartitionDefinition } from './model';

const prefix = /^caches\/(?:[^/]+\/(?:groovy-dsl|kotlin-dsl|transforms)|transforms-[^/]+)(?:\/|$)/u;
export const isTransformWorkspace = (root: string): boolean =>
  /^caches\/(?:transforms-4|[^/]+\/transforms)\/[a-f0-9]{32}$/u.test(root);
const rootPattern =
  /^(caches\/(?:[^/]+\/(?:groovy-dsl\/[a-f0-9]{32}|kotlin-dsl\/(?:scripts\/[a-f0-9]{32}|accessors\/[a-f0-9]{32}(?:-PS)?))|(?:transforms-4|[^/]+\/transforms)\/[a-f0-9]{32}))(?:\/|$)/u;
export const isWorkspaceCachePath = (name: string): boolean => prefix.test(name);
export const workspaceRoot = (name: string): string | null => rootPattern.exec(name)?.[1] ?? null;
const partitionPath = (name: string): boolean =>
  /^caches\/(?:[^/]+\/(?:groovy-dsl|kotlin-dsl|scripts|generated-gradle-jars|transforms)|transforms-[^/]+)\//u.test(
    name,
  );
export const isWorkspacePartition = (p: CachePartitionDefinition): boolean =>
  p.relativeIncludeGlobs.length > 0 && p.relativeIncludeGlobs.every(partitionPath);
export function workspaceKind(root: string, files: readonly string[] = []) {
  if (isTransformWorkspace(root)) {
    return 'artifact-transform' as const;
  }
  if (root.includes('/groovy-dsl/')) {
    return 'groovy' as const;
  }
  if (root.includes('/kotlin-dsl/scripts/')) {
    return 'kotlin-script' as const;
  }
  if (root.endsWith('-PS')) {
    return 'kotlin-plugin-spec-accessors' as const;
  }
  return files.some((p) => p === root + '/classes.jar' || p === root + '/sources.jar')
    ? ('kotlin-accessor-jars' as const)
    : ('kotlin-accessor-directories' as const);
}
