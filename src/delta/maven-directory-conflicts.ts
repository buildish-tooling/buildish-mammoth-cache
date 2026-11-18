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
import type { CacheModel } from '../cache/model';
import type { CutoffUpsert } from '../cache/cutoff-format';
import type { CutoffPackage } from './cutoff-service';

interface DirectoryView {
  pkg: CutoffPackage;
  entries: CutoffUpsert[];
  policies: Set<string>;
}
export interface MavenDirectoryConflicts {
  winners: Map<string, CutoffPackage>;
  count: number;
  details: string[];
}

/** Complete-view arbitration precedes per-file merging; no marker contents are interpreted. */
export function resolveMavenDirectoryConflicts(
  packages: readonly CutoffPackage[],
  model: CacheModel,
): MavenDirectoryConflicts {
  const result: MavenDirectoryConflicts = { winners: new Map(), count: 0, details: [] };
  if (model.buildToolId !== 'maven') return result;
  const definitions = new Map(model.partitions.map((p) => [p.id, p]));
  const directories = new Map<string, DirectoryView[]>();
  for (const pkg of packages) {
    const views = new Map<string, DirectoryView>();
    for (const partition of pkg.manifest.partitions) {
      for (const entry of partition.upserts) {
        if (!entry.relativePath.startsWith('repository/')) continue;
        const directory = path.posix.dirname(entry.relativePath);
        const view = views.get(directory) ?? { pkg, entries: [], policies: new Set<string>() };
        view.entries.push(entry);
        view.policies.add(definitions.get(partition.partitionId)?.conflictHandling ?? 'default');
        views.set(directory, view);
      }
    }
    for (const [directory, view] of views) {
      const group = directories.get(directory) ?? [];
      group.push(view);
      directories.set(directory, group);
    }
  }
  let diagnosticBytes = 0;
  for (const [directory, views] of [...directories].sort(([a], [b]) => ordinal(a, b))) {
    const policies = new Set(views.flatMap((v) => [...v.policies]));
    if (policies.size !== 1)
      throw new Error(
        `Maven repository directory '${directory}' has mixed conflict-handling policies.`,
      );
    const signatures = views.map((v) =>
      JSON.stringify(
        v.entries.map((e) => JSON.stringify([e.relativePath, e.contentSha256, e.size])).sort(),
      ),
    );
    const conflicting = signatures.some((signature) => signature !== signatures[0]);
    if (!policies.has('choose-worker-directory')) {
      if (conflicting)
        throw new Error(
          `Conflicting Maven repository directory: ${directory}. Use a common seeded repository and one writer per changed directory; duplicate-path overrides do not apply.`,
        );
      continue;
    }
    const ordered = [...views].sort((a, b) =>
      ordinal(a.pkg.metadata.producer.jobName, b.pkg.metadata.producer.jobName),
    );
    if (new Set(ordered.map((v) => v.pkg.metadata.producer.jobName)).size !== ordered.length)
      throw new Error(`Ambiguous worker directory contributions: ${directory}.`);
    const winner = ordered[0]!;
    result.winners.set(directory, winner.pkg);
    if (!conflicting) continue;
    result.count++;
    if (result.details.length >= 10) continue;
    const losers = ordered.slice(1, 6).map((v) => display(v.pkg.metadata.producer.jobName, 80));
    const omitted = ordered.length - 1 - losers.length;
    const detail = `Directory '${display(directory, 256)}': selected '${display(winner.pkg.metadata.producer.jobName, 80)}'; discarded ${losers.join(', ')}${omitted ? ` (+${omitted} producers)` : ''}.`;
    const bytes = Buffer.byteLength(detail);
    // Reserve space within the 8 KiB budget for the total and omitted-directory summaries.
    if (diagnosticBytes + bytes > 7680) continue;
    diagnosticBytes += bytes;
    result.details.push(detail);
  }
  return result;
}
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function display(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}
