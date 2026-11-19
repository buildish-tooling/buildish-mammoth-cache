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
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { gradleCacheJobs, snapshotGradleJob } from '../support/gradle-cache-jobs';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';

const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
const javaHome = process.env.BUILDISH_TEST_JAVA_21_HOME;
const enabled = !!executable && !!javaHome;
const executionCount = (log: string) =>
  log.split('\n').filter((l) => l.startsWith('TRANSFORM_EXECUTED ')).length;
async function harness(cacheable: boolean, outputKind = 'files') {
  const f = await gradleCacheJobs('gradle-transform-workspaces-', [{ id: 'transforms-metadata' }]);
  const script = await readFile('test/fixtures/gradle-transforms/build.gradle', 'utf8');
  const input = path.join(f.root, 'jar-input');
  await mkdir(path.join(input, 'nested/empty'), { recursive: true });
  await writeFile(path.join(input, 'resource.txt'), 'portable-transform-input\n');
  await writeFile(path.join(input, 'nested/gc.properties'), 'real-transform-output\n');
  const jar = path.join(f.root, 'fixture.jar');
  await promisify(execFile)(path.join(javaHome!, 'bin/jar'), [
    '--create',
    '--file',
    jar,
    '-C',
    input,
    '.',
  ]);
  async function job(name: string, mode = 'standalone', dependencies = '') {
    const j = await f.job(name, mode, dependencies);
    async function run(buildCache = true, extra = '', readerJava = javaHome!) {
      const project = path.join(j.root, extra ? 'extra' : 'project');
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, 'settings.gradle'),
        "rootProject.name = 'transform-workspace-reuse'\n",
      );
      await writeFile(path.join(project, 'build.gradle'), script);
      await writeFile(
        path.join(project, 'gradle.properties'),
        'org.gradle.java.installations.auto-download=false\norg.gradle.java.installations.auto-detect=false\n',
      );
      await copyFile(jar, path.join(project, extra ? extra + '.jar' : 'input.jar'));
      const { stdout, stderr } = await promisify(execFile)(
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
          '-Pcacheable=' + cacheable,
          '-PoutputKind=' + outputKind,
          ...(extra ? ['-Partifact=' + extra + '.jar'] : []),
          'probe',
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            JAVA_HOME: readerJava,
            GRADLE_USER_HOME: j.home,
            GRADLE_OPTS: '',
            JAVA_OPTS: '',
            JAVA_TOOL_OPTIONS: '',
            JDK_JAVA_OPTIONS: '',
            _JAVA_OPTIONS: '',
          },
          timeout: 150000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      await writeFile(
        path.join(j.root, extra ? 'extra-gradle.log' : 'gradle.log'),
        stdout + stderr,
      );
      expect(stdout).toContain('RESULT_OK');
      expect(stdout).not.toContain('have been modified');
      return stdout;
    }
    return { ...j, run };
  }
  async function units(j: Awaited<ReturnType<typeof job>>) {
    const s = await snapshotGradleJob(j);
    return new Map(
      await Promise.all(
        (s.workspaces ?? []).map(
          async (u) =>
            [
              u.workspace.root,
              {
                workspace: u.workspace,
                hashes: await Promise.all(
                  u.workspace.files.map(async (name) => [
                    name,
                    createHash('sha256')
                      .update(await readFile(path.join(j.home, name)))
                      .digest('hex'),
                  ]),
                ),
              },
            ] as const,
        ),
      ),
    );
  }
  return { ...f, job, units };
}
test.skipIf(!enabled).each([true, false])(
  'reuses real JAR transform workspaces through independent workers and native archives (cacheable=%s)',
  async (cacheable) => {
    const f = await harness(cacheable);
    try {
      const a = await f.job('worker-a', 'distributed-worker'),
        b = await f.job('worker-b', 'distributed-worker');
      await a.prepare();
      await b.prepare();
      expect(f.backend.savedKeys).toHaveLength(0);
      const logA = await a.run(),
        logB = await b.run();
      expect(executionCount(logA)).toBe(1);
      expect(executionCount(logB)).toBe(1);
      const sharedA = await f.units(a),
        sharedB = await f.units(b),
        common = [...sharedA.keys()].filter((k) => sharedB.has(k));
      expect(common).toHaveLength(1);
      const key = common[0]!;
      expect(sharedA.get(key)!.hashes.find(([p]) => p.endsWith('/metadata.bin'))).not.toEqual(
        sharedB.get(key)!.hashes.find(([p]) => p.endsWith('/metadata.bin')),
      );
      expect(sharedA.get(key)!.hashes.filter(([p]) => !p.endsWith('/metadata.bin'))).toEqual(
        sharedB.get(key)!.hashes.filter(([p]) => !p.endsWith('/metadata.bin')),
      );
      const cold = await f.job('reader-none');
      expect(executionCount(await cold.run())).toBe(1);
      const archivesOnly = await f.job('reader-build-cache');
      const buildCache = path.join(a.home, 'caches/build-cache-1');
      expect(
        (await readdir(buildCache)).filter((name) => /^[a-f0-9]{32}$/u.test(name)).length,
      ).toBeGreaterThan(0);
      await cp(buildCache, path.join(archivesOnly.home, 'caches/build-cache-1'), {
        recursive: true,
        filter: (p) => !p.endsWith('.lock'),
      });
      for (const relative of ['caches/9.8.1/transforms', 'caches/transforms-4'])
        await expect(lstat(path.join(archivesOnly.home, relative))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      const cacheOnlyLog = await archivesOnly.run();
      expect(cacheOnlyLog).toContain(':cacheControl FROM-CACHE');
      expect(executionCount(cacheOnlyLog)).toBe(cacheable ? 0 : 1);
      for (const [j, extra] of [
        [a, 'extra-a'],
        [b, 'extra-b'],
      ] as const)
        expect(executionCount(await j.run(true, extra))).toBe(1);
      const allA = await f.units(a),
        allB = await f.units(b),
        expected = new Map([...allB, ...allA]);
      expect(allA.size).toBe(2);
      expect(allB.size).toBe(2);
      expect(expected.size).toBe(3);
      await executeFinalizeAction(b.deps);
      await executeFinalizeAction(a.deps);
      const aggregator = await f.job('aggregate', 'distributed-aggregator', 'worker-b,worker-a');
      await aggregator.prepare();
      expect(await f.units(aggregator)).toEqual(expected);
      const captured = await snapshotGradleJob(aggregator);
      process.stdout.write(
        'TRANSFORM_FIXTURE_STATS ' +
          JSON.stringify({
            cacheable,
            layout: key.split('/').slice(0, -1).join('/'),
            workspaces: expected.size,
            files: captured.partitions.flatMap((p) => p.entries).length,
            bytes: captured.partitions
              .flatMap((p) => p.entries)
              .reduce((n, e) => n + e.identity.size, 0),
          }) +
          '\n',
      );
      await executeFinalizeAction(aggregator.deps);
      const reader = await f.job('reader-workspaces');
      await reader.prepare();
      expect(await f.units(reader)).toEqual(expected);
      for (const u of expected.values())
        for (const empty of u.workspace.emptyDirectories)
          expect((await lstat(path.join(reader.home, empty))).isDirectory()).toBe(true);
      await rm(path.join(reader.home, 'caches/build-cache-1'), { recursive: true, force: true });
      expect(executionCount(await reader.run(false))).toBe(0);
      if (process.env.BUILDISH_TEST_JAVA_25_HOME && key.startsWith('caches/9.')) {
        const otherJdk = await f.job('reader-java25');
        await otherJdk.prepare();
        expect(
          executionCount(await otherJdk.run(false, '', process.env.BUILDISH_TEST_JAVA_25_HOME)),
        ).toBe(0);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  600000,
);
test.skipIf(!enabled).each(['empty', 'none'])(
  'preserves real transform %s outputs without build-cache fallback',
  async (outputKind) => {
    const f = await harness(false, outputKind);
    try {
      const writer = await f.job('writer');
      await writer.prepare();
      expect(executionCount(await writer.run(false))).toBe(1);
      const expected = await f.units(writer);
      expect(expected.size).toBe(1);
      if (outputKind === 'none') {
        const unit = [...expected.values()][0]!.workspace;
        expect((await lstat(path.join(writer.home, unit.root, 'results.bin'))).size).toBe(0);
      }
      await executeFinalizeAction(writer.deps);
      const reader = await f.job('reader');
      await reader.prepare();
      expect(await f.units(reader)).toEqual(expected);
      expect(executionCount(await reader.run(false))).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  600000,
);
