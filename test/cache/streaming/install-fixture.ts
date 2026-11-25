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

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { resolveModel, invocationId, type ResolvedModel } from '../../../src/cache/streaming/model';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import { createMetadataDescriptor } from '../../../src/cache/streaming/metadata-base-records';
import { randomUUID } from 'node:crypto';
import type { ObjectRef } from '../../../src/cache/streaming/native-records';
import { closeFixtureInstallPlans } from './install-plan-fixture';
import { localFixtures, localOptions, nonce } from './local-fixtures';
import type { Failpoint } from '../../../src/cache/streaming/native';
import type { Context } from '../../../src/cache/streaming/schema';
export async function installFixture(
  tool: 'gradle' | 'maven' = 'gradle',
  configuration: {
    shared?: boolean;
    partitionCount?: number;
    foreignSibling?: boolean;
    upperSibling?: boolean;
    excluded?: string[];
    repositorySplit?: 'aggregate' | 'single-writer';
    purgeGlobs?: readonly string[];
    model?: ResolvedModel;
    role?: 'standalone' | 'distributed-worker' | 'distributed-aggregator';
    access?: 'writable' | 'read-only';
    root?: string;
    nonce?: string;
    job?: string;
    fail?: Failpoint;
  } = {},
) {
  const root = configuration.root ?? (await mkdtemp(path.resolve('build/native-install-'))),
    hard = ['.mammoth/**', '**/*.lock', ...(configuration.excluded ?? [])];
  const model =
    configuration.model ??
    resolveModel(
      [
        'model',
        1,
        tool,
        hard,
        configuration.partitionCount
          ? Array.from({ length: configuration.partitionCount }, (_, i) => {
              const p = 'p' + String(i).padStart(3, '0');
              return [p, ['shared/**/' + p], hard, 'aggregate', null, 'default', 0];
            })
          : [
              [
                'data',
                configuration.upperSibling
                  ? ['shared/lower/**']
                  : configuration.shared
                    ? ['shared/data/**']
                    : ['data/**', 'caches/**', 'repository/**'],
                configuration.foreignSibling
                  ? [...hard, 'data/empty/foreign']
                  : configuration.repositorySplit
                    ? [...hard, 'repository/other/**']
                    : hard,
                'aggregate',
                null,
                'default',
                0,
                ...(configuration.purgeGlobs?.length ? [configuration.purgeGlobs] : []),
              ],
              [
                'state',
                configuration.repositorySplit
                  ? ['repository/other/**']
                  : configuration.foreignSibling
                    ? ['data/empty/foreign']
                    : configuration.upperSibling
                      ? ['shared/LOWER/**']
                      : configuration.shared
                        ? ['shared/state/**']
                        : ['state/**'],
                hard,
                configuration.repositorySplit ?? 'single-writer',
                configuration.repositorySplit === 'aggregate' ? null : 'A',
                'default',
                0,
              ],
            ],
      ],
      'install-fixture-',
      1,
    );
  const context: Context = [...localOptions().context];
  context[7] = tool;
  if (configuration.job) {
    context[4] = configuration.job;
  }
  const options = {
      ...localOptions(),
      model,
      context,
      invocation: invocationId(context, configuration.nonce ?? nonce),
      access: configuration.access ?? ('writable' as const),
      role: configuration.role ?? ('standalone' as const),
    },
    codec = new LocalCodec(options),
    store = await OwnedStore.bind(root, codec, configuration.fail),
    budget = new WorkingBudget();
  async function files(base: string, entries: Record<string, string | null>) {
    for (const [logical, body] of Object.entries(entries)) {
      const native = store.root.resolve(base ? base + '/' + logical : logical);
      if (body === null) {
        await mkdir(native, { recursive: true });
      } else {
        await mkdir(path.dirname(native), { recursive: true });
        await writeFile(native, body);
      }
    }
  }
  async function incoming(
    partition: string,
    entries: Record<string, string | null>,
    _origin: 'worker' | 'trusted-base' = 'worker',
  ) {
    const objectRoot = store.prefix + 'base/' + randomUUID(),
      nativeRoot = objectRoot + '/payload';
    await mkdir(store.root.resolve(nativeRoot), { recursive: true });
    await files(nativeRoot, entries);
    const { bytes, reference } = createMetadataDescriptor(model, [
      model.family,
      model.id,
      partition,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]);
    await writeFile(store.root.resolve(objectRoot + '/envelope.json'), bytes);
    return { partition, nativeRoot, objectRoot, reference: reference as ObjectRef };
  }
  const f = localFixtures(options, configuration.nonce ?? nonce),
    bindings = structuredClone(f.bindings);
  bindings[4] = configuration.nonce ?? nonce;
  bindings[5] = [root, store.root.binding];
  return {
    root,
    store,
    budget,
    model,
    files,
    incoming,
    bindings,
    close: async () => {
      await closeFixtureInstallPlans(store);
      await rm(root, { recursive: true, force: true });
    },
  };
}
