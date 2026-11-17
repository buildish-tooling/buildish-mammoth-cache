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

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cutoffJob } from '../support/cutoff-job';
import { preflightCutoffLifecycle } from '../../src/phases/cutoff-lifecycle';
import { collectCutoffGarbage } from '../../src/cache/cutoff-gc';
import {
  loadCutoffJournal,
  cutoffJournalPath,
  verifyCutoffReplay,
} from '../../src/cache/cutoff-state';
import * as metadata from '../../src/cache/metadata-io';
import * as guarded from '../../src/cache/guarded-files';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(count: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cutoff-gc-'));
  roots.push(root);
  const job = await cutoffJob(root);
  await mkdir(path.join(job.home, 'data'));
  for (let i = 0; i < count; i++) {
    const file = path.join(job.home, 'data', String(i).padStart(4, '0'));
    await writeFile(file, 'bytes');
    await utimes(file, 1700000000, 1700000000);
  }
  job.deps.now = () => Date.now() + 10000;
  await job.prepare();
  const pre = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  return pre.journal!;
}
it('keeps full-journal writes constant and bytes linear as the deletion batch doubles', async () => {
  const measured: { writes: number; bytes: number }[] = [];
  for (const count of [50, 100]) {
    const state = await fixture(count);
    const original = metadata.writeMetadata;
    let writes = 0,
      bytes = 0;
    const spy = vi.spyOn(metadata, 'writeMetadata').mockImplementation(async (...args) => {
      if (args[1] === cutoffJournalPath(state.invocation)) {
        writes++;
        bytes += Buffer.byteLength(JSON.stringify(args[2])) + 1;
      }
      await original(...args);
    });
    expect((await collectCutoffGarbage(state))?.deletedFileCount).toBe(count);
    measured.push({ writes, bytes });
    spy.mockRestore();
    expect(writes).toBe(2);
    expect(
      (await loadCutoffJournal(state.model, cutoffJournalPath(state.invocation))).deletedPaths,
    ).toHaveLength(count);
  }
  console.log('GC_CHECKPOINT_TRAFFIC', JSON.stringify(measured));
  expect(measured[1]!.bytes).toBeLessThan(measured[0]!.bytes * 2.5);
});
it.each([false, true])(
  'recovers an interrupted sweep without per-file checkpoints; recreated=%s',
  async (recreated) => {
    const state = await fixture(2);
    const original = guarded.regularStat;
    const spy = vi.spyOn(guarded, 'regularStat').mockImplementation(async (file) => {
      if (file.endsWith('0001')) throw new Error('interrupted before second unlink');
      return original(file);
    });
    await expect(collectCutoffGarbage(state)).rejects.toThrow('interrupted');
    spy.mockRestore();
    await expect(stat(path.join(state.model.cacheRoot, 'data/0000'))).rejects.toThrow();
    expect((await stat(path.join(state.model.cacheRoot, 'data/0001'))).isFile()).toBe(true);
    const recovered = await loadCutoffJournal(state.model, cutoffJournalPath(state.invocation));
    expect(recovered.deletedPaths).toEqual([]);
    if (recreated) {
      await writeFile(path.join(state.model.cacheRoot, 'data/0000'), 'replacement');
      await expect(verifyCutoffReplay(recovered)).rejects.toThrow(/changed/);
      await expect(collectCutoffGarbage(recovered)).rejects.toThrow(/changed/);
      expect((await stat(path.join(state.model.cacheRoot, 'data/0001'))).isFile()).toBe(true);
    } else {
      await verifyCutoffReplay(recovered);
      expect((await collectCutoffGarbage(recovered))?.deletedFileCount).toBe(2);
      expect(recovered.deletedPaths).toEqual(['data/0000', 'data/0001']);
    }
  },
);
