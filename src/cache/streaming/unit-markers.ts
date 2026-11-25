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

import type { Unit } from './schema';
// Protocol: docs/dev/cache-protocol.md#complete-unit-and-final-acceptance
/** Constant marker names only; usable for metadata-only deletion eligibility. */
export class UnitMarkers {
  private readonly fileMarkers: string[];
  private readonly directoryMarkers: string[];
  private readonly seenFiles = new Set<string>();
  private readonly seenDirectories = new Set<string>();
  private jarKind = false;

  constructor(readonly unit: Unit) {
    const [kind] = unit;
    this.fileMarkers =
      kind === 'maven-directory'
        ? []
        : kind === 'artifact-transform'
          ? ['metadata.bin', 'results.bin']
          : kind === 'groovy'
            ? ['metadata.bin', 'metadata/metadata.bin']
            : kind === 'kotlin-accessor-jars'
              ? ['metadata.bin', 'classes.jar', 'sources.jar']
              : ['metadata.bin'];
    this.directoryMarkers =
      kind === 'artifact-transform'
        ? ['transformed']
        : kind === 'groovy'
          ? ['classes', 'instrumented', 'metadata']
          : kind === 'kotlin-script'
            ? ['classes', 'instrumented/classes']
            : kind === 'kotlin-plugin-spec-accessors' || kind === 'kotlin-accessor-directories'
              ? ['classes', 'sources']
              : [];
  }

  private relative(path: string): string {
    const root = this.unit[1];
    if (path === root) {
      return '';
    }
    if (!path.startsWith(root + '/')) {
      throw new Error('Marker outside unit.');
    }
    return path.slice(root.length + 1);
  }

  private marker(path: string, directory: boolean): void {
    const rel = this.relative(path);
    if (!directory) {
      const marker = this.fileMarkers.find((m) => m === rel);
      if (marker !== undefined) {
        this.seenFiles.add(marker);
      }
      if (rel === 'classes.jar' || rel === 'sources.jar') {
        this.jarKind = true;
      }
    }
    for (const marker of this.directoryMarkers) {
      if ((directory && rel === marker) || rel.startsWith(marker + '/')) {
        this.seenDirectories.add(marker);
      }
    }
  }

  file(path: string): void {
    this.marker(path, false);
  }

  directory(path: string): void {
    this.marker(path, true);
  }

  finish(): void {
    if (
      this.fileMarkers.some((p) => !this.seenFiles.has(p)) ||
      this.directoryMarkers.some((p) => !this.seenDirectories.has(p))
    ) {
      throw new Error('Missing required workspace markers.');
    }
    if (this.unit[0] === 'kotlin-accessor-directories' && this.jarKind) {
      throw new Error('Workspace kind does not match markers.');
    }
  }
}
