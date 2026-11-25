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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceKind, workspaceRoot } from '../../src/cache/immutable-workspaces';
import type { ResolvedModel } from '../../src/cache/streaming/model';
import { NativeRoot } from '../../src/cache/streaming/native';
import { walkNative } from '../../src/cache/streaming/native-walk';
import { WorkingBudget } from '../../src/cache/streaming/tree-state';
import { UnitMarkers } from '../../src/cache/streaming/unit-markers';

/** Independent assertions for native integration fixtures on the active ownership model. */
export async function captureStreamingWorkspaceEvidence(home: string, model: ResolvedModel) {
  const root = await NativeRoot.bind(home);
  const units = new Map<string, { files: string[]; directories: Set<string> }>();
  const sizes = new Map<string, number>();
  const archives = new Map<string, string>();
  const sha = async (name: string) =>
    createHash('sha256')
      .update(await readFile(path.join(home, name)))
      .digest('hex');

  const entries = (await root.stat('caches'))
    ? walkNative(root, 'caches', { budget: new WorkingBudget() })
    : [];
  for await (const entry of entries) {
    if (entry.tag !== 'file' && entry.tag !== 'directory-open') {
      continue;
    }
    const name = entry.path;
    const unit = workspaceRoot(name);
    if (!unit && !/^caches\/build-cache-[0-9]+\/[a-f0-9]{32}$/u.test(name)) {
      continue;
    }
    try {
      model.owner(entry.tag === 'file' ? name : name + '/.workspace-directory-probe');
    } catch (error) {
      if (error instanceof Error && /Unowned|Reserved\/excluded/u.test(error.message)) {
        continue;
      }
      throw error;
    }
    if (!unit) {
      if (entry.tag === 'file') {
        archives.set(name, await sha(name));
      }
      continue;
    }
    const details = units.get(unit) ?? { files: [], directories: new Set<string>() };
    if (entry.tag === 'file') {
      details.files.push(name);
      sizes.set(name, Number(entry.identity[5]));
    } else {
      details.directories.add(name);
    }
    units.set(unit, details);
  }
  const evidence = new Map<
    string,
    {
      workspace: {
        root: string;
        kind: ReturnType<typeof workspaceKind>;
        emptyDirectories: string[];
      };
      hashes: (readonly [string, string])[];
    }
  >();
  for (const [unit, { files, directories }] of units) {
    const kind = workspaceKind(unit, files);
    const markers = new UnitMarkers([kind, unit, 'subtree']);
    const parents = new Set<string>();
    for (const file of files) {
      markers.file(file);
      parents.add(path.posix.dirname(file));
    }
    for (const directory of directories) {
      markers.directory(directory);
      parents.add(path.posix.dirname(directory));
    }
    try {
      markers.finish();
    } catch (error) {
      if (error instanceof Error && error.message === 'Missing required workspace markers.') {
        continue;
      }
      throw error;
    }
    evidence.set(unit, {
      workspace: {
        root: unit,
        kind,
        emptyDirectories: [...directories].filter((d) => !parents.has(d)),
      },
      hashes: await Promise.all(files.map(async (file) => [file, await sha(file)] as const)),
    });
  }
  return { units: evidence, archives, sizes };
}
