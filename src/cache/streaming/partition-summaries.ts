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

import type { HostReporter, ReportSink } from '../../host/types';
import type { ResolvedModel, Partition } from './model';
import type { WorkingBudget } from './tree-state';
import { add } from './encoding';

type Action = 'new' | 'reuse' | 'empty';
type Hint =
  'excluded or unmanaged entries remain' | 'mixed partition ownership' | 'unselected contents';
type Outcome = 'deleted' | 'missing' | 'unsupported';
interface Samples {
  paths: string[];
  bytes: number;
  truncated: boolean;
  releases: (() => void)[];
}
const samples = (): Samples => ({ paths: [], bytes: 0, truncated: false, releases: [] });
// Protocol: docs/dev/cache-lifecycle-protocol.md#pre-freeze-purge-configuration.
// Operation-local diagnostics only. Never evidence, authority or persistent state.
export class PartitionSummaries {
  private readonly cells = new Map<
    string,
    {
      config: Partition;
      action?: Action;
      directories: number;
      files: number;
      purge: 'not applicable' | 'skipped' | 'executed';
      deleted: number;
      missing: number;
      unsupported: number;
      hints: Set<Hint>;
      examples: Samples;
    }
  >();
  private readonly opaque = samples();
  private opaqueCount = 0;
  private closed = false;
  constructor(
    private readonly model: ResolvedModel,
    private readonly budget: WorkingBudget,
  ) {
    for (const config of model.partitions)
      this.cells.set(config[0], {
        config,
        directories: 0,
        files: 0,
        purge: config[6]?.length ? 'skipped' : 'not applicable',
        deleted: 0,
        missing: 0,
        unsupported: 0,
        hints: new Set(),
        examples: samples(),
      });
  }
  assert(model: ResolvedModel) {
    if (this.closed || model.id !== this.model.id)
      throw new Error('Unbound or closed partition summaries.');
  }
  private cell(id: string) {
    this.assert(this.model);
    const c = this.cells.get(id);
    if (!c) throw new Error('Unknown summary partition.');
    return c;
  }
  capture(enabled: boolean) {
    this.assert(this.model);
    for (const c of this.cells.values())
      c.purge = c.config[6]?.length ? (enabled ? 'executed' : 'skipped') : 'not applicable';
  }
  purge(id: string, outcome: Outcome) {
    const c = this.cell(id);
    c[outcome] = add(c[outcome]);
  }
  private sample(to: Samples, path: string) {
    if (to.paths.some((p) => path === p || path.startsWith(p + '/'))) return;
    const size = Buffer.byteLength(path);
    if (to.paths.length >= 8 || to.bytes + size > 4096) {
      to.truncated = true;
      return;
    }
    const release = this.budget.holdRecord(128 + size);
    to.paths.push(path);
    to.bytes += size;
    to.releases.push(release);
  }
  opaqueScope(path: string) {
    this.assert(this.model);
    this.opaqueCount = add(this.opaqueCount);
    this.sample(this.opaque, path);
  }
  root(id: string, kind: 'file' | 'directory') {
    const c = this.cell(id);
    if (kind === 'file') c.files = add(c.files);
    else c.directories = add(c.directories);
  }
  hint(id: string, reason: Hint, path: string) {
    const c = this.cell(id);
    c.hints.add(reason);
    this.sample(c.examples, path);
  }
  choice(id: string, action: Action) {
    this.cell(id).action = action;
  }
  snapshot() {
    this.assert(this.model);
    return [...this.cells].map(([id, c]) => ({
      id,
      action: c.action,
      directories: c.directories,
      files: c.files,
      purge: c.purge,
      deleted: c.deleted,
      missing: c.missing,
      unsupported: c.unsupported,
      hints: [...c.hints],
      examples: [...c.examples.paths],
      truncated: c.examples.truncated,
    }));
  }
  emit(reporter: Pick<HostReporter, 'info'>, sink?: Pick<ReportSink, 'publishLogGroup'>) {
    this.assert(this.model);
    for (const [id, c] of this.cells) {
      const roots =
          c.action === 'new'
            ? `planned-roots=${c.directories} directories/${c.files} files`
            : c.action
              ? 'no upload moves planned'
              : 'planning incomplete',
        purged =
          c.purge === 'executed'
            ? `purged=${c.deleted} files (shared matches credited once), missing=${c.missing}, unsupported=${c.unsupported}`
            : `purge=${c.purge}`;
      reporter.info(`${id}: action=${c.action ?? 'unplanned'}, ${roots}, ${purged}`);
      if (c.action === 'new' && c.hints.size) {
        reporter.info('  finer-grained moves: ' + [...c.hints].join('; '));
        for (const p of c.examples.paths) reporter.info('  example: ' + p);
        if (c.examples.truncated) reporter.info('  additional examples omitted (bounded sample)');
      }
      const p = c.config;
      sink?.publishLogGroup(
        'Mammoth partition ' + id,
        [
          JSON.stringify({
            id,
            includes: p[1],
            excludes: [...new Set([...p[2], ...(p[6] ?? [])])],
            purgeableGlobs: p[6] ?? [],
            publication: p[3],
            writer: p[4],
            conflict: p[5],
          }),
        ],
        (line) => reporter.info(line),
      );
    }
    if (this.opaqueCount) {
      reporter.info(
        `purge scope: ${this.opaqueCount} hard-pruned directories not inspected; descendant match counts unknown`,
      );
      for (const p of this.opaque.paths) reporter.info('  skipped scope: ' + p);
      if (this.opaque.truncated) reporter.info('  additional scopes omitted (bounded sample)');
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const s of [this.opaque, ...[...this.cells.values()].map((c) => c.examples)]) {
      for (const release of s.releases) release();
      s.releases = [];
      s.paths = [];
    }
  }
}
