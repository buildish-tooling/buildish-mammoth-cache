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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GradleBuildToolAdapter } from '../../src/build-tool/gradle/adapter';
import {
  normalizeGradleActionConfig,
  readGradleActionInputs,
} from '../../src/build-tool/gradle/config';
import { createCacheModel } from '../../src/cache/model';
import { cutoffFixtureCi } from './cutoff-fixture';
import { createTestRuntimeHost } from './github-test-runtime';

export async function groovyFixtureModel(root: string, overrides: object[] = []) {
  const disabled = [
    'modules',
    'dependency-metadata',
    'kotlin-dsl',
    'build-cache',
    'wrapper-dists',
  ].map((id) => ({ id, includes: [] }));
  const ci = cutoffFixtureCi(root);
  const config = normalizeGradleActionConfig(
    readGradleActionInputs(
      createTestRuntimeHost({
        inputs: {
          'cache-partitions': JSON.stringify([...disabled, ...overrides]),
        },
      }),
    ),
    { phase: 'prepare', ciContext: ci, env: { GRADLE_USER_HOME: root } },
  );
  return createCacheModel(config, ci, new GradleBuildToolAdapter(config));
}
export async function writeGroovyWorkspace(
  root: string,
  key = 'a'.repeat(32),
  content = 'compiled',
  empty = false,
) {
  const relative = `caches/9.8.1/groovy-dsl/${key}`;
  for (const name of ['classes/proj', 'instrumented/proj', 'metadata', 'reports'])
    await mkdir(path.join(root, relative, name), { recursive: true });
  for (const [name, bytes] of [
    ['metadata.bin', 'origin-' + content],
    ['metadata/metadata.bin', 'flags'],
    ...(!empty
      ? [
          ['classes/proj/Script.class', content],
          ['instrumented/proj/Script.class', content],
        ]
      : []),
  ])
    await writeFile(path.join(root, relative, name!), bytes!);
  return relative;
}
