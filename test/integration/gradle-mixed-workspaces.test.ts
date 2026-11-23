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
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { cleanupBaseFixtures } from '../cache/streaming/native-cache-fixture';
import { mixedProbeTasks, mixedWorkspaceJobs } from '../support/gradle-workspace-jobs';

afterEach(cleanupBaseFixtures);

const enabled =
  !!process.env.BUILDISH_TEST_GRADLE_EXECUTABLE &&
  !!process.env.BUILDISH_TEST_JAVA_21_HOME &&
  !!process.env.BUILDISH_TEST_JAVA_25_HOME;
type Fixture = Awaited<ReturnType<typeof mixedWorkspaceJobs>>;
type Job = Awaited<ReturnType<Fixture['job']>>;
type Evidence = Awaited<ReturnType<Job['evidence']>>;
function kotlinTaskKey(log: string) {
  const key = /Build cache key for task ':kotlin:probe' is ([a-f0-9]{32})/u.exec(log)?.[1];
  assert(key, 'Expected Kotlin task cache key');
  return 'caches/build-cache-1/' + key;
}
function transformLines(log: string, kind?: string) {
  return log
    .split('\n')
    .filter((line) => line.startsWith('TRANSFORM_EXECUTED ') && (!kind || line.includes(kind)));
}
async function noCompilation(job: Job, label: string) {
  const log = await job.run(label, { cache: 'disabled' });
  expect(transformLines(log)).toEqual([]);
  expect(log).not.toContain('Kotlin DSL script compilation');
  expect(log).not.toContain('Kotlin DSL accessors for');
  // Writable streaming jobs add capture hooks. Only the fixture's capture scripts may compile.
  const capture = [
    'buildish-mammoth-cache.build-result-capture.init.gradle',
    'buildish-mammoth-cache.build-result-capture-service.plugin.groovy',
  ].map((file) => "'" + path.join(job.home, 'init.d', file).replaceAll('\\', '/') + "'");
  expect(
    log
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('Compiling ') &&
          !capture.some((file) => line.replaceAll('\\', '/').includes(file)),
      ),
  ).toEqual([]);
  return log;
}
async function output(j: Job) {
  expect(await readFile(path.join(j.root, 'kotlin/build/probe.txt'), 'utf8')).toBe('same output');
  expect(await readFile(path.join(j.root, 'extra/build/probe.txt'), 'utf8')).toBe(
    'extra-' + j.variant,
  );
}
function union(...evidence: Evidence[]) {
  return {
    units: new Map(evidence.flatMap((e) => [...e.units])),
    archives: new Map(evidence.flatMap((e) => [...e.archives])),
  };
}
async function restored(j: Job, expected: ReturnType<typeof union>) {
  const actual = await j.evidence();
  expect(actual.units).toEqual(expected.units);
  expect(actual.archives).toEqual(expected.archives);
  for (const unit of expected.units.values())
    for (const empty of unit.workspace.emptyDirectories)
      expect((await lstat(path.join(j.home, empty))).isDirectory()).toBe(true);
}
async function published(j: Job, original: ReturnType<typeof union>) {
  expect((await j.post()).outcome).toBe('published');
  const actual = await j.evidence();
  for (const [key, value] of original.units) expect(actual.units.get(key)).toEqual(value);
  for (const [key, value] of original.archives) expect(actual.archives.get(key)).toEqual(value);
  return actual;
}
function distinctCommonOrigins(a: Evidence, b: Evidence, kind: 'groovy' | 'kotlin-script') {
  const common = [...a.units].filter(
    ([key, unit]) => unit.workspace.kind === kind && b.units.has(key),
  );
  expect(common.length, 'real common ' + kind + ' roots').toBeGreaterThan(0);
  const metadata = (unit: Evidence['units'] extends Map<string, infer T> ? T : never) =>
    unit.hashes.find(([name]) => name === unit.workspace.root + '/metadata.bin')?.[1];
  expect(common.some(([key, unit]) => metadata(unit) !== metadata(b.units.get(key)!))).toBe(true);
}

