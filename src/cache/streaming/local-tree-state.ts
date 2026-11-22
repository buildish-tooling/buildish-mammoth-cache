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

import { z } from 'zod';
import { UnitMarkers } from './unit-markers';
import { Digest, equal, type Value } from './encoding';
import {
  componentSchema,
  pathSchema,
  shaSchema,
  unitSchema,
  unitKindSchema,
  type Unit,
} from './schema';
import {
  isWorkspaceScaffolding,
  TreeState,
  type WorkingBudget,
  compareName,
  baseName,
  joinPath,
  recognizedRoot,
  isWorkspaceRoot,
  validateUnit,
} from './tree-state';
import type { LocalSchemas } from './local-schema';

const closeDirectory = z.tuple([z.literal('dir-close'), pathSchema]);
const closeObservationUnit = z.tuple([
  z.literal('unit-close'),
  unitKindSchema,
  pathSchema,
  shaSchema,
]);
const activityUnit = z.tuple([
  z.literal('unit-open'),
  unitKindSchema,
  pathSchema,
  z.enum(['direct', 'subtree']),
  z.enum(['upsert', 'used']),
]);
const closeActivityUnit = z.tuple([z.literal('unit-close'), unitKindSchema, pathSchema]);
interface Projection {
  path: string;
  children: Map<string, readonly ['file' | 'directory' | 'symlink' | 'other', string, string]>;
  phase: 'non-directory' | 'directory' | 'body';
  last: string | null;
  count: number;
  charge: number;
  evidence: Digest;
}
interface ActiveUnit {
  markers: UnitMarkers | null;
  unit: Unit;
  activity: string;
  decision: string;
  digest: Digest | null;
  expected: string | null;
  owner: string | null;
}
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-observation-and-gc-schemas
/** Child projections are per-open-directory and charged alongside managed name state. */
export class LocalTreeState {
  private readonly tree: TreeState;
  private readonly frames: Projection[] = [];
  private active: ActiveUnit | null = null;
  private closeRoot: string | null = null;
  private required: string | null = null;
  constructor(
    private readonly purpose: 'activity' | 'observations',
    private readonly schemas: LocalSchemas,
    private readonly budget: WorkingBudget,
    private readonly maxEntries = 100000,
  ) {
    this.tree = new TreeState(budget, maxEntries);
  }
  private frame(): Projection {
    if (!this.frames.length) throw new Error('No observation directory.');
    return this.frames[this.frames.length - 1];
  }
  private owner(path: string): string {
    const partition = this.schemas.options.model.owner(path)[0];
    if (this.active && this.active.unit[0] !== 'maven-directory') {
      if (this.active.owner !== null && this.active.owner !== partition)
        throw new Error('Split local workspace owner.');
      this.active.owner = partition;
    }
    return partition;
  }
  private bind(name: string, native: readonly Value[], kind: 'file' | 'directory'): void {
    if (this.purpose !== 'observations') return;
    const child = this.frame().children.get(name);
    if (!child || child[0] !== kind || child[1] !== native[3] || child[2] !== native[4])
      throw new Error('Managed fact differs from frozen child projection.');
  }
  accept(value: Value): void {
    if (!Array.isArray(value) || typeof value[0] !== 'string')
      throw new Error('Invalid local tree row.');
    const tag = value[0];
    if (
      this.required !== null &&
      tag !== 'unit-open' &&
      !(this.purpose === 'observations' && tag === 'child')
    )
      throw new Error('Missing local complete unit wrapper.');
    if (this.closeRoot !== null && (tag !== 'dir-close' || value[1] !== this.closeRoot))
      throw new Error('Missing local unit root close.');
    if (tag !== 'child' && this.frames.length) this.frame().phase = 'body';
    if (tag === 'dir-open') {
      const row =
        this.purpose === 'observations'
          ? this.schemas.rows.observationDirectory.parse(value)
          : z.tuple([z.literal('dir-open'), pathSchema]).parse(value);
      if (this.active?.unit[2] === 'direct') throw new Error('Directory inside direct local unit.');
      if (this.frames.length) this.bind(baseName(row[1]), row[2] ?? [], 'directory');
      this.tree.open(row[1]);
      this.active?.markers?.directory(row[1]);
      const evidence = new Digest('observation-unit');
      if (this.purpose === 'observations') {
        const fact: Value = ['directory', row[1], row[2]!];
        evidence.update(fact);
        this.active?.digest?.update(fact);
      }
      const charge = 128 + 4 * Buffer.byteLength(row[1]);
      this.budget.retain(charge);
      this.frames.push({
        path: row[1],
        children: new Map(),
        phase: 'non-directory',
        last: null,
        count: 0,
        charge,
        evidence,
      });
      if (!this.active && isWorkspaceRoot(this.schemas.options.model, row[1]))
        this.required = row[1];
    } else if (tag === 'child') {
      if (this.purpose !== 'observations') throw new Error('Child projection in activity.');
      const row = this.schemas.rows.child.parse(value),
        f = this.frame(),
        directory = row[2] === 'directory';
      if (f.phase === 'body' || (!directory && f.phase === 'directory'))
        throw new Error('Late/unordered child projection.');
      if (directory && f.phase === 'non-directory') {
        f.phase = 'directory';
        f.last = null;
      }
      if (f.children.has(row[1]) || (f.last !== null && compareName(f.last, row[1]) >= 0))
        throw new Error('Duplicate/unordered frozen child.');
      if (f.count === this.maxEntries) throw new Error('Observation directory breadth exceeded.');
      const name = Buffer.from(row[1]).toString('utf8'),
        charge = 128 + 4 * (Buffer.byteLength(name) + row[3].length + row[4].length);
      this.budget.retain(charge);
      f.charge += charge;
      f.count++;
      f.last = name;
      f.children.set(name, [row[2], row[3], row[4]]);
      const fact: Value = ['child', f.path, ...row.slice(1)];
      f.evidence.update(fact);
      this.active?.digest?.update(fact);
    } else if (tag === 'unit-open') {
      const row =
        this.purpose === 'observations'
          ? this.schemas.rows.observationUnit.parse(value)
          : activityUnit.parse(value);
      const unit = unitSchema.parse(row.slice(1, 4));
      validateUnit(this.schemas.options.model, unit);
      if (this.active || !this.tree.emptyDirectory || unit[1] !== this.tree.path)
        throw new Error('Invalid local unit boundary.');
      this.active = {
        unit,
        activity: row[4],
        decision: this.purpose === 'observations' ? String(row[5]) : 'retain',
        digest: this.purpose === 'observations' ? this.frame().evidence.copy() : null,
        expected: this.purpose === 'observations' ? String(row[6]) : null,
        owner: null,
        markers: null,
      };
      if (this.active.decision === 'delete') this.active.markers = new UnitMarkers(unit);
      this.required = null;
    } else if (tag === 'file' || tag === 'upsert' || tag === 'used') {
      let name: string, partition: string;
      if (this.purpose === 'observations') {
        const row = this.schemas.rows.observationFile.parse(value);
        name = row[1];
        partition = row[2];
        const path = joinPath(this.tree.path, name);
        this.bind(name, row[3], 'file');
        if (this.active && (row[5] !== this.active.activity || row[6] !== this.active.decision))
          throw new Error('Mixed local unit decisions.');
        this.active?.digest?.update(['file', path, partition, row[3], row[4]]);
      } else {
        const row = z
          .tuple([z.enum(['upsert', 'used']), componentSchema, this.schemas.partition])
          .parse(value);
        name = row[1];
        partition = row[2];
        if (this.active && this.active.activity !== row[0])
          throw new Error('Mixed local unit activity.');
      }
      const path = joinPath(this.tree.path, name);
      this.tree.file(path);
      this.active?.markers?.file(path);
      if (this.owner(path) !== partition)
        throw new Error('Wrong local activity/observation owner.');
      const root = recognizedRoot(this.schemas.options.model, path);
      if (root !== null && (!this.active || this.active.unit[1] !== root || root === path))
        throw new Error('Missing local file unit.');
    } else if (tag === 'unit-close') {
      const row =
          this.purpose === 'observations'
            ? closeObservationUnit.parse(value)
            : closeActivityUnit.parse(value),
        a = this.active;
      if (!a || row[1] !== a.unit[0] || row[2] !== a.unit[1] || this.tree.path !== row[2])
        throw new Error('Unbalanced local unit.');
      a.markers?.finish();
      if (a.digest)
        equal(
          [row[3]!, a.expected],
          [a.digest.digest(), a.digest.digest()],
          'observation unit evidence',
        );
      if (a.unit[2] === 'direct') this.tree.endFiles();
      else this.closeRoot = a.unit[1];
      this.active = null;
    } else if (tag === 'dir-close') {
      const row = closeDirectory.parse(value);
      if (this.active?.unit[1] === row[1]) throw new Error('Missing local unit close.');
      if (row[1] && this.tree.leaf) {
        const probe = row[1] + '/.workspace-directory-probe';
        let owned = true;
        try {
          this.owner(probe);
        } catch (error) {
          if (
            this.purpose !== 'observations' ||
            (this.active && (this.active.owner !== null || this.active.decision !== 'retain')) ||
            !(error instanceof Error) ||
            error.message !== 'Unowned managed path.'
          )
            throw error;
          // Physical observation scaffolding is evidence, never a managed contribution.
          owned = false;
        }
        if (
          owned &&
          !(
            this.purpose === 'observations' &&
            isWorkspaceScaffolding(this.schemas.options.model, row[1])
          )
        )
          recognizedRoot(this.schemas.options.model, probe);
      }
      this.tree.close(row[1]);
      this.closeRoot = null;
      const f = this.frames.pop();
      if (!f || f.path !== row[1]) throw new Error('Unbalanced observation frame.');
      this.budget.release(f.charge);
    } else throw new Error('Unknown local tree row.');
  }
  finish(): void {
    if (!this.tree.complete || this.active || this.frames.length)
      throw new Error('Incomplete local tree.');
  }
  dispose(): void {
    this.tree.dispose();
    while (this.frames.length) this.budget.release(this.frames.pop()!.charge);
  }
}
