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

import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as glob from '@actions/glob';
import { cutoffJob } from '../support/cutoff-job';
import { packCacheFiles, unpackCacheFiles } from '../support/archive-round-trip';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
  type BaseCacheBackend,
} from '../../src/cache/backend';

const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
const java21 = process.env.BUILDISH_TEST_JAVA_21_HOME;
const java25 = process.env.BUILDISH_TEST_JAVA_25_HOME;
// Only supplied installed tools are used. No toolchain/distribution download is allowed.
test.skipIf(!executable || !java21 || !java25)(
  'shares real Java 21/25 Gradle cache generations while respecting task inputs',
  async () => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/gradle-java-sharing-'));
    const entries: { key: string; archive: string }[] = [];
    const backend = (home: string): BaseCacheBackend => ({
      capabilities: STANDARD_BASE_CACHE_BACKEND_CAPABILITIES,
      isFeatureAvailable: () => true,
      isMissingPathsError: () => false,
      restoreCache: async (_paths, key) => {
        const hit = [...entries].reverse().find((entry) => entry.key.startsWith(key));
        if (!hit) return undefined;
        await unpackCacheFiles(home, hit.archive);
        return hit.key;
      },
      saveCache: async (patterns, key) => {
        const files = await (
          await glob.create(patterns.join('\n'), {
            implicitDescendants: false,
            followSymbolicLinks: false,
          })
        ).glob();
        const archive = await packCacheFiles(
          home,
          files.map((file) => path.relative(home, file)),
          path.join(root, 'archives', String(entries.length)),
        );
        entries.push({ key, archive });
        return entries.length;
      },
    });
    async function job(name: string, javaHome: string) {
      const home = path.join(root, name, 'cache');
      const result = await cutoffJob(path.join(root, name), { name, cacheBackend: backend(home) });
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
        path.join(result.root, 'settings.gradle'),
        "rootProject.name = 'java-sharing'\n",
      );
      await writeFile(
        path.join(result.root, 'gradle.properties'),
        `org.gradle.java.installations.auto-download=false\norg.gradle.java.installations.auto-detect=false\norg.gradle.java.installations.paths=${java21},${java25}\n`,
      );
      await mkdir(path.join(result.root, 'src/main/java'), { recursive: true });
      await writeFile(
        path.join(result.root, 'src/main/java/Example.java'),
        'public class Example {}\n',
      );
      await writeFile(
        path.join(result.root, 'build.gradle'),
        `
plugins { id 'java' }
@CacheableTask
abstract class TextOutput extends DefaultTask {
  @Input abstract Property<String> getIdentity()
  @OutputFile abstract RegularFileProperty getDestination()
  @TaskAction void writeOutput() { destination.get().asFile.text = identity.get() }
}
tasks.register('portable', TextOutput) {
  identity = 'portable'
  destination = layout.buildDirectory.file('portable.txt')
}
tasks.register('strict', TextOutput) {
  identity = providers.gradleProperty('strictIdentity').orElse('a')
  destination = layout.buildDirectory.file('strict.txt')
}
if (providers.gradleProperty('compilerJava').isPresent()) {
  tasks.named('compileJava') {
    javaCompiler = javaToolchains.compilerFor { languageVersion = JavaLanguageVersion.of(providers.gradleProperty('compilerJava').get()) }
  }
}
`,
      );
      const run = async (...args: string[]) => {
        const { stdout } = await promisify(execFile)(
          executable!,
          [
            '--no-daemon',
            '--max-workers=2',
            '--build-cache',
            'compileJava',
            'portable',
            'strict',
            ...args,
          ],
          {
            cwd: result.root,
            env: {
              ...process.env,
              JAVA_HOME: javaHome,
              GRADLE_USER_HOME: home,
              GRADLE_OPTS: '',
              JAVA_OPTS: '',
            },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        return stdout;
      };
      const classMajor = async () =>
        (
          await readFile(path.join(result.root, 'build/classes/java/main/Example.class'))
        ).readUInt16BE(6);
      return { ...result, run, classMajor };
    }
    try {
      const first = await job('java21', java21!);
      const prepared21 = await first.prepare();
      await first.run();
      expect(await first.classMajor()).toBe(65);
      await executeFinalizeAction(first.deps);
      const second = await job('java25', java25!);
      const prepared25 = await second.prepare();
      expect(prepared25.bootstrap.cacheModel!.cacheFamilyKey).toBe(
        prepared21.bootstrap.cacheModel!.cacheFamilyKey,
      );
      expect(prepared25.bootstrap.baseCacheResult!.status).toBe('current-lineage-hit');
      const differentCompiler = await second.run();
      expect(differentCompiler).not.toContain(':compileJava FROM-CACHE');
      expect(await second.classMajor()).toBe(69);
      expect(differentCompiler).toContain(':portable FROM-CACHE');
      expect(differentCompiler).toContain(':strict FROM-CACHE');
      await rm(path.join(second.root, 'build'), { recursive: true });
      const sharedCompiler = await second.run('-PcompilerJava=21', '-PstrictIdentity=b');
      expect(sharedCompiler).toContain(':compileJava FROM-CACHE');
      expect(await second.classMajor()).toBe(65);
      expect(sharedCompiler).toContain(':portable FROM-CACHE');
      expect(sharedCompiler).not.toContain(':strict FROM-CACHE');
      expect(await readFile(path.join(second.root, 'build/strict.txt'), 'utf8')).toBe('b');
      await executeFinalizeAction(second.deps);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  360_000,
);
