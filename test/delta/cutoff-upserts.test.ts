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

import { afterEach, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, utimes, chmod, lstat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {
  assertCutoffPackageCompatible,
  stageCutoffPackage,
  verifyCutoffPackage,
  uploadCutoffPackage,
  downloadCutoffPackage,
} from '../../src/delta/cutoff-service';
import { mergeCutoffPackages, applyCutoffPlan } from '../../src/delta/cutoff-apply';
import { verifyCutoffReplay } from '../../src/cache/cutoff-state';
import * as guarded from '../../src/cache/guarded-files';
import { cutoffFixtureState, cutoffFixtureCi, cutoffFixtureModel } from '../support/cutoff-fixture';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../../src/delta/backend';
const require = createRequire(import.meta.url),
  roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cutoff-upsert-'));
  roots.push(root);
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/a'), 'original');
  await chmod(path.join(root, 'data/a'), 0o755);
  await utimes(path.join(root, 'data/a'), 1700000000.123, 1700000000.123);
  return { root, ...(await cutoffFixtureState(root)) };
}
it('reads selected source once and stages a stable checksum-sealed package across retries', async () => {
  const { root, state, ci } = await fixture(),
    copy = vi.spyOn(guarded, 'copyGuardedFile');
  const pkg = await stageCutoffPackage(state, ci);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(pkg.files).toHaveLength(3);
  expect((await verifyCutoffPackage(pkg.rootDirectory)).manifest).toEqual(pkg.manifest);
  const sealed = state.seal;
  await rm(pkg.rootDirectory, { recursive: true });
  await verifyCutoffReplay(state);
  const again = await stageCutoffPackage(state, ci);
  expect(state.seal).toEqual(sealed);
  expect(again.metadata.artifactName).toBe(pkg.metadata.artifactName);
  await writeFile(path.join(root, 'data/a'), 'changed!');
  await expect(stageCutoffPackage(state, ci)).rejects.toThrow(/changed/);
});
it('coalesces equal bytes with different mtimes and rejects conflicting ties or wrong ownership before mutation', async () => {
  const { state, ci, model, root } = await fixture(),
    pkg = await stageCutoffPackage(state, ci);
  const other = structuredClone({
    metadata: pkg.metadata,
    manifest: pkg.manifest,
    rootDirectory: pkg.rootDirectory,
  });
  other.manifest.partitions[0]!.upserts[0]!.mtimeMs += 1000;
  const plan = mergeCutoffPackages([pkg, other], model, ci);
  expect(plan.upserts).toHaveLength(1);
  expect(plan.upserts[0]!.entry.mtimeMs).toBe(other.manifest.partitions[0]!.upserts[0]!.mtimeMs);
  other.manifest.partitions[0]!.upserts[0]!.contentSha256 = 'f'.repeat(64);
  expect(() => mergeCutoffPackages([pkg, other], model, ci)).toThrow(/Conflicting/);
  expect(() =>
    mergeCutoffPackages(
      [
        pkg,
        {
          ...other,
          manifest: {
            ...other.manifest,
            partitions: [
              {
                ...other.manifest.partitions[0]!,
                upserts: [
                  {
                    ...other.manifest.partitions[0]!.upserts[0]!,
                    mtimeMs: pkg.manifest.partitions[0]!.upserts[0]!.mtimeMs,
                  },
                ],
              },
            ],
          },
        },
      ],
      model,
      ci,
      true,
    ),
  ).toThrow(/Conflicting/);
  const bad = { ...plan, used: ['outside/b'] };
  await expect(applyCutoffPlan(bad, model)).rejects.toThrow(/ownership/);
  expect(await readFile(path.join(root, 'data/a'), 'utf8')).toBe('original');
});
it('round-trips a real installed ZIP archive and explicitly restores upsert mode/mtime', async () => {
  const { state, ci, root } = await fixture(),
    pkg = await stageCutoffPackage(state, ci),
    archive = path.join(root, 'worker.zip');
  const backend: WorkflowArtifactBackend = {
    capabilities: STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
    uploadArtifact: async (name, files, base, options) => {
      expect(options?.retentionDays).toBe(7);
      const zip = require('archiver')('zip');
      const done = pipeline(zip, createWriteStream(archive));
      for (const file of files) zip.file(file, { name: path.relative(base, file) });
      await zip.finalize();
      await done;
      return { id: 1, name, size: (await lstat(archive)).size, digest: null };
    },
    downloadArtifact: async (_id, options) => {
      await new Promise<void>((resolve, reject) =>
        createReadStream(archive)
          .pipe(require('unzip-stream').Extract({ path: options!.path }))
          .on('close', resolve)
          .on('error', reject),
      );
      return { downloadPath: options!.path!, digestMismatch: false };
    },
    listArtifacts: async () => [],
    getArtifact: async () => {
      throw new Error('unused');
    },
    deleteArtifact: async () => {
      throw new Error('must retain worker');
    },
  };
  const uploaded = await uploadCutoffPackage(backend, pkg);
  const downloaded = await downloadCutoffPackage(
    backend,
    uploaded,
    path.join(root, '.mammoth/downloads'),
    {
      repository: ci.repository,
      workflowName: ci.workflowName,
      runId: ci.runId,
      producerJobName: ci.jobName,
      producerAttempt: 1,
      sourceRevision: null,
    },
  );
  const target = path.join(root, 'target');
  await mkdir(target);
  const model = cutoffFixtureModel(target);
  const merged = mergeCutoffPackages([downloaded], model, cutoffFixtureCi(target));
  await applyCutoffPlan(merged, model);
  expect(await readFile(path.join(target, 'data/a'), 'utf8')).toBe('original');
  const stats = await lstat(path.join(target, 'data/a'));
  expect(Math.trunc(stats.mtimeMs)).toBe(1700000000123);
  expect(stats.mode & 0o777).toBe(0o755);
});
it('keeps used-only and empty completions payload-free, does not resurrect missing paths', async () => {
  const { state, ci, root } = await fixture();
  state.selection!.upserts = [];
  state.selection!.used = ['data/a'];
  // Freeze a separate valid used-only journal, before any payload seal exists.
  const { persistCutoffJournal } = await import('../../src/cache/cutoff-state');
  await persistCutoffJournal(state);
  const pkg = await stageCutoffPackage(state, ci);
  expect(pkg.files).toHaveLength(2);
  expect(pkg.manifest.partitions[0]!.usedPaths).toEqual(['data/a']);
  const target = path.join(root, 'empty');
  await mkdir(target);
  const model = cutoffFixtureModel(target);
  expect(
    await applyCutoffPlan(mergeCutoffPackages([pkg], model, cutoffFixtureCi(target)), model),
  ).toEqual({ upserts: [], used: [] });
});
it('rejects tampered payloads, unexpected entries and old package versions', async () => {
  const { state, ci } = await fixture(),
    pkg = await stageCutoffPackage(state, ci);
  await writeFile(
    path.join(pkg.rootDirectory, pkg.manifest.partitions[0]!.upserts[0]!.payloadPath),
    'tampered',
  );
  await expect(verifyCutoffPackage(pkg.rootDirectory)).rejects.toThrow(/SHA-256/);
  const meta = path.join(pkg.rootDirectory, 'delta-package.json');
  await writeFile(meta, JSON.stringify({ ...pkg.metadata, schemaVersion: 3 }));
  await expect(verifyCutoffPackage(pkg.rootDirectory)).rejects.toThrow();
});

