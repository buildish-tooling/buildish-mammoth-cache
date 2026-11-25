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

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitHubBaseCacheBackend } from '../../../src/ci/github/cache';
const roots: string[] = [];
export async function cleanupBaseFixtures() {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}
export async function nativeCacheBackend() {
  const root = await mkdtemp(path.resolve('build/native-sdk-'));
  roots.push(root);
  const sdk = path.dirname(fileURLToPath(import.meta.resolve('@actions/cache'))),
    utils = await import(pathToFileURL(path.join(sdk, 'internal/cacheUtils.js')).href),
    tar = await import(pathToFileURL(path.join(sdk, 'internal/tar.js')).href),
    objects = new Map<string, { directory: string; version: string }>(),
    calls: { kind: string; key: string; paths: string[]; members?: string[] }[] = [];
  let id = 0;
  const backend = createGitHubBaseCacheBackend(
    {
      isFeatureAvailable: () => true,
      async saveCache(paths, key, _options, crossOs) {
        if (!crossOs) {
          throw new Error('Expected cross OS mode.');
        }
        const version = utils.getCacheVersion(paths, 'gzip', crossOs),
          members = await utils.resolvePaths(paths),
          directory = path.join(root, String(++id));
        calls.push({ kind: 'save', key, paths: [...paths], members: [...members] });
        if (objects.has(key)) {
          return -1;
        }
        await mkdir(directory);
        await tar.createTar(directory, members, 'gzip');
        objects.set(key, { directory, version });
        return id;
      },
      async restoreCache(paths, key, fallback, options, crossOs) {
        calls.push({ kind: options?.lookupOnly ? 'lookup' : 'restore', key, paths: [...paths] });
        if (!crossOs) {
          throw new Error('Expected cross OS mode.');
        }
        const version = utils.getCacheVersion(paths, 'gzip', crossOs);
        let selected: string | undefined;
        for (const prefix of [key, ...(fallback ?? [])]) {
          selected = [...objects.keys()]
            .reverse()
            .find((k) => k.startsWith(prefix) && objects.get(k)!.version === version);
          if (selected) {
            break;
          }
        }
        if (selected && !options?.lookupOnly) {
          await tar.extractTar(path.join(objects.get(selected)!.directory, 'cache.tgz'), 'gzip');
        }
        return selected;
      },
    },
    undefined,
    undefined,
    () => true,
  );
  return { backend, objects, calls };
}
