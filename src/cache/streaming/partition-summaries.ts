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
import type { NativeChild } from './native-walk';
import { WorkingBudget } from './tree-state';

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
const exclusions = () => ({ file: 0, directory: 0, symlink: 0, other: 0, housekeeping: 0 });
type Exclusions = ReturnType<typeof exclusions>;
function describeExcluded(c: Exclusions) {
  return `observed-excluded=${c.file} files/${c.directory} directories/${c.symlink + c.other} other entries, housekeeping=${c.housekeeping} files`;
}
const escapePathCharacter = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function displayPath(path: string) {
  const suffix = '… [truncated]';
  const limit = 1024 - Buffer.byteLength(suffix);
  let displayed = '',
    bytes = 0;
  for (const character of path) {
    const escaped =
      character === '\\'
        ? '\\\\'
        : escapePathCharacter.test(character)
          ? '\\u{' + character.codePointAt(0)!.toString(16) + '}'
          : character;
    bytes += Buffer.byteLength(escaped);
    if (bytes > limit) return displayed + suffix;
    displayed += escaped;
  }
  return displayed;
}
function releaseSamples(s: Samples) {
  for (const release of s.releases) release();
  s.releases.length = s.paths.length = s.bytes = 0;
}
function report(write: ((message: string) => void) | undefined, message: string) {
  try {
    write?.(message);
  } catch {
    // Reporting cannot change an operation outcome or mask its error.
  }
}
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
      capturedFiles: number;
      logicalBytes: bigint;
      excluded: Exclusions;
      unsupportedLayouts: number;
      hints: Set<Hint>;
      examples: Samples;
    }
  >();
  private readonly opaque = samples();
  private readonly unknown = samples();
  private readonly unattributed = exclusions();
  private readonly sampleBudget: WorkingBudget;
  private prunedDirectories = 0;
  private unknownCount = 0;
  private capturing = false;
  private closed = false;
  constructor(
    private readonly model: ResolvedModel,
    budget: WorkingBudget,
    private readonly analytics = true,
  ) {
    // Samples cannot consume record capacity needed later by the operation.
    this.sampleBudget = new WorkingBudget(Math.min(budget.limit, 512 * 1024));
    if (!analytics) return;
    for (const config of model.partitions)
      this.cells.set(config[0], {
        config,
        directories: 0,
        files: 0,
        purge: config[6]?.length ? 'skipped' : 'not applicable',
        deleted: 0,
        missing: 0,
        unsupported: 0,
        capturedFiles: 0,
        logicalBytes: 0n,
        excluded: exclusions(),
        unsupportedLayouts: 0,
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
    this.capturing = true;
    for (const c of this.cells.values())
      c.purge = c.config[6]?.length ? (enabled ? 'executed' : 'skipped') : 'not applicable';
  }
  purge(id: string, outcome: Outcome) {
    if (this.analytics) this.cell(id)[outcome]++;
  }
  capturedFile(id: string, size: string) {
    if (!this.analytics) return;
    const c = this.cell(id);
    c.capturedFiles++;
    c.logicalBytes += BigInt(size);
  }
  excluded(kind: NativeChild['type'], id?: string, housekeeping = false) {
    if (!this.analytics) return;
    const counts = id === undefined ? this.unattributed : this.cell(id).excluded;
    counts[kind]++;
    if (housekeeping) counts.housekeeping++;
  }
  unsupportedLayout(id: string, path: string) {
    this.excluded('file', id);
    if (this.analytics) this.cell(id).unsupportedLayouts++;
    this.unknownCount++;
    this.sample(this.unknown, path, id + ': ');
  }
  private sample(to: Samples, path: string, displayPrefix?: string) {
    if (to.truncated) return;
    if (to.paths.length >= 8) {
      to.truncated = true;
      return;
    }
    const example = displayPrefix === undefined ? path : displayPrefix + displayPath(path);
    if (to.paths.some((p) => example === p || example.startsWith(p + '/'))) return;
    const size = Buffer.byteLength(example) + (displayPrefix === undefined ? 0 : 3);
    if (to.bytes + size > 4096) {
      to.truncated = true;
      return;
    }
    try {
      to.releases.push(this.sampleBudget.holdRecord(128 + size));
    } catch {
      to.truncated = true;
      return;
    }
    to.paths.push(example);
    to.bytes += size;
  }
  prunedDirectory(path: string) {
    if (!this.analytics) return;
    this.prunedDirectories++;
    this.sample(this.opaque, path, '');
  }
  finishCapture(
    complete: boolean,
    info?: (message: string) => void,
    warning?: (message: string) => void,
  ) {
    if (!this.capturing) return;
    this.capturing = false;
    try {
      if (this.unknownCount) {
        const files = this.unknownCount === 1 ? 'file' : 'files';
        const scope = complete ? '' : ' (partial capture)';
        const omitted = this.unknown.truncated
          ? '\nAdditional examples omitted (bounded sample).'
          : '';
        const examples = this.unknown.paths.map((p) => '\n  ' + p).join('');
        report(
          warning,
          `Omitted ${this.unknownCount} Gradle ${files} outside a supported workspace${scope}.${examples}${omitted}\nFiles in recognized workspaces remain eligible.`,
        );
      }
      if (!this.analytics || !info) return;
      report(info, 'Mammoth capture summary (' + (complete ? 'complete' : 'partial') + '):');
      for (const [id, c] of this.cells) {
        const purge =
          c.purge === 'executed'
            ? `purged=${c.deleted} files (shared claims credited once), missing=${c.missing}, unsupported=${c.unsupported}`
            : `purge=${c.purge}`;
        report(
          info,
          `${id}: captured=${c.capturedFiles} files/${c.logicalBytes} logical bytes, ${describeExcluded(c.excluded)}, unsupported-layout=${c.unsupportedLayouts} files, ${purge}`,
        );
      }
      report(
        info,
        `Unattributed: ${describeExcluded(this.unattributed)}, pruned=${this.prunedDirectories} directories (descendant counts unknown)`,
      );
      for (const path of this.opaque.paths) report(info, '  skipped scope: ' + path);
      if (this.opaque.truncated) report(info, '  additional scopes omitted (bounded sample)');
    } finally {
      releaseSamples(this.opaque);
      releaseSamples(this.unknown);
    }
  }
  root(id: string, kind: 'file' | 'directory') {
    if (!this.analytics) return;
    const c = this.cell(id);
    if (kind === 'file') c.files++;
    else c.directories++;
  }
  hint(id: string, reason: Hint, path: string) {
    if (!this.analytics) return;
    const c = this.cell(id);
    c.hints.add(reason);
    this.sample(c.examples, path);
  }
  choice(id: string, action: Action) {
    if (this.analytics) this.cell(id).action = action;
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
      capturedFiles: c.capturedFiles,
      logicalBytes: c.logicalBytes,
      excluded: { ...c.excluded },
      unsupportedLayouts: c.unsupportedLayouts,
      hints: [...c.hints],
      examples: [...c.examples.paths],
      truncated: c.examples.truncated,
    }));
  }
  emit(reporter: Pick<HostReporter, 'info'>, sink?: Pick<ReportSink, 'publishLogGroup'>) {
    this.assert(this.model);
    if (!this.analytics) return;
    for (const [id, c] of this.cells) {
      const roots =
        c.action === 'new'
          ? `planned-roots=${c.directories} directories/${c.files} files`
          : c.action
            ? 'no upload moves planned'
            : 'planning incomplete';
      reporter.info(`${id}: action=${c.action ?? 'unplanned'}, ${roots}`);
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
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    releaseSamples(this.opaque);
    releaseSamples(this.unknown);
    for (const c of this.cells.values()) releaseSamples(c.examples);
  }
}
