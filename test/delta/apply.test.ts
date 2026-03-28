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

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DownloadedDeltaArtifactPackage,
  stageDeltaArtifactPackage,
} from '../../src/delta/service';
import { applyMergedDeltaPlan, mergeDeltaArtifactPackages } from '../../src/delta/apply';
import {
  calculateCanonicalCacheManifestDigest,
  captureCacheManifest,
  computeCacheDelta,
} from '../../src/cache/manifest';
import { createCachePartitions, type CacheModel } from '../../src/cache/model';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../src/config/types';
import type { CiJobContext } from '../../src/ci/types';

describe('cache delta merge/apply engine', () => {
  const temporaryDirectories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map(async (directory) => {
        temporaryDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it('merges ordered delta packages and applies them to a cache root', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
        await rm(path.join(home, 'wrapper/dists/gradle-8.10/bin.zip'));
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-apply-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);

    const plan = mergeDeltaArtifactPackages([packageA, packageB]);
    const result = await applyMergedDeltaPlan(plan, targetGradleUserHome);

    expect(
      plan.deltaManifest.partitions
        .filter((partition) => partition.entries.length > 0)
        .map((partition) => partition.partitionId),
    ).toEqual(['modules', 'build-cache', 'wrapper-dists']);
    expect(result).toMatchObject({
      addedCount: 1,
      modifiedCount: 1,
      deletedCount: 1,
      warnings: [],
    });
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/modules-2/files-2.1/example.jar'), 'utf8'),
    ).resolves.toBe('after-a');
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin'), 'utf8'),
    ).resolves.toBe('build-output');
    await expect(
      stat(path.join(targetGradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip')),
    ).rejects.toThrow();
  });

  it('validates every target precondition before changing any path', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
        await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-precondition-atomicity-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);
    await writeGradleFile(
      targetGradleUserHome,
      'caches/build-cache-1/output.bin',
      'unexpected-existing-output',
    );

    await expect(
      applyMergedDeltaPlan(mergeDeltaArtifactPackages([packageA]), targetGradleUserHome),
    ).rejects.toThrow(/does not match its desired state or any accepted previous state/u);
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/modules-2/files-2.1/example.jar'), 'utf8'),
    ).resolves.toBe('before');
  });

  it('treats an already-applied plan as an idempotent no-op', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
        await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
        await rm(path.join(home, 'wrapper/dists/gradle-8.10/bin.zip'));
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-idempotent-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);
    const plan = mergeDeltaArtifactPackages([packageA]);

    await applyMergedDeltaPlan(plan, targetGradleUserHome);
    const repeated = await applyMergedDeltaPlan(plan, targetGradleUserHome);

    expect(repeated).toMatchObject({ addedCount: 0, modifiedCount: 0, deletedCount: 0 });
  });

  it('accepts any compatible worker previous state for the same desired content', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'shared-after');
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'shared-after');
      },
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'alternate-before');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-compatible-bases-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);
    await writeGradleFile(
      targetGradleUserHome,
      'caches/modules-2/files-2.1/example.jar',
      'alternate-before',
    );

    const plan = mergeDeltaArtifactPackages([packageA, packageB]);
    const precondition = plan.preconditions.find(
      (candidate) => candidate.relativePath === 'caches/modules-2/files-2.1/example.jar',
    );
    expect(precondition?.acceptablePreviousSnapshots).toHaveLength(2);

    await applyMergedDeltaPlan(plan, targetGradleUserHome);
    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/modules-2/files-2.1/example.jar'), 'utf8'),
    ).resolves.toBe('shared-after');
  });

  it('accepts different previous states for a shared deletion', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await rm(path.join(home, 'wrapper/dists/gradle-8.10/bin.zip'));
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await rm(path.join(home, 'wrapper/dists/gradle-8.10/bin.zip'));
      },
      async (home) => {
        await writeGradleFile(home, 'wrapper/dists/gradle-8.10/bin.zip', 'alternate-delete-me');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-compatible-deletions-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);
    await writeGradleFile(
      targetGradleUserHome,
      'wrapper/dists/gradle-8.10/bin.zip',
      'alternate-delete-me',
    );

    const result = await applyMergedDeltaPlan(
      mergeDeltaArtifactPackages([packageA, packageB]),
      targetGradleUserHome,
    );

    expect(result.deletedCount).toBe(1);
    await expect(
      stat(path.join(targetGradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip')),
    ).rejects.toThrow();
  });

  it("does not inherit a losing duplicate-path winner's previous state", async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
        const target = path.join(home, 'caches/modules-2/files-2.1/example.jar');
        await utimes(
          target,
          new Date('2026-03-25T12:00:02.000Z'),
          new Date('2026-03-25T12:00:02.000Z'),
        );
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-b');
        const target = path.join(home, 'caches/modules-2/files-2.1/example.jar');
        await utimes(
          target,
          new Date('2026-03-25T12:00:06.000Z'),
          new Date('2026-03-25T12:00:06.000Z'),
        );
      },
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'alternate-before');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-losing-precondition-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);

    await expect(
      applyMergedDeltaPlan(
        mergeDeltaArtifactPackages([packageA, packageB], {
          allowDuplicateDependentDeltaPaths: true,
        }),
        targetGradleUserHome,
      ),
    ).rejects.toThrow(/does not match its desired state or any accepted previous state/u);
  });

  it('fails hard when dependent deltas change the same file to different content', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-b');
      },
    );

    expect(() => mergeDeltaArtifactPackages([packageA, packageB])).toThrow(
      /path conflict[\s\S]*example\.jar/u,
    );
  });

  it('allows same-content overlaps with differing timestamps and keeps the highest times', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'same-after');
        await utimes(
          path.join(home, 'caches/modules-2/files-2.1/example.jar'),
          new Date('2026-03-25T12:00:01.000Z'),
          new Date('2026-03-25T12:00:02.000Z'),
        );
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'same-after');
        await utimes(
          path.join(home, 'caches/modules-2/files-2.1/example.jar'),
          new Date('2026-03-25T12:00:05.000Z'),
          new Date('2026-03-25T12:00:06.000Z'),
        );
      },
    );

    const plan = mergeDeltaArtifactPackages([packageA, packageB]);
    const mergedEntry =
      plan.deltaManifest.partitions.find((partition) => partition.partitionId === 'modules')
        ?.entries[0] ?? null;

    expect(plan.payloads).toHaveLength(1);
    expect(mergedEntry?.current).toMatchObject({
      atimeMs: new Date('2026-03-25T12:00:05.000Z').getTime(),
      mtimeMs: new Date('2026-03-25T12:00:06.000Z').getTime(),
    });
  });

  it('can resolve different overlapping content by newest mtime when explicitly allowed', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-a');
        await utimes(
          path.join(home, 'caches/modules-2/files-2.1/example.jar'),
          new Date('2026-03-25T12:00:01.000Z'),
          new Date('2026-03-25T12:00:02.000Z'),
        );
      },
    );
    const packageB = await createDownloadedPackage(
      temporaryDirectories,
      'Worker B',
      async (home) => {
        await writeGradleFile(home, 'caches/modules-2/files-2.1/example.jar', 'after-b');
        await utimes(
          path.join(home, 'caches/modules-2/files-2.1/example.jar'),
          new Date('2026-03-25T12:00:05.000Z'),
          new Date('2026-03-25T12:00:06.000Z'),
        );
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-duplicate-paths-',
    );
    await seedBaseGradleUserHome(targetGradleUserHome);

    const plan = mergeDeltaArtifactPackages([packageA, packageB], {
      allowDuplicateDependentDeltaPaths: true,
    });
    await applyMergedDeltaPlan(plan, targetGradleUserHome);

    await expect(
      readFile(path.join(targetGradleUserHome, 'caches/modules-2/files-2.1/example.jar'), 'utf8'),
    ).resolves.toBe('after-b');
    expect(
      plan.deltaManifest.partitions.find((partition) => partition.partitionId === 'modules')
        ?.entries[0]?.current,
    ).toMatchObject({
      atimeMs: new Date('2026-03-25T12:00:05.000Z').getTime(),
      mtimeMs: new Date('2026-03-25T12:00:06.000Z').getTime(),
    });
  });

  it('warns and falls back to preserving only mtime when atime restoration fails', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-times-',
    );
    const basePlan = mergeDeltaArtifactPackages([packageA]);
    const plan = {
      ...basePlan,
      deltaManifest: {
        ...basePlan.deltaManifest,
        partitions: basePlan.deltaManifest.partitions.map((partition) => ({
          ...partition,
          entries: partition.entries.map((entry) =>
            entry.relativePath === 'caches/build-cache-1/output.bin' && entry.current
              ? {
                  ...entry,
                  current: { ...entry.current, atimeMs: entry.current.mtimeMs + 1000 },
                }
              : entry,
          ),
        })),
      },
    };
    const expectedMtimeMs =
      plan.deltaManifest.partitions.find((partition) => partition.partitionId === 'build-cache')
        ?.entries[0]?.current?.mtimeMs ?? 0;
    const setTimes = vi.fn(async (filePath: string, atime: Date, mtime: Date) => {
      if (atime.getTime() !== mtime.getTime()) {
        throw new Error('atime not supported');
      }
      await utimes(filePath, atime, mtime);
    });

    const result = await applyMergedDeltaPlan(plan, targetGradleUserHome, { setTimes });
    const fileStats = await stat(
      path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin'),
    );

    expect(result.warnings).toEqual([
      "Could not fully restore access time for 'caches/build-cache-1/output.bin'; preserved modification time only.",
    ]);
    expect(setTimes).toHaveBeenCalledTimes(2);
    expect(Math.round(fileStats.mtimeMs)).toBe(Math.round(expectedMtimeMs));
  });

  it('rejects existing symbolic-link targets during apply', async () => {
    const packageA = await createDownloadedPackage(
      temporaryDirectories,
      'Worker A',
      async (home) => {
        await writeGradleFile(home, 'caches/build-cache-1/output.bin', 'build-output');
      },
    );
    const targetGradleUserHome = await createGradleUserHome(
      temporaryDirectories,
      'buildish-mammoth-cache-symlink-',
    );
    const targetPath = path.join(targetGradleUserHome, 'caches/build-cache-1/output.bin');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await symlink('/tmp/escape', targetPath);

    await expect(
      applyMergedDeltaPlan(mergeDeltaArtifactPackages([packageA]), targetGradleUserHome),
    ).rejects.toThrow(/must not be a symbolic link/u);
  });
});

