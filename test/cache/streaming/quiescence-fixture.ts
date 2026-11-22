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

import {
  createGradleLifecycle,
  type GradleConsumerDependencies,
} from '../../../src/build-tool/gradle/lifecycle';
import { mavenLifecycle } from '../../../src/build-tool/maven/lifecycle';
import type { LifecycleResolver } from '../../../src/build-tool/lifecycle-types';
import { mkdir, writeFile } from 'node:fs/promises';
import { observationFixture } from './observation-fixtures';
import { registrationDirectory } from '../../../src/build-tool/gradle/registrations';
import { H, encodeRecord } from '../../../src/cache/streaming/encoding';
export async function quiescenceFixture(options: Parameters<typeof observationFixture>[1] = {}) {
  const f = await observationFixture('gradle', options);
  const state = f.store.codec.schemas.documents['local-state'].parse(await f.store.state());
  state[3]++;
  state[4] = 'build-ready';
  state[13] = null;
  await f.store.updateState(state);
  await f.store.makeParents(registrationDirectory(f.store) + '/placeholder');
  async function register(version: string) {
    const home = f.root + '/Gradle ' + version;
    await mkdir(home + '/bin', { recursive: true });
    await writeFile(
      home + '/bin/' + (process.platform === 'win32' ? 'gradle.bat' : 'gradle'),
      'fixture',
    );
    const row = f.store.codec.schemas.documents['gradle-installation'].parse([
      'gradle-installation',
      1,
      f.store.codec.options.invocation,
      home,
      version,
      f.root,
      f.root + '/java home',
    ]);
    const file = registrationDirectory(f.store) + '/' + H('gradle-installation', row) + '.json';
    await writeFile(f.store.root.resolve(file), encodeRecord(row));
    return row;
  }
  return { ...f, register };
}

/** Tool-owned dependencies exercise the real Gradle implementation through shared selection. */
export function gradleResolver(dependencies: GradleConsumerDependencies): LifecycleResolver {
  return async (tool) => (tool === 'gradle' ? createGradleLifecycle(dependencies) : mavenLifecycle);
}
