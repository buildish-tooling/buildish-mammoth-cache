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
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import { readCutoffLifecycle } from '../../src/phases/cutoff-lifecycle';
import { cutoffJob } from './cutoff-job';
import { CutoffArtifacts } from './cutoff-artifacts';
import { ImmutableCacheBackend } from './immutable-cache-backend';
import { captureWorkspaceEvidence } from './gradle-workspace-evidence';

export const transformProjects = [
  'transform-cacheable',
  'transform-noncacheable',
  'transform-empty',
  'transform-none',
];
export const mixedProbeTasks = [
  'groovyProbe',
  'portable',
  'strict',
  ':kotlin:probe',
  ':extra:probe',
  ...transformProjects.map((name) => ':' + name + ':probe'),
];
export async function mixedWorkspaceJobs() {
  const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
  const java21 = process.env.BUILDISH_TEST_JAVA_21_HOME;
  const java25 = process.env.BUILDISH_TEST_JAVA_25_HOME;
  assert(executable && java21 && java25, 'Supply installed Gradle and JDK 21/25');
  for (const home of [java21, java25]) await access(path.join(home, 'bin/javac'));
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/gradle-mixed-workspaces-'));
  const backend = new ImmutableCacheBackend(path.join(root, 'archives'));
  const artifacts = new CutoffArtifacts(path.join(root, 'artifacts'));
  const invocations: string[] = [];
  const jarInput = path.join(root, 'jar-input');
  await mkdir(path.join(jarInput, 'nested/empty'), { recursive: true });
  await writeFile(path.join(jarInput, 'resource.txt'), 'portable-transform-input\n');
  await writeFile(path.join(jarInput, 'nested/gc.properties'), 'real-transform-output\n');
  const jar = path.join(root, 'fixture.jar');
  await promisify(execFile)(path.join(java21, 'bin/jar'), [
    '--create',
    '--file',
    jar,
    '-C',
    jarInput,
    '.',
  ]);
  const transformScript = await readFile('test/fixtures/gradle-transforms/build.gradle', 'utf8');
  async function job(
    name: string,
    options: {
      jdk: '21' | '25';
      variant?: 'A' | 'B' | 'C' | 'D';
      mode?: 'standalone' | 'distributed-worker' | 'distributed-aggregator';
      dependencies?: string;
      readOnly?: boolean;
    },
  ) {
    const variant = options.variant ?? 'A';
    const j = await cutoffJob(path.join(root, name), {
      name,
      cacheBackend: backend,
      artifactBackend: artifacts,
      inputs: {
        'job-mode': options.mode ?? 'standalone',
        'dependent-jobs': options.dependencies ?? '',
        'cache-gc-mode': 'off',
        'read-only': String(options.readOnly ?? false),
      },
    });
    const adapter = new GradleBuildToolAdapter({
      ...j.deps.config,
      gradleUserHome: j.home,
      wrapperSelectionMode: 'default',
      wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
      defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
      wrapperPropertiesFiles: [],
    });
    j.adapter.getBuildToolId = () => 'gradle';
    j.adapter.getBuiltInPartitionPresets = () => adapter.getBuiltInPartitionPresets();
    j.adapter.getHardCacheExcludeGlobs = () => adapter.getHardCacheExcludeGlobs();
    await cp('test/fixtures/gradle-mixed-workspaces', j.root, { recursive: true });
    for (const file of ['variant.gradle', 'extra/build.gradle.kts']) {
      const target = path.join(j.root, file);
      await writeFile(
        target,
        (await readFile(target, 'utf8')).replace(
          file === 'variant.gradle' ? 'GROOVY_VARIANT_A' : 'extra-A',
          file === 'variant.gradle' ? 'GROOVY_VARIANT_' + variant : 'extra-' + variant,
        ),
      );
    }
    for (const project of transformProjects) {
      const directory = path.join(j.root, project);
      await mkdir(directory);
      await writeFile(path.join(directory, 'build.gradle'), transformScript);
      await cp(jar, path.join(directory, 'input.jar'));
      await cp(jar, path.join(directory, 'extra-' + variant + '.jar'));
    }
    await writeFile(
      path.join(j.root, 'gradle.properties'),
      'org.gradle.java.installations.auto-download=false\norg.gradle.java.installations.auto-detect=false\n' +
        `org.gradle.java.installations.paths=${java21},${java25}\n`,
    );
    async function run(
      label: string,
      runOptions: {
        cache: 'enabled' | 'disabled';
        tasks?: string[];
        args?: string[];
      },
    ) {
      invocations.push(label);
      console.log('Gradle stage:', label);
      const logPath = path.join(j.root, label + '.log');
      try {
        const { stdout, stderr } = await promisify(execFile)(
          executable!,
          [
            '--offline',
            '--no-daemon',
            '--no-watch-fs',
            '--max-workers=2',
            '--console=plain',
            '--info',
            runOptions.cache === 'enabled' ? '--build-cache' : '--no-build-cache',
            '--no-configuration-cache',
            '-PfixtureVariant=' + variant,
            ...(runOptions.tasks ?? mixedProbeTasks),
            ...(runOptions.args ?? []),
          ],
          {
            cwd: j.root,
            timeout: 150_000,
            maxBuffer: 8 * 1024 * 1024,
            env: {
              ...process.env,
              JAVA_HOME: options.jdk === '21' ? java21 : java25,
              GRADLE_USER_HOME: j.home,
              GRADLE_OPTS: '',
              JAVA_OPTS: '',
              JAVA_TOOL_OPTIONS: '',
              JDK_JAVA_OPTIONS: '',
              _JAVA_OPTIONS: '',
            },
          },
        );
        await writeFile(logPath, stdout + stderr);
        assert(!stdout.includes('have been modified. These workspace directories'), label);
        return stdout;
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        if (failure.stdout !== undefined || failure.stderr !== undefined)
          await writeFile(logPath, (failure.stdout ?? '') + (failure.stderr ?? ''));
        throw new Error(`Gradle stage ${label} failed; log: ${logPath}`, { cause: error });
      }
    }
    async function evidence() {
      const state = readCutoffLifecycle(j.deps.runtimeHost.getState);
      assert(state.cacheEnabled);
      return captureWorkspaceEvidence(state.model);
    }
    return { ...j, run, evidence, variant };
  }
  return { root, backend, artifacts, job, invocations };
}
