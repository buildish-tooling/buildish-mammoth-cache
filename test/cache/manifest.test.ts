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
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CACHE_MANIFEST_SCHEMA_VERSION,
  DEFAULT_CACHE_MANIFEST_SCAN_CONCURRENCY,
  calculateCanonicalCacheManifestDigest,
  captureCacheMetadataSnapshot,
  captureCacheManifest,
  computeCacheDelta,
  deserializeCacheManifest,
  deserializeCacheDeltaManifest,
  serializeCacheDeltaManifest,
  serializeCacheManifest,
  type CacheFileManifestEntry,
  type CacheManifest,
} from '../../src/cache/manifest';
import {
  createCachePartitions,
  type CacheModel,
  type CachePartitionDefinition,
} from '../../src/cache/model';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../src/config/types';
import { hashStableFileSha256 } from '../../src/util/fs';

describe('captureCacheManifest', () => {
  it('uses a conservative bounded default concurrency', () => {
    expect(DEFAULT_CACHE_MANIFEST_SCAN_CONCURRENCY).toBe(32);
  });

  it('captures regular files by partition and excludes lock/configuration-cache content', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'module');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/fileHashes/hash.bin', 'transform');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/md-rule/rule.bin', 'ignored-transform');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/scripts/script.bin', 'script');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/output.bin', 'build');
      await writeTrackedFile(
        gradleUserHome,
        'wrapper/dists/gradle-8.10/bin/gradle',
        'wrapper',
        0o755,
      );
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/example.lock', 'ignored');
      await writeTrackedFile(gradleUserHome, 'caches/8.10/cc-keystore', 'ignored');
      await writeTrackedFile(
        gradleUserHome,
        'caches/modules-2/configuration-cache/should-be-ignored.bin',
        'ignored',
      );
      await writeTrackedFile(
        gradleUserHome,
        'caches/modules-2/metadata-2.107/module-artifact.bin',
        'ignored-metadata',
      );

      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));

      expect(flattenManifestPaths(manifest)).toEqual([
        'caches/8.10/scripts/script.bin',
        'caches/build-cache-1/output.bin',
        'caches/modules-2/files-2.1/example.jar',
        'wrapper/dists/gradle-8.10/bin/gradle',
      ]);
      expect(manifest.partitions.map((partition) => partition.partitionId)).toEqual([
        'modules',
        'kotlin-dsl',
        'build-cache',
        'wrapper-dists',
      ]);
      const wrapperEntry = manifest.partitions.find(
        (partition) => partition.partitionId === 'wrapper-dists',
      )?.entries[0];
      expect(wrapperEntry).toBeDefined();
      expect(wrapperEntry!.mode & 0o777).toBe(0o755);
      expect(serializeCacheManifest(manifest)).toContain('"schemaVersion":1');
    });
  });

  it('supports opting into the transforms partition explicitly', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'caches/transforms-4/example/transform.bin', 'xform');

      const partitions = createCachePartitions(gradleUserHome, [
        { id: 'transforms-metadata', includes: ['caches/transforms-*/**'], excludes: [] },
      ]);
      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome, partitions));

      expect(
        manifest.partitions.find((partition) => partition.partitionId === 'transforms-metadata')
          ?.entries,
      ).toEqual([
        expect.objectContaining({ relativePath: 'caches/transforms-4/example/transform.bin' }),
      ]);
    });
  });

  it.each(['broad', 'deep'] as const)(
    'preserves canonical manifest semantics for a %s tree across concurrency limits',
    async (shape) => {
      await withGradleUserHome(async (gradleUserHome) => {
        const fileCount = 400;
        for (let index = 0; index < fileCount; index += 1) {
          const relativePath =
            shape === 'broad'
              ? `caches/modules-2/files-2.1/broad/file-${String(index).padStart(4, '0')}.bin`
              : `caches/modules-2/files-2.1/deep/branch-${String(index % 20).padStart(2, '0')}/one/two/three/four/five/file-${String(index).padStart(4, '0')}.bin`;
          await writeTrackedFile(gradleUserHome, relativePath, `contents-${index}`);
        }

        const cacheModel = createTestCacheModel(gradleUserHome);
        const serialManifest = await captureCacheManifest(cacheModel, { maxConcurrency: 1 });
        const parallelManifest = await captureCacheManifest(cacheModel, { maxConcurrency: 4 });

        expect(flattenManifestPaths(parallelManifest)).toEqual(
          flattenManifestPaths(serialManifest),
        );
        expect(calculateCanonicalCacheManifestDigest(parallelManifest)).toBe(
          calculateCanonicalCacheManifestDigest(serialManifest),
        );
      });
    },
  );

  it('rejects invalid scan concurrency before traversing the cache', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await expect(
        captureCacheManifest(createTestCacheModel(gradleUserHome), { maxConcurrency: 0 }),
      ).rejects.toThrow(/positive integer/u);
    });
  });

  it('captures cache metadata without content hashes', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'module');

      const snapshot = await captureCacheMetadataSnapshot(createTestCacheModel(gradleUserHome));
      const entry = snapshot.partitions.find((partition) => partition.partitionId === 'modules')
        ?.entries[0];

      expect(entry).toEqual(
        expect.objectContaining({
          relativePath: 'caches/modules-2/files-2.1/example.jar',
          size: Buffer.byteLength('module'),
          atimeMs: expect.any(Number),
          mtimeMs: expect.any(Number),
        }),
      );
      expect(entry).not.toHaveProperty('contentSha256');
    });
  });

  it('applies scan concurrency validation to metadata capture', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await expect(
        captureCacheMetadataSnapshot(createTestCacheModel(gradleUserHome), {
          maxConcurrency: 0,
        }),
      ).rejects.toThrow(/positive integer/u);
    });
  });

  it('preserves the pre-read access time when hashing updates atime', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const relativePath = 'caches/modules-2/files-2.1/example.jar';
      const expectedAtime = new Date('2026-03-25T11:59:58.000Z');
      const expectedMtime = new Date('2026-03-25T12:00:00.000Z');
      const absolutePath = path.join(gradleUserHome, relativePath);

      await writeTrackedFile(gradleUserHome, relativePath, 'module');
      await utimes(absolutePath, expectedAtime, expectedMtime);

      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));
      const entry = manifest.partitions.find((partition) => partition.partitionId === 'modules')
        ?.entries[0];

      expect(entry).toMatchObject({
        relativePath,
        atimeMs: expectedAtime.getTime(),
        mtimeMs: expectedMtime.getTime(),
      });
    });
  });

  it('fails when the same file matches multiple cache partitions', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'shared/example.bin', 'shared');

      await expect(
        captureCacheManifest(createOverlappingCacheModel(gradleUserHome)),
      ).rejects.toThrow(/matches multiple cache partitions/);
    });
  });
});

