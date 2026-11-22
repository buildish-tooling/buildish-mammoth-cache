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
import { walkNative } from '../../../src/cache/streaming/native-walk';
import { VerifiedIncoming } from '../../../src/cache/streaming/install-evidence';
import { localFixtures, localOptions, nonce } from './local-fixtures';
import type { Failpoint } from '../../../src/cache/streaming/native';
import type { Context } from '../../../src/cache/streaming/schema';
import type { Value } from '../../../src/cache/streaming/encoding';
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
              return [p, ['shared/**/' + p], hard, 'aggregate', null, 'default'];
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
              ],
            ],
      ],
      'install-fixture-',
      1,
    );
  const context: Context = [...localOptions().context];
  context[7] = tool;
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
      if (body === null) await mkdir(native, { recursive: true });
      else {
        await mkdir(path.dirname(native), { recursive: true });
        await writeFile(native, body);
      }
    }
  }
  async function incoming(
    partition: string,
    entries: Record<string, string | null>,
    origin: 'worker' | 'trusted-base' = 'worker',
  ) {
    const nativeRoot = store.prefix + 'install/' + partition;
    await mkdir(store.root.resolve(nativeRoot), { recursive: true });
    await files(nativeRoot, entries);
    async function* records() {
      for await (const event of walkNative(store.root, nativeRoot, { budget, logicalRoot: '' })) {
        if (event.tag === 'directory-close') continue;
        if (event.tag === 'protected-child') throw new Error('Bad fixture child');
        if (event.tag === 'directory-open')
          yield ['directory', event.path, event.identity] as Value;
        else
          yield [
            'file',
            event.path,
            event.identity,
            await store.root.hash(event.nativePath, event.identity),
          ] as Value;
      }
    }
    const evidence = await store.writeStream('native-evidence', { budget, partition }, records());
    return VerifiedIncoming.verify(
      store,
      { partition, nativeRoot, evidence, origin, finishVerification: async (binding) => binding },
      { budget },
    );
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
    close: () => rm(root, { recursive: true, force: true }),
  };
}
