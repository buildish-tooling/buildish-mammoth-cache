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
import { Digest, equal, type Value } from './encoding';
import { filePathSchema, shaSchema, positiveSchema, unitKindSchema } from './schema';
import { GcTreeState } from './local-gc-state';
import { semanticUnitSchema, type LocalSchemas } from './local-schema';
import {
  TreeState,
  compareMembership,
  parentPath,
  recognizedRoot,
  validateUnit,
  type WorkingBudget,
} from './tree-state';

export type InstallKind = (row: Value) => 'file' | 'directory';
/** Implicit directory closes in native evidence, while retaining only active tree frames. */
class FlatTree {
  private readonly tree: TreeState;
  constructor(
    budget: WorkingBudget,
    maxEntries: number,
    private readonly leaf: (path: string) => void,
  ) {
    this.tree = new TreeState(budget, maxEntries);
  }
  accept(path: string, directory: boolean): void {
    const parent = parentPath(path);
    if (!this.tree.depth) {
      if (path !== '' || !directory) throw new Error('Missing evidence root.');
      this.tree.open('');
      return;
    }
    while (this.tree.depth && this.tree.path !== parent) this.close();
    if (!this.tree.depth) throw new Error('Invalid native evidence hierarchy.');
    if (directory) this.tree.open(path);
    else this.tree.file(path);
  }
  private close(): void {
    if (this.tree.path && this.tree.leaf) this.leaf(this.tree.path);
    this.tree.close(this.tree.path);
  }
  finish(): void {
    while (this.tree.depth) this.close();
    if (!this.tree.complete) throw new Error('Incomplete native evidence.');
  }
  dispose(): void {
    this.tree.dispose();
  }
}
const gcClose = z.tuple([
  z.literal('gc-unit-close'),
  z.union([z.literal('file'), unitKindSchema]),
  filePathSchema,
  shaSchema,
]);
const moveClose = z.tuple([
  z.literal('move-unit-close'),
  z.union([z.literal('file'), z.literal('directory'), unitKindSchema]),
  filePathSchema,
  positiveSchema,
]);
const installClose = z.tuple([
  z.literal('install-unit-close'),
  z.union([z.literal('file'), z.literal('snapshot'), z.literal('empty-directory'), unitKindSchema]),
  filePathSchema,
]);
const moveDescriptor = z.union([
  semanticUnitSchema,
  z.tuple([z.literal('directory'), filePathSchema, z.literal('subtree')]),
]);
const installDescriptor = z.union([
  semanticUnitSchema,
  z.tuple([z.literal('empty-directory'), filePathSchema, z.literal('subtree')]),
  z.tuple([z.literal('snapshot'), filePathSchema, z.literal('partition')]),
]);
// Protocol: docs/dev/cache-lifecycle-protocol.md#frozen-publication-and-native-transfer-plans
export class LocalEvidenceState {
  private flat?: FlatTree;
  private unit: readonly Value[] | null = null;
  private unitDigest: Digest | null = null;
  private roots = 0;
  private index = 0;
  private installContext = false;
  private haveInstallIndex = false;
  private previous: readonly Value[] | null = null;
  private previousUnit: readonly Value[] | null = null;
  private epoch: number | null = null;
  private snapshotIndex = -1;
  private gc?: GcTreeState;
  constructor(
    private readonly purpose: string,
    private readonly schemas: LocalSchemas,
    private readonly budget: WorkingBudget,
    private readonly partition: string | null,
    private readonly maxEntries = 100000,
    private readonly installKind?: InstallKind,
  ) {
    if (purpose === 'native-evidence' || purpose === 'stage-evidence')
      this.flat = new FlatTree(budget, maxEntries, (path) => {
        const probe = path + '/.workspace-directory-probe';
        recognizedRoot(schemas.options.model, probe);
        if (schemas.options.model.owner(probe)[0] !== partition)
          throw new Error('Wrong native evidence empty-directory owner.');
      });
  }
  private within(path: string, kind?: 'file' | 'directory'): void {
    const u = this.unit;
    if (!u) throw new Error('Evidence outside complete semantic unit.');
    const root = String(u[1]),
      scope = u[2];
    if (u[0] === 'empty-directory' && (path !== root || kind !== 'directory'))
      throw new Error('Empty-directory presence requires its exact directory root.');
    if (u[0] === 'directory' && (path !== root || kind !== 'directory'))
      throw new Error('Directory move group requires its single directory root.');
    if (scope === 'file' && kind !== undefined && kind !== 'file')
      throw new Error('Directory operation in ordinary file unit.');
    if (scope === 'direct' && path === root && kind === 'directory' && this.purpose === 'move-plan')
      return;
    if (scope === 'partition') {
      const owner = kind === 'directory' ? root : this.schemas.options.model.owner(path)[0];
      if (owner !== root) throw new Error('Wrong snapshot install owner.');
    } else if (
      scope === 'file'
        ? path !== root
        : scope === 'direct'
          ? parentPath(path) !== root
          : path !== root && !path.startsWith(root + '/')
    )
      throw new Error('Evidence escapes semantic unit.');
  }
  private ordered(path: string, kind: 'file' | 'directory', nonoverlap = true): void {
    const current: Value[] = ['member', kind === 'file' ? 'file' : 'unit', path];
    if (
      this.previous &&
      (compareMembership(this.previous, current) >= 0 ||
        (nonoverlap && String(path).startsWith(String(this.previous[2]) + '/')))
    )
      throw new Error('Overlapping/unordered evidence roots.');
    this.previous = current;
  }
  private open(value: readonly Value[]): void {
    if (this.unit) throw new Error('Nested evidence unit.');
    const descriptor = this.purpose.startsWith('install')
      ? installDescriptor.parse(value.slice(1))
      : this.purpose === 'move-plan'
        ? moveDescriptor.parse(value.slice(1))
        : semanticUnitSchema.parse(value.slice(1));
    if (descriptor[0] === 'snapshot') this.schemas.partition.parse(descriptor[1]);
    if (
      descriptor[0] !== 'snapshot' &&
      descriptor[0] !== 'file' &&
      descriptor[0] !== 'directory' &&
      descriptor[0] !== 'empty-directory'
    ) {
      if ((descriptor[0] === 'maven-directory') !== (descriptor[2] === 'direct'))
        throw new Error('Wrong evidence unit scope.');
    }
    const install = this.purpose.startsWith('install');
    if (descriptor[0] === 'file') {
      if (recognizedRoot(this.schemas.options.model, descriptor[1]) !== null)
        throw new Error('Indivisible unit labeled ordinary file.');
    } else if (descriptor[0] === 'empty-directory') {
      const model = this.schemas.options.model,
        probe = descriptor[1] + '/.workspace-directory-probe';
      if (model.owner(probe)[3] !== 'aggregate')
        throw new Error('Empty-directory presence requires aggregate owner.');
      if (model.tuple[2] !== 'maven' && recognizedRoot(model, probe) !== null)
        throw new Error('Indivisible unit labeled empty-directory.');
    } else if (descriptor[0] !== 'snapshot' && descriptor[0] !== 'directory')
      validateUnit(this.schemas.options.model, descriptor);
    const order: Value[] = ['member', descriptor[0] === 'file' ? 'file' : 'unit', descriptor[1]];
    if (install && descriptor[0] === 'snapshot') {
      const index = this.schemas.options.model.partitions.findIndex(
        (p) => p[0] === descriptor[1] && p[3] === 'single-writer',
      );
      if (index <= this.snapshotIndex)
        throw new Error('Duplicate/unordered snapshot install unit.');
      this.snapshotIndex = index;
    } else {
      if (install && this.snapshotIndex >= 0)
        throw new Error('Aggregate install unit after snapshots.');
      if (this.previousUnit && compareMembership(this.previousUnit, order) >= 0)
        throw new Error('Unordered evidence units.');
      this.previousUnit = order;
    }
    if (install) this.previous = null;

    this.unit = descriptor;
    this.roots = 0;
    this.unitDigest = this.purpose === 'gc-evidence' ? new Digest('gc-unit').update(value) : null;
    if (this.purpose === 'gc-evidence')
      this.gc = new GcTreeState(
        String(descriptor[1]),
        String(descriptor[2]),
        this.budget,
        this.maxEntries,
      );
  }
  private resetChildren(): void {
    this.gc?.dispose();
    this.gc = undefined;
  }
  accept(value: Value): void {
    if (!Array.isArray(value) || typeof value[0] !== 'string')
      throw new Error('Invalid evidence row.');
    const tag = value[0];
    if (this.purpose.startsWith('install')) {
      if (tag === 'install-context') {
        if (this.installContext || this.unit) throw new Error('Duplicate/late install context.');
        z.tuple([z.literal('install-context'), this.schemas.ref('install-current')]).parse(value);
        this.installContext = true;
        return;
      }
      if (!this.installContext) throw new Error('Missing install context.');
    }
    if (this.flat) {
      const row =
        tag === 'directory'
          ? this.schemas.rows.evidenceDirectory.parse(value)
          : this.schemas.rows.evidenceFile.parse(value);
      this.flat.accept(row[1], tag === 'directory');
      if (tag === 'file') recognizedRoot(this.schemas.options.model, row[1]);
      if (
        tag === 'file' &&
        this.partition !== null &&
        this.schemas.options.model.owner(row[1])[0] !== this.partition
      )
        throw new Error('Wrong native evidence partition.');
      return;
    }
    if (this.purpose === 'adjustments') {
      const row =
        tag === 'adjust'
          ? this.schemas.rows.adjust.parse(value)
          : this.schemas.rows.ancestorEffect.parse(value);
      const kind =
        tag === 'adjust' ? ((row[3] as Value[])[2] as 'file' | 'directory') : 'directory';
      if (this.previous && this.previous[2] === row[1])
        throw new Error('Duplicate effective adjustment.');
      this.ordered(row[1], kind, false);
      return;
    }
    if (this.purpose === 'outbound-evidence' || this.purpose === 'return-evidence') {
      const row = this.schemas.rows.transition.parse(value),
        direction = this.purpose === 'outbound-evidence' ? 'outbound' : 'return';
      if (
        row[1] <= this.index ||
        row[3] !== direction ||
        (this.epoch !== null && row[2] !== this.epoch)
      )
        throw new Error('Unordered/wrong transfer evidence.');
      this.index = row[1];
      this.epoch = row[2];
      return;
    }
    const kind =
      this.purpose === 'gc-evidence' ? 'gc' : this.purpose === 'move-plan' ? 'move' : 'install';
    if (tag === kind + '-unit-open') {
      this.open(value);
      return;
    }
    if (!this.unit) throw new Error('Missing evidence unit.');
    if (tag === kind + '-unit-close') {
      const row =
        kind === 'gc'
          ? gcClose.parse(value)
          : kind === 'move'
            ? moveClose.parse(value)
            : installClose.parse(value);
      if (row[1] !== this.unit[0] || row[2] !== this.unit[1])
        throw new Error('Unbalanced evidence unit.');
      if (kind === 'gc') this.gc!.finish();
      if (kind === 'gc') equal(row[3]!, this.unitDigest!.digest(), 'GC projection');
      if (kind === 'move' && this.unit[0] === 'directory' && this.roots !== 1)
        throw new Error('Directory group root count.');
      if (kind === 'move' && row[3] !== this.roots) throw new Error('Wrong move root count.');
      if (
        kind !== 'gc' &&
        this.roots === 0 &&
        this.unit[0] !== 'snapshot' &&
        this.unit[0] !== 'empty-directory'
      )
        throw new Error('Empty operation unit.');
      this.unit = null;
      this.unitDigest = null;
      this.resetChildren();
      return;
    }
    if (kind === 'move') {
      const row = this.schemas.rows.move.parse(value);
      this.within(row[4], row[5]);
      if (row[1] !== this.index + 1) throw new Error('Noncontiguous move index.');
      this.ordered(row[4], row[5]);
      this.index = row[1];
      this.roots++;
      return;
    }
    if (kind === 'install' && tag === 'install-parent') {
      const row = this.schemas.rows.installParent.parse(value);
      if (!this.haveInstallIndex && this.purpose === 'install-evidence') this.index = row[1] - 1;
      if (row[1] !== this.index + 1) throw new Error('Noncontiguous install index.');
      this.haveInstallIndex = true;
      // Structural ancestors may cross a unit root. Admission binds each to a later
      // member of this unit and proves empty source/absent destination before intent.
      this.index = row[1];
      return;
    }
    if (kind === 'install') {
      const row = this.schemas.rows.install.parse(value);
      if (!this.installKind)
        throw new Error('Install ordering requires independently validated member kind.');
      const memberKind = this.installKind(row);
      if (memberKind !== 'file' && memberKind !== 'directory')
        throw new Error('Invalid install evidence kind.');
      this.within(row[2], memberKind);
      if (!this.haveInstallIndex && this.purpose === 'install-evidence') this.index = row[1] - 1;
      if (row[1] !== this.index + 1) throw new Error('Noncontiguous install index.');
      this.haveInstallIndex = true;
      this.ordered(row[2], memberKind);
      this.index = row[1];
      this.roots++;
      if (this.unit[0] === 'empty-directory' && this.roots > 1)
        throw new Error('Multiple empty-directory operations.');
      if (this.unit[0] === 'empty-directory' && row[6] === 'delete')
        throw new Error('Empty-directory presence cannot delete.');
      return;
    }
    if (tag === 'directory') {
      const row = this.schemas.rows.evidenceDirectory.parse(value);
      this.gc!.directory(row[1], row[2]);
      this.unitDigest!.update(row);
    } else if (tag === 'parent-child') {
      const row = this.schemas.rows.parentChild.parse(value);
      this.gc!.child(row[1], row[2], row[3], row[4], row[5]);
      this.unitDigest!.update(row);
    } else if (tag === 'target') {
      const row = this.schemas.rows.gcTarget.parse(value);
      this.within(row[1]);
      if (this.schemas.options.model.owner(row[1])[0] !== row[2])
        throw new Error('Wrong GC target owner.');
      this.gc!.target(row[1], row[3]);
      this.unitDigest!.update(row);
      this.roots++;
    } else throw new Error('Unknown GC evidence row.');
  }
  finish(): void {
    if (this.purpose.startsWith('install') && !this.installContext)
      throw new Error('Missing install context.');
    this.flat?.finish();
    if (this.unit) throw new Error('Incomplete evidence unit.');
  }
  dispose(): void {
    this.flat?.dispose();
    this.resetChildren();
  }
}