describe('computeCacheDelta', () => {
  it('classifies added, modified, and deleted files per partition', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const cacheModel = createTestCacheModel(gradleUserHome);
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'before');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/deleted.bin', 'delete-me');
      await writeTrackedFile(gradleUserHome, 'wrapper/dists/gradle-8.10/bin/gradle', 'same');

      const previousManifest = await captureCacheManifest(cacheModel);

      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/example.jar', 'after');
      await writeTrackedFile(gradleUserHome, 'caches/build-cache-1/added.bin', 'add-me');
      await unlink(path.join(gradleUserHome, 'caches/build-cache-1/deleted.bin'));

      const currentManifest = await captureCacheManifest(cacheModel);
      const delta = computeCacheDelta(previousManifest, currentManifest);

      expect(
        delta.partitions.find((partition) => partition.partitionId === 'modules')?.entries,
      ).toEqual([
        expect.objectContaining({
          relativePath: 'caches/modules-2/files-2.1/example.jar',
          changeType: 'modified',
        }),
      ]);
      expect(
        delta.partitions.find((partition) => partition.partitionId === 'build-cache')?.entries,
      ).toEqual([
        expect.objectContaining({
          relativePath: 'caches/build-cache-1/added.bin',
          changeType: 'added',
          previous: null,
        }),
        expect.objectContaining({
          relativePath: 'caches/build-cache-1/deleted.bin',
          changeType: 'deleted',
          current: null,
        }),
      ]);
      expect(
        delta.partitions
          .filter((partition) => partition.entries.length > 0)
          .map((partition) => partition.partitionId),
      ).toEqual(['modules', 'build-cache']);
      expect(serializeCacheDeltaManifest(delta)).toContain('"changeType":"modified"');
    });
  });

  it('rejects manifests from different build tools', () => {
    const previousManifest: CacheManifest = {
      schemaVersion: 1,
      buildToolId: 'gradle',
      cacheRoot: '/tmp/one',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };
    const currentManifest: CacheManifest = {
      schemaVersion: 1,
      buildToolId: 'maven',
      cacheRoot: '/tmp/one',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };

    expect(() => computeCacheDelta(previousManifest, currentManifest)).toThrow(/same build tool/);
  });

  it('rejects manifests from different cache roots', () => {
    const previousManifest: CacheManifest = {
      schemaVersion: 1,
      buildToolId: 'gradle',
      cacheRoot: '/tmp/one',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };
    const currentManifest: CacheManifest = {
      schemaVersion: 1,
      buildToolId: 'gradle',
      cacheRoot: '/tmp/two',
      partitions: [{ partitionId: 'modules', entries: [] }],
    };

    expect(() => computeCacheDelta(previousManifest, currentManifest)).toThrow(/same cache root/);
  });

  it('ignores atime-only differences so manifest capture does not manufacture large deltas', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const cacheModel = createTestCacheModel(gradleUserHome);
      const relativePath = 'caches/modules-2/files-2.1/example.jar';
      const absolutePath = path.join(gradleUserHome, relativePath);
      const originalMtime = new Date('2026-03-25T12:00:00.000Z');

      await writeTrackedFile(gradleUserHome, relativePath, 'same-content');
      const previousManifest = await captureCacheManifest(cacheModel);

      await utimes(absolutePath, new Date('2026-03-25T13:30:00.000Z'), originalMtime);
      const currentManifest = await captureCacheManifest(cacheModel);
      const delta = computeCacheDelta(previousManifest, currentManifest);

      expect(delta.partitions.every((partition) => partition.entries.length === 0)).toBe(true);
    });
  });
});

