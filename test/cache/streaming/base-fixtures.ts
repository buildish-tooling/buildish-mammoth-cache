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

import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitHubBaseCacheBackend } from '../../../src/ci/github/cache';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { invocationId, resolveModel, type ResolvedModel } from '../../../src/cache/streaming/model';
import { WorkingBudget, normalizeMode } from '../../../src/cache/streaming/tree-state';
import { createBasePayload, captureBaseObject } from '../../../src/cache/streaming/base-object';
import type { ObjectIdentity } from '../../../src/cache/streaming/native-records';
import {
  createGeneration,
  type GenerationEntry,
} from '../../../src/cache/streaming/native-records';
import { lineageId } from '../../../src/cache/streaming/model';
import { encodeRecord } from '../../../src/cache/streaming/encoding';
import { baseRecordPaths } from '../../../src/cache/streaming/base-layout';
import { randomUUID } from 'node:crypto';
import { localOptions, nonce, h } from './local-fixtures';
const roots: string[] = [];
export async function cleanupBaseFixtures() {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}
export async function baseFixture(model?: ResolvedModel) {
  const root = await mkdtemp(path.resolve('build/native-base-'));
  roots.push(root);
  model ??= resolveModel(
    [
      'model',
      1,
      'gradle',
      ['.mammoth/**'],
      [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default']],
    ],
    'base-',
    1,
  );
  const options = localOptions();
  options.context[7] = model.tuple[2];
  const store = await OwnedStore.bind(
    root,
    new LocalCodec({ ...options, model, invocation: invocationId(options.context, nonce) }),
  );
  return { root, store, model, budget: new WorkingBudget() };
}
export async function preparedBase(
  f: Awaited<ReturnType<typeof baseFixture>>,
  files: Record<string, string>,
  partition = 'data',
  directories: readonly string[] = [],
) {
  const payload = await createBasePayload(f.store, partition);
  for (const directory of directories)
    await mkdir(f.store.root.resolve(payload + '/' + directory), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = f.store.root.resolve(payload + '/' + name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { mode: normalizeMode(f.model.tuple[2], name, 0o644) });
    await utimes(file, 1.234, 1.234);
  }
  const identity: ObjectIdentity = [f.model.family, f.model.id, partition, h, h, h];
  return captureBaseObject(f.store, identity, { budget: f.budget });
}
/** Existing installed SDK archive path with a test-only immutable remote key catalogue. */
export async function nativeCacheBackend() {
  const root = await mkdtemp(path.resolve('build/native-sdk-'));
  roots.push(root);
  const sdk = path.dirname(fileURLToPath(import.meta.resolve('@actions/cache'))),
    utils = await import(pathToFileURL(path.join(sdk, 'internal/cacheUtils.js')).href),
    tar = await import(pathToFileURL(path.join(sdk, 'internal/tar.js')).href),
    objects = new Map<string, { directory: string; version: string }>(),
    calls: { kind: string; key: string; paths: string[]; members?: string[] }[] = [];
  let id = 0;
  const backend = createGitHubBaseCacheBackend({
    isFeatureAvailable: () => true,
    async saveCache(paths, key, _options, crossOs) {
      if (!crossOs) throw new Error('Expected cross OS mode.');
      const version = utils.getCacheVersion(paths, 'gzip', crossOs),
        members = await utils.resolvePaths(paths),
        directory = path.join(root, String(++id));
      calls.push({ kind: 'save', key, paths: [...paths], members: [...members] });
      if (objects.has(key)) return -1;
      await mkdir(directory);
      await tar.createTar(directory, members, 'gzip');
      objects.set(key, { directory, version });
      return id;
    },
    async restoreCache(paths, key, fallback, options, crossOs) {
      calls.push({ kind: options?.lookupOnly ? 'lookup' : 'restore', key, paths: [...paths] });
      if (!crossOs) throw new Error('Expected cross OS mode.');
      const version = utils.getCacheVersion(paths, 'gzip', crossOs);
      let selected: string | undefined;
      for (const prefix of [key, ...(fallback ?? [])]) {
        selected = [...objects.keys()]
          .reverse()
          .find((k) => k.startsWith(prefix) && objects.get(k)!.version === version);
        if (selected) break;
      }
      if (selected && !options?.lookupOnly)
        await tar.extractTar(path.join(objects.get(selected)!.directory, 'cache.tgz'), 'gzip');
      return selected;
    },
  });
  return { backend, objects, calls };
}

/** Test seeding only: publication/source-return gating is exercised through the production publisher later. */
export async function seedBaseGeneration(
  f: Awaited<ReturnType<typeof baseFixture>>,
  sdk: Awaited<ReturnType<typeof nativeCacheBackend>>,
  entries: GenerationEntry[],
  groups: string[][] = entries.map((e) => [e[1]]),
) {
  const generation = createGeneration(f.model, lineageId('refs/heads/main'), h, h, entries, groups),
    root = f.store.prefix + 'records/' + randomUUID();
  await f.store.writeNativeMetadata(
    root,
    'record.json',
    (async function* () {
      yield encodeRecord(generation);
    })(),
  );
  await sdk.backend.saveCache(baseRecordPaths(f.store, root), generation[11], {
    archiveRoot: f.store.root.resolve(root),
  });
  return generation;
}
