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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { entrypointBundles, entrypointJob } from '../support/streaming-entrypoint';
import { inspectGradleDaemons } from '../../src/build-tool/gradle/process-inspection';
import { cacheMetadataDirectory } from '../../src/cache/metadata-paths';
const gradle = process.env.MAMMOTH_TEST_ENTRYPOINT_GRADLE_HOME,
  maven = process.env.MAMMOTH_TEST_ENTRYPOINT_MAVEN_HOME,
  required = process.env.MAMMOTH_REQUIRE_ENTRYPOINT_NATIVE === '1',
  configured = !!gradle && !!maven && !!process.env.JAVA_HOME;
if (required && !configured) {
  throw new Error('Required entrypoint proof is missing installed tools.');
}
let root: string;
beforeAll(async () => {
  if (!configured) {
    return;
  }
  root = await mkdtemp(path.resolve('build/entrypoint-native-'));
  // Only the remote SDK services are doubled. Native evidence and wrapper verification are real.
  await entrypointBundles(root, true);
}, 30000);
afterAll(async () => {
  // Opt-in native evidence stays under build/ for inspection without another tool build.
  if (root) {
    process.stdout.write('V7_NATIVE_EVIDENCE_ROOT ' + root + '\n');
  }
});
it.skipIf(!configured).each(['gradle', 'maven'] as const)(
  'actual %s entrypoints surround a real offline build using default tool/native code',
  async (tool) => {
    if (tool === 'gradle') {
      const baseline = await inspectGradleDaemons();
      if (baseline.remaining || baseline.uncertain) {
        throw new Error('Native entrypoint proof requires a dedicated finished-consumer host.');
      }
    }
    const j = await entrypointJob(root, tool, 'native-' + tool, {
      'cache-partitions': JSON.stringify([{ id: 'data', includes: ['data/**'] }]),
    });
    const executable = path.join(
      tool === 'gradle' ? gradle! : maven!,
      'bin',
      tool === 'gradle' ? 'gradle' : 'mvn',
    );
    try {
      // Native harnesses can supply a short runner-temp path (GnuPG uses Unix sockets).
      await j.run(
        'main',
        process.env.MAMMOTH_TEST_ENTRYPOINT_TEMP
          ? { RUNNER_TEMP: process.env.MAMMOTH_TEST_ENTRYPOINT_TEMP }
          : {},
      );
      if (tool === 'gradle') {
        await writeFile(j.workspace + '/settings.gradle', "rootProject.name='entrypoint-proof'\n");
        await promisify(execFile)(executable, ['--offline', '--gradle-user-home', j.home, 'help'], {
          cwd: j.workspace,
          env: j.env,
          timeout: 120000,
        });
        expect((await inspectGradleDaemons()).remaining).toBe(true);
      } else {
        await writeFile(
          j.workspace + '/pom.xml',
          '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>entrypoint-proof</artifactId><version>1</version></project>',
        );
        await promisify(execFile)(
          executable,
          ['--offline', '-Dmaven.repo.local=' + j.home + '/repository', 'validate'],
          {
            cwd: j.workspace,
            env: j.env,
            timeout: 120000,
          },
        );
      }
      await j.write('data/native-build', tool);
      await j.run('post');
      expect(await readFile(j.home + '/data/native-build', 'utf8')).toBe(tool);
      expect((await j.trace()).some(([name]) => name === 'cache-save')).toBe(true);
      expect((await j.trace()).some(([name]) => name === 'wrapper-provision')).toBe(false);
      const control = cacheMetadataDirectory(j.home),
        locator = JSON.parse(await readFile(path.join(control, 'v1/current.json'), 'utf8')),
        state = JSON.parse(
          await readFile(path.join(control, locator[3].slice('.mammoth/'.length)), 'utf8'),
        );
      expect(state[7][1]).toBe('published');
      if (tool === 'gradle') {
        expect(state[6]).not.toBeNull();
        expect(await inspectGradleDaemons()).toMatchObject({ remaining: false, uncertain: false });
      }
      process.stdout.write(
        'V7_NATIVE_ENTRYPOINT ' +
          JSON.stringify({ tool, platform: process.platform, published: true }) +
          '\n',
      );
    } finally {
      if (tool === 'gradle') {
        await promisify(execFile)(executable, ['--stop', '--gradle-user-home', j.home], {
          env: j.env,
          timeout: 60000,
        });
        expect(await inspectGradleDaemons()).toMatchObject({ remaining: false, uncertain: false });
      }
    }
  },
  180000,
);