test.skipIf(!enabled)(
  'reuses real mixed Groovy/Kotlin workspaces, task archives and Java inputs through cold and seeded workers',
  async () => {
    const f = await mixedWorkspaceJobs();
    let passed = false;
    try {
      const a = await f.job('worker-a', { jdk: '21', mode: 'distributed-worker' });
      const b = await f.job('worker-b', { jdk: '21', variant: 'B', mode: 'distributed-worker' });
      const c = await f.job('worker-c', { jdk: '25', mode: 'distributed-worker' });
      for (const j of [a, b, c]) {
        await j.prepare();
        expect((await j.evidence()).units.size).toBe(0);
      }
      expect(f.backend.objects.size).toBe(0);
      const logA = await a.run('cold-a21', {
        cache: 'enabled',
        tasks: [...mixedProbeTasks, 'compileJava'],
      });
      const logB = await b.run('cold-b21', { cache: 'enabled' });
      const logC = await c.run('cold-c25-groovy', { cache: 'enabled', tasks: ['groovyProbe'] });
      for (const log of [logA, logB]) {
        expect(log).toContain('Kotlin DSL script compilation');
        expect(log).toContain('Kotlin DSL accessors for');
        expect(log).toContain('KOTLIN_PROBE_EXECUTED');
        expect(log).not.toContain(':kotlin:probe FROM-CACHE');
        expect(log.split('\n').some((line) => line.startsWith('Compiling '))).toBe(true);
      }
      expect(logC).toContain('GROOVY_PROBE_EXECUTED');
      expect(logC).not.toContain('> Task :compileJava');
      expect(logC).not.toContain('> Task :kotlin:probe');
      await expect(
        lstat(path.join(c.root, 'build/classes/java/main/Example.class')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const classMajor = async (j: Job) =>
        (await readFile(path.join(j.root, 'build/classes/java/main/Example.class'))).readUInt16BE(
          6,
        );
      expect(await classMajor(a)).toBe(65);
      const ea = await a.evidence(),
        eb = await b.evidence(),
        ec = await c.evidence();
      const kinds = new Set([...ea.units.values()].map((u) => u.workspace.kind));
      for (const kind of [
        'groovy',
        'artifact-transform',
        'kotlin-script',
        'kotlin-plugin-spec-accessors',
      ] as const)
        expect(kinds.has(kind), kind).toBe(true);
      // Gradle distributions produce either directory- or JAR-form accessors.
      expect(kinds.has('kotlin-accessor-jars') || kinds.has('kotlin-accessor-directories')).toBe(
        true,
      );
      for (const log of [logA, logB]) {
        expect(transformLines(log, 'files CacheableExpandJar')).toHaveLength(2);
        expect(transformLines(log, 'files NonCacheableExpandJar')).toHaveLength(2);
        expect(transformLines(log, 'empty NonCacheableExpandJar')).toHaveLength(1);
        expect(transformLines(log, 'none NonCacheableExpandJar')).toHaveLength(1);
      }
      const commonTransforms = [...ea.units].filter(
        ([key, u]) => u.workspace.kind === 'artifact-transform' && eb.units.has(key),
      );
      expect(commonTransforms).toHaveLength(4);
      for (const [key, unit] of commonTransforms) {
        const other = eb.units.get(key)!;
        expect(unit.hashes.find(([p]) => p === key + '/metadata.bin')).not.toEqual(
          other.hashes.find(([p]) => p === key + '/metadata.bin'),
        );
        expect(unit.hashes.filter(([p]) => p !== key + '/metadata.bin')).toEqual(
          other.hashes.filter(([p]) => p !== key + '/metadata.bin'),
        );
      }
      const sizes = ea.sizes;
      expect(commonTransforms.some(([key]) => sizes.get(key + '/results.bin') === 0)).toBe(true);
      expect(
        commonTransforms.some(([, u]) =>
          u.workspace.emptyDirectories.includes(u.workspace.root + '/transformed/expanded'),
        ),
      ).toBe(true);
      for (const [left, right] of [
        [ea, eb],
        [eb, ea],
      ])
        expect(
          [...left.units].filter(
            ([key, u]) => u.workspace.kind === 'artifact-transform' && !right.units.has(key),
          ),
        ).toHaveLength(2);
      distinctCommonOrigins(ea, eb, 'kotlin-script');
      distinctCommonOrigins(ea, ec, 'groovy');
      expect([...ea.units.keys()].some((k) => k.includes('/accessors/') && eb.units.has(k))).toBe(
        true,
      );
      expect(kotlinTaskKey(logA)).toBe(kotlinTaskKey(logB));
      expect(ea.archives.get(kotlinTaskKey(logA))).toBeDefined();
      expect(eb.archives.get(kotlinTaskKey(logB))).toBeDefined();
      expect(ea.archives.get(kotlinTaskKey(logA))).not.toBe(eb.archives.get(kotlinTaskKey(logB)));
      for (const [left, right] of [
        [ea, eb],
        [eb, ea],
      ]) {
        expect([...left.units.keys()].some((k) => !right.units.has(k))).toBe(true);
        expect([...left.archives.keys()].some((k) => !right.archives.has(k))).toBe(true);
      }
      for (const j of [c, b, a]) expect((await j.post()).outcome).toBe('worker-uploaded');
      const expected = union(ec, eb, ea);
      const aggregate = await f.job('aggregate', {
        jdk: '21',
        mode: 'distributed-aggregator',
        dependencies: 'worker-c,worker-b,worker-a',
      });
      await aggregate.prepare();
      expect(aggregate.warnings.join('\n')).toContain('Worker merge selected winners');
      expect(aggregate.outputs['dependent-delta-artifact-count']).toBe('3');
      await restored(aggregate, expected);
      await noCompilation(aggregate, 'aggregate21-direct');
      // Capture hook compilation can contribute additional local workspaces.
      const publishedBase = await published(aggregate, expected);
      for (const jdk of ['21', '25'] as const) {
        const direct = await f.job('direct-' + jdk, { jdk, readOnly: true });
        expect((await direct.prepare()).restoreStatus).toBe('current-lineage-hit');
        await restored(direct, publishedBase);
        await rm(path.join(direct.home, 'caches/build-cache-1'), { recursive: true, force: true });
        const log = await noCompilation(direct, 'direct' + jdk);
        expect(log).toContain('GROOVY_PROBE_EXECUTED');
        expect(log).toContain('KOTLIN_PROBE_EXECUTED');
        await output(direct);
        expect((await direct.post()).outcome).toBe('read-only');
      }
      const cached = await f.job('task-reader21', { jdk: '21', readOnly: true });
      await cached.prepare();
      await restored(cached, publishedBase);
      const layouts = new Set(
        [...expected.units.values()]
          .filter((u) => u.workspace.kind === 'artifact-transform')
          .map((u) => path.posix.dirname(u.workspace.root)),
      );
      for (const layout of layouts) {
        await rm(path.join(cached.home, layout), { recursive: true, force: true });
        await expect(lstat(path.join(cached.home, layout))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      const archiveOnlyLog = await cached.run('task-cache21', { cache: 'enabled' });
      expect(archiveOnlyLog).toContain(':kotlin:probe FROM-CACHE');
      expect(archiveOnlyLog).toContain(':transform-noncacheable:cacheControl FROM-CACHE');
      expect(transformLines(archiveOnlyLog, 'files CacheableExpandJar')).toHaveLength(0);
      expect(transformLines(archiveOnlyLog, 'files NonCacheableExpandJar')).toHaveLength(2);
      expect(transformLines(archiveOnlyLog, 'empty NonCacheableExpandJar')).toHaveLength(1);
      expect(transformLines(archiveOnlyLog, 'none NonCacheableExpandJar')).toHaveLength(1);
      await output(cached);
      expect((await cached.post()).outcome).toBe('read-only');
      const inputs = await f.job('input-reader25', { jdk: '25', readOnly: true });
      await inputs.prepare();
      const java25 = await inputs.run('compiler25-miss', {
        cache: 'enabled',
        tasks: [...mixedProbeTasks, 'compileJava'],
      });
      expect(java25).not.toContain(':compileJava FROM-CACHE');
      expect(await classMajor(inputs)).toBe(69);
      for (const task of [':portable', ':strict']) expect(java25).toContain(task + ' FROM-CACHE');
      await rm(path.join(inputs.root, 'build'), { recursive: true });
      const java21 = await inputs.run('compiler21-hit-changed-input', {
        cache: 'enabled',
        tasks: [...mixedProbeTasks, 'compileJava'],
        args: ['-PcompilerJava=21', '-PstrictIdentity=b'],
      });
      expect(java21).toContain(':compileJava FROM-CACHE');
      expect(java21).toContain(':portable FROM-CACHE');
      expect(java21).not.toContain(':strict FROM-CACHE');
      expect(await classMajor(inputs)).toBe(65);
      expect(await readFile(path.join(inputs.root, 'build/strict.txt'), 'utf8')).toBe('b');
      expect((await inputs.post()).outcome).toBe('read-only');
      const seedA = await f.job('seeded-a', {
        jdk: '21',
        variant: 'C',
        mode: 'distributed-worker',
      });
      const seedB = await f.job('seeded-b', {
        jdk: '25',
        variant: 'D',
        mode: 'distributed-worker',
      });
      for (const j of [seedA, seedB]) {
        expect((await j.prepare()).restoreStatus).toBe('current-lineage-hit');
        await restored(j, publishedBase);
      }
      const seedEvidence = [];
      for (const j of [seedA, seedB]) {
        const log = await j.run(j === seedA ? 'seeded-a21' : 'seeded-b25', { cache: 'enabled' });
        expect(log.split('\n').some((line) => line.startsWith('Compiling '))).toBe(true);
        expect(log).toContain('GROOVY_VARIANT_' + j.variant);
        const e = await j.evidence();
        expect([...e.units.keys()].some((k) => !publishedBase.units.has(k))).toBe(true);
        seedEvidence.push(e);
        expect((await j.post()).outcome).toBe('worker-uploaded');
      }
      const seededExpected = union(seedEvidence[1]!, seedEvidence[0]!);
      const merged = await f.job('seeded-aggregate', {
        jdk: '21',
        variant: 'C',
        mode: 'distributed-aggregator',
        dependencies: 'seeded-b,seeded-a',
      });
      await merged.prepare();
      await restored(merged, seededExpected);
      await noCompilation(merged, 'seeded-aggregate21');
      const publishedMerged = await published(merged, seededExpected);
      const consumer = await f.job('seeded-reader25', { jdk: '25', variant: 'D', readOnly: true });
      await consumer.prepare();
      await restored(consumer, publishedMerged);
      await noCompilation(consumer, 'seeded-reader25');
      await output(consumer);
      expect((await consumer.post()).outcome).toBe('read-only');
      const saves = f.backend.calls.filter((call) => call.kind === 'save');
      expect(saves.some((call) => call.key.includes('-g-'))).toBe(true);
      expect(saves.some((call) => call.key.includes('-p-'))).toBe(true);
      for (const save of saves)
        expect(save.paths).toEqual(
          save.key.includes('-p-') ? ['envelope.json', 'payload/'] : ['record.json'],
        );
      await writeFile(
        path.join(f.root, 'invocations.json'),
        JSON.stringify(f.invocations, null, 2) + '\n',
      );
      console.log('Mixed fixture Gradle invocations:', f.invocations.length);
      passed = true;
    } finally {
      if (passed && process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT !== '1')
        await rm(f.root, { recursive: true, force: true });
      else console.log('Mixed fixture evidence retained:', f.root);
    }
  },
  600_000,
);
