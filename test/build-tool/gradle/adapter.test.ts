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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GradleBuildToolAdapter } from '../../../src/build-tool/gradle/adapter';
import type { NormalizedGradleConfig } from '../../../src/config/types';
import type { CiJobContext } from '../../../src/ci/types';

function createTestGradleConfig(gradleUserHome: string): NormalizedGradleConfig {
  return {
    phase: 'prepare',
    baseDirectory: '.',
    cacheEnabled: true,
    readOnly: false,
    jobMode: 'standalone',
    dependentJobs: [],
    allowDuplicateDependentDeltaPaths: false,
    cacheKeyPrefix: 'test-prefix',
    cacheKeyTemplate: null,
    cachePartitions: [],
    cacheSchemaVersion: 1,
    cleanupEnabled: true,
    restoreCleanupMode: 'none',
    cacheGcMode: 'off',
    cacheGcOlderThanDays: 14,
    wrapperSelectionMode: 'default',
    wrapperPropertiesGlob: '**/gradle-wrapper.properties',
    defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
    wrapperPropertiesFiles: [],
    gradleUserHome,
  };
}

function createTestContext(tempDirectory: string | null): CiJobContext {
  return {
    eventName: 'push',
    resolvedRefName: 'main',
    safeRefName: 'main',
    runnerOs: 'linux',
    runnerArch: 'x64',
    defaultBranch: 'main',
    isPullRequest: false,
    repository: 'test/repo',
    workflowName: 'CI',
    jobName: 'check',
    runId: null,
    runAttempt: null,
    tempDirectory,
    workspace: '/workspace',
    actionPath: null,
  };
}

describe('GradleBuildToolAdapter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('exposes the correct build tool metadata', () => {
    const adapter = new GradleBuildToolAdapter(createTestGradleConfig('/gradle-home'));

    expect(adapter.getName()).toBe('Gradle');
    expect(adapter.getBuildToolId()).toBe('gradle');
    expect(adapter.getCacheRoot()).toBe('/gradle-home');
  });

  it('exposes the expected built-in partition preset ids in stable order', () => {
    const adapter = new GradleBuildToolAdapter(createTestGradleConfig('/gradle-home'));
    const ids = adapter.getBuiltInPartitionPresets().map((p) => p.id);

    expect(ids).toEqual([
      'modules',
      'transforms-metadata',
      'kotlin-dsl',
      'build-cache',
      'wrapper-dists',
    ]);
  });

  it('exposes hard-exclude globs that cover lock files and security-sensitive paths', () => {
    const adapter = new GradleBuildToolAdapter(createTestGradleConfig('/gradle-home'));
    const globs = adapter.getHardCacheExcludeGlobs();

    expect(globs).toContain('**/*.lock');
    expect(globs).toContain('caches/*/cc-keystore');
    expect(globs).toContain('**/configuration-cache/**');
  });

  it('reports "no builds captured" log line when the CI temp directory is not configured', async () => {
    const gradleUserHome = await mkdtemp(path.join(os.tmpdir(), 'gradle-adapter-test-'));
    temporaryDirectories.push(gradleUserHome);

    const adapter = new GradleBuildToolAdapter(createTestGradleConfig(gradleUserHome));
    const report = await adapter.collectBuildReport(createTestContext(null));

    expect(report.anyBuildFailed).toBe(false);
    expect(report.builds).toHaveLength(0);
    expect(report.logLines).toEqual(['No Gradle build invocations were captured.']);
  });

  it('formats log lines with version, outcome, config-cache state, and tasks for each build', async () => {
    const gradleUserHome = await mkdtemp(path.join(os.tmpdir(), 'gradle-adapter-test-'));
    const runnerTemp = await mkdtemp(path.join(os.tmpdir(), 'gradle-adapter-runner-'));
    temporaryDirectories.push(gradleUserHome, runnerTemp);

    const buildResultsDir = path.join(runnerTemp, '.buildish-mammoth-cache', 'build-results');
    await mkdir(buildResultsDir, { recursive: true });

    await writeFile(
      path.join(buildResultsDir, '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1000,
        rootProjectName: 'my-project',
        requestedTasks: 'build',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(buildResultsDir, '__run-2.json'),
      JSON.stringify({
        capturedAtEpochMillis: 2000,
        rootProjectName: 'my-project',
        requestedTasks: 'check',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        buildFailed: true,
        configCacheHit: true,
      }),
      'utf8',
    );

    const adapter = new GradleBuildToolAdapter(createTestGradleConfig(gradleUserHome));
    const report = await adapter.collectBuildReport(createTestContext(runnerTemp));

    expect(report.anyBuildFailed).toBe(true);
    expect(report.builds).toHaveLength(2);
    expect(report.logLines).toEqual([
      "Gradle 8.14.3 SUCCESS (config-cache miss) tasks='build' project='my-project'",
      "Gradle 8.14.3 FAILED (config-cache hit) tasks='check' project='my-project'",
    ]);
  });

  it('appends a scan URL suffix to the log line when a build scan was published', async () => {
    const gradleUserHome = await mkdtemp(path.join(os.tmpdir(), 'gradle-adapter-test-'));
    const runnerTemp = await mkdtemp(path.join(os.tmpdir(), 'gradle-adapter-runner-'));
    temporaryDirectories.push(gradleUserHome, runnerTemp);

    const captureRoot = path.join(runnerTemp, '.buildish-mammoth-cache');
    await mkdir(path.join(captureRoot, 'build-results'), { recursive: true });
    await mkdir(path.join(captureRoot, 'build-scans'), { recursive: true });

    await writeFile(
      path.join(captureRoot, 'build-results', '__run-1.json'),
      JSON.stringify({
        capturedAtEpochMillis: 1000,
        rootProjectName: 'demo',
        requestedTasks: '--scan build',
        gradleVersion: '8.14.3',
        javaVersion: '21.0.4',
        buildFailed: false,
        configCacheHit: false,
      }),
      'utf8',
    );
    await writeFile(
      path.join(captureRoot, 'build-scans', '__run-1.json'),
      JSON.stringify({ buildScanUri: 'https://scans.gradle.com/s/abc123', buildScanFailed: false }),
      'utf8',
    );

    const adapter = new GradleBuildToolAdapter(createTestGradleConfig(gradleUserHome));
    const report = await adapter.collectBuildReport(createTestContext(runnerTemp));

    expect(report.logLines[0]).toContain('scan=https://scans.gradle.com/s/abc123');
  });
});
