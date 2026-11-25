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
import { type Value } from './encoding';
import { filePathSchema, unitKindSchema } from './schema';
import { semanticUnitSchema, type LocalSchemas } from './local-schema';
import {
  compareMembership,
  parentPath,
  recognizedRoot,
  validateUnit,
  isWorkspaceScaffolding,
} from './tree-state';
export type InstallKind = (row: Value) => 'file' | 'directory';

const installDescriptor = z.union([
  semanticUnitSchema,
  z.tuple([z.literal('directory'), filePathSchema, z.literal('subtree')]),
  z.tuple([z.literal('empty-directory'), filePathSchema, z.literal('subtree')]),
  z.tuple([z.literal('snapshot'), filePathSchema, z.literal('partition')]),
]);
const installClose = z.tuple([
  z.literal('install-unit-close'),
  z.union([
    z.literal('file'),
    z.literal('directory'),
    z.literal('snapshot'),
    z.literal('empty-directory'),
    unitKindSchema,
  ]),
  filePathSchema,
]);
/** Strict temporary operation grammar; selectors require the original process-owned context. */
export class LocalInstallState {
  private unit: readonly Value[] | null = null;
  private roots = 0;
  private index = 0;
  private installContext = false;
  private previous: readonly Value[] | null = null;
  private previousUnit: readonly Value[] | null = null;
  private previousDirectoryGroup = false;
  private snapshotIndex = -1;

  constructor(
    private readonly schemas: LocalSchemas,
    private readonly installKind: InstallKind | undefined,
  ) {}

  private within(path: string, kind?: 'file' | 'directory'): void {
    const u = this.unit;
    if (!u) {
      throw new Error('Evidence outside complete semantic unit.');
    }
    const root = String(u[1]),
      scope = u[2];
    if (u[0] === 'empty-directory' && (path !== root || kind !== 'directory')) {
      throw new Error('Empty-directory presence requires its exact directory root.');
    }
    if (u[0] === 'directory' && (path !== root || kind !== 'directory')) {
      throw new Error('Directory move group requires its single directory root.');
    }
    if (scope === 'file' && kind !== undefined && kind !== 'file') {
      throw new Error('Directory operation in ordinary file unit.');
    }
    if (scope === 'partition') {
      const owner = kind === 'directory' ? root : this.schemas.options.model.owner(path)[0];
      if (owner !== root) {
        throw new Error('Wrong snapshot install owner.');
      }
    } else if (
      scope === 'file'
        ? path !== root
        : scope === 'direct'
          ? parentPath(path) !== root
          : path !== root && !path.startsWith(root + '/')
    ) {
      throw new Error('Evidence escapes semantic unit.');
    }
  }

  private ordered(path: string, kind: 'file' | 'directory', nonoverlap = true): void {
    const current: Value[] = ['member', kind === 'file' ? 'file' : 'unit', path];
    if (
      this.previous &&
      (compareMembership(this.previous, current) >= 0 ||
        (nonoverlap && String(path).startsWith(String(this.previous[2]) + '/')))
    ) {
      throw new Error('Overlapping/unordered evidence roots.');
    }
    this.previous = current;
  }

