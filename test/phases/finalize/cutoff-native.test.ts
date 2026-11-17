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
import { test, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cutoffJob } from '../../support/cutoff-job';
import { preflightCutoffLifecycle } from '../../../src/phases/cutoff-lifecycle';
import { executeFinalizeAction } from '../../../src/phases/finalize/flow';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
test('native build reads protect old artifacts; own finalize reads do not extend the frozen grace', async (t) => {
  const r = await mkdtemp(path.join(os.tmpdir(), 'cutoff-native-'));
  roots.push(r);
  const job = await cutoffJob(r);
  await mkdir(path.join(job.home, 'data'));
  for (const name of ['build-used', 'unused']) {
    const f = path.join(job.home, 'data', name);
    await writeFile(f, 'bytes');
    await utimes(f, 1700000000, 1700000000);
  }
  await job.prepare();
  await readFile(path.join(job.home, 'data/build-used'));
  const pre = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!pre.journal?.selection) throw new Error('frozen');
  const before = await stat(path.join(job.home, 'data/build-used'));
  if (before.atimeMs < pre.journal.cutoff!) {
    t.skip('Filesystem did not record build read atime; documented age-only fallback applies.');
    return;
  }
  expect([
    ...pre.journal.selection.used,
    ...pre.journal.selection.upserts.map((e) => e.relativePath),
  ]).toContain('data/build-used');
  expect(pre.journal.selection.gc.map((e) => e.relativePath)).toContain('data/unused');
  // Simulate an own content read after freeze; it must not rescue the previously unused old file.
  await readFile(path.join(job.home, 'data/unused'));
  const result = await executeFinalizeAction({ ...job.deps, preflight: pre });
  expect(result.cacheGcResult?.deletedFileCount).toBe(1);
  expect(await readFile(path.join(job.home, 'data/build-used'), 'utf8')).toBe('bytes');
  await expect(stat(path.join(job.home, 'data/unused'))).rejects.toThrow();
});
test('native added files with deliberately old mtime are upserts through ctime without an upfront inventory', async () => {
  const r = await mkdtemp(path.join(os.tmpdir(), 'cutoff-native-'));
  roots.push(r);
  const job = await cutoffJob(r);
  await job.prepare();
  await mkdir(path.join(job.home, 'data'));
  await writeFile(path.join(job.home, 'data/added'), 'bytes');
  await utimes(path.join(job.home, 'data/added'), 1700000000, 1700000000);
  const pre = await preflightCutoffLifecycle(job.deps.runtimeHost.getState);
  expect(pre.journal?.selection?.upserts.map((e) => e.relativePath)).toContain('data/added');
  expect(pre.journal?.selection?.gc).toEqual([]);
});
