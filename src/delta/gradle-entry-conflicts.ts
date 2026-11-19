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
import type { CacheModel } from '../cache/model';
import type { CutoffPackage } from './cutoff-service';
import type { CutoffMergedUpsert } from './cutoff-apply';

export const isGradleBuildCacheEntry = (name: string): boolean =>
  /^caches\/build-cache-[0-9]+\/[a-f0-9]{32}$/u.test(name);

/** An archive is one opaque file; never choose a whole build-cache partition. */
export function resolveGradleEntryConflicts(packages: readonly CutoffPackage[], model: CacheModel) {
  const groups = new Map<string, { pkg: CutoffPackage; item: CutoffMergedUpsert }[]>();
  if (model.buildToolId === 'gradle')
    for (const pkg of packages)
      for (const p of pkg.manifest.partitions)
        for (const entry of p.upserts) {
          if (!isGradleBuildCacheEntry(entry.relativePath)) continue;
          const group = groups.get(entry.relativePath) ?? [];
          group.push({
            pkg,
            item: { partitionId: p.partitionId, entry, rootDirectory: pkg.rootDirectory },
          });
          groups.set(entry.relativePath, group);
        }
  const chosen: CutoffMergedUpsert[] = [],
    details: string[] = [];
  let count = 0;
  for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) =>
      a.pkg.metadata.producer.jobName < b.pkg.metadata.producer.jobName
        ? -1
        : a.pkg.metadata.producer.jobName > b.pkg.metadata.producer.jobName
          ? 1
          : 0,
    );
    if (new Set(group.map((g) => g.pkg.metadata.producer.jobName)).size !== group.length)
      throw new Error('Ambiguous Gradle build-cache entry producer contributions.');
    const winner = group[0]!,
      definition = model.partitions.find((p) => p.id === winner.item.partitionId)!;
    const conflict = group.some(
      (g) =>
        g.item.entry.contentSha256 !== winner.item.entry.contentSha256 ||
        g.item.entry.size !== winner.item.entry.size,
    );
    if (conflict && definition.conflictHandling !== 'choose-worker-entry')
      throw new Error('Conflicting worker upserts: ' + name);
    // Under strict mode retain ordinary equivalence handling (including portable modes).
    if (definition.conflictHandling !== 'choose-worker-entry') continue;
    chosen.push(winner.item);
    if (conflict) {
      count++;
      if (details.length < 10)
        details.push(
          `Gradle build-cache entry '${name}': selected '${winner.pkg.metadata.producer.jobName.slice(0, 80)}'; discarded ${group
            .slice(1, 6)
            .map((g) => g.pkg.metadata.producer.jobName.slice(0, 80))
            .join(', ')}.`,
        );
    }
  }
  return { chosen, paths: new Set(chosen.map((e) => e.entry.relativePath)), count, details };
}
