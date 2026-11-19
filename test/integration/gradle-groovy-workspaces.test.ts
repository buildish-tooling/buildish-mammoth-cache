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
const kotlinFixture = `plugins { java }
@CacheableTask
abstract class PortableOutput : DefaultTask() {
    @get:Input abstract val text: Property<String>
    @get:OutputFile abstract val destination: RegularFileProperty
    @TaskAction fun write() {
        destination.get().asFile.writeText(text.get())
        println("PROBE_OK")
    }
}
tasks.register<PortableOutput>("probe") {
    text.set("same output")
    destination.set(layout.buildDirectory.file("probe.txt"))
}
`;

async function harness() {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/gradle-immutable-workspaces-'));
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
      restoreCache: async (paths, key, _fallback, options) => {
        const operationRoot = options?.archiveRoot ?? home;
        patterns.push(paths.map((p) => p.replaceAll(operationRoot, '<cache>')));
        const entry = [...archives].reverse().find((e) => e.key.startsWith(key));
        if (!entry) return undefined;
        await unpackCacheFiles(operationRoot, entry.archive);
        return entry.key;
      },
      saveCache: async (paths, key, options) => {
        const operationRoot = options?.archiveRoot ?? home;
        patterns.push(paths.map((p) => p.replaceAll(operationRoot, '<cache>')));
        const files = await (
          await glob.create(paths.join('\n'), {
            implicitDescendants: false,
            followSymbolicLinks: false,
          })
        ).glob();
        for (const file of files) expect((await lstat(file)).isFile()).toBe(true);
        const archive = await packCacheFiles(
          operationRoot,
          files.map((p) => path.relative(operationRoot, p)),
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
      await writeFile(path.join(result.root, 'build.gradle.kts'), kotlinFixture);
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
    const run = async (buildCache = false, projectDirectory = result.root) => {
      const { stdout } = await promisify(execFile)(
        executable!,
        [
          '--offline',
          '--no-daemon',
          '--no-watch-fs',
          '--max-workers=2',
          '--console=plain',
          '--info',
          buildCache ? '--build-cache' : '--no-build-cache',
          '--no-configuration-cache',
          'probe',
        ],
        {
          cwd: projectDirectory,
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
      if (!stdout.includes(':probe FROM-CACHE')) expect(stdout).toContain('PROBE_OK');
      if (kotlin)
        expect(await readFile(path.join(projectDirectory, 'build/probe.txt'), 'utf8')).toBe(
          'same output',
        );
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
        'Gradle cache unit selection resolved',
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
      for (const patterns of f.patterns) {
        expect(
          patterns.every((p) => !p.includes('publication-') && !p.includes('mammoth-generation-')),
        ).toBe(true);
        expect(
          patterns.some((p) =>
            /^<cache>\/\.mammoth\/(?:generations-v2\/record.json|partition-objects-v2\/[^/]+\/object.json)$/.test(
              p,
            ),
          ),
        ).toBe(true);
      }
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

// Both producers execute from fresh homes; task-cache fallback is tested separately
// from direct immutable-workspace reuse.
test.skipIf(!enabled)(
  'merges independent Kotlin script/accessor workspaces and task archives and proves direct reuse',
  async () => {
    const f = await harness();
    type Job = Awaited<ReturnType<typeof f.job>>;
    const digest = async (j: Job, name: string) =>
      createHash('sha256')
        .update(await readFile(path.join(j.home, name)))
        .digest('hex');
    const snapshot = async (j: Job) => {
      const state = readCutoffLifecycle(j.deps.runtimeHost.getState);
      if (!state.cacheEnabled) throw new Error('Expected active cache');
      return captureCacheMetadataSnapshot(state.model);
    };
    const units = async (j: Job) => {
      const captured = await snapshot(j);
      return new Map(
        await Promise.all(
          (captured.workspaces ?? []).map(
            async (u) =>
              [
                u.workspace.root,
                {
                  workspace: u.workspace,
                  hashes: await Promise.all(
                    u.workspace.files.map(async (name) => [name, await digest(j, name)]),
                  ),
                },
              ] as const,
          ),
        ),
      );
    };
    const archives = async (j: Job) => {
      const captured = await snapshot(j);
      return new Map(
        await Promise.all(
          captured.partitions
            .flatMap((p) => p.entries)
            .filter((e) => /^caches\/build-cache-[0-9]+\/[a-f0-9]{32}$/u.test(e.relativePath))
            .map(async (e) => [e.relativePath, await digest(j, e.relativePath)] as const),
        ),
      );
    };
    try {
      const a = await f.job('kotlin-worker-a', java21!, 'distributed-worker', '', '', true),
        b = await f.job('kotlin-worker-b', java21!, 'distributed-worker', '', '', true);
      await a.prepare();
      await b.prepare();
      expect(f.archives).toHaveLength(0);
      expect((await units(a)).size).toBe(0);
      expect((await units(b)).size).toBe(0);
      const logA = await a.run(true),
        logB = await b.run(true);
      for (const log of [logA, logB]) {
        expect(log).toContain('PROBE_OK');
        expect(log).not.toContain(':probe FROM-CACHE');
        expect(log).toContain('Kotlin DSL script compilation');
      }
      const taskKey = (log: string) => {
        const match = /Build cache key for task ':probe' is ([a-f0-9]{32})/u.exec(log);
        expect(match).not.toBeNull();
        return match![1]!;
      };
      const key = taskKey(logA);
      expect(taskKey(logB)).toBe(key);
      const sharedA = await units(a),
        sharedB = await units(b);
      const common = [...sharedA.keys()].filter((name) => sharedB.has(name));
      expect(common.some((name) => name.includes('/scripts/'))).toBe(true);
      expect(common.some((name) => name.includes('/accessors/'))).toBe(true);
      const originDifferences = await Promise.all(
        common.map(
          async (name) =>
            (await digest(a, name + '/metadata.bin')) !== (await digest(b, name + '/metadata.bin')),
        ),
      );
      expect(originDifferences.some(Boolean)).toBe(true);
      const mainArchive = 'caches/build-cache-1/' + key;
      expect(await digest(a, mainArchive)).not.toBe(await digest(b, mainArchive));
      // A distinct extra project per worker adds real disjoint workspace/task keys,
      // while retaining the identical main project/task contribution above.
      for (const [j, variant] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const extra = path.join(j.root, 'extra');
        await mkdir(extra);
        await writeFile(
          path.join(extra, 'settings.gradle.kts'),
          'rootProject.name = "extra-' + variant + '"\n',
        );
        await writeFile(
          path.join(extra, 'gradle.properties'),
          await readFile(path.join(j.root, 'gradle.properties')),
        );
        await writeFile(
          path.join(extra, 'build.gradle.kts'),
          kotlinFixture + '\nprintln("EXTRA_' + variant + '")\n',
        );
        await j.run(true, extra);
      }
      const allA = await units(a),
        allB = await units(b),
        archiveA = await archives(a),
        archiveB = await archives(b);
      for (const [left, right] of [
        [allA, allB],
        [allB, allA],
        [archiveA, archiveB],
        [archiveB, archiveA],
      ] as const)
        expect([...left.keys()].some((name) => !right.has(name))).toBe(true);
      await executeFinalizeAction(b.deps);
      await executeFinalizeAction(a.deps);
      const aggregator = await f.job(
        'kotlin-aggregator',
        java21!,
        'distributed-aggregator',
        'kotlin-worker-b,kotlin-worker-a',
        '',
        true,
      );
      await aggregator.prepare();
      const expected = new Map([...allB, ...allA]),
        expectedArchives = new Map([...archiveB, ...archiveA]);
      expect(await units(aggregator)).toEqual(expected);
      expect(await archives(aggregator)).toEqual(expectedArchives);
      await executeFinalizeAction(aggregator.deps);
      const reader = await f.job('kotlin-reader', java21!, 'standalone', '', '', true);
      await reader.prepare();
      expect(await units(reader)).toEqual(expected);
      expect(await archives(reader)).toEqual(expectedArchives);
      expect(await reader.run(true)).toContain(':probe FROM-CACHE');
      await executeFinalizeAction(reader.deps);
      const direct = await f.job('kotlin-direct-reader', java21!, 'standalone', '', '', true);
      await direct.prepare();
      expect(await units(direct)).toEqual(expected);
      for (const unit of expected.values())
        for (const name of unit.workspace.emptyDirectories)
          expect((await lstat(path.join(direct.home, name))).isDirectory()).toBe(true);
      const directLog = await direct.run(false);
      expect(directLog).not.toContain('Kotlin DSL script compilation');
      // The cold run must expose these version-qualified execution markers so
      // their absence on the no-build-cache reader is meaningful.
      expect(logA).toContain('Kotlin DSL accessors for');
      expect(directLog).not.toContain('Kotlin DSL accessors for');
      expect(directLog).toContain('PROBE_OK');
      await executeFinalizeAction(direct.deps);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  600_000,
);
