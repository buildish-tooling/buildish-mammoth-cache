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

// Source-mapped native/codec diagnostics, separate from unchanged production bundles.
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { NativeRoot } from '../../src/cache/streaming/native';
import { OwnedStore } from '../../src/cache/streaming/owned-store';
import { LocalCodec } from '../../src/cache/streaming/local-schema';
import { resolveModel, invocationId } from '../../src/cache/streaming/model';
import { WorkingBudget } from '../../src/cache/streaming/tree-state';
import { walkNative, walkWork } from '../../src/cache/streaming/native-walk';
import { DiskMembership } from '../../src/cache/streaming/worker-spool';
import { writeWorkerArchive, type WorkerEvent } from '../../src/cache/streaming/worker-codec';
import { mergeWorkerArchives } from '../../src/cache/streaming/worker-merge';
import type { Context } from '../../src/cache/streaming/schema';
async function report(value: unknown) {
  await mkdir(path.resolve('build/q1-results'), { recursive: true });
  const name = process.argv
    .slice(2, 5)
    .join('-')
    .replace(/[^a-z0-9-]/giu, '');
  await writeFile(
    path.resolve('build/q1-results/native-' + name + '.json'),
    JSON.stringify(value, null, 2) + '\n',
  );
  console.log(JSON.stringify(value));
}
async function main() {
  const root = await mkdtemp(path.resolve('build/q1-diagnostic-'));
  const [kind, readersText, shape] = process.argv.slice(2);
  try {
    if (kind === 'width') {
      const dir = path.join(root, 'width');
      await mkdir(dir);
      for (let n = 0; n < 100000; n++)
        await writeFile(path.join(dir, n.toString(36).padStart(4, '0')), 'x');
      const native = await NativeRoot.bind(dir),
        budget = new WorkingBudget(),
        work = walkWork();
      let files = 0;
      const start = performance.now();
      for await (const e of walkNative(native, '', { budget }, work)) if (e.tag === 'file') files++;
      assert.equal(files, 100000);
      assert.equal(budget.retained, 0);
      await writeFile(path.join(dir, 'zzzz'), 'overflow');
      await assert.rejects(async () => {
        for await (const e of walkNative(native, '', { budget }, walkWork())) void e;
      }, /breadth/);
      await report({
        case: 'W',
        files,
        overflowRejected: true,
        work,
        native: native.work,
        chargedPeak: budget.peakRetained,
        milliseconds: performance.now() - start,
      });
    } else {
      assert.equal(kind, 'merge');
      const k = Number(readersText);
      assert([2, 4, 16].includes(k));
      assert(['disjoint', 'overlap'].includes(shape));
      const union = process.argv[5] === '--smoke' ? 64 : 64000,
        hard = ['.mammoth/**'],
        withSnapshot = k === 16 && shape === 'overlap';
      const model = resolveModel(
        [
          'model',
          1,
          'gradle',
          hard,
          [
            ['data', ['caches/build-cache-1/**'], hard, 'aggregate', null, 'choose-worker-entry'],
            ...(withSnapshot
              ? [['state', ['state/**'], hard, 'single-writer', null, 'default']]
              : []),
          ],
        ],
        'q1-phase-',
        1,
      );
      const context: Context = [
        'github',
        'qualification/fixture',
        'q1',
        '1',
        'aggregator',
        1,
        'diagnostic',
        'gradle',
      ];
      const store = await OwnedStore.bind(
        root,
        new LocalCodec({
          model,
          context,
          invocation: invocationId(context, 'a'.repeat(32)),
          role: 'standalone',
          access: 'writable',
        }),
      );
      const inputs = [];
      let compressedBytes = 0,
        rawTarBytes = 0;
      for (let worker = 0; worker < k; worker++) {
        const job = 'worker' + String(worker).padStart(2, '0'),
          ctx: Context = [...context];
        ctx[4] = job;
        const file = path.join(root, job + '.tar.gz'),
          budget = new WorkingBudget(),
          snapshots = withSnapshot && worker === k - 1 ? ['state'] : [];
        const first = shape === 'overlap' ? 0 : worker * (union / k),
          end = shape === 'overlap' ? union : (worker + 1) * (union / k);
        async function* events(): AsyncGenerator<WorkerEvent> {
          yield { type: 'channel-open' };
          yield { type: 'dir-open', path: '' };
          yield { type: 'dir-open', path: 'caches' };
          yield { type: 'dir-open', path: 'caches/build-cache-1' };
          for (
            let bucket = Math.floor(first / 1000);
            bucket <= Math.floor((end - 1) / 1000);
            bucket++
          ) {
            const dir = 'caches/build-cache-1/' + String(bucket).padStart(3, '0');
            yield { type: 'dir-open', path: dir };
            for (
              let i = Math.max(first, bucket * 1000);
              i < Math.min(end, (bucket + 1) * 1000);
              i++
            ) {
              const body = Buffer.alloc(64, worker + 1);
              yield {
                type: 'file',
                path: dir + '/' + String(i).padStart(6, '0'),
                size: 64,
                mode: 420,
                mtimeMs: 0,
                bytes: (async function* () {
                  yield body;
                })(),
                assertStable: async () => {},
              };
            }
            yield { type: 'dir-close', path: dir };
          }
          yield { type: 'dir-close', path: 'caches/build-cache-1' };
          yield { type: 'dir-close', path: 'caches' };
          yield { type: 'dir-close', path: '' };
          yield { type: 'channel-close' };
          yield { type: 'channel-open' };
          yield { type: 'dir-open', path: '' };
          yield { type: 'dir-close', path: '' };
          yield { type: 'channel-close' };
          if (snapshots.length) {
            yield { type: 'channel-open' };
            yield { type: 'dir-open', path: '' };
            yield { type: 'dir-open', path: 'state' };
            yield {
              type: 'file',
              path: 'state/value',
              size: 8,
              mode: 420,
              mtimeMs: 0,
              bytes: (async function* () {
                yield Buffer.from('snapshot');
              })(),
              assertStable: async () => {},
            };
            yield { type: 'dir-close', path: 'state' };
            yield { type: 'dir-close', path: '' };
            yield { type: 'channel-close' };
          }
        }
        await writeWorkerArchive(
          createWriteStream(file),
          {
            model,
            context: ctx,
            authorizedSnapshots: snapshots,
            budget,
            membership: await DiskMembership.create(store, budget),
            snapshots,
            assertStable: async () => {},
          },
          () => events(),
        );
        assert.equal(budget.retained, 0);
        compressedBytes += (await stat(file)).size;
        // Qualification analysis pass only, excluded from the merge measurement below.
        for await (const chunk of createReadStream(file).pipe(createGunzip()))
          rawTarBytes += chunk.length;
        inputs.push({
          job,
          authorizedSnapshots: snapshots,
          context: ctx,
          source: createReadStream(file, { highWaterMark: 65536 }),
        });
      }
      const budget = new WorkingBudget(),
        cpu = process.cpuUsage(),
        start = performance.now();
      const merged = await mergeWorkerArchives(store, inputs, {
        budget,
        ordinaryOrder: inputs.map((i) => i.job),
        ordinaryPolicy: 'strict',
        snapshots: withSnapshot
          ? [{ partition: 'state', job: inputs[k - 1].job, required: true }]
          : [],
      });
      try {
        assert.equal(merged.stage.work.files, union + (withSnapshot ? 1 : 0));
        assert.equal(merged.stage.work.bodyBytes, union * 64 + (withSnapshot ? 8 : 0));
        const bodyReads = merged.readers.reduce((n, r) => n + r.work.bodyBytes, 0),
          expectedInputs = shape === 'overlap' ? union * k : union;
        assert.equal(bodyReads, expectedInputs * 64 + (withSnapshot ? 8 : 0));
        if (withSnapshot) {
          assert.deepEqual(merged.selectedSnapshots, ['state']);
          const state = merged.partitions.find((p) => p.partition === 'state')!;
          assert.equal(
            await readFile(store.root.resolve(state.nativeRoot + '/state/value'), 'utf8'),
            'snapshot',
          );
        }
        assert(merged.readers.every((r) => r.work.archivePasses === 1));
        const target = merged.partitions[0];
        assert.deepEqual(
          await readFile(
            store.root.resolve(target.nativeRoot + '/caches/build-cache-1/000/000000'),
          ),
          Buffer.alloc(64, 1),
        );
        await report({
          case: 'K',
          k,
          shape,
          union,
          snapshotFiles: withSnapshot ? 1 : 0,
          memoryScope:
            'Process sample at merge completion; external peak covers archive construction plus merge, not isolated merge RSS',
          inputFiles: expectedInputs,
          validatedBodyBytes: bodyReads,
          stage: merged.stage.work,
          compressedBytes,
          rawTarBytes,
          rawTarOverheadBytes: rawTarBytes - bodyReads,
          milliseconds: performance.now() - start,
          cpu: process.cpuUsage(cpu),
          memory: process.memoryUsage(),
          chargedPeak: budget.peakRetained,
          native: store.root.work,
          readers: merged.readers.map((r) => r.work),
        });
      } finally {
        await merged.dispose();
      }
      assert.equal(budget.retained, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