describe('captureCacheManifest — error handling', () => {
  it('does not hash through a symlink that replaces a checked regular file', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      const checkedPath = path.join(gradleUserHome, 'caches/modules-2/files-2.1/module.jar');
      const targetPath = path.join(gradleUserHome, 'outside-secret.txt');
      await mkdir(path.dirname(checkedPath), { recursive: true });
      await writeFile(checkedPath, 'original', 'utf8');
      await writeFile(targetPath, 'outside-target', 'utf8');

      const checkedStats = await lstat(checkedPath);
      await unlink(checkedPath);
      await symlink(targetPath, checkedPath);

      await expect(hashStableFileSha256(checkedPath, checkedStats)).resolves.toBeNull();
    });
  });

  it('throws when a symbolic link is encountered inside the scanned cache tree', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      // Create a real file and a symlink pointing at it inside a tracked partition directory.
      // The 'modules' partition's include glob is 'caches/modules-*/files-*/**', so the files
      // must live inside a 'files-*' subdirectory to be picked up by captureCacheManifest.
      const realFile = path.join(gradleUserHome, 'caches', 'modules-2', 'files-2.1', 'real.jar');
      const linkFile = path.join(gradleUserHome, 'caches', 'modules-2', 'files-2.1', 'link.jar');
      await mkdir(path.dirname(realFile), { recursive: true });
      await writeFile(realFile, 'content', 'utf8');
      await symlink(realFile, linkFile);

      await expect(captureCacheManifest(createTestCacheModel(gradleUserHome))).rejects.toThrow(
        /symbolic links/u,
      );
    });
  });
});

describe('deserializeCacheManifest', () => {
  it('round-trips a manifest through serialization and deserialization', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/example.jar', 'content');
      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));

      const roundTripped = deserializeCacheManifest(serializeCacheManifest(manifest));

      expect(roundTripped).toEqual(manifest);
    });
  });

  it('throws for malformed JSON', () => {
    expect(() => deserializeCacheManifest('not-json')).toThrow(/Could not parse serialized/u);
  });

  it('throws for data that passes JSON parsing but fails schema validation', () => {
    expect(() =>
      deserializeCacheManifest(JSON.stringify({ schemaVersion: 1, buildToolId: '' })),
    ).toThrow(/Invalid cache manifest/u);
  });

  it('throws for a manifest with an unsupported schema version', () => {
    expect(() =>
      deserializeCacheManifest(
        JSON.stringify({
          schemaVersion: 9999,
          buildToolId: 'gradle',
          cacheRoot: '/tmp',
          partitions: [],
        }),
      ),
    ).toThrow(/Invalid cache manifest/u);
  });
});

