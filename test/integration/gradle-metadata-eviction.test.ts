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
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as glob from '@actions/glob';
import { cutoffJob } from '../support/cutoff-job';
import { executeFinalizeAction } from '../../src/phases/finalize/flow';
import {
  readPartitionSnapshot,
  restorePartitionSnapshot,
} from '../../src/cache/partition-snapshots';

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
      const job = await cutoffJob(path.join(root, 'job'), {
        inputs: {
          'cache-partitions': JSON.stringify([
            { id: 'data', includes: [] },
            { id: 'modules', includes: ['caches/modules-*/files-*/**'] },
            {
              id: 'metadata',
              includes: ['caches/modules-*/metadata-*/**'],
              excludes: ['**/gc.properties'],
              publication: 'single-writer',
            },
          ]),
        },
      });
      await writeFile(
        path.join(job.root, 'settings.gradle'),
        "rootProject.name = 'metadata-eviction'\n",
      );
      await writeFile(
        path.join(job.root, 'build.gradle'),
        `
repositories { maven { url = uri('http://127.0.0.1:${address.port}'); allowInsecureProtocol = true } }
configurations { libraries }
dependencies { libraries 'org.example:demo:1.0' }
tasks.register('resolve') { doLast { println configurations.libraries.singleFile.text } }
`,
      );
      const run = async () => {
        const result = await promisify(execFile)(
          executable!,
          ['--no-daemon', '--max-workers=2', 'resolve'],
          {
            cwd: job.root,
            env: { ...process.env, GRADLE_USER_HOME: job.home, GRADLE_OPTS: '', JAVA_OPTS: '' },
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        expect(result.stdout).toContain(artifact.toString());
      };
      const prepared = await job.prepare();
      await run();
      await executeFinalizeAction(job.deps);
      const model = prepared.bootstrap.cacheModel!;
      const snapshot = await readPartitionSnapshot(model, 'metadata');
      expect(snapshot!.manifest.files.some((e) => e.relativePath.endsWith('.bin'))).toBe(true);
      // Model ordinary artifact eviction while keeping the actual captured resolution indexes.
      await rm(path.join(job.home, 'caches/modules-2/files-2.1'), { recursive: true, force: true });
      await restorePartitionSnapshot(model, snapshot!);
      const before = artifactRequests;
      await run();
      expect(artifactRequests).toBeGreaterThan(before);
      const files = await (
        await glob.create(path.join(job.home, 'caches/modules-2/files-2.1/**/*.jar'), {
          implicitDescendants: false,
          followSymbolicLinks: false,
        })
      ).glob();
      expect(files).toHaveLength(1);
      expect(await readFile(files[0]!)).toEqual(artifact);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
