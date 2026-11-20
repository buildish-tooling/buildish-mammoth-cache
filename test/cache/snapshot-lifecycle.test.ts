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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, chmod, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Hash } from 'node:crypto';
import * as fileIO from '../../src/util/fs';
import * as glob from '@actions/glob';
import * as fs from 'node:fs/promises';
import * as metadataIO from '../../src/cache/metadata-io';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
}));
import { cutoffJob } from '../support/cutoff-job';
import { CutoffArtifacts } from '../support/cutoff-artifacts';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { readCutoffLifecycle } from '../../src/phases/cutoff-lifecycle';
import { loadCutoffJournal, cutoffJournalPath } from '../../src/cache/cutoff-state';
import { PARTITION_SNAPSHOT_DIRECTORY } from '../../src/cache/partition-snapshots';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';

type Job = Awaited<ReturnType<typeof cutoffJob>>;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function put(job: Job, name: string, content: string) {
  await mkdir(path.dirname(path.join(job.home, name)), { recursive: true });
  await writeFile(path.join(job.home, name), content);
}
async function get(job: Job, name: string) {
  return readFile(path.join(job.home, name), 'utf8');
}
async function journal(job: Job) {
  const record = readCutoffLifecycle(job.deps.runtimeHost.getState);
  if (!record.cacheEnabled) throw new Error('enabled');
  return loadCutoffJournal(record.model, cutoffJournalPath(record.invocation));
}
async function fixture(writer: string | null = 'master', secondWriter = false) {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/snapshot-lifecycle-'));
  roots.push(root);
  const entries: {
    key: string;
    files: { name: string; bytes: Buffer; mode: number; mtime: Date }[];
  }[] = [];
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  const definitions = [
    {
      id: 'metadata',
      includes: ['metadata/**'],
      excludes: ['metadata/excluded.bin'],
      publication: 'single-writer',
      ...(writer ? { writer } : {}),
    },
    ...(secondWriter
      ? [{ id: 'second', includes: ['second/**'], publication: 'single-writer', writer: 'other' }]
      : []),
  ];
  const backend = (home: string): BaseCacheBackend => ({
    capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
    isFeatureAvailable: () => true,
    isMissingPathsError: () => false,
    restoreCache: async (_patterns, primary, fallback = [], options) => {
      const targetRoot = options?.archiveRoot ?? home;
      const entry = [primary, ...fallback].flatMap((key) =>
        [...entries].reverse().filter((e) => e.key.startsWith(key)),
      )[0];
      if (!entry) return undefined;
      for (const file of entry.files) {
        const target = path.join(targetRoot, file.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes);
        await chmod(target, file.mode);
        await utimes(target, file.mtime, file.mtime);
      }
      return entry.key;
    },
    saveCache: async (patterns, key, options) => {
      const sourceRoot = options?.archiveRoot ?? home;
      const files = await (
        await glob.create(patterns.join('\n'), {
          implicitDescendants: false,
          followSymbolicLinks: false,
        })
      ).glob();
      const archived = [];
      for (const file of files) {
        const st = await stat(file);
        if (!st.isFile()) throw new Error('Directory in archive');
        archived.push({
          name: path.relative(sourceRoot, file),
          bytes: await readFile(file),
          mode: st.mode & 0o777,
          mtime: st.mtime,
        });
      }
      entries.push({ key, files: archived });
      return entries.length;
    },
  });
  async function job(label: string, mode = 'standalone', extra: Record<string, string> = {}) {
    const dir = path.join(root, label);
    return cutoffJob(dir, {
      name: label === 'seed' ? 'build' : label,
      artifactBackend: artifacts,
      cacheBackend: backend(path.join(dir, 'cache')),
      inputs: { 'job-mode': mode, 'cache-partitions': JSON.stringify(definitions), ...extra },
    });
  }
  async function seed() {
    const s = await job('seed');
    await s.prepare();
    await put(s, 'metadata/index.bin', 'seed');
    await put(s, 'metadata/stale.bin', 'stale');
    await executeFinalizeAction(s.deps);
    return s;
  }
  return { root, job, seed, entries, artifacts };
}
describe('single-writer partition lifecycle', () => {
  it('publishes Windows writer metadata through a macOS aggregator and restores it on Linux', async () => {
    const f = await fixture();
    await f.seed();
    const writer = await f.job('master', 'distributed-worker');
    writer.ci.runnerOs = 'windows';
    writer.ci.runnerArch = 'arm64';
    await writer.prepare();
    await put(writer, 'metadata/index.bin', 'windows writer');
    await executeFinalizeAction(writer.deps);
    const aggregator = await f.job('aggregate', 'distributed-aggregator');
    aggregator.ci.runnerOs = 'macos';
    aggregator.ci.runnerArch = 'arm64';
    await aggregator.prepare();
    expect(await get(aggregator, 'metadata/index.bin')).toBe('windows writer');
    await executeFinalizeAction(aggregator.deps);
    const fresh = await f.job('fresh');
    await fresh.prepare();
    expect(await get(fresh, 'metadata/index.bin')).toBe('windows writer');
  });

  it('caches the default Gradle metadata partition while omitting locks and GC markers', async () => {
    const f = await fixture();
    const job = await f.job('gradle-default');
    // Use the production Gradle presets/exclusions with the isolated lifecycle harness.
    const config = normalizeGradleActionConfig(readGradleActionInputs(job.deps.runtimeHost), {
      phase: 'prepare',
      ciContext: job.ci,
      env: {},
    });
    const adapter = new GradleBuildToolAdapter(config);
    job.adapter.getBuildToolId = () => 'gradle';
    job.adapter.getBuiltInPartitionPresets = () => adapter.getBuiltInPartitionPresets();
    job.adapter.getHardCacheExcludeGlobs = () => adapter.getHardCacheExcludeGlobs();
    await job.prepare();
    await put(job, 'caches/modules-2/metadata-2.107/module-metadata.bin', 'index');
    await put(job, 'caches/modules-2/metadata-2.107/cache.lock', 'lock');
    await put(job, 'caches/modules-2/metadata-2.107/gc.properties', 'local');
    await executeFinalizeAction(job.deps);
    const selected = (await journal(job)).partitionSnapshots.find(
      (p) => p.partitionId === 'dependency-metadata',
    );
    expect(selected?.fileCount).toBe(1);
    const transport = JSON.parse(
      await readFile(
        path.join(job.home, PARTITION_SNAPSHOT_DIRECTORY, 'dependency-metadata/snapshot.json'),
        'utf8',
      ),
    );
    expect(transport.files.map((e: { relativePath: string }) => e.relativePath)).toEqual([
      'caches/modules-2/metadata-2.107/module-metadata.bin',
    ]);
  });
  it.each(['before-record', 'after-record'])(
    'retries interrupted snapshot journal persistence %s',
    async (point) => {
      const f = await fixture();
      await f.seed();
      const owner = await f.job('master', 'distributed-aggregator');
      await owner.prepare();
      await put(owner, 'metadata/index.bin', 'new');
      const original = metadataIO.writeMetadata;
      let injected = false;
      vi.spyOn(metadataIO, 'writeMetadata').mockImplementation(async (...args) => {
        const candidate = args[2] as { partitionSnapshots?: { source: string }[] };
        if (!injected && candidate?.partitionSnapshots?.some((s) => s.source === 'local')) {
          injected = true;
          if (point === 'after-record') await original(...args);
          throw new Error('interrupted snapshot journal');
        }
        return original(...args);
      });
      await expect(executeFinalizeAction(owner.deps)).rejects.toThrow(
        /interrupted snapshot journal/,
      );
      vi.restoreAllMocks();
      expect((await executeFinalizeAction(owner.deps)).bootstrap.baseCacheResult?.status).toBe(
        'saved',
      );
      const fresh = await f.job('fresh');
      await fresh.prepare();
      expect(await get(fresh, 'metadata/index.bin')).toBe('new');
    },
  );
  it('rejects an invalid optional writer instead of retaining the seed silently', async () => {
    const f = await fixture();
    await f.seed();
    const master = await f.job('master', 'distributed-worker');
    await master.prepare();
    await put(master, 'metadata/index.bin', 'writer');
    await executeFinalizeAction(master.deps);
    await writeFile(path.join(f.artifacts.storage, '1', 'payload/000001.bin'), 'bad');
    const agg = await f.job('aggregate', 'distributed-aggregator');
    await expect(agg.prepare()).rejects.toThrow(/size\/SHA-256/);
  });
  it('replaces preexisting metadata on hit and miss while preserving user-excluded files and warnings', async () => {
    const f = await fixture();
    const cold = await f.job('cold');
    await put(cold, 'metadata/local.bin', 'local');
    await put(cold, 'metadata/excluded.bin', 'keep');
    await cold.prepare();
    await expect(get(cold, 'metadata/local.bin')).rejects.toThrow();
    expect(await get(cold, 'metadata/excluded.bin')).toBe('keep');
    expect(cold.warnings.join(' ')).toContain('preexisting');
    expect(cold.summaries.join(' ')).toContain('preexisting');
    await f.seed();
    const restored = await f.job('restored');
    await put(restored, 'metadata/extra.bin', 'extra');
    await restored.prepare();
    expect(await get(restored, 'metadata/index.bin')).toBe('seed');
    await expect(get(restored, 'metadata/extra.bin')).rejects.toThrow();
  });
  it.each(['absent', 'not-configured'])(
    'preserves seed against aggregator-local edits with writer %s',
    async (mode) => {
      const f = await fixture(mode === 'absent' ? 'master' : null);
      await f.seed();
      const agg = await f.job('aggregate', 'distributed-aggregator');
      await agg.prepare();
      await put(agg, 'metadata/index.bin', 'local');
      await rm(path.join(agg.home, 'metadata/stale.bin'));
      await put(agg, 'data/trigger.bin', 'trigger');
      await executeFinalizeAction(agg.deps);
      expect(agg.summaries.join(' ')).toContain(
        mode === 'absent' ? 'contributed no snapshot' : 'no distributed writer',
      );
      const fresh = await f.job('fresh');
      await fresh.prepare();
      expect(await get(fresh, 'metadata/index.bin')).toBe('seed');
      expect(await get(fresh, 'metadata/stale.bin')).toBe('stale');
      expect(f.entries.at(-1)!.files.some((file) => file.name === 'metadata/index.bin')).toBe(
        false,
      );
    },
  );
  it('imports only metadata from an optional writer, including a failed-build snapshot', async () => {
    const f = await fixture();
    await f.seed();
    const master = await f.job('master', 'distributed-worker');
    await master.prepare();
    await rm(path.join(master.home, 'metadata/stale.bin'));
    await put(master, 'metadata/index.bin', 'master');
    await put(master, 'data/master-only.bin', 'not a dependency');
    master.adapter.collectBuildReport = async () => ({
      anyBuildFailed: true,
      warnings: [],
      summaryLines: [],
      logLines: [],
      builds: [],
    });
    await executeFinalizeAction(master.deps);
    const agg = await f.job('aggregate', 'distributed-aggregator');
    await agg.prepare();
    expect(await get(agg, 'metadata/index.bin')).toBe('master');
    await expect(get(agg, 'data/master-only.bin')).rejects.toThrow();
    await expect(get(agg, 'metadata/stale.bin')).rejects.toThrow();
    await put(agg, 'metadata/index.bin', 'aggregator change');
    await executeFinalizeAction(agg.deps);
    const fresh = await f.job('fresh');
    await fresh.prepare();
    expect(await get(fresh, 'metadata/index.bin')).toBe('master');
    await expect(get(fresh, 'metadata/stale.bin')).rejects.toThrow();
  });
  it.each(['empty', 'fewer'])(
    'publishes deletion-only %s snapshots without an ordinary upsert',
    async (kind) => {
      const f = await fixture();
      await f.seed();
      const master = await f.job('master', 'distributed-worker');
      await master.prepare();
      await rm(path.join(master.home, 'metadata/stale.bin'));
      if (kind === 'empty') await rm(path.join(master.home, 'metadata/index.bin'));
      const worker = await executeFinalizeAction(master.deps);
      expect(worker.deltaArtifactResult?.emptyEnvelope).toBe(false);
      const agg = await f.job('aggregate', 'distributed-aggregator');
      await agg.prepare();
      expect((await executeFinalizeAction(agg.deps)).bootstrap.baseCacheResult?.status).toBe(
        'saved',
      );
      const fresh = await f.job('fresh');
      await fresh.prepare();
      await expect(get(fresh, 'metadata/stale.bin')).rejects.toThrow();
      if (kind === 'empty') await expect(get(fresh, 'metadata/index.bin')).rejects.toThrow();
      else expect(await get(fresh, 'metadata/index.bin')).toBe('seed');
    },
  );
  it('supports independent writers for multiple partitions and a required ordinary dependency', async () => {
    const f = await fixture('master', true);
    await f.seed();
    for (const name of ['master', 'other']) {
      const worker = await f.job(name, 'distributed-worker');
      await worker.prepare();
      await put(worker, name === 'master' ? 'metadata/index.bin' : 'second/index.bin', name);
      await put(worker, 'data/' + name, name);
      await executeFinalizeAction(worker.deps);
    }
    const agg = await f.job('aggregate', 'distributed-aggregator', { 'dependent-jobs': 'master' });
    await agg.prepare();
    expect(await get(agg, 'data/master')).toBe('master');
    await expect(get(agg, 'data/other')).rejects.toThrow();
    expect(await get(agg, 'metadata/index.bin')).toBe('master');
    expect(await get(agg, 'second/index.bin')).toBe('other');
    await executeFinalizeAction(agg.deps);
  });
  it('keeps required workers required and read-only jobs nonpublishing', async () => {
    const f = await fixture();
    await f.seed();
    const required = await f.job('required', 'distributed-aggregator', {
      'dependent-jobs': 'master',
    });
    await expect(required.prepare()).rejects.toThrow(/no artifact/);
    const reader = await f.job('reader', 'distributed-aggregator', { 'read-only': 'true' });
    await reader.prepare();
    await put(reader, 'metadata/index.bin', 'local');
    const before = f.entries.length;
    expect((await executeFinalizeAction(reader.deps)).bootstrap.baseCacheResult?.status).toBe(
      'read-only',
    );
    expect(f.entries).toHaveLength(before);
  });
  it.each(['standalone', 'distributed-worker', 'distributed-aggregator'])(
    'restores read-only snapshots in %s and ignores publication-only drift at finalize',
    async (mode) => {
      const f = await fixture();
      await f.seed();
      const reader = await f.job('reader', mode, { 'read-only': 'true' });
      await put(reader, 'metadata/extra.bin', 'replace me');
      await put(reader, 'metadata/excluded.bin', 'keep');
      await reader.prepare();
      expect(await get(reader, 'metadata/index.bin')).toBe('seed');
      expect(await get(reader, 'metadata/stale.bin')).toBe('stale');
      expect(await get(reader, 'metadata/excluded.bin')).toBe('keep');
      await expect(get(reader, 'metadata/extra.bin')).rejects.toThrow();
      await put(reader, 'metadata/index.bin', 'local build changes');
      await rm(path.join(reader.home, 'metadata/stale.bin'));
      // Consumed transport is no longer a publication/retry contract for a reader.
      await rm(path.join(reader.home, PARTITION_SNAPSHOT_DIRECTORY), { recursive: true });
      const original = fs.readFile;
      const reads = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        if (String(args[0]).includes(PARTITION_SNAPSHOT_DIRECTORY))
          throw new Error('Unexpected transport read');
        return original(...args);
      });
      const before = f.entries.length;
      const result = await executeFinalizeAction(reader.deps);
      expect(result.cacheStatistics).toBeNull();
      expect(result.partitionSnapshotLines?.join(' ')).toContain(
        'prepare snapshot; 2 file(s). Post-build contents not observed',
      );
      expect(await get(reader, 'metadata/index.bin')).toBe('local build changes');
      expect(f.entries).toHaveLength(before);
      expect((await journal(reader)).selection).toBeNull();
      reads.mockRestore();
    },
  );
  it('still rejects size-changing restored transport for a read-only consumer', async () => {
    const f = await fixture();
    await f.seed();
    const payload = f.entries[0]!.files.find((file) => file.name.endsWith('payload/000001.bin'))!;
    payload.bytes = Buffer.from('corrupt');
    const reader = await f.job('reader', 'standalone', { 'read-only': 'true' });
    await expect(reader.prepare()).rejects.toThrow(/size mismatch/);
  });
  it('exempts retained snapshots from per-file GC while ordinary artifacts are evicted', async () => {
    const f = await fixture();
    const s = await f.job('seed');
    await s.prepare();
    await put(s, 'metadata/index.bin', 'seed');
    await put(s, 'data/old.bin', 'old');
    for (const name of ['metadata/index.bin', 'data/old.bin'])
      await utimes(path.join(s.home, name), 1700000000, 1700000000);
    await executeFinalizeAction(s.deps);
    const agg = await f.job('aggregate', 'distributed-aggregator');
    agg.deps.now = () => Date.now() + 10_000;
    await agg.prepare();
    const result = await executeFinalizeAction(agg.deps);
    expect(result.cacheGcResult?.deletedFileCount).toBe(1);
    const fresh = await f.job('fresh');
    await fresh.prepare();
    expect(await get(fresh, 'metadata/index.bin')).toBe('seed');
    await expect(get(fresh, 'data/old.bin')).rejects.toThrow();
  });
  it.each(['before-install', 'after-install'])(
    'retries owner snapshot replacement interrupted %s',
    async (point) => {
      const f = await fixture();
      await f.seed();
      const owner = await f.job('master', 'distributed-aggregator');
      await owner.prepare();
      await put(owner, 'metadata/index.bin', 'new');
      const original = fs.rename;
      let injected = false;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        const target = String(to);
        if (!injected && target.endsWith(PARTITION_SNAPSHOT_DIRECTORY + '/metadata')) {
          injected = true;
          if (point === 'after-install') await original(from, to);
          throw new Error('injected install interruption');
        }
        return original(from, to);
      });
      await expect(executeFinalizeAction(owner.deps)).rejects.toThrow(/injected/);
      vi.restoreAllMocks();
      expect((await executeFinalizeAction(owner.deps)).bootstrap.baseCacheResult?.status).toBe(
        'saved',
      );
      const selected = (await journal(owner)).partitionSnapshots[0]!;
      expect(selected.source).toBe('local');
      const fresh = await f.job('fresh');
      await fresh.prepare();
      expect(await get(fresh, 'metadata/index.bin')).toBe('new');
    },
  );
  it('rejects corruption of a selected snapshot on publication retry', async () => {
    const f = await fixture();
    await f.seed();
    const agg = await f.job('aggregate', 'distributed-aggregator');
    await agg.prepare();
    await put(agg, 'data/trigger', 'trigger');
    vi.spyOn(agg.deps.cacheBackend, 'saveCache').mockRejectedValueOnce(new Error('save failed'));
    await expect(executeFinalizeAction(agg.deps)).rejects.toThrow(/durable/);
    const selected = (await journal(agg)).partitionSnapshots[0]!;
    await writeFile(
      path.join(agg.home, PARTITION_SNAPSHOT_DIRECTORY, selected.partitionId, 'payload/000001.bin'),
      'bad',
    );
    await expect(executeFinalizeAction(agg.deps)).rejects.toThrow(/SHA-256/);
  });
});

it('base snapshot initialization trusts same-size bytes without any payload hash', async () => {
  const f = await fixture();
  await f.seed();
  const payload = f.entries[0]!.files.find((file) => file.name.endsWith('payload/000001.bin'))!;
  payload.bytes = Buffer.alloc(payload.bytes.length, 88);
  const hashes = vi.spyOn(Hash.prototype, 'update');
  const fileHashes = vi.spyOn(fileIO, 'hashStableFileSha256');
  const reader = await f.job('hash-free', 'standalone', { 'read-only': 'true' });
  await reader.prepare();
  expect(hashes.mock.calls.filter(([data]) => typeof data !== 'string')).toHaveLength(0);
  expect(fileHashes).not.toHaveBeenCalled();
  expect(await get(reader, 'metadata/index.bin')).toBe(payload.bytes.toString());
});