describe('calculateCanonicalCacheManifestDigest', () => {
  const manifest = makeManifest([
    {
      partitionId: 'modules',
      entries: [makeEntry('caches/example.bin', 'a'.repeat(64))],
    },
  ]);

  it('ignores machine-specific roots and access-time-only changes', () => {
    const relocated: CacheManifest = {
      ...manifest,
      cacheRoot: '/different/runner/cache',
      partitions: manifest.partitions.map((partition) => ({
        ...partition,
        entries: partition.entries.map((entry) => ({ ...entry, atimeMs: entry.atimeMs + 99_000 })),
      })),
    };

    expect(calculateCanonicalCacheManifestDigest(relocated)).toBe(
      calculateCanonicalCacheManifestDigest(manifest),
    );
  });

  it.each([
    ['content', { contentSha256: 'b'.repeat(64) }],
    ['size', { size: 11 }],
    ['mode', { mode: 0o100600 }],
    ['mtime', { mtimeMs: 2_000 }],
  ])('changes when material %s state changes', (_label, entryOverride) => {
    const changed: CacheManifest = {
      ...manifest,
      partitions: manifest.partitions.map((partition) => ({
        ...partition,
        entries: partition.entries.map((entry) => ({ ...entry, ...entryOverride })),
      })),
    };

    expect(calculateCanonicalCacheManifestDigest(changed)).not.toBe(
      calculateCanonicalCacheManifestDigest(manifest),
    );
  });
});

