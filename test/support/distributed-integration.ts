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
import { cp, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, vi } from 'vitest';
import { nativeCacheBackend, cleanupBaseFixtures } from '../cache/streaming/native-cache-fixture';
import { memoryArtifacts } from '../cache/streaming/memory-artifact-fixture';
import { gradleExecutable } from './gradle-executable';
import { streamingIntegrationJob } from './streaming-integration';

const exec = promisify(execFile);
export async function distributedReuse(tool: 'gradle' | 'maven') {
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/integration-' + tool + '-reuse-'));
  let passed = false;
  try {
    const { backend: cache, calls } = await nativeCacheBackend();
    const artifacts = memoryArtifacts();
    const fixture = path.resolve('test/fixtures/integration', tool + '-project');
    async function job(
      name: string,
      mode: string,
      readOnly = false,
      inputs: Record<string, string> = {},
      now?: () => number,
    ) {
      const rootDirectory = path.join(root, name);
      const result = await streamingIntegrationJob({
        root: rootDirectory,
        tool,
        installedGradle: process.env.BUILDISH_TEST_GRADLE_EXECUTABLE,
        name,
        cache,
        artifacts: artifacts.api,
        now,
        inputs: {
          'job-mode': mode,
          'read-only': String(readOnly),
          'dependent-jobs': mode === 'distributed-aggregator' ? 'worker-a,worker-b' : '',
          'cache-key-prefix': 'local-integration-',
          'cache-partitions': JSON.stringify([
            ...(tool === 'gradle'
              ? [{ id: 'dependency-metadata', writer: 'worker-a' }]
              : [{ id: 'repository', 'conflict-handling': 'choose-worker-directory' }]),
            { id: 'proof', includes: ['proof/**'] },
          ]),
          ...inputs,
        },
      });
      await cp(fixture, result.workspace, { recursive: true });
      const settings = path.join(rootDirectory, 'settings.xml');
      await writeFile(settings, '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n');
      async function build(profiles: 'a' | 'b' | 'both', offline: boolean) {
        const selected = profiles === 'both' ? ['a', 'b'] : [profiles];
        const args =
          tool === 'gradle'
            ? [
                '--no-daemon',
                '--max-workers=2',
                '--console=plain',
                '--info',
                ...(offline ? ['--offline'] : []),
                ...selected.map((p) => 'resolveWorker' + p.toUpperCase()),
              ]
            : [
                '--batch-mode',
                '--no-transfer-progress',
                '--settings',
                settings,
                '--global-settings',
                settings,
                '-Dmaven.repo.local=' + path.join(result.home, 'repository'),
                ...(offline ? ['--offline'] : []),
                '-P',
                selected.map((p) => 'worker-' + p).join(','),
                'dependency:resolve',
              ];
        try {
          const { stdout, stderr } = await exec(
            tool === 'gradle' ? gradleExecutable() : 'mvn',
            args,
            {
              cwd: result.workspace,
              env: { ...result.env, MAVEN_ARGS: '', MAVEN_OPTS: '-Duser.home=' + rootDirectory },
              timeout: 150_000,
              maxBuffer: 8 * 1024 * 1024,
            },
          );
          await writeFile(path.join(rootDirectory, 'build.log'), stdout + stderr);
          return stdout;
        } catch (error) {
          const logs = error as { stdout?: string; stderr?: string };
          await writeFile(
            path.join(rootDirectory, 'build.log'),
            (logs.stdout ?? '') + (logs.stderr ?? ''),
          );
          throw error;
        }
      }
      return { ...result, build };
    }
    for (const name of ['a', 'b'] as const) {
      const worker = await job('worker-' + name, 'distributed-worker');
      await worker.prepare();
      // A supplies Gradle's complete metadata snapshot. B proves an independent upload.
      await worker.build(tool === 'gradle' && name === 'a' ? 'both' : name, false);
      await mkdir(path.join(worker.home, 'proof'));
      const file = path.join(worker.home, 'proof', name);
      await writeFile(file, name);
      expect((await worker.post()).outcome).toBe('worker-uploaded');
      expect(await readFile(file, 'utf8')).toBe(name);
    }
    expect(artifacts.objects.size).toBe(2);
    const parent = await job('aggregator', 'distributed-aggregator');
    await parent.prepare();
    expect(parent.outputs['dependent-delta-artifact-count']).toBe('2');
    async function verify(result: Awaited<ReturnType<typeof job>>) {
      for (const name of ['a', 'b']) {
        expect(await readFile(path.join(result.home, 'proof', name), 'utf8')).toBe(name);
      }
    }
    async function resolveBoth(result: Awaited<ReturnType<typeof job>>) {
      const output = await result.build('both', true);
      if (tool === 'gradle') {
        expect(output).toMatch(/resolved workerA: guava-33\.6\.0-jre\.jar/u);
        expect(output).toMatch(/resolved workerB: commons-io-2\.22\.0\.jar/u);
        expect(output).not.toMatch(/(?:Downloading|Downloaded).*\.jar/u);
      } else {
        expect(output).toMatch(/com\.google\.guava:guava:jar:33\.6\.0-jre/u);
        expect(output).toMatch(/commons-io:commons-io:jar:2\.22\.0/u);
      }
    }
    await verify(parent);
    await resolveBoth(parent);
    expect((await parent.post()).outcome).toBe('published');
    await verify(parent);
    expect(artifacts.api.deleteArtifact).not.toHaveBeenCalled();
    expect(artifacts.objects.size).toBe(2);
    const timestampGc = { 'cache-gc-mode': 'timestamp' };
    const afterGrace = Date.now() + 4 * 86400000 + 60 * 60 * 1000;
    let sweptKey: string | undefined;
    if (tool === 'maven') {
      const bootstrap = await job('initial-sweep', 'standalone', false, timestampGc);
      await bootstrap.prepare();
      expect(bootstrap.outputs['dependency-gc-due']).toBe('true');
      expect((await bootstrap.post()).outcome).toBe('published');

      const planner = await job('planner', 'prepare-only', true, timestampGc, () => afterGrace);
      calls.length = 0;
      expect(await planner.prepare()).toEqual({ outcome: 'generation-checked' });
      expect(planner.outputs).toEqual({ 'dependency-gc-due': 'true' });
      expect(calls.filter(({ kind }) => kind === 'restore').map(({ paths }) => paths)).toEqual([
        ['record.json'],
      ]);
      expect((await planner.post()).outcome).toBe('skipped');

      // Workers were gated off. The aggregator performs its own lookup after the force deadline.
      const forced = await job(
        'forced-sweep',
        'distributed-aggregator',
        false,
        { ...timestampGc, 'dependent-jobs': '' },
        () => afterGrace,
      );
      await forced.prepare();
      expect(forced.outputs['dependency-gc-due']).toBe('true');
      expect(forced.outputs['dependent-delta-artifact-count']).toBe('0');
      calls.length = 0;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(afterGrace);
      const result = await forced.post().finally(() => clock.mockRestore());
      if (result.outcome !== 'published' || !result.key) {
        throw new Error('Expected the forced sweep to publish a generation.');
      }
      sweptKey = result.key;
      expect(sweptKey).not.toBe(forced.outputs['restored-cache-key']);
      expect(calls.filter(({ kind }) => kind === 'save').map(({ paths }) => paths)).toEqual([
        ['record.json'],
      ]);
    }
    const reader = await job(
      'reader',
      'standalone',
      true,
      sweptKey ? timestampGc : {},
      sweptKey ? () => afterGrace + 1000 : undefined,
    );
    await reader.prepare();
    expect(reader.outputs['base-cache-restore-status']).toBe('current-lineage-hit');
    if (sweptKey) {
      expect(reader.outputs['restored-cache-key']).toBe(sweptKey);
      expect(reader.outputs['dependency-gc-due']).toBe('false');
    }
    await verify(reader);
    await resolveBoth(reader);
    expect((await reader.post()).outcome).toBe('read-only');
    passed = true;
  } finally {
    await cleanupBaseFixtures();
    if (passed && process.env.BUILDISH_MAMMOTH_CACHE_KEEP_LOCAL_IT !== '1') {
      await rm(root, { recursive: true, force: true });
    } else {
      console.log('Distributed fixture retained:', root);
    }
  }
}