it('reserves complete JSON overhead before reading near-limit payload candidates', async () => {
  const { state, ci } = await fixture();
  state.selection!.upserts[0]!.identity.size = 4 * 1024 * 1024 * 1024;
  const { persistCutoffJournal } = await import('../../src/cache/cutoff-state');
  await persistCutoffJournal(state);
  const copy = vi.spyOn(guarded, 'copyGuardedFile');
  await expect(stageCutoffPackage(state, ci)).rejects.toThrow(/metadata\+payload budget/);
  expect(copy).not.toHaveBeenCalled();
});
it('treats fractional conflicting mtimes in the same portable millisecond as a tied conflict', async () => {
  const { state, ci, model } = await fixture(),
    pkg = await stageCutoffPackage(state, ci);
  const other = structuredClone({
    metadata: pkg.metadata,
    manifest: pkg.manifest,
    rootDirectory: pkg.rootDirectory,
  });
  pkg.manifest.partitions[0]!.upserts[0]!.mtimeMs = 1000.1;
  other.manifest.partitions[0]!.upserts[0]!.mtimeMs = 1000.9;
  other.manifest.partitions[0]!.upserts[0]!.contentSha256 = 'f'.repeat(64);
  expect(() => mergeCutoffPackages([pkg, other], model, ci, true)).toThrow(/Conflicting/);
});

