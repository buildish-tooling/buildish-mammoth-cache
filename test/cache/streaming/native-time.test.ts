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
import { afterEach, expect, it, vi } from 'vitest';
import { baseFixture, cleanupBaseFixtures } from './base-fixtures';
import { resolveModel } from '../../../src/cache/streaming/model';
import { WorkerStage } from '../../../src/cache/streaming/worker-stage';
import { WorkerNativeIndex } from '../../../src/cache/streaming/worker-native';
import { MetadataSnapshot } from '../../../src/cache/streaming/metadata-snapshot';
import * as native from '../../../src/cache/streaming/native';
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBaseFixtures();
});
async function fixture() {
  const hard = ['.mammoth/**'],
    model = resolveModel(
      ['model', 1, 'gradle', hard, [['data', ['**'], hard, 'single-writer', 'A', 'default', 0]]],
      'mtime-',
      1,
    ),
    f = await baseFixture(model),
    stage = await WorkerStage.create(f.store, f.budget),
    signal = new AbortController().signal;
  stage.enter('');
  return { ...f, stage, signal };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, ms: number) {
  return f.stage.write(
    {
      path: 'a',
      partition: 'data',
      ordinal: 0,
      header: { name: 'a', type: 'file', size: 1, mode: 420, mtimeMs: ms },
      body: (async function* () {
        yield Buffer.from('x');
      })(),
    },
    f.signal,
  );
}
const sha = createHash('sha256').update('x').digest('hex');
it.each([0, 1000, 1700000000123, 1795305600001])(
  'retains portable millisecond %i through worker staging and native snapshot copy',
  async (ms) => {
    const f = await fixture();
    let copy: MetadataSnapshot | undefined, index: WorkerNativeIndex | undefined;
    try {
      const file = await pending(f, ms);
      try {
        await file.finish(sha, 1, 420, ms);
      } finally {
        await file.close();
      }
      await f.stage.leave('', f.signal);
      const [part] = await f.stage.seal(f.signal);
      const n = await f.store.root.stat(part.nativeRoot + '/a');
      expect(BigInt(n![8]) / 1000000n).toBe(BigInt(ms));
      if (ms % 1000 === 0) expect(BigInt(n![8])).toBe(BigInt(ms) * 1000000n);
      index = await WorkerNativeIndex.capture(f.store, [part], f.budget, f.signal);
      copy = await MetadataSnapshot.copy(
        index,
        'data',
        ['local', f.store.codec.options.invocation],
        {
          budget: f.budget,
        },
      );
      const written = await f.store.root.stat(copy.nativeRoot + '/a');
      expect(BigInt(written![8]) / 1000000n).toBe(BigInt(ms));
      expect(copy.bytes).toBe(1);
    } finally {
      await copy?.dispose();
      await index?.dispose();
      await f.stage.dispose();
      expect(f.budget.retained).toBe(0);
    }
  },
);
it('does not seal staged file facts when a filesystem cannot retain the requested bucket', async () => {
  const f = await fixture(),
    file = await pending(f, 1795305600001);
  try {
    vi.spyOn(native, 'portableMtimeSeconds').mockReturnValue(0);
    await expect(file.finish(sha, 1, 420, 1795305600001)).rejects.toThrow('portable timestamp');
    expect(f.stage.work.files).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await file.close();
    await f.stage.dispose();
    expect(f.budget.retained).toBe(0);
  }
});