  private open(value: readonly Value[]): void {
    if (this.unit) {
      throw new Error('Nested evidence unit.');
    }
    const descriptor = installDescriptor.parse(value.slice(1));
    if (descriptor[0] === 'snapshot') {
      this.schemas.partition.parse(descriptor[1]);
    }
    if (
      descriptor[0] !== 'snapshot' &&
      descriptor[0] !== 'file' &&
      descriptor[0] !== 'directory' &&
      descriptor[0] !== 'empty-directory'
    ) {
      if ((descriptor[0] === 'maven-directory') !== (descriptor[2] === 'direct')) {
        throw new Error('Wrong evidence unit scope.');
      }
    }
    const install = true;
    if (descriptor[0] === 'file') {
      if (recognizedRoot(this.schemas.options.model, descriptor[1]) !== null) {
        throw new Error('Indivisible unit labeled ordinary file.');
      }
    } else if (descriptor[0] === 'empty-directory') {
      const model = this.schemas.options.model,
        probe = descriptor[1] + '/.workspace-directory-probe';
      if (model.owner(probe)[3] !== 'aggregate') {
        throw new Error('Empty-directory presence requires aggregate owner.');
      }
      if (model.tuple[2] !== 'maven' && recognizedRoot(model, probe) !== null) {
        throw new Error('Indivisible unit labeled empty-directory.');
      }
    } else if (install && descriptor[0] === 'directory') {
      const model = this.schemas.options.model,
        probe = descriptor[1] + '/.workspace-directory-probe';
      if (!isWorkspaceScaffolding(model, descriptor[1])) {
        const root = recognizedRoot(model, probe);
        if (root !== null && root !== descriptor[1]) {
          throw new Error('Directory insertion splits semantic unit.');
        }
      }
    } else if (descriptor[0] !== 'snapshot' && descriptor[0] !== 'directory') {
      validateUnit(this.schemas.options.model, descriptor);
    }
    const order: Value[] = ['member', descriptor[0] === 'file' ? 'file' : 'unit', descriptor[1]];
    if (install && descriptor[0] === 'snapshot') {
      const index = this.schemas.options.model.partitions.findIndex(
        (p) => p[0] === descriptor[1] && p[3] === 'single-writer',
      );
      if (index <= this.snapshotIndex) {
        throw new Error('Duplicate/unordered snapshot install unit.');
      }
      this.snapshotIndex = index;
    } else {
      if (install && this.snapshotIndex >= 0) {
        throw new Error('Aggregate install unit after snapshots.');
      }
      if (
        this.previousUnit &&
        this.previousDirectoryGroup &&
        String(descriptor[1]).startsWith(String(this.previousUnit[2]) + '/')
      ) {
        throw new Error('Overlapping directory insertion units.');
      }
      if (this.previousUnit && compareMembership(this.previousUnit, order) >= 0) {
        throw new Error('Unordered evidence units.');
      }
      this.previousUnit = order;
      this.previousDirectoryGroup = descriptor[0] === 'directory';
    }
    if (install) {
      this.previous = null;
    }

    this.unit = descriptor;
    this.roots = 0;
  }

  accept(value: Value): void {
    if (!Array.isArray(value)) {
      throw new Error('Invalid install operation row.');
    }
    const tag = value[0];
    if (!this.installContext) {
      z.tuple([z.literal('install-context'), z.string().regex(/^[a-f0-9]{32}$/)]).parse(value);
      this.installContext = true;
      return;
    }
    if (tag === 'install-context') {
      throw new Error('Duplicate install context.');
    }
    if (tag === 'install-unit-open') {
      this.open(value);
      return;
    }
    if (!this.unit) {
      throw new Error('Install operation outside unit.');
    }
    if (tag === 'install-unit-close') {
      const row = installClose.parse(value);
      if (row[1] !== this.unit[0] || row[2] !== this.unit[1]) {
        throw new Error('Unbalanced install unit.');
      }
      if (this.unit[0] === 'directory' && this.roots !== 1) {
        throw new Error('Directory group root count.');
      }
      if (this.roots === 0 && this.unit[0] !== 'snapshot' && this.unit[0] !== 'empty-directory') {
        throw new Error('Empty operation unit.');
      }
      this.unit = null;
      return;
    }
    if (tag === 'install-parent') {
      const row = this.schemas.rows.installParent.parse(value);
      if (row[1] !== this.index + 1) {
        throw new Error('Noncontiguous install index.');
      }
      this.index = row[1];
      return;
    }
    const row = this.schemas.rows.install.parse(value);
    if (!this.installKind) {
      throw new Error('Install ordering requires independently validated member kind.');
    }
    const kind = this.installKind(row);
    if (kind !== 'file' && kind !== 'directory') {
      throw new Error('Invalid install member kind.');
    }
    this.within(row[2], kind);
    if (
      this.unit[0] === 'directory' &&
      (row[6] !== 'insert' ||
        row[4] === null ||
        row[4][2] !== 'source' ||
        !this.schemas.options.model.partitions.some(
          (p) => p[0] === row[4]![3] && p[3] === 'aggregate',
        ))
    ) {
      throw new Error('Directory insertion requires an exact aggregate source.');
    }
    if (row[1] !== this.index + 1) {
      throw new Error('Noncontiguous install index.');
    }
    this.ordered(row[2], kind);
    this.index = row[1];
    this.roots++;
    if (this.unit[0] === 'empty-directory' && (this.roots > 1 || row[6] === 'delete')) {
      throw new Error('Invalid empty-directory presence operation.');
    }
  }

  finish(): void {
    if (this.unit || !this.installContext) {
      throw new Error('Incomplete install plan.');
    }
  }

  dispose(): void {}
}