it.each(['gradle', 'maven'])(
  'accepts mixed-platform %s workers without weakening identity checks',
  async (tool) => {
    const { state, ci, model } = await fixture();
    const pkg = await stageCutoffPackage(state, ci);
    pkg.manifest.buildToolId = tool;
    const targetModel = { ...model, buildToolId: tool };
    pkg.metadata.producer.runnerOs = 'windows';
    pkg.metadata.producer.runnerArch = 'arm64';
    expect(() =>
      assertCutoffPackageCompatible(pkg, targetModel, { ...ci, runnerOs: 'macos' }),
    ).not.toThrow();
    const bad = structuredClone(pkg);
    bad.metadata.cacheIdentity.familyKey += '-other';
    expect(() => assertCutoffPackageCompatible(bad, targetModel, ci)).toThrow(/identity/);
    bad.metadata.cacheIdentity.familyKey = model.cacheFamilyKey;
    bad.metadata.cacheIdentity.partitionFingerprint += '-other';
    expect(() => assertCutoffPackageCompatible(bad, targetModel, ci)).toThrow(/identity/);
    bad.metadata.cacheIdentity.partitionFingerprint = model.partitionFingerprint;
    bad.metadata.producer.safeRefName = 'other';
    expect(() => assertCutoffPackageCompatible(bad, targetModel, ci)).toThrow(/identity/);
  },
);

it('coalesces permission differences in either worker order and preserves executability', async () => {
  const { state, ci, model, root } = await fixture();
  const pkg = await stageCutoffPackage(state, ci);
  const other = structuredClone(pkg);
  pkg.manifest.partitions[0]!.upserts[0]!.mode = 0o755;
  other.manifest.partitions[0]!.upserts[0]!.mode = 0o600;
  for (const packages of [
    [pkg, other],
    [other, pkg],
  ]) {
    const plan = mergeCutoffPackages(packages, model, ci);
    expect(plan.upserts[0]!.entry.mode).toBe(0o755);
    await applyCutoffPlan(plan, model);
    expect((await lstat(path.join(root, 'data/a'))).mode & 0o777).toBe(0o755);
  }
  other.manifest.partitions[0]!.upserts[0]!.contentSha256 = 'f'.repeat(64);
  expect(() => mergeCutoffPackages([pkg, other], model, ci)).toThrow(/Conflicting/);
});

it('ignores incidental modes in complete Maven directory views while retaining content conflicts', async () => {
  const { state, ci, model } = await fixture();
  const pkg = await stageCutoffPackage(state, ci);
  pkg.manifest.buildToolId = 'maven';
  const pattern = 'repository/**';
  const targetModel = {
    ...model,
    buildToolId: 'maven',
    partitions: [
      {
        ...model.partitions[0]!,
        relativeIncludeGlobs: [pattern],
        absoluteIncludeGlobs: [path.join(model.cacheRoot, pattern)],
      },
    ],
  };
  pkg.manifest.partitions[0]!.upserts[0]!.relativePath = 'repository/org/example/1/example.jar';
  const other = structuredClone(pkg);
  other.manifest.partitions[0]!.upserts[0]!.mode = 0o666;
  expect(mergeCutoffPackages([pkg, other], targetModel, ci).upserts).toHaveLength(1);
  other.manifest.partitions[0]!.upserts[0]!.contentSha256 = 'f'.repeat(64);
  expect(() => mergeCutoffPackages([pkg, other], targetModel, ci, true)).toThrow(
    /Conflicting Maven/,
  );
});

it.each([
  ['gradle', 'wrapper/dists/gradle-9-bin/hash/gradle-9/bin/gradle'],
  ['maven', 'wrapper/dists/apache-maven-3/hash/bin/mvn'],
  ['maven', 'wrapper/dists/apache-maven-3-bin/hash/apache-maven-3/bin/mvn'],
])('makes Windows %s launchers executable during worker application', async (tool, launcher) => {
  const { state, ci, model, root } = await fixture();
  const pkg = await stageCutoffPackage(state, ci);
  pkg.manifest.buildToolId = tool;
  const entry = pkg.manifest.partitions[0]!.upserts[0]!;
  entry.relativePath = launcher;
  entry.mode = 0o666;
  const targetModel = {
    ...model,
    buildToolId: tool,
    partitions: [
      {
        ...model.partitions[0]!,
        relativeIncludeGlobs: ['wrapper/dists/**'],
        absoluteIncludeGlobs: [path.join(root, 'wrapper/dists/**')],
      },
    ],
  };
  await applyCutoffPlan(mergeCutoffPackages([pkg], targetModel, ci), targetModel);
  expect((await lstat(path.join(root, launcher))).mode & 0o777).toBe(0o755);
});
