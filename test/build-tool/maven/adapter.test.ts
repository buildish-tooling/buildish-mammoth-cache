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

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MavenBuildToolAdapter } from '../../../src/build-tool/maven/adapter';
import type { NormalizedMavenConfig } from '../../../src/config/types';
import type { CiJobContext } from '../../../src/ci/types';

function makeConfig(overrides: Partial<NormalizedMavenConfig> = {}): NormalizedMavenConfig {
  return {
    phase: 'prepare',
    baseDirectory: '.',
    cacheEnabled: true,
    readOnly: false,
    jobMode: 'standalone',
    dependentJobs: [],
    allowDuplicateDependentDeltaPaths: false,
    cacheKeyPrefix: 'buildish-mammoth-maven-cache-',
    cacheKeyTemplate: null,
    cachePartitions: [],
    cacheSchemaVersion: 1,
    cleanupEnabled: true,
    restoreCleanupMode: 'none',
    cacheGcMode: 'off',
    cacheGcOlderThanDays: 14,
    mavenLocalRepository: path.join(os.homedir(), '.m2'),
    ...overrides,
  };
}

const STUB_CI_CONTEXT: CiJobContext = {
  eventName: 'push',
  resolvedRefName: 'main',
  safeRefName: 'main',
  runnerOs: 'linux',
  runnerArch: 'x64',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'apache/repo',
  workflowName: 'CI',
  jobName: 'build',
  runId: 1,
  runAttempt: 1,
  tempDirectory: null,
  workspace: '/workspace',
  actionPath: null,
};

describe('MavenBuildToolAdapter', () => {
  describe('identity', () => {
    it('getName returns Maven', () => {
      expect(new MavenBuildToolAdapter(makeConfig()).getName()).toBe('Maven');
    });

    it('getBuildToolId returns maven', () => {
      expect(new MavenBuildToolAdapter(makeConfig()).getBuildToolId()).toBe('maven');
    });
  });

  describe('getCacheRoot', () => {
    it('returns the configured mavenLocalRepository', () => {
      const customRepo = '/opt/ci/m2';
      const adapter = new MavenBuildToolAdapter(makeConfig({ mavenLocalRepository: customRepo }));
      expect(adapter.getCacheRoot()).toBe(customRepo);
    });

    it('defaults to the home-directory .m2 path', () => {
      const adapter = new MavenBuildToolAdapter(makeConfig());
      expect(adapter.getCacheRoot()).toBe(path.join(os.homedir(), '.m2'));
    });
  });

  describe('getBuiltInPartitionPresets', () => {
    it('returns the repository and wrapper-dists presets', () => {
      const presets = new MavenBuildToolAdapter(makeConfig()).getBuiltInPartitionPresets();
      const ids = presets.map((p) => p.id);
      expect(ids).toContain('repository');
      expect(ids).toContain('wrapper-dists');
    });

    it('all built-in presets are enabled by default', () => {
      const presets = new MavenBuildToolAdapter(makeConfig()).getBuiltInPartitionPresets();
      for (const preset of presets) {
        expect(preset.defaultEnabled).toBe(true);
      }
    });

    it('repository preset includes repository/**', () => {
      const presets = new MavenBuildToolAdapter(makeConfig()).getBuiltInPartitionPresets();
      const repo = presets.find((p) => p.id === 'repository');
      expect(repo?.relativeIncludeGlobs).toContain('repository/**');
    });

    it('wrapper-dists preset includes wrapper/dists/**', () => {
      const presets = new MavenBuildToolAdapter(makeConfig()).getBuiltInPartitionPresets();
      const wrapperDists = presets.find((p) => p.id === 'wrapper-dists');
      expect(wrapperDists?.relativeIncludeGlobs).toContain('wrapper/dists/**');
    });
  });

  describe('getHardCacheExcludeGlobs', () => {
    it('excludes .lastUpdated files', () => {
      const globs = new MavenBuildToolAdapter(makeConfig()).getHardCacheExcludeGlobs();
      expect(globs.some((g) => g.includes('lastUpdated'))).toBe(true);
    });

    it('excludes _remote.repositories files', () => {
      const globs = new MavenBuildToolAdapter(makeConfig()).getHardCacheExcludeGlobs();
      expect(globs.some((g) => g.includes('_remote.repositories'))).toBe(true);
    });

    it('excludes .lock files', () => {
      const globs = new MavenBuildToolAdapter(makeConfig()).getHardCacheExcludeGlobs();
      expect(globs.some((g) => g.includes('.lock'))).toBe(true);
    });
  });

  describe('provision', () => {
    it('returns an empty result (no-op in v1)', async () => {
      const adapter = new MavenBuildToolAdapter(makeConfig());
      const result = await adapter.provision({
        workspace: '/tmp',
        httpHeadersByHost: new Map(),
        logRetry: () => {},
      });
      expect(result.items).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.additionalOutputs).toEqual({});
    });
  });

  describe('installBuildHooks', () => {
    it('is a no-op (returns void)', async () => {
      const adapter = new MavenBuildToolAdapter(makeConfig());
      const result = await adapter.installBuildHooks(STUB_CI_CONTEXT);
      expect(result).toBeUndefined();
    });
  });

  describe('collectBuildReport', () => {
    it('returns an empty build report', async () => {
      const adapter = new MavenBuildToolAdapter(makeConfig());
      const report = await adapter.collectBuildReport(STUB_CI_CONTEXT);
      expect(report.anyBuildFailed).toBe(false);
      expect(report.warnings).toEqual([]);
      expect(report.summaryLines).toEqual([]);
      expect(report.logLines).toEqual([]);
      expect(report.builds).toEqual([]);
    });
  });
});
