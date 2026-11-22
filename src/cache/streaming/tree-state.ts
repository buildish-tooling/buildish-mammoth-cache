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

import { UnitMarkers } from './unit-markers';
import { workspaceRoot, workspaceKind, isWorkspaceCachePath } from '../immutable-workspaces';
import { add, Digest, type Value } from './encoding';
import type { ResolvedModel } from './model';
import {
  componentSchema,
  filePathSchema,
  pathSchema,
  unitSchema,
  type Counts,
  type Unit,
} from './schema';

// Protocol: docs/dev/cache-protocol.md#paths-and-order and #resource-accounting
export class WorkingBudget {
  private names = 0;
  private records = 0;
  private peak = 0;
  constructor(readonly limit = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid working budget.');
  }
  retain(bytes: number): void {
    if (this.names + bytes > this.limit)
      throw new Error('Active metadata/name working budget exceeded.');
    this.names += bytes;
    this.peak = Math.max(this.peak, this.retained);
  }
  release(bytes: number): void {
    this.names -= bytes;
    if (this.names < 0) throw new Error('Invalid budget release.');
  }
  holdRecord(bytes: number): () => void {
    const charge = add(4096, bytes * 8);
    if (this.records + charge > this.limit)
      throw new Error('Active decoded-record working budget exceeded.');
    this.records += charge;
    this.peak = Math.max(this.peak, this.retained);
    let held = true;
    return () => {
      if (held) {
        this.records -= charge;
        held = false;
      }
    };
  }
  get peakRetained(): number {
    return this.peak;
  }
  get retained(): number {
    return this.names + this.records;
  }
}
export function compareName(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
export function joinPath(parent: string, name: string): string {
  return parent ? parent + '/' + name : name;
}
interface Frame {
  path: string;
  phase: 'files' | 'directories';
  lastFile: string | null;
  lastDirectory: string | null;
  files: Set<string>;
  children: number;
  charge: number;
  directoryCharge: number;
}
export class TreeState {
  private readonly frames: Frame[] = [];
  private started = false;
  private ended = false;
  constructor(
    readonly budget: WorkingBudget,
    readonly maxEntries = 100000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new Error('Invalid directory entry allowance.');
  }
  get path(): string {
    if (!this.frames.length) throw new Error('No open directory.');
    return this.frames[this.frames.length - 1].path;
  }
  get depth(): number {
    return this.frames.length;
  }
  get emptyDirectory(): boolean {
    return (
      this.frames.length > 0 &&
      this.frames[this.frames.length - 1].children === 0 &&
      this.frames[this.frames.length - 1].phase === 'files'
    );
  }
  get leaf(): boolean {
    return this.frames.length > 0 && this.frames[this.frames.length - 1].children === 0;
  }
  get complete(): boolean {
    return this.started && this.ended && !this.frames.length;
  }
  private child(name: string, directory: boolean): Frame {
    componentSchema.parse(name);
    // V8 slices can retain a whole long path for each short basename. Own the bytes.
    name = Buffer.from(name).toString('utf8');
    const parent = this.frames[this.frames.length - 1];
    if (!parent) throw new Error('Missing parent directory.');
    if (parent.children === this.maxEntries) throw new Error('Managed directory breadth exceeded.');
    if (directory) {
      if (
        parent.files.has(name) ||
        (parent.lastDirectory !== null && compareName(parent.lastDirectory, name) >= 0)
      )
        throw new Error('Duplicate/colliding/unordered directory.');
      const charge = 64 + 4 * Buffer.byteLength(name);
      this.budget.retain(charge);
      this.budget.release(parent.directoryCharge);
      parent.charge += charge - parent.directoryCharge;
      parent.directoryCharge = charge;
      parent.phase = 'directories';
      parent.lastDirectory = name;
    } else {
      if (
        parent.phase !== 'files' ||
        (parent.lastFile !== null && compareName(parent.lastFile, name) >= 0)
      )
        throw new Error('Duplicate/unordered file.');
      const charge = 64 + 4 * Buffer.byteLength(name);
      this.budget.retain(charge);
      parent.charge += charge;
      parent.files.add(name);
      parent.lastFile = name;
    }
    parent.children++;
    return parent;
  }
  open(path: string): void {
    pathSchema.parse(path);
    if (this.ended || this.frames.length === 100) throw new Error('Invalid tree depth/root.');
    if (!this.started) {
      if (path !== '') throw new Error('Missing empty root.');
      this.started = true;
    } else {
      if (!path || parentPath(path) !== this.path) throw new Error('Invalid directory hierarchy.');
      this.child(baseName(path), true);
    }
    const charge = 128 + 4 * Buffer.byteLength(path);
    this.budget.retain(charge);
    this.frames.push({
      path,
      phase: 'files',
      lastFile: null,
      lastDirectory: null,
      files: new Set(),
      children: 0,
      charge,
      directoryCharge: 0,
    });
  }
  file(path: string): void {
    filePathSchema.parse(path);
    if (parentPath(path) !== this.path) throw new Error('File outside current directory.');
    this.child(baseName(path), false);
  }
  /** A no-follow protected child participates in order/breadth without opening its subtree. */
  protectedChild(name: string, directory: boolean): void {
    this.child(name, directory);
  }
  endFiles(): void {
    if (!this.frames.length) throw new Error('Missing directory.');
    this.frames[this.frames.length - 1].phase = 'directories';
  }
  close(path: string): void {
    if (path !== this.path) throw new Error('Unbalanced directory close.');
    const frame = this.frames.pop()!;
    this.budget.release(frame.charge);
    if (!this.frames.length) this.ended = true;
  }
  dispose(): void {
    while (this.frames.length) this.budget.release(this.frames.pop()!.charge);
  }
}
export function newCounts(): Counts {
  return [0, 0, 0, 0, 0];
}
export function countInto(target: Counts, source: Counts): void {
  for (let i = 0; i < 5; i++) target[i] = add(target[i], source[i]);
}
export function normalizeMode(buildTool: string, path: string, mode: number): number {
  const launcher =
    buildTool === 'gradle'
      ? /^wrapper\/dists\/[^/]+\/[^/]+\/gradle-[^/]+\/bin\/gradle$/
      : /^wrapper\/dists\/[^/]+\/[^/]+\/(?:apache-maven-[^/]+\/)?bin\/(?:mvn|mvnDebug|mvnyjp)$/;
  return launcher.test(path) ? 493 : 420 | (mode & 73);
}
export function isWorkspaceRoot(model: ResolvedModel, path: string): boolean {
  return model.tuple[2] === 'gradle' && workspaceRoot(path) === path;
}
// Namespace directories carry physical evidence, never an empty workspace payload.
export function isWorkspaceScaffolding(model: ResolvedModel, path: string): boolean {
  return model.tuple[2] === 'gradle' && isWorkspaceCachePath(path) && workspaceRoot(path) === null;
}
export function recognizedRoot(model: ResolvedModel, path: string): string | null {
  if (model.tuple[2] === 'maven') return path.startsWith('repository/') ? parentPath(path) : null;
  const root = workspaceRoot(path);
  if (root === null && isWorkspaceCachePath(path))
    throw new Error('Unsupported workspace-surface contribution. Path: ' + path);
  return root;
}
export function validateUnit(model: ResolvedModel, unit: Unit): void {
  unitSchema.parse(unit);
  const [kind, root] = unit;
  if (model.tuple[2] === 'maven') {
    if (kind !== 'maven-directory' || (root !== 'repository' && !root.startsWith('repository/')))
      throw new Error('Unrecognized Maven unit.');
  } else if (
    workspaceRoot(root) !== root ||
    (workspaceKind(root) !== kind &&
      !(workspaceKind(root) === 'kotlin-accessor-directories' && kind === 'kotlin-accessor-jars'))
  )
    throw new Error('Unrecognized workspace unit.');
}
export interface UnitSummary {
  counts: Counts;
  semantic: string;
  comparison: string;
}
/** Incremental facts and a constant set of classifier markers, never unit members. */
export class UnitProjection {
  readonly counts = newCounts();
  private readonly semantic: Digest;
  private readonly comparison: Digest;
  private sealed?: UnitSummary;
  private readonly markers: UnitMarkers;
  private owner: string | null = null;
  constructor(
    readonly model: ResolvedModel,
    readonly unit: Unit,
    readonly usage = false,
    readonly projection: string | null = null,
  ) {
    validateUnit(model, unit);
    const [kind, root, scope] = unit;
    this.counts[2] = 1;
    this.semantic = new Digest(
      usage ? 'usage-membership' : projection === null ? 'unit-semantic' : 'base-unit-semantic',
    );
    this.comparison = new Digest(projection === null ? 'unit-compare' : 'base-unit-compare');
    this.semantic.update(
      projection === null
        ? ['unit', ...unit]
        : ['unit', ...unit, 'partition-projection', projection],
    );
    this.comparison.update(
      projection === null ? ['unit', kind] : ['unit', kind, 'partition-projection', projection],
    );
    this.markers = new UnitMarkers(unit);
    if (scope === 'subtree') this.directory(root, 'open');
  }
  private relative(path: string): string {
    const root = this.unit[1];
    if (path === root) return '';
    if (!path.startsWith(root + '/')) throw new Error('Unit member outside root.');
    return path.slice(root.length + 1);
  }
  directory(path: string, phase: 'open' | 'close'): void {
    if (this.sealed) throw new Error('Fact after unit close.');
    if (this.unit[2] === 'direct') throw new Error('Child directory inside direct unit.');
    this.relative(path);
    this.semantic.update(['directory', path, phase]);
    if (!this.usage) this.comparison.update(['directory', this.relative(path), phase]);
    if (phase === 'open') {
      this.counts[1] = add(this.counts[1]);
      this.markers.directory(path);
    }
  }
  file(
    path: string,
    partition: string,
    size: number,
    mode: number,
    time: number,
    sha: string,
  ): void {
    if (this.sealed || (this.unit[2] === 'direct' && parentPath(path) !== this.unit[1]))
      throw new Error('Invalid unit file boundary.');
    this.markers.file(path);
    this.ownership(partition);
    if (this.usage) {
      this.semantic.update(['used', path, partition]);
      this.counts[3] = add(this.counts[3]);
    } else {
      this.semantic.update(['file', path, partition, size, mode, time, sha]);
      this.comparison.update(
        this.unit[0] === 'maven-directory'
          ? ['file', this.relative(path), size, sha]
          : ['file', this.relative(path), size, mode, sha],
      );
      this.counts[0] = add(this.counts[0]);
      this.counts[4] = add(this.counts[4], size);
    }
  }
  ownership(partition: string): void {
    if (this.projection !== null && this.projection !== partition)
      throw new Error('Wrong unit projection owner.');
    if (this.unit[0] !== 'maven-directory') {
      if (this.owner !== null && this.owner !== partition)
        throw new Error('Split workspace ownership.');
      this.owner = partition;
    }
  }
  finish(): UnitSummary {
    if (this.sealed) return this.sealed;
    if (this.unit[2] === 'subtree') this.directory(this.unit[1], 'close');
    this.markers.finish();
    this.semantic.update(['unit-end', this.unit[0], this.unit[1]]);
    return (this.sealed = {
      counts: [...this.counts],
      semantic: this.semantic.digest(),
      comparison: this.comparison.digest(),
    });
  }
}
/** Files-first hierarchical order; unit roots precede their own members. */
export function compareMembership(a: readonly Value[], b: readonly Value[]): number {
  const pa = String(a[2]).split('/'),
    pb = String(b[2]).split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const ca = i === pa.length - 1 && a[1] === 'file' ? 0 : 1,
      cb = i === pb.length - 1 && b[1] === 'file' ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const cmp = compareName(pa[i], pb[i]);
    if (cmp) return cmp;
  }
  return pa.length - pb.length;
}
