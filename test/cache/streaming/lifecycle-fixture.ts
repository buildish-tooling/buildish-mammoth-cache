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
import { mkdtemp, rm } from 'node:fs/promises';
import type { BaseCacheBackend } from '../../../src/cache/backend';
import type { WorkflowArtifactBackend } from '../../../src/delta/backend';
import { resolveModel, type ResolvedModel } from '../../../src/cache/streaming/model';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
import type { Context } from '../../../src/cache/streaming/schema';
const roots: string[] = [];
export async function cleanupLifecycleFixtures() {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}
async function directory(label: string) {
  const root = await mkdtemp(path.resolve('build/ls4-' + label + '-'));
  roots.push(root);
  return root;
}
export async function prepareLifecycle(
  api: BaseCacheBackend,
  nonce: string,
  config: {
    job?: string;
    role?: 'standalone' | 'distributed-worker' | 'distributed-aggregator';
    order?: string[];
    model?: ResolvedModel;
    artifacts?: WorkflowArtifactBackend;
    currentRef?: string;
    defaultRef?: string;
    gcAgeMs?: number;
    now?: () => number;
    root?: string;
    budget?: WorkingBudget;
    hooks?: () => Promise<void>;
  } = {},
) {
  const root = config.root ?? (await directory('root')),
    budget = config.budget ?? new WorkingBudget(),
    hard = ['.mammoth/**'],
    model =
      config.model ??
      resolveModel(
        ['model', 1, 'maven', hard, [['data', ['data/**'], hard, 'aggregate', null, 'default']]],
        'metadata-lifecycle-',
        1,
      ),
    context: Context = [
      'github',
      'example/repo',
      'ci',
      '42',
      config.job ?? 'parent',
      1,
      'rev-1',
      model.tuple[2],
    ];
  const result = await prepareStreaming({
    root,
    model,
    context,
    nonce,
    budget,
    policy: {
      role: config.role ?? 'standalone',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: config.gcAgeMs ?? null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: config.order ?? [],
    },
    currentRef: config.currentRef ?? 'refs/heads/main',
    defaultRef: config.defaultRef,
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    now: config.now,
    saveAnchor() {},
    cacheBackend: async () => api,
    artifactBackend: config.artifacts ? async () => config.artifacts! : undefined,
    provision: async () => {},
    installHooks: config.hooks ?? (async () => {}),
    assertCurrent: (): undefined => {},
  });
  return { ...result, root, budget };
}
