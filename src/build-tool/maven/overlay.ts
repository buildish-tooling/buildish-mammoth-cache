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
import { lstat } from 'node:fs/promises';
import { isMavenTransientFile } from '../../cache/maven-repository';
import { isOverlayWhiteout, withinOverlay } from '../../cache/streaming/overlay';
import type { OwnedStore } from '../../cache/streaming/owned-store';
import { ownsLocalSnapshot } from '../../cache/streaming/model';
import type { OverlayPolicy } from '../lifecycle-types';

const repository = 'repository';

function eligible(store: OwnedStore, entries: Parameters<OverlayPolicy['accepts']>[2]): boolean {
  const options = store.codec.options;
  const { model, role, access } = options;
  const partition = model.partitions.find((p) => p[0] === repository);
  return (
    model.tuple[2] === 'maven' &&
    role === 'distributed-worker' &&
    access === 'writable' &&
    !model.partitions.some((p) => ownsLocalSnapshot(p, options)) &&
    !!partition &&
    partition[3] === 'aggregate' &&
    partition[1].length === 1 &&
    partition[1][0] === repository + '/**' &&
    entries.some((e) => e[1] === repository && e[2] === 'available')
  );
}

export const mavenOverlay: OverlayPolicy = {
  async prepareTarget(store, restored) {
    return eligible(store, restored.entries) ? repository : undefined;
  },
  accepts(store, target, entries) {
    return target === repository && eligible(store, entries);
  },
  async capture(store, overlay) {
    const upper = store.root.resolve(overlay[2] + '/upper');
    const useMerged = (relative: string) => withinOverlay(repository, relative);
    return {
      useMerged,
      omitEmptyDirectory: useMerged,
      listDirectory(relative, open) {
        if (!useMerged(relative)) {
          return;
        }
        const upperDirectory = path.join(upper, relative.slice(repository.length + 1));
        return (async function* () {
          let touched = false;
          for await (const entry of open(upperDirectory)) {
            if (entry.isDirectory()) {
              yield entry;
            } else if (!touched && !isMavenTransientFile(entry.name)) {
              const member = relative + '/' + entry.name;
              try {
                store.codec.options.model.owner(member);
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !/Unowned|Reserved\/excluded/u.test(error.message)
                ) {
                  throw error;
                }
                continue;
              }
              // A removal alone carries no aggregate replacement authority. When
              // another direct file selects the unit, merged membership reflects it.
              store.root.work.stats++;
              const raw = await lstat(path.join(upperDirectory, entry.name), { bigint: true });
              touched = !(await isOverlayWhiteout(store, member, raw));
            }
          }
          if (touched) {
            for await (const entry of open(path.join(store.root.path, relative))) {
              if (!entry.isDirectory()) {
                yield entry;
              }
            }
          }
        })();
      },
    };
  },
};
