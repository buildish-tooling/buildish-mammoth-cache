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
import { composedFixture } from './composed-fixture';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { registrationDirectory } from '../../../src/build-tool/gradle/registrations';
import { H, encodeRecord } from '../../../src/cache/streaming/encoding';
export async function quiescenceFixture(options: Parameters<typeof composedFixture>[2] = {}) {
  const f = await composedFixture({}, undefined, options, 'gradle');
  const ready = await prepareStreaming({
    ...f.request,
    policy: {
      ...f.request.policy,
      role: f.store.codec.options.role,
      access: f.store.codec.options.access,
    },
  });
  f.store = ready.store;
  f.bindings = f.store.codec.schemas.documents.bindings.parse(
    await f.store.readDocument(
      f.store.codec.schemas.documents['local-state'].parse(await f.store.state())[5],
      'bindings',
    ),
  );
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
