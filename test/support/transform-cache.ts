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
import { groovyFixtureModel } from './groovy-cache';

export function transformFixtureModel(root: string, overrides: object[] = []) {
  return groovyFixtureModel(
    root,
    [
      { id: 'groovy-dsl', includes: [] },
      { id: 'transforms-metadata', includes: ['caches/transforms-*/**', 'caches/*/transforms/**'] },
      ...overrides,
    ].filter(
      (p, i, all) =>
        !all.slice(i + 1).some((q) => (q as { id: string }).id === (p as { id: string }).id),
    ),
  );
}
export async function writeTransformWorkspace(
  home: string,
  layout = '9.8.1/transforms',
  key = 'a'.repeat(32),
  content = 'compiled',
  empty = false,
) {
  const root = 'caches/' + layout + '/' + key;
  await mkdir(path.join(home, root, 'transformed/empty'), { recursive: true });
  for (const [name, bytes] of [
    ['metadata.bin', 'origin-' + content],
    ['results.bin', empty ? '' : 'o/output.txt\n'],
    ...(!empty
      ? [
          ['transformed/output.txt', content],
          ['transformed/nested/gc.properties', 'real-output'],
        ]
      : []),
  ]) {
    await mkdir(path.dirname(path.join(home, root, name!)), { recursive: true });
    await writeFile(path.join(home, root, name!), bytes!);
  }
  return root;
}
