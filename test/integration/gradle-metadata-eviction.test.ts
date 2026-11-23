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

import { afterEach, test, expect } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as glob from '@actions/glob';
import { streamingIntegrationJob } from '../support/streaming-integration';
import { nativeCacheBackend, cleanupBaseFixtures } from '../cache/streaming/native-cache-fixture';

afterEach(cleanupBaseFixtures);

// Supply an already installed executable. This check never installs/downloads a Gradle distribution.
const executable = process.env.BUILDISH_TEST_GRADLE_EXECUTABLE;
test.skipIf(!executable)(
  'retained real Gradle metadata safely re-resolves an evicted artifact',
  async () => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/gradle-metadata-eviction-'));
    const artifact = Buffer.from('known local dependency artifact bytes');
    let artifactRequests = 0;
    const server = createServer((request, response) => {
      const name = request.url ?? '';
      if (name === '/org/example/demo/1.0/demo-1.0.pom') {
        response.setHeader('Content-Type', 'application/xml');
        response.end(
          '<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>demo</artifactId><version>1.0</version></project>',
        );
      } else if (name === '/org/example/demo/1.0/demo-1.0.jar') {
        artifactRequests++;
        response.end(artifact);
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('loopback listener');
      const { backend: cache } = await nativeCacheBackend();
      const inputs = {
        'cache-partitions': JSON.stringify([
          { id: 'modules', includes: ['caches/modules-*/files-*/**'] },
          {
            id: 'dependency-metadata',
            includes: ['caches/modules-*/metadata-*/**'],
            excludes: ['**/gc.properties'],
            publication: 'single-writer',
          },
        ]),
      };
      const job = await streamingIntegrationJob({
        root: path.join(root, 'seed'),
        tool: 'gradle',
        installedGradle: executable,
        name: 'seed',
        inputs,
        cache,
      });
      await writeFile(
        path.join(job.workspace, 'settings.gradle'),
        "rootProject.name = 'metadata-eviction'\n",
      );
      await writeFile(
        path.join(job.workspace, 'build.gradle'),
        `
repositories { maven { url = uri('http://127.0.0.1:${address.port}'); allowInsecureProtocol = true } }
configurations { libraries }
dependencies { libraries 'org.example:demo:1.0' }
tasks.register('resolve') { doLast { println configurations.libraries.singleFile.text } }
`,
      );
      const run = async (job: Awaited<ReturnType<typeof streamingIntegrationJob>>) => {
        const result = await promisify(execFile)(
          executable!,
          ['--no-daemon', '--max-workers=2', 'resolve'],
          {
            cwd: job.workspace,
            env: { ...process.env, GRADLE_USER_HOME: job.home, GRADLE_OPTS: '', JAVA_OPTS: '' },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        expect(result.stdout).toContain(artifact.toString());
      };
      await job.prepare();
      await run(job);
      expect((await job.post()).outcome).toBe('published');
      const reader = await streamingIntegrationJob({
        root: path.join(root, 'reader'),
        tool: 'gradle',
        installedGradle: executable,
        name: 'reader',
        inputs: { ...inputs, 'read-only': 'true' },
        cache,
      });
      for (const file of ['settings.gradle', 'build.gradle'])
        await writeFile(
          path.join(reader.workspace, file),
          await readFile(path.join(job.workspace, file)),
        );
      await reader.prepare();
      expect(reader.outputs['base-cache-restore-status']).toBe('current-lineage-hit');
      expect(
        await (
          await glob.create(path.join(reader.home, 'caches/modules-2/metadata-*/**/*.bin'))
        ).glob(),
      ).not.toHaveLength(0);
      // Evict only the artifact while keeping the restored resolution indexes.
      await rm(path.join(reader.home, 'caches/modules-2/files-2.1'), {
        recursive: true,
        force: true,
      });
      const before = artifactRequests;
      await run(reader);
      expect(artifactRequests).toBeGreaterThan(before);
      const files = await (
        await glob.create(path.join(reader.home, 'caches/modules-2/files-2.1/**/*.jar'), {
          implicitDescendants: false,
          followSymbolicLinks: false,
        })
      ).glob();
      expect(files).toHaveLength(1);
      expect(await readFile(files[0]!)).toEqual(artifact);
      expect((await reader.post()).outcome).toBe('read-only');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
