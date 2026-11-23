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

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import {
  invocationId,
  lineageId,
  resolveModel,
  type ResolvedModel,
} from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import {
  createMetadataDescriptor,
  createMetadataGeneration,
} from '../../../src/cache/streaming/metadata-base-records';
import { encodeRecord } from '../../../src/cache/streaming/encoding';
import {
  prepareStreaming,
  type StreamingPrepareRequest,
} from '../../../src/cache/streaming/prepare';
import type { Context } from '../../../src/cache/streaming/schema';
import type { GenerationEntry } from '../../../src/cache/streaming/native-records';
export const h = 'a'.repeat(64),
  currentRef = 'refs/heads/main';
/** V2-only test owner and extraction double; no old tree/digest/replay fixtures. */
export async function metadataFixture(model?: ResolvedModel) {
  const directory = await mkdtemp(path.resolve('build/metadata-restore-')),
    root = directory + '/managed',
    remote = directory + '/remote';
  await mkdir(root);
  await mkdir(remote);
  const hard = ['.mammoth/**', '**/*.lock'];
  model ??= resolveModel(
    [
      'model',
      1,
      'maven',
      hard,
      [
        ['data', ['data/**', 'repository/**'], hard, 'aggregate', null, 'default'],
        ['state', ['state/**'], hard, 'single-writer', 'A', 'default'],
      ],
    ],
    'metadata-restore-',
    1,
  );
  const context: Context = ['github', 'example/repo', 'ci', '42', 'A', 1, 'rev-1', model.tuple[2]],
    nonce = 'a'.repeat(32),
    budget = new WorkingBudget();
  const store = await OwnedStore.bind(
    root,
    new LocalCodec({
      model,
      context,
      invocation: invocationId(context, nonce),
      role: 'standalone',
      access: 'writable',
    }),
  );
  const objects = new Map<string, string>();
  let sequence = 0;
  async function files(base: string, entries: Record<string, string | null>) {
    for (const [name, body] of Object.entries(entries)) {
      const file = path.join(base, ...name.split('/'));
      await mkdir(body === null ? file : path.dirname(file), { recursive: true });
      if (body !== null) await writeFile(file, body);
    }
  }
  const save = vi.fn<BaseCacheBackend['saveCache']>(async (paths, key) => {
    const target = remote + '/save-' + String(++sequence);
    await mkdir(target);
    for (const original of paths) {
      const source = original.replace(/[\\/]$/, '');
      await cp(source, path.join(target, path.basename(source)), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
    objects.set(key, target);
    return sequence;
  });
  const restore = vi.fn<BaseCacheBackend['restoreCache']>(
    async (_paths, prefix, fallback, options) => {
      const key = [prefix, ...(fallback ?? [])]
        .map((p) => [...objects.keys()].reverse().find((k) => k.startsWith(p)))
        .find(Boolean);
      if (key)
        for (const member of await readdir(objects.get(key)!))
          await cp(path.join(objects.get(key)!, member), path.join(options!.archiveRoot!, member), {
            recursive: true,
            preserveTimestamps: true,
          });
      return key;
    },
  );
  const api: BaseCacheBackend = {
    capabilities: { supportsNewestPrefixRestore: true, supportsExplicitSave: true },
    isFeatureAvailable: () => true,
    saveCache: save,
    restoreCache: restore,
    isMissingPathsError: () => false,
  };
  async function seed(
    payloads: Record<string, Record<string, string | null>>,
    groups = model!.partitions.map((p) => [p[0]]),
    ref = currentRef,
  ) {
    const entries: GenerationEntry[] = [],
      lineage = lineageId(ref),
      number = ++sequence;
    for (const p of model!.partitions) {
      const payload = payloads[p[0]];
      if (payload === undefined) {
        entries.push(['empty', p[0]]);
        continue;
      }
      const descriptor = createMetadataDescriptor(model!, [
          model!.family,
          model!.id,
          p[0],
          lineage,
          h,
          h,
        ]),
        target = remote + '/seed-' + number + '-' + p[0];
      await mkdir(target + '/payload', { recursive: true });
      await writeFile(target + '/envelope.json', descriptor.bytes);
      await files(target + '/payload', payload);
      objects.set(descriptor.reference[2], target);
      entries.push(['object', p[0], descriptor.reference]);
    }
    const generation = createMetadataGeneration(model!, lineage, h, h, entries, groups),
      target = remote + '/record-' + number;
    await mkdir(target);
    await writeFile(target + '/record.json', encodeRecord(generation));
    objects.set(generation[11], target);
    return { generation, entries, target };
  }
  const request: StreamingPrepareRequest = {
    root,
    model,
    context,
    nonce,
    budget,
    policy: {
      role: 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: [],
    },
    currentRef,
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    saveAnchor() {},
    cacheBackend: async () => api,
    provision: async () => {},
    installHooks: async () => {},
    assertCurrent: (): undefined => {},
  };
  return {
    directory,
    root,
    remote,
    store,
    model,
    budget,
    api,
    save,
    restore,
    objects,
    files,
    seed,
    request,
    prepare: (overrides: Partial<StreamingPrepareRequest> = {}) =>
      prepareStreaming({ ...request, ...overrides }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
export type MetadataFixture = Awaited<ReturnType<typeof metadataFixture>>;
