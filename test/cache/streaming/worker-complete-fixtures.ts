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
import { Writable } from 'node:stream';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { resolveModel, invocationId } from '../../../src/cache/streaming/model';
import {
  WorkingBudget,
  compareName,
  parentPath,
  baseName,
} from '../../../src/cache/streaming/tree-state';
import { DiskMembership } from '../../../src/cache/streaming/worker-spool';
import { writeWorkerArchive, type WorkerEvent } from '../../../src/cache/streaming/worker-codec';
import { workspaceRoot, workspaceKind } from '../../../src/cache/immutable-workspaces';
import type { Value } from '../../../src/cache/streaming/encoding';
import type { Unit, Context } from '../../../src/cache/streaming/schema';
import { localFixtures, localOptions, nonce } from './local-fixtures';
import { byteSource } from './protocol-fixtures';
import { MetadataSnapshot } from '../../../src/cache/streaming/metadata-snapshot';
import type { WorkerMergeInput } from '../../../src/cache/streaming/worker-merge';
import type { WorkerWriter } from '../../../src/cache/streaming/worker-codec';
const roots: string[] = [];
export async function cleanupCompleteFixtures() {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}
export async function completeFixture(
  tool: 'gradle' | 'maven' = 'gradle',
  policy: 'default' | 'choose-worker-entry' | 'choose-worker-directory' = 'default',
  snapshots = false,
) {
  const directory = await mkdtemp(path.resolve('build/worker-complete-'));
  const root = path.join(directory, 'home');
  roots.push(directory);
  await mkdir(root);
  const hard = ['.mammoth/**'];
  const includes =
    tool === 'maven'
      ? ['repository/**']
      : policy === 'choose-worker-entry'
        ? ['caches/build-cache-1/**']
        : policy === 'choose-worker-directory'
          ? ['caches/transforms-4/**']
          : ['**'];
  const model = resolveModel(
    [
      'model',
      1,
      tool,
      hard,
      [
        [
          'data',
          includes,
          [...hard, ...(snapshots ? ['state/**', 'other/**'] : [])],
          'aggregate',
          null,
          policy,
          0,
        ],
        ...(snapshots
          ? [
              ['state', ['state/**'], hard, 'single-writer', null, 'default', 0],
              ['other', ['other/**'], hard, 'single-writer', null, 'default', 0],
            ]
          : []),
      ],
    ],
    'complete-',
    1,
  );
  const context: Context = [...localOptions().context];
  context[7] = tool;
  const codec = new LocalCodec({
      ...localOptions(),
      model,
      context,
      invocation: invocationId(context, nonce),
    }),
    store = await OwnedStore.bind(root, codec),
    budget = new WorkingBudget();
  return { root, model, context, store, budget };
}
export type FixtureFile = string | null | { body: string; mode?: number; time?: number };

export async function completeArchive(
  f: Awaited<ReturnType<typeof completeFixture>>,
  job: string,
  aggregate: Record<string, FixtureFile> = {},
  usage: readonly string[] = [],
  snapshots: Record<string, Record<string, FixtureFile>> = {},
  capture: Pick<WorkerWriter, 'sweep' | 'incompleteUsage'> = {},
): Promise<WorkerMergeInput & { bytes: Buffer }> {
  const context: Context = [...f.context];
  context[4] = job;
  const snapshotIds = f.model.partitions
    .map((p) => p[0])
    .filter((p) => Object.hasOwn(snapshots, p));
  async function* tree(
    files: Record<string, FixtureFile>,
    used = false,
  ): AsyncGenerator<WorkerEvent> {
    const directories = new Set(['']);
    for (const [name, value] of Object.entries(files)) {
      let dir = value === null ? name : parentPath(name);
      while (dir) {
        directories.add(dir);
        dir = parentPath(dir);
      }
    }
    async function* visit(path: string): AsyncGenerator<WorkerEvent> {
      yield { type: 'dir-open', path };
      const direct = Object.keys(files)
          .filter((p) => files[p] !== null && parentPath(p) === path)
          .sort((a, b) => compareName(baseName(a), baseName(b))),
        wr = workspaceRoot(path);
      const unit: Unit | null =
        f.model.tuple[2] === 'maven' && path.startsWith('repository') && direct.length
          ? ['maven-directory', path, 'direct']
          : wr === path
            ? [workspaceKind(path, Object.keys(files)), path, 'subtree']
            : null;
      if (unit) {
        yield { type: used ? 'used-unit-open' : 'unit-open', unit };
      }
      for (const name of direct) {
        const spec = files[name],
          file = typeof spec === 'string' ? { body: spec } : spec!;
        if (used) {
          yield { type: 'used', name: baseName(name) };
        } else {
          yield {
            type: 'file',
            path: name,
            size: Buffer.byteLength(file.body),
            mode: file.mode ?? 0o644,
            mtimeMs: file.time ?? 1000,
            bytes: (async function* () {
              yield Buffer.from(file.body);
            })(),
            assertStable: async () => {},
          };
        }
      }
      if (unit?.[2] === 'direct') {
        yield { type: used ? 'used-unit-close' : 'unit-close' };
      }
      for (const dir of [...directories]
        .filter((d) => d && parentPath(d) === path)
        .sort((a, b) => compareName(baseName(a), baseName(b)))) {
        yield* visit(dir);
      }
      if (unit?.[2] === 'subtree') {
        yield { type: used ? 'used-unit-close' : 'unit-close' };
      }
      yield { type: 'dir-close', path };
    }
    yield* visit('');
  }
  async function* events(): AsyncGenerator<WorkerEvent> {
    yield { type: 'channel-open' };
    yield* tree(aggregate);
    yield { type: 'channel-close' };
    yield { type: 'channel-open' };
    yield* tree(Object.fromEntries(usage.map((p) => [p, ''])), true);
    yield { type: 'channel-close' };
    for (const p of snapshotIds) {
      yield { type: 'channel-open' };
      yield* tree(snapshots[p]);
      yield { type: 'channel-close' };
    }
  }
  const chunks: Buffer[] = [];
  await writeWorkerArchive(
    new Writable({
      write(b, _e, cb) {
        chunks.push(Buffer.from(b));
        cb();
      },
    }),
    {
      model: f.model,
      context,
      authorizedSnapshots: snapshotIds,
      budget: f.budget,
      membership: await DiskMembership.create(f.store, f.budget),
      snapshots: snapshotIds,
      ...capture,
      assertStable: async () => {},
    },
    () => events(),
  );
  const bytes = Buffer.concat(chunks);
  return { job, context, source: byteSource(bytes), bytes, authorizedSnapshots: snapshotIds };
}

export async function preparedSnapshotFixture(
  f: Awaited<ReturnType<typeof completeFixture>>,
  partition: string,
): Promise<MetadataSnapshot> {
  return MetadataSnapshot.empty(f.store, partition, ['empty', 'miss'], { budget: f.budget });
}

export async function initializeCompleteFixture(
  f: Awaited<ReturnType<typeof completeFixture>>,
  order: readonly string[],
  policy: 'strict' | 'newer-mtime' = 'strict',
) {
  const fixtures = localFixtures(f.store.codec.options),
    bindings = structuredClone(fixtures.bindings);
  bindings[5] = [f.root, f.store.root.binding];
  const frozen = bindings[8] as Value[];
  frozen[8] = policy;
  frozen[10] = [...order];
  await f.store.initialize(bindings);
}