async function createDownloadedPackage(
  temporaryDirectories: Set<string>,
  jobName: string,
  mutateGradleUserHome: (gradleUserHome: string) => Promise<void>,
  prepareBase: (gradleUserHome: string) => Promise<void> = async () => {},
): Promise<DownloadedDeltaArtifactPackage> {
  const gradleUserHome = await createGradleUserHome(
    temporaryDirectories,
    'buildish-mammoth-cache-worker-',
  );
  await seedBaseGradleUserHome(gradleUserHome);
  await prepareBase(gradleUserHome);
  const cacheModel = createFixtureCacheModel(gradleUserHome);
  const previousManifest = await captureCacheManifest(cacheModel);

  await mutateGradleUserHome(gradleUserHome);

  const currentManifest = await captureCacheManifest(cacheModel);
  const deltaManifest = computeCacheDelta(previousManifest, currentManifest);
  const stagedPackage = await stageDeltaArtifactPackage(
    createFixtureCiContext(jobName),
    cacheModel,
    deltaManifest,
    {
      lifecycleIdentity: {
        restoredGenerationKey: null,
        preBuildManifestDigest: calculateCanonicalCacheManifestDigest(previousManifest),
      },
      parentDirectory: await createTempDirectory(
        temporaryDirectories,
        'buildish-mammoth-cache-stage-parent-',
      ),
    },
  );

  return {
    artifact: { id: 1, name: stagedPackage.artifactName, size: 0, digest: null },
    downloadDirectory: stagedPackage.rootDirectory,
    metadata: stagedPackage.metadata,
    deltaManifest: stagedPackage.deltaManifest,
  };
}

