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
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  rename,
} from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installFixture } from '../cache/streaming/install-fixture';
import { initializeObservationFixture } from '../cache/streaming/observation-fixtures';
import { installGradleLifecycleCapture } from '../../src/build-tool/gradle/lifecycle-capture';
import { toGroovySingleQuotedString } from '../../src/build-tool/gradle/build-result-capture-scripts';
import { ExclusiveWindow } from '../../src/cache/streaming/quiescence';
import {
  registrationDirectory,
  registrationFailure,
} from '../../src/build-tool/gradle/registrations';
import { createGradleLifecycle } from '../../src/build-tool/gradle/lifecycle';

import { inspectGradleDaemons } from '../../src/build-tool/gradle/process-inspection';
import { stopGradleInstallation } from '../../src/build-tool/gradle/stop-client';
import { sameNative } from '../../src/cache/streaming/native';
import { H, decodeRecord } from '../../src/cache/streaming/encoding';
const exec = promisify(execFile);
const configured = process.env.MAMMOTH_TEST_GRADLE_HOMES && process.env.MAMMOTH_TEST_JAVA_HOME;
const required = process.env.MAMMOTH_REQUIRE_NATIVE_QUIESCENCE === '1';
if (required && !configured) throw new Error('Required native proof is missing its installations.');
it.skipIf(!configured)(
  'captures real suppressed/Test/config-cache/failed builds and stops two isolated installed versions',
  async (test) => {
    const baseline = await inspectGradleDaemons();
    if (baseline.uncertain || baseline.remaining) {
      if (required)
        throw new Error('Required native proof has unrelated/uncertain initial consumers.');
      test.skip('Host already has unowned/opaque daemons; no unrelated stop is authorized.');
      return;
    }
    const homes: string[] = JSON.parse(process.env.MAMMOTH_TEST_GRADLE_HOMES!),
      java = await realpath(process.env.MAMMOTH_TEST_JAVA_HOME!);
    expect(homes).toHaveLength(2);
    const root = await mkdtemp(path.resolve('build/streaming-gradle-')),
      guh = root + (process.platform === 'win32' ? '/cache é' : '/cache é\tcontrol'),
      project = root + '/project',
      helper = root + '/invoke.cjs';
    await mkdir(guh);
    await mkdir(project);
    const f = await installFixture('gradle', { root: await realpath(guh) });
    try {
      await initializeObservationFixture(f);
      const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
      state[3]++;
      state[4] = 'build-ready';
      state[13] = null;
      await f.store.updateState(state);
      await installGradleLifecycleCapture(f.store, { tempDirectory: root + '/reports' });
      await writeFile(
        helper,
        `const {spawnSync}=require('child_process');const [home,...args]=process.argv.slice(2);let command=home+'/bin/gradle',argv=args,env={...process.env};if(process.platform==='win32'){command='powershell.exe';const script='$buildArgs=ConvertFrom-Json $env:MAMMOTH_BUILD_ARGS; & $env:MAMMOTH_BUILD_LAUNCHER @buildArgs; exit $LASTEXITCODE';argv=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];env.MAMMOTH_BUILD_LAUNCHER=home+'/bin/gradle.bat';env.MAMMOTH_BUILD_ARGS=JSON.stringify(args);}const p=spawnSync(command,argv,{stdio:'inherit',env});if(p.error)throw p.error;process.exit(p.status??1);`,
      );
      const base = [
        '--gradle-user-home',
        guh,
        '--project-dir',
        project,
        '--offline',
        '--console=plain',
        '--max-workers=2',
        '-Dorg.gradle.jvmargs=-Xmx512m -XX:MaxMetaspaceSize=384m -XX:ActiveProcessorCount=2',
      ];
      await writeFile(
        project + '/settings.gradle',
        "rootProject.name='operational-lifecycle'\nif (file('fail-settings').exists()) throw new GradleException('intentional settings failure')\n",
      );
      await mkdir(project + '/dummy');
      await writeFile(project + '/dummy/Unused.class', 'fixture');
      const child = [process.execPath, helper, homes[1], ...base, 'help']
        .map(toGroovySingleQuotedString)
        .join(',');
      await writeFile(
        project + '/build.gradle',
        `plugins { id 'java' }\ntasks.register('childFromTest', org.gradle.api.tasks.testing.Test) { task ->\n testClassesDirs=files('dummy')\n classpath=files()\n doFirst {\n  if(environment['BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE']!='true')throw new GradleException('Test suppression missing')\n  def process=new ProcessBuilder([${child}]).directory(projectDir).inheritIO()\n  process.environment().putAll(environment.collectEntries { k,v -> [(k):v.toString()] })\n  if(process.start().waitFor()!=0)throw new GradleException('Nested build failed')\n  throw new GradleException('intentional Test fixture finish')\n }\n}\n`,
      );
      const env = {
        ...process.env,
        JAVA_HOME: java,
        JAVA_OPTS: '',
        GRADLE_OPTS: '',
        JAVA_TOOL_OPTIONS: '',
        JDK_JAVA_OPTIONS: '',
        _JAVA_OPTIONS: '',
      };
      async function run(home: string, args: string[], skip = false, failed = false) {
        process.stdout.write(
          'V5_NATIVE_BUILD ' + path.basename(home) + ' ' + args.join(' ') + '\n',
        );
        try {
          const result = await exec(process.execPath, [helper, home, ...base, ...args], {
            env: {
              ...env,
              ...(skip ? { BUILDISH_MAMMOTH_CACHE_GRADLE_SKIP_BUILD_RESULT_CAPTURE: 'true' } : {}),
            },
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120000,
          });
          if (failed) throw new Error('Expected fixture failure');
          return result.stdout;
        } catch (error) {
          if (!failed) throw error;
          const e = error as { stdout?: string; stderr?: string; code?: unknown };
          if (e.code !== 1) throw error;
          return (e.stdout ?? '') + (e.stderr ?? '');
        }
      }
      await run(homes[0], ['help', '--configuration-cache'], true);
      await run(homes[0], ['help', '--configuration-cache'], true);
      const hit = await run(homes[0], ['help', '--configuration-cache'], true);
      expect(hit).toContain('Reusing configuration cache');
      const output = await run(homes[0], ['childFromTest'], false, true);
      expect(output).toContain('intentional Test fixture finish');
      const running = await inspectGradleDaemons();
      expect(running).toEqual({ remaining: true, uncertain: false });
      process.stdout.write('V6_NATIVE_RUNNING ' + JSON.stringify(running) + '\n');
      const dir = f.store.root.resolve(registrationDirectory(f.store));
      let files = await readdir(dir);
      expect(files).toHaveLength(2);
      for (const name of files) {
        const row = decodeRecord(await readFile(dir + '/' + name));
        expect(name).toBe(H('gradle-installation', row) + '.json');
        f.store.codec.schemas.documents['gradle-installation'].parse(row);
      }
      // Delete the first record: an early settings failure must recreate it independently
      // of summary completion, while still using exactly the same installation tuple.
      for (const name of files) {
        const row = f.store.codec.schemas.documents['gradle-installation'].parse(
          decodeRecord(await readFile(dir + '/' + name)),
        );
        if (row[3] === (await realpath(homes[0]))) await rm(dir + '/' + name);
      }
      await writeFile(project + '/fail-settings', 'fail');
      expect(await run(homes[0], ['help'], true, true)).toContain('intentional settings failure');
      files = await readdir(dir);
      expect(files).toHaveLength(2);
      expect(await f.store.root.stat(registrationFailure(f.store))).toBeNull();
      // Withhold only the second fixture-owned registration: its live daemon must
      // deny the gate after the first captured installation has stopped.
      let withheld = '';
      for (const name of files) {
        const row = f.store.codec.schemas.documents['gradle-installation'].parse(
          decodeRecord(await readFile(dir + '/' + name)),
        );
        if (row[3] === (await realpath(homes[1]))) withheld = name;
      }
      expect(withheld).not.toBe('');
      await rename(dir + '/' + withheld, root + '/withheld-registration.json');
      try {
        const denied = await ExclusiveWindow.establish(f.store, f.budget, {
          assertCurrent: (): undefined => {},
          exitGraceMs: 0,
        });
        if (denied.status === 'ready') denied.window.close();
        expect(denied.status).toBe('skipped-not-quiescent');
        expect((await inspectGradleDaemons()).remaining).toBe(true);
      } finally {
        await rename(root + '/withheld-registration.json', dir + '/' + withheld);
      }
      const stopped: string[] = [];
      let active = 0,
        peak = 0;
      const before = await f.store.root.stat(registrationDirectory(f.store)),
        gate = await ExclusiveWindow.establish(f.store, f.budget, {
          assertCurrent: (): undefined => {},
          lifecycle: async () =>
            createGradleLifecycle({
              stop: async (installation, signal, timeout) => {
                active++;
                peak = Math.max(peak, active);
                stopped.push(installation.gradleHome);
                try {
                  await stopGradleInstallation(installation, signal, timeout);
                } finally {
                  active--;
                }
              },
            }),
        });
      expect(peak).toBe(1);
      expect(stopped.sort()).toEqual((await Promise.all(homes.map((h) => realpath(h)))).sort());
      if (gate.status !== 'ready') throw new Error(gate.message);
      gate.window.close();
      expect((await inspectGradleDaemons()).remaining).toBe(false);
      expect(
        sameNative(before!, (await f.store.root.stat(registrationDirectory(f.store)))!, true),
      ).toBe(true);
      // Once that window is closed, a later failed registration must deny a new
      // window even though an earlier quiescence record exists.
      await rm(project + '/fail-settings');
      await rename(dir, dir + '.valid');
      await writeFile(dir, 'not a registration directory');
      await run(homes[0], ['help'], true);
      expect(await f.store.readFixed(registrationFailure(f.store))).toEqual([
        'gradle-capture-failed',
        1,
        f.store.codec.options.invocation,
      ]);
      expect(
        (await ExclusiveWindow.establish(f.store, f.budget, { assertCurrent: (): undefined => {} }))
          .status,
      ).toBe('skipped-not-quiescent');
      process.stdout.write(
        'V5_NATIVE_GRADLE ' +
          JSON.stringify({
            versions: homes.map((h) => path.basename(h)),
            registrations: files.length,
            configurationCache: 'reused',
            testSuppression: true,
            settingsFailure: true,
            quiescent: true,
            missingRegistrationBlocked: true,
            stopClients: stopped.length,
            peakStopClients: peak,
            failedCaptureBlocked: true,
          }) +
          '\n',
      );
    } finally {
      // Only these exact isolated homes/installations; never stop host-discovered daemons.
      for (const home of homes)
        await stopGradleInstallation(
          { gradleHome: home, gradleUserHome: guh, javaHome: java },
          new AbortController().signal,
          60000,
        ).catch(() => {});
      let clean = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const scan = await inspectGradleDaemons();
        if (!scan.remaining && !scan.uncertain) {
          clean = true;
          break;
        }
        await delay(250);
      }
      expect(clean).toBe(true);
      expect(f.budget.retained).toBe(0);
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  process.platform === 'win32' ? 600000 : 240000,
);
