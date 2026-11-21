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

import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { OwnedStore } from '../../../src/cache/streaming/owned-store';
import { resolveModel, invocationId, type ResolvedModel } from '../../../src/cache/streaming/model';
import { LocalCodec } from '../../../src/cache/streaming/local-schema';
import { WorkingBudget, compareName } from '../../../src/cache/streaming/tree-state';
import { tuple, Digest, type Value } from '../../../src/cache/streaming/encoding';
import { localOptions, nonce } from './local-fixtures';
const sourceRoots: string[] = [];
export async function cleanupSourceFixtures() {
  for (const root of sourceRoots.splice(0)) await rm(root, { recursive: true, force: true });
}
export async function sourceFixture(
  snapshot = false,
  tool: 'gradle' | 'maven' = 'gradle',
  override?: ResolvedModel,
  job = 'A',
) {
  const root = await mkdtemp(path.resolve('build/worker-source-'));
  sourceRoots.push(root);
  const model =
    override ??
    resolveModel(
      [
        'model',
        1,
        tool,
        ['.mammoth/**'],
        [
          [
            'data',
            ['**'],
            ['.mammoth/**'],
            snapshot ? 'single-writer' : 'aggregate',
            null,
            'default',
          ],
        ],
      ],
      'v2-',
      1,
    );
  const options = localOptions();
  options.context[7] = tool;
  options.context[4] = job;
  const codec = new LocalCodec({
      ...options,
      invocation: invocationId(options.context, nonce),
      model,
      role: 'distributed-worker',
    }),
    store = await OwnedStore.bind(root, codec),
    budget = new WorkingBudget();
  await store.makeParents(store.prefix + 'fixture');
  await mkdir(path.join(root, 'd'));
  await writeFile(path.join(root, 'd/a'), 'abc');
  await writeFile(path.join(root, 'd/b'), 'defg');
  return { root, model, store, budget };
}
export async function freezeSources(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  remove = '',
  unitRoot = '',
) {
  async function* visit(p: string): AsyncGenerator<Value> {
    const n = (await f.store.root.stat(p))!;
    yield ['dir-open', p, n];
    const entries = (
      await readdir(p ? f.store.root.resolve(p) : f.root, { withFileTypes: true })
    ).sort(
      (a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || compareName(a.name, b.name),
    );
    for (const e of entries) {
      const nn = (await f.store.root.stat(p ? p + '/' + e.name : e.name))!;
      yield ['child', e.name, e.isDirectory() ? 'directory' : 'file', nn[3], nn[4]];
    }
    for (const e of entries) {
      if (e.name === '.mammoth' || e.name.endsWith('.lock') || e.name.endsWith('-excluded.jar'))
        continue;
      const name = p ? p + '/' + e.name : e.name;
      if (e.isDirectory()) yield* visit(name);
      else
        yield [
          'file',
          e.name,
          'data',
          (await f.store.root.stat(name))!,
          null,
          'upsert',
          name === remove ? 'delete' : 'retain',
        ];
    }
    yield ['dir-close', p];
  }
  const rows: Value[] = [];
  for await (const r of visit('')) rows.push(r);
  if (unitRoot) {
    const start = rows.findIndex((v) => tuple(v)[0] === 'dir-open' && tuple(v)[1] === unitRoot),
      end = rows.findIndex((v) => tuple(v)[0] === 'dir-close' && tuple(v)[1] === unitRoot);
    const digest = new Digest('observation-unit');
    let current = '';
    for (let i = start; i <= end; i++) {
      const r = tuple(rows[i]);
      if (r[0] === 'dir-open') {
        current = String(r[1]);
        digest.update(['directory', current, r[2]]);
      }
      if (r[0] === 'child') digest.update(['child', current, ...r.slice(1)]);
      if (r[0] === 'file') {
        const row = r as Value[];
        row[6] = remove ? 'delete' : 'retain';
        digest.update(['file', current + '/' + r[1], r[2], r[3], r[4]]);
      }
      if (r[0] === 'dir-close') current = String(r[1]).split('/').slice(0, -1).join('/');
    }
    let insert = start + 1;
    while (tuple(rows[insert])[0] === 'child') insert++;
    rows.splice(end, 0, [
      'unit-close',
      f.model.tuple[2] === 'maven' ? 'maven-directory' : 'artifact-transform',
      unitRoot,
      digest.digest(),
    ]);
    rows.splice(insert, 0, [
      'unit-open',
      f.model.tuple[2] === 'maven' ? 'maven-directory' : 'artifact-transform',
      unitRoot,
      f.model.tuple[2] === 'maven' ? 'direct' : 'subtree',
      'upsert',
      remove ? 'delete' : 'retain',
      digest.digest(),
    ]);
  }
  const observations = await f.store.writeStream(
    'observations',
    { budget: f.budget, partition: null },
    (async function* () {
      yield* rows;
    })(),
  );
  const workerSources = await f.store.writeStream(
    'worker-sources',
    { budget: f.budget, partition: null },
    (async function* () {
      if (f.model.partitions[0][3] === 'single-writer')
        yield ['worker-snapshot', 'data', observations] as Value;
    })(),
  );
  if (!remove) return { observations, workerSources, gcProgress: null };
  if (unitRoot) {
    await rm(f.store.root.resolve(unitRoot + '/metadata.bin'));
    await rm(f.store.root.resolve(unitRoot + '/results.bin'));
    await rm(f.store.root.resolve(unitRoot + '/transformed'), { recursive: true });
  } else await rm(f.store.root.resolve(remove));
  let end = 0,
    record = 0;
  for await (const r of f.store.rows(observations, 'observations', {
    budget: f.budget,
    partition: null,
  }))
    if (tuple(r.value)[0] === 'dir-close' && tuple(r.value)[1] === '') {
      end = r.end;
      record = r.record + 1;
    }
  const gcProgress = await f.store.writeDocument([
    'gc-progress',
    1,
    f.store.codec.options.invocation,
    observations,
    ['cursor', observations[4], end, record, 1, null],
    null,
  ]);
  return { observations, workerSources, gcProgress, prune: (p: string) => p.endsWith('.lock') };
}

/** Small real-tree fixture capture; production capture/GC remains V4b. */
export async function freezeRetainedSources(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  units: readonly string[] = [],
  snapshots: readonly string[] = [],
) {
  async function* visit(p: string): AsyncGenerator<Value> {
    yield ['dir-open', p, (await f.store.root.stat(p))!];
    const entries = (await readdir(f.store.root.resolve(p), { withFileTypes: true })).sort(
      (a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || compareName(a.name, b.name),
    );
    for (const e of entries) {
      const n = (await f.store.root.stat(p ? p + '/' + e.name : e.name))!;
      yield ['child', e.name, e.isDirectory() ? 'directory' : 'file', n[3], n[4]];
    }
    for (const e of entries) {
      if (e.name === '.mammoth') continue;
      const name = p ? p + '/' + e.name : e.name;
      if (e.isDirectory()) yield* visit(name);
      else
        yield [
          'file',
          e.name,
          f.model.owner(name)[0],
          (await f.store.root.stat(name))!,
          null,
          'upsert',
          'retain',
        ];
    }
    yield ['dir-close', p];
  }
  const rows: Value[] = [];
  for await (const row of visit('')) rows.push(row);
  // Inject complete units from last to first so earlier offsets stay stable.
  for (const root of [...units].sort(
    (a, b) =>
      rows.findIndex((v) => tuple(v)[0] === 'dir-open' && tuple(v)[1] === b) -
      rows.findIndex((v) => tuple(v)[0] === 'dir-open' && tuple(v)[1] === a),
  )) {
    const start = rows.findIndex((v) => tuple(v)[0] === 'dir-open' && tuple(v)[1] === root),
      close = rows.findIndex((v) => tuple(v)[0] === 'dir-close' && tuple(v)[1] === root),
      direct = f.model.tuple[2] === 'maven';
    let insert = start + 1;
    while (tuple(rows[insert])[0] === 'child') insert++;
    let end = close;
    if (direct) {
      end = insert;
      while (tuple(rows[end])[0] === 'file') end++;
    }
    const digest = new Digest('observation-unit');
    let current = root;
    for (let i = start; i < end; i++) {
      const r = tuple(rows[i]);
      if (r[0] === 'dir-open') {
        current = String(r[1]);
        digest.update(['directory', current, r[2]]);
      }
      if (r[0] === 'child') digest.update(['child', current, ...r.slice(1)]);
      if (r[0] === 'file') digest.update(['file', current + '/' + r[1], r[2], r[3], r[4]]);
      if (r[0] === 'dir-close') current = String(r[1]).split('/').slice(0, -1).join('/');
    }
    const kind = direct ? 'maven-directory' : 'artifact-transform';
    rows.splice(end, 0, ['unit-close', kind, root, digest.digest()]);
    rows.splice(insert, 0, [
      'unit-open',
      kind,
      root,
      direct ? 'direct' : 'subtree',
      'upsert',
      'retain',
      digest.digest(),
    ]);
  }
  const observations = await f.store.writeStream(
    'observations',
    { budget: f.budget, partition: null },
    (async function* () {
      yield* rows;
    })(),
  );
  const workerSources = await f.store.writeStream(
    'worker-sources',
    { budget: f.budget, partition: null },
    (async function* () {
      for (const p of snapshots) yield ['worker-snapshot', p, observations] as Value;
    })(),
  );
  return { observations, workerSources, gcProgress: null };
}