async function withGradleUserHome(run: (gradleUserHome: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-manifest-'));
  const gradleUserHome = path.join(tempRoot, '.gradle');
  await mkdir(gradleUserHome, { recursive: true });

  try {
    await run(gradleUserHome);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeTrackedFile(
  gradleUserHome: string,
  relativePath: string,
  content: string,
  mode = 0o644,
): Promise<void> {
  const absolutePath = path.join(gradleUserHome, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
  await chmod(absolutePath, mode);
  const timestamp = new Date('2026-03-25T12:00:00.000Z');
  await utimes(absolutePath, timestamp, timestamp);
}

function createTestCacheModel(
  gradleUserHome: string,
  partitions?: readonly CachePartitionDefinition[],
): CacheModel {
  const adapter = new GradleBuildToolAdapter({ gradleUserHome } as NormalizedGradleConfig);
  const resolvedPartitions =
    partitions ??
    createCachePartitions(
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
    partitionFingerprint: 'feedcafe1234abcd',
    partitions: resolvedPartitions,
    includePaths: resolvedPartitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [
      ...new Set(resolvedPartitions.flatMap((partition) => partition.absoluteExcludeGlobs)),
    ],
  };
}

function createOverlappingCacheModel(gradleUserHome: string): CacheModel {
  const partitions: readonly CachePartitionDefinition[] = [
    createCustomPartition('modules', gradleUserHome, ['shared/**']),
    createCustomPartition('build-cache', gradleUserHome, ['shared/**']),
  ];

  return {
    buildToolId: 'gradle',
    cacheRoot: gradleUserHome,
    cacheFamilyKey: 'overlap-family',
    currentRefToken: 'main-aaaaaaaaaaaa',
    currentRefLineagePrefix: 'overlap-family-ref-main-aaaaaaaaaaaa-gen-',
    fallbackRefLineagePrefixes: [],
    plannedGenerationId: 'run-1-attempt-1-job-aaaaaaaaaaaa',
    javaMajor: 21,
    runnerOs: 'linux',
    runnerArch: 'x64',
    safeRefName: 'main',
    partitionFingerprint: 'overlapfingerprint',
    partitions,
    includePaths: partitions.flatMap((partition) => partition.absoluteIncludeGlobs),
    excludePaths: [],
  };
}

function createCustomPartition(
  id: CachePartitionDefinition['id'],
  gradleUserHome: string,
  relativeIncludeGlobs: readonly string[],
): CachePartitionDefinition {
  return {
    id,
    displayName: id,
    description: id,
    relativeIncludeGlobs,
    relativeExcludeGlobs: [],
    absoluteIncludeGlobs: relativeIncludeGlobs.map((glob) => path.join(gradleUserHome, glob)),
    absoluteExcludeGlobs: [],
  };
}

function flattenManifestPaths(manifest: CacheManifest): readonly string[] {
  return manifest.partitions
    .flatMap((partition) => partition.entries.map((entry) => entry.relativePath))
    .sort();
}

// ---------------------------------------------------------------------------
// Helper: build a minimal but structurally valid manifest
// ---------------------------------------------------------------------------

function makeManifest(
  partitions: Array<{ partitionId: string; entries: CacheFileManifestEntry[] }>,
  overrides: Partial<CacheManifest> = {},
): CacheManifest {
  return {
    schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
    buildToolId: 'gradle',
    cacheRoot: '/tmp/gradle',
    partitions,
    ...overrides,
  } as unknown as CacheManifest;
}

function makeEntry(relativePath: string, sha = 'a'.repeat(64)): CacheFileManifestEntry {
  return { relativePath, contentSha256: sha, size: 10, mode: 0o644, atimeMs: 1000, mtimeMs: 1000 };
}

// ---------------------------------------------------------------------------
// captureCacheManifest — sort comparator (line 279) + unsupported include glob
// ---------------------------------------------------------------------------

describe('captureCacheManifest — sort comparator and include-glob validation', () => {
  it('returns entries sorted by relativePath when a partition has multiple files', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      // Write two files in reverse alphabetical order so the sort is observable.
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/z-last.jar', 'z');
      await writeTrackedFile(gradleUserHome, 'caches/modules-2/files-2.1/a-first.jar', 'a');

      const manifest = await captureCacheManifest(createTestCacheModel(gradleUserHome));
      const modulesPartition = manifest.partitions.find((p) => p.partitionId === 'modules');
      const relPaths = modulesPartition?.entries.map((e) => e.relativePath) ?? [];

      expect(relPaths).toEqual([...relPaths].sort());
      expect(relPaths.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('throws for a cache include glob that does not end with **', async () => {
    await withGradleUserHome(async (gradleUserHome) => {
      await expect(
        captureCacheManifest(
          createTestCacheModel(gradleUserHome, [
            createCustomPartition('bad', gradleUserHome, ['caches/modules-2/*.jar']),
          ]),
        ),
      ).rejects.toThrow(/trailing '\*\*'/u);
    });
  });

  it('throws for a cache include glob that contains a .. path-traversal segment', async () => {
    // A pattern like '../**' or 'caches/../../../etc/**' must not silently escape the cache
    // root — the containment check in expandPatternPrefix must reject it before any stat call.
    await withGradleUserHome(async (gradleUserHome) => {
      await expect(
        captureCacheManifest(
          createTestCacheModel(gradleUserHome, [
            createCustomPartition('bad', gradleUserHome, ['../**']),
          ]),
        ),
      ).rejects.toThrow(/escape the scan root/u);
    });
  });
});

// ---------------------------------------------------------------------------
// computeCacheDelta — cross-path deletion / addition branches (lines 330–334, 337–340)
// ---------------------------------------------------------------------------

describe('computeCacheDelta — cross-path deletion and addition', () => {
  it('correctly handles a deletion and an addition with interleaved paths', () => {
    // Previous: [a.jar, z.jar]   Current: [m.jar, z.jar]
    // a.jar is deleted (pathComparison < 0), m.jar is added (pathComparison > 0), z.jar unchanged.
    const previous = makeManifest([
      {
        partitionId: 'modules',
        entries: [makeEntry('caches/a.jar'), makeEntry('caches/z.jar')],
      },
    ]);
    const current = makeManifest([
      {
        partitionId: 'modules',
        entries: [makeEntry('caches/m.jar'), makeEntry('caches/z.jar')],
      },
    ]);

    const delta = computeCacheDelta(previous, current);
    const entries = delta.partitions[0]?.entries ?? [];

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ relativePath: 'caches/a.jar', changeType: 'deleted' });
    expect(entries[1]).toMatchObject({ relativePath: 'caches/m.jar', changeType: 'added' });
  });
});

// ---------------------------------------------------------------------------
// computeCacheDelta — validateComparableManifests errors (lines 679, 693, 698)
// ---------------------------------------------------------------------------

describe('computeCacheDelta — manifest compatibility validation', () => {
  it('throws when the manifest schema version does not match the current version', () => {
    const old = makeManifest([], {
      schemaVersion: 0 as unknown as typeof CACHE_MANIFEST_SCHEMA_VERSION,
    });
    const current = makeManifest([]);
    expect(() => computeCacheDelta(old, current)).toThrow(/manifest schema version/u);
  });

  it('throws when the manifests have different numbers of partitions', () => {
    const a = makeManifest([{ partitionId: 'modules', entries: [] }]);
    const b = makeManifest([
      { partitionId: 'modules', entries: [] },
      { partitionId: 'build-cache', entries: [] },
    ]);
    expect(() => computeCacheDelta(a, b)).toThrow(/matching partition layouts/u);
  });

  it('throws when the manifests have the same partition count but different partition IDs', () => {
    const a = makeManifest([{ partitionId: 'modules', entries: [] }]);
    const b = makeManifest([{ partitionId: 'build-cache', entries: [] }]);
    expect(() => computeCacheDelta(a, b)).toThrow(/matching partition identifiers/u);
  });
});

// ---------------------------------------------------------------------------
// deserializeCacheDeltaManifest — schema-level invariant errors (lines 107–120, 153)
// ---------------------------------------------------------------------------

describe('deserializeCacheDeltaManifest', () => {
  const snapshot = {
    contentSha256: 'a'.repeat(64),
    size: 10,
    mode: 0o644,
    atimeMs: 1000,
    mtimeMs: 1000,
  };

  function deltaJson(entries: unknown[]): string {
    return JSON.stringify({
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: 'gradle',
      cacheRoot: '/tmp',
      partitions: [{ partitionId: 'modules', entries }],
    });
  }

  it("rejects an 'added' entry that has a non-null previous snapshot", () => {
    const json = deltaJson([
      { relativePath: 'caches/a.jar', changeType: 'added', previous: snapshot, current: snapshot },
    ]);
    expect(() => deserializeCacheDeltaManifest(json)).toThrow(/Invalid cache delta manifest/u);
  });

  it("rejects a 'deleted' entry that has a non-null current snapshot", () => {
    const json = deltaJson([
      {
        relativePath: 'caches/a.jar',
        changeType: 'deleted',
        previous: snapshot,
        current: snapshot,
      },
    ]);
    expect(() => deserializeCacheDeltaManifest(json)).toThrow(/Invalid cache delta manifest/u);
  });

  it("rejects a 'modified' entry that has a null previous snapshot", () => {
    const json = deltaJson([
      { relativePath: 'caches/a.jar', changeType: 'modified', previous: null, current: snapshot },
    ]);
    expect(() => deserializeCacheDeltaManifest(json)).toThrow(/Invalid cache delta manifest/u);
  });

  it('rejects a delta manifest with duplicate partition IDs', () => {
    const json = JSON.stringify({
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: 'gradle',
      cacheRoot: '/tmp',
      partitions: [
        { partitionId: 'modules', entries: [] },
        { partitionId: 'modules', entries: [] },
      ],
    });
    expect(() => deserializeCacheDeltaManifest(json)).toThrow(/Invalid cache delta manifest/u);
  });
});

// ---------------------------------------------------------------------------
// deserializeCacheManifest — schema-level invariant errors (lines 42, 68, 87)
// ---------------------------------------------------------------------------

describe('deserializeCacheManifest — schema validation', () => {
  it('rejects a manifest entry with an invalid (path-escaping) relative path', () => {
    const json = JSON.stringify({
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: 'gradle',
      cacheRoot: '/tmp',
      partitions: [
        {
          partitionId: 'modules',
          entries: [
            {
              relativePath: '../outside',
              contentSha256: 'a'.repeat(64),
              size: 10,
              mode: 0o644,
              atimeMs: 1000,
              mtimeMs: 1000,
            },
          ],
        },
      ],
    });
    expect(() => deserializeCacheManifest(json)).toThrow(/Invalid cache manifest/u);
  });

  it('rejects a manifest with out-of-order entries', () => {
    const json = JSON.stringify({
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: 'gradle',
      cacheRoot: '/tmp',
      partitions: [
        {
          partitionId: 'modules',
          entries: [
            {
              relativePath: 'caches/z.jar',
              contentSha256: 'z'.repeat(64),
              size: 10,
              mode: 0o644,
              atimeMs: 1000,
              mtimeMs: 1000,
            },
            {
              relativePath: 'caches/a.jar',
              contentSha256: 'a'.repeat(64),
              size: 10,
              mode: 0o644,
              atimeMs: 1000,
              mtimeMs: 1000,
            },
          ],
        },
      ],
    });
    expect(() => deserializeCacheManifest(json)).toThrow(/Invalid cache manifest/u);
  });

  it('rejects a manifest with duplicate partition IDs', () => {
    const json = JSON.stringify({
      schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
      buildToolId: 'gradle',
      cacheRoot: '/tmp',
      partitions: [
        { partitionId: 'modules', entries: [] },
        { partitionId: 'modules', entries: [] },
      ],
    });
    expect(() => deserializeCacheManifest(json)).toThrow(/Invalid cache manifest/u);
  });
});
