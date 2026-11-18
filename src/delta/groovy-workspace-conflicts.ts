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
import type { IncomingGroovyWorkspace } from '../cache/groovy-apply';

/** Choose one complete subtree, even if only its outer origin metadata differs. */
export function resolveGroovyWorkspaceConflicts(
  packages: readonly CutoffPackage[],
  model: CacheModel,
) {
  const groups = new Map<string, { pkg: CutoffPackage; unit: IncomingGroovyWorkspace }[]>();
  const chosen: IncomingGroovyWorkspace[] = [],
    details: string[] = [];
  let count = 0;
  for (const pkg of packages)
    for (const partition of pkg.manifest.partitions)
      for (const workspace of partition.workspaces ?? []) {
        const members = new Set(workspace.files);
        const entries = partition.upserts.filter((e) => members.has(e.relativePath));
        const group = groups.get(workspace.root) ?? [];
        group.push({
          pkg,
          unit: {
            partitionId: partition.partitionId,
            workspace,
            entries,
            rootDirectory: pkg.rootDirectory,
          },
        });
        groups.set(workspace.root, group);
      }
  for (const [root, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    group.sort((a, b) =>
      a.pkg.metadata.producer.jobName < b.pkg.metadata.producer.jobName
        ? -1
        : a.pkg.metadata.producer.jobName > b.pkg.metadata.producer.jobName
          ? 1
          : 0,
    );
    if (new Set(group.map((g) => g.pkg.metadata.producer.jobName)).size !== group.length)
      throw new Error('Ambiguous Groovy workspace producer contributions.');
    const winner = group[0]!,
      definition = model.partitions.find((p) => p.id === winner.unit.partitionId)!;
    const signature = (u: IncomingGroovyWorkspace) =>
      JSON.stringify([
        u.workspace,
        u.entries.map((e) => [e.relativePath, e.contentSha256, e.size, e.mode]),
      ]);
    const expected = signature(winner.unit),
      conflict = group.some((g) => signature(g.unit) !== expected);
    if (conflict && definition.conflictHandling !== 'choose-worker-directory')
      throw new Error('Conflicting Groovy workspace: ' + root);
    chosen.push(winner.unit);
    if (conflict) {
      count++;
      if (details.length < 10)
        details.push(
          `Groovy workspace '${root}': selected '${winner.pkg.metadata.producer.jobName.slice(0, 80)}'; discarded ${group
            .slice(1, 6)
            .map((g) => g.pkg.metadata.producer.jobName.slice(0, 80))
            .join(', ')}.`,
        );
    }
  }
  return { chosen, roots: new Set(groups.keys()), count, details };
}