async function seedBaseGradleUserHome(gradleUserHome: string): Promise<void> {
  await writeGradleFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'before');
  await writeGradleFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin.zip', 'delete-me');
}

async function createGradleUserHome(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const tempRoot = await createTempDirectory(temporaryDirectories, prefix);
  const gradleUserHome = path.join(tempRoot, '.gradle');
  await mkdir(gradleUserHome, { recursive: true });
  return gradleUserHome;
}

function createFixtureCacheModel(gradleUserHome: string): CacheModel {
  const adapter = new GradleBuildToolAdapter({ gradleUserHome } as NormalizedGradleConfig);
  const partitions = createCachePartitions(
    gradleUserHome,
    [],
    adapter.getBuiltInPartitionPresets(),
    adapter.getHardCacheExcludeGlobs(),
  );

  return {
    buildToolId: adapter.getBuildToolId(),
    cacheRoot: gradleUserHome,
    cacheFamilyKey: 'test-family',
    currentRefToken: 'main-aaaaaaaaaaaa',
    currentRefLineagePrefix: 'test-family-ref-main-aaaaaaaaaaaa-gen-',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'run-1-attempt-1-job-aaaaaaaaaaaa',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'fixture-partitions',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [...new Set(partitions.flatMap((partition) => partition.absoluteExcludeGlobs))],
  };
}

function createFixtureCiContext(jobName: string): CiJobContext {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'buildish-tooling/buildish',
    workflowName: 'CI',
    jobName,
    runId: 12345,
    runAttempt: 2,
    sourceRevision: null,
    tempDirectory: null,
    workspace: '/tmp/workspace',
    actionPath: null,
  };
}

async function createTempDirectory(
  temporaryDirectories: Set<string>,
  prefix: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

async function writeGradleFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
  mode = 0o644,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  await chmod(absolutePath, mode);
  const timestamp = new Date('2026-03-25T12:00:00.000Z');
  await utimes(absolutePath, timestamp, timestamp);
}
