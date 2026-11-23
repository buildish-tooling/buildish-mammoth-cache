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
import { createHash } from 'node:crypto';
import { glob, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const dependencies = new Map([
  ['standalone', ['org.apache.commons', 'commons-lang3', '3.20.0']],
  ['worker_a', ['com.google.guava', 'guava', '33.6.0-jre']],
  ['worker_b', ['commons-io', 'commons-io', '2.22.0']],
  ['worker_c', ['org.apache.commons', 'commons-collections4', '4.5.0']],
]);

export async function assertDependency(tool, home, fixture, { central = false } = {}) {
  const [group, artifact, version] = dependencies.get(fixture);
  const jar = `${artifact}-${version}.jar`;
  if (tool === 'gradle') {
    const location = `caches/modules-2/files-2.1/${group}/${artifact}/${version}/*/${jar}`;
    for await (const file of glob(location, { cwd: home })) {
      assert((await stat(path.join(home, file))).size > 0, `Empty dependency: ${jar}`);
      return;
    }
    assert.fail(`Gradle dependency absent: ${jar}`);
  }
  assert.equal(tool, 'maven');
  const directory = path.join(home, 'repository', ...group.split('.'), artifact, version);
  assert((await stat(path.join(directory, jar))).size > 0, `Empty dependency: ${jar}`);
  if (central) {
    // Maven 3.10's Resolver qualifies origin keys with the configured repository URL.
    const origin =
      'central-' + createHash('sha1').update('https://repo.maven.apache.org/maven2').digest('hex');
    assert(
      (await readFile(path.join(directory, '_remote.repositories'), 'utf8'))
        .split(/\r?\n/u)
        .includes(jar + '>' + origin + '='),
      `Expected Central origin marker for ${directory}/${jar}`,
    );
  }
}
