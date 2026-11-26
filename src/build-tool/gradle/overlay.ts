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

import { opendir } from 'node:fs/promises';
import { workspaceRoot } from '../../cache/immutable-workspaces';
import type { OwnedStore } from '../../cache/streaming/owned-store';
import { ownsLocalSnapshot } from '../../cache/streaming/model';
import { directoryBreadthError, type WorkingBudget } from '../../cache/streaming/tree-state';
import { missing } from '../../cache/streaming/native';
import type { Overlay, OverlayCapture } from '../../cache/streaming/overlay';
import { gradleDependencySources, gradleLayerCandidate, GRADLE_MODULES } from './dependency-layer';
import type { OverlayPolicy } from '../lifecycle-types';

function gradleOverlayCandidate(store: OwnedStore): boolean {
  const options = store.codec.options;
  if (gradleLayerCandidate(options.model, options, 'none')) {
    return true;
  }
  return (
    options.model.tuple[2] === 'gradle' &&
    options.model.dependencyCacheLayer &&
    options.role === 'distributed-worker' &&
    options.access === 'writable' &&
    options.model.partitions.filter((p) => ownsLocalSnapshot(p, options)).length === 1 &&
    options.model.partitions.some((p) => p[6] === 1 && ownsLocalSnapshot(p, options))
  );
}

/** Include authoritative metadata even when there are no upper changes in its hierarchy. */
async function gradleOverlayCapture(
  store: OwnedStore,
  overlay: Overlay,
  budget: WorkingBudget,
  maxEntries: number,
  signal: AbortSignal,
): Promise<OverlayCapture> {
  const modules = GRADLE_MODULES;
  const options = store.codec.options;
  const snapshot = options.model.partitions.find((p) => ownsLocalSnapshot(p, options));
  if (!snapshot) {
    return { useMerged: (path) => workspaceRoot(path) !== null };
  }
  // Prepare only enables this policy for the qualified Gradle dependency snapshot layout.
  const pattern = snapshot[1][0].slice(modules.length + 1, -3);
  const metadata = new Set<string>();
  let charge = 0;
  const dispose = () => {
    budget.release(charge);
    charge = 0;
    metadata.clear();
  };
  try {
    let directory;
    try {
      await store.root.parents(modules + '/.metadata-probe');
      store.root.work.nativeListings++;
      directory = await opendir(store.root.resolve(modules), { bufferSize: 32 });
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
    if (directory) {
      let entries = 0;
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (++entries > maxEntries) {
          throw directoryBreadthError(modules, maxEntries, 'OverlayFS snapshot discovery');
        }
        if (
          entry.isDirectory() &&
          (pattern === 'metadata-*' ? /^metadata-.+/u.test(entry.name) : entry.name === pattern)
        ) {
          if (metadata.has(entry.name)) {
            throw new Error('Duplicate decoded metadata directory name.');
          }
          const bytes = 128 + 4 * Buffer.byteLength(entry.name);
          budget.retain(bytes);
          charge += bytes;
          metadata.add(entry.name);
        }
      }
    }
    const mergedScaffolds = new Set<string>();
    const scaffolds = new Map([
      ['', new Set(['caches'])],
      ['caches', new Set(['modules-2'])],
      [modules, metadata],
    ]);
    if (metadata.size) {
      for (const scope of ['caches', modules]) {
        if (!(await store.root.stat(overlay[2] + '/upper/' + scope))) {
          mergedScaffolds.add(scope);
        }
      }
    }
    return {
      useMerged(path: string) {
        return (
          mergedScaffolds.has(path) ||
          workspaceRoot(path) !== null ||
          (path.startsWith(modules + '/') &&
            metadata.has(path.slice(modules.length + 1).split('/', 1)[0]))
        );
      },
      extraDirectories(path: string) {
        const names = metadata.size ? scaffolds.get(path) : undefined;
        return names && { names, only: mergedScaffolds.has(path) };
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export const gradleOverlay: OverlayPolicy = {
  async prepareTarget(store, restored, inputs) {
    if (
      !inputs.existingDependencyLayer &&
      inputs.hasWrapper?.() &&
      restored.generation &&
      (store.codec.options.role !== 'distributed-worker' ||
        (gradleOverlayCandidate(store) && (await gradleDependencySources(store, restored))))
    ) {
      return '';
    }
  },
  accepts(store, target) {
    return (
      target === '' &&
      (store.codec.options.role !== 'distributed-worker' || gradleOverlayCandidate(store))
    );
  },
  capture(store, overlay, options) {
    return gradleOverlayCapture(
      store,
      overlay,
      options.budget,
      options.maxDirectoryEntries ?? 100000,
      options.signal,
    );
  },
};
