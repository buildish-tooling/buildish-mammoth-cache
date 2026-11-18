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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as glob from '@actions/glob';
import { expect, test } from 'vitest';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import { captureCacheMetadataSnapshot } from '../../src/cache/manifest';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';
import { readCutoffLifecycle } from '../../src/phases/cutoff-lifecycle';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { cutoffJob } from '../support/cutoff-job';
import { CutoffArtifacts } from '../support/cutoff-artifacts';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';

const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
const java21 = process.env.BUILDISH_TEST_JAVA_21_HOME;
const java25 = process.env.BUILDISH_TEST_JAVA_25_HOME;
const enabled = !!executable && !!java21 && !!java25;
async function harness() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/gradle-groovy-workspaces-'));
  const archives: { key: string; archive: string }[] = [],
    patterns: string[][] = [];
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  async function job(
    name: string,
    javaHome: string,
    mode = 'standalone',
    dependencies = '',
    variant = '',
    kotlin = false,
  ) {
    const home = path.join(root, name, 'cache');
    const backend: BaseCacheBackend = {
      capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
      isFeatureAvailable: () => true,
      isMissingPathsError: () => false,
      restoreCache: async (paths, key) => {
        patterns.push(paths.map((p) => p.replaceAll(home, '<cache>')));
        const entry = [...archives].reverse().find((e) => e.key.startsWith(key));
        if (!entry) return undefined;
        await unpackCacheFiles(home, entry.archive);
        return entry.key;
      },
      saveCache: async (paths, key) => {
        patterns.push(paths.map((p) => p.replaceAll(home, '<cache>')));
        const files = await (
          await glob.create(paths.join('\n'), {
            implicitDescendants: false,
            followSymbolicLinks: false,
          })
        ).glob();
        for (const file of files) expect((await lstat(file)).isFile()).toBe(true);
        const archive = await packCacheFiles(
          home,
          files.map((p) => path.relative(home, p)),
          path.join(root, 'archives', String(archives.length)),
        );
        archives.push({ key, archive });
        return archives.length;
      },
    };
    const result = await cutoffJob(path.join(root, name), {
      name,
      cacheBackend: backend,
      artifactBackend: artifacts,
      inputs: { 'job-mode': mode, ...(dependencies ? { 'dependent-jobs': dependencies } : {}) },
    });
    const gradle = new GradleBuildToolAdapter({
      ...result.deps.config,
      gradleUserHome: home,
      wrapperSelectionMode: 'default',
      wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
      defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
      wrapperPropertiesFiles: [],
    });
    result.adapter.getBuildToolId = () => 'gradle';
    result.adapter.getBuiltInPartitionPresets = () => gradle.getBuiltInPartitionPresets();
    result.adapter.getHardCacheExcludeGlobs = () => gradle.getHardCacheExcludeGlobs();
    await writeFile(
      path.join(result.root, 'gradle.properties'),
      'org.gradle.java.installations.auto-download=false\norg.gradle.java.installations.auto-detect=false\n',
    );
    if (kotlin) {
      await writeFile(
        path.join(result.root, 'settings.gradle.kts'),
        'rootProject.name = "workspace-reuse"\n',
      );
      await writeFile(
        path.join(result.root, 'build.gradle.kts'),
        'plugins { java }\ntasks.register("probe") { doLast { println("PROBE_OK") } }\n',
      );
    } else {
      await writeFile(
        path.join(result.root, 'settings.gradle'),
        "rootProject.name = 'workspace-reuse'\n",
      );
      await writeFile(
        path.join(result.root, 'build.gradle'),
        "plugins { id 'java' }\ntasks.register('probe') { doLast { println('PROBE_OK') } }\n" +
          (variant ? "apply from: 'extra.gradle'\n" : ''),
      );
      if (variant)
        await writeFile(
          path.join(result.root, 'extra.gradle'),
          "println('EXTRA_" + variant + "')\n",
        );
    }
    const run = async () => {
      const { stdout } = await promisify(execFile)(
        executable!,
        [
          '--offline',
          '--no-daemon',
          '--no-watch-fs',
          '--max-workers=2',
          '--console=plain',
          '--info',
          '--no-build-cache',
          '--no-configuration-cache',
          'probe',
        ],
        {
          cwd: result.root,
          env: {
            ...process.env,
            JAVA_HOME: javaHome,
            GRADLE_USER_HOME: home,
            GRADLE_OPTS: '',
            JAVA_OPTS: '',
            JAVA_TOOL_OPTIONS: '',
            JDK_JAVA_OPTIONS: '',
            _JAVA_OPTIONS: '',
          },
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      expect(stdout).toContain('PROBE_OK');
      expect(stdout).not.toContain('have been modified. These workspace directories');
      if (variant) expect(stdout).toContain('EXTRA_' + variant);
      return stdout;
    };
    return { ...result, run };
  }
  async function origins(current: Awaited<ReturnType<typeof job>>) {
    const record = readCutoffLifecycle(current.deps.runtimeHost.getState);
    if (!record.cacheEnabled) throw new Error('cache enabled');
    const snapshot = await captureCacheMetadataSnapshot(record.model);
    return Object.fromEntries(
      await Promise.all(
        (snapshot.workspaces ?? []).map(async (u) => [
          u.workspace.root,
          createHash('sha256')
            .update(await readFile(path.join(current.home, u.workspace.root, 'metadata.bin')))
            .digest('hex'),
        ]),
      ),
    );
  }
  return { root, job, origins, patterns, artifacts, archives };
}
const compileLines = (log: string) => log.split('\n').filter((l) => l.startsWith('Compiling '));
test.skipIf(!enabled)(
  'preserves real Groovy workspace winners and independent additions through Java 21/25 fan-out and fresh base restores',
  async () => {
    const f = await harness();
    try {
      const a = await f.job('worker-a', java21!, 'distributed-worker');
      await a.prepare();
      expect(compileLines(await a.run())).toHaveLength(4);
      await executeFinalizeAction(a.deps);
      const winner = await f.origins(a);
      const b = await f.job('worker-b', java25!, 'distributed-worker');
      await b.prepare();
      expect(compileLines(await b.run())).toHaveLength(4);
      await executeFinalizeAction(b.deps);
      expect(await f.origins(b)).not.toEqual(winner);
      const aggregator = await f.job(
        'aggregate',
        java21!,
        'distributed-aggregator',
        'worker-b,worker-a',
      );
      const prepared = await aggregator.prepare();
      expect(prepared.dependentDeltaResult!.warnings.join('\n')).toContain(
        'Groovy workspace selection resolved',
      );
      expect(await f.origins(aggregator)).toEqual(winner);
      expect(compileLines(await aggregator.run())).toEqual([]);
      await executeFinalizeAction(aggregator.deps);
      const fresh = await f.job('fresh25', java25!);
      expect((await fresh.prepare()).bootstrap.baseCacheResult!.status).toBe('current-lineage-hit');
      expect(compileLines(await fresh.run())).toEqual([]);
      expect(await f.origins(fresh)).toEqual(winner);
      await executeFinalizeAction(fresh.deps);
      const seededA = await f.job('seeded-a', java21!, 'distributed-worker', '', 'A');
      await seededA.prepare();
      expect(compileLines(await seededA.run()).length).toBeGreaterThan(0);
      await executeFinalizeAction(seededA.deps);
      const seededB = await f.job('seeded-b', java25!, 'distributed-worker', '', 'B');
      await seededB.prepare();
      expect(compileLines(await seededB.run()).length).toBeGreaterThan(0);
      await executeFinalizeAction(seededB.deps);
      const merged = await f.job(
        'seeded-aggregate',
        java21!,
        'distributed-aggregator',
        'seeded-b,seeded-a',
        'A',
      );
      await merged.prepare();
      expect(compileLines(await merged.run())).toEqual([]);
      expect(Object.keys(await f.origins(merged)).length).toBeGreaterThan(
        Object.keys(winner).length,
      );
      await executeFinalizeAction(merged.deps);
      const consumerB = await f.job('seeded-consumer-b', java25!, 'standalone', '', 'B');
      await consumerB.prepare();
      expect(compileLines(await consumerB.run())).toEqual([]);
      await executeFinalizeAction(consumerB.deps);
      expect(f.patterns.length).toBeGreaterThan(4);
      for (const patterns of f.patterns) expect(patterns).toEqual(f.patterns[0]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  240_000,
);
test.skipIf(!enabled)(
  'keeps existing Kotlin script reuse through the new default layout',
  async () => {
    const f = await harness();
    try {
      const seed = await f.job('kotlin-seed', java21!, 'standalone', '', '', true);
      await seed.prepare();
      expect(await seed.run()).toContain('Kotlin DSL script compilation');
      await executeFinalizeAction(seed.deps);
      const fresh = await f.job('kotlin-fresh', java21!, 'standalone', '', '', true);
      await fresh.prepare();
      expect(await fresh.run()).not.toContain('Kotlin DSL script compilation');
      await executeFinalizeAction(fresh.deps);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  120_000,
);
