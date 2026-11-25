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

import { mkdir, mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopGradleInstallation } from '../../../src/build-tool/gradle/stop-client';
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});
async function fixture(hang: boolean | 'tree' = false) {
  const root = await mkdtemp(path.resolve('build/stop-client-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = root + '/Gradle home & percent%',
    script = root + '/client.cjs',
    log = root + '/result.json';
  await mkdir(home + '/bin', { recursive: true });
  const leaf = root + '/leaf.cjs';
  if (hang === 'tree') {
    await writeFile(
      leaf,
      "process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.MAMMOTH_TEST_LOG+'.resistant','ready');setTimeout(()=>process.exit(0),10000);",
    );
  }
  await writeFile(
    script,
    `require('fs').writeFileSync(process.env.MAMMOTH_TEST_LOG,JSON.stringify({pid:process.pid,args:process.argv.slice(2),java:process.env.JAVA_HOME,opts:process.env.JAVA_OPTS,gradle:process.env.GRADLE_OPTS}));${hang === 'tree' ? `const child=require('child_process').spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'});require('fs').writeFileSync(process.env.MAMMOTH_TEST_LOG+'.child',String(child.pid));setInterval(()=>{},1000);` : hang ? 'setTimeout(()=>{},60000);' : ''}`,
  );
  const launcher = home + '/bin/' + (process.platform === 'win32' ? 'gradle.bat' : 'gradle');
  await writeFile(
    launcher,
    process.platform === 'win32'
      ? '@echo off\r\n"%MAMMOTH_TEST_NODE%" "%MAMMOTH_TEST_SCRIPT%" %*\r\nexit /b %ERRORLEVEL%\r\n'
      : '#!/bin/sh\nexec "$MAMMOTH_TEST_NODE" "$MAMMOTH_TEST_SCRIPT" "$@"\n',
  );
  if (process.platform !== 'win32') {
    await chmod(launcher, 0o755);
  }
  vi.stubEnv('MAMMOTH_TEST_NODE', process.execPath);
  vi.stubEnv('MAMMOTH_TEST_SCRIPT', script);
  vi.stubEnv('MAMMOTH_TEST_LOG', log);
  vi.stubEnv('unexpanded', 'WRONG_EXPANSION');
  vi.stubEnv('JAVA_OPTS', '-Xmx4g');
  vi.stubEnv('GRADLE_OPTS', '-Xmx4g');
  return {
    installation: {
      gradleHome: home,
      gradleUserHome: root + '/user home & %unexpanded% é',
      javaHome: root + '/java home',
    },
    log,
  };
}
it('passes literal homes through the native launcher bridge and avoids inherited build JVM heaps', async () => {
  const f = await fixture();
  await stopGradleInstallation(f.installation, new AbortController().signal, 15000);
  const result = JSON.parse(await readFile(f.log, 'utf8'));
  expect(result.args).toEqual(['--stop', '--gradle-user-home', f.installation.gradleUserHome]);
  expect(result.java).toBe(f.installation.javaHome);
  expect(result.opts).toBe('');
  expect(result.gradle).toBe('');
}, 30000);
it('settles a timed-out owned client and its native pipeline without signalling discovered daemons', async () => {
  const f = await fixture(true);
  await expect(
    stopGradleInstallation(f.installation, new AbortController().signal, 5000),
  ).rejects.toThrow('deadline');
  const result = JSON.parse(await readFile(f.log, 'utf8'));
  expect(() => process.kill(result.pid, 0)).toThrow();
}, 30000);

it.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'keeps the owned group supervisor alive until a TERM-resistant descendant is killed',
  async () => {
    const f = await fixture('tree');
    await expect(
      stopGradleInstallation(f.installation, new AbortController().signal, 1000),
    ).rejects.toThrow('deadline');
    const pid = Number(await readFile(f.log + '.child', 'utf8'));
    expect(await readFile(f.log + '.resistant', 'utf8')).toBe('ready');
    // A killed orphan can briefly remain a zombie; it cannot retain live cache handles.
    await expect.poll(() => ended(pid), { timeout: 3000, interval: 20 }).toBe(true);
  },
  15000,
);

async function ended(pid: number): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      const result = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'stat=']);
      return /^Z/.test(result.stdout.trim());
    } catch (error) {
      if ((error as { code: unknown }).code === 1) {
        return true;
      }
      throw error;
    }
  }
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return true;
  }
}
it.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'settles its owned POSIX client before propagating cancellation',
  async () => {
    const f = await fixture(true),
      controller = new AbortController(),
      result = stopGradleInstallation(f.installation, controller.signal, 15000),
      rejected = expect(result).rejects.toThrow('owned cancellation');
    await expect
      .poll(
        async () => {
          try {
            await readFile(f.log);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
            return false;
          }
        },
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
    const { pid } = JSON.parse(await readFile(f.log, 'utf8'));
    expect(await ended(pid)).toBe(false);
    controller.abort(new Error('owned cancellation'));
    await rejected;
    await expect.poll(() => ended(pid), { timeout: 3000, interval: 20 }).toBe(true);
  },
  30000,
);
