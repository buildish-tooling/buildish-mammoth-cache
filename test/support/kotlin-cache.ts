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
import type { ImmutableWorkspace } from '../../src/cache/immutable-workspaces';

export function kotlinFixtureModel(root: string, overrides: object[] = []) {
  return groovyFixtureModel(
    root,
    [
      { id: 'groovy-dsl', includes: [] },
      {
        id: 'kotlin-dsl',
        includes: [
          'caches/*/kotlin-dsl/**',
          'caches/*/scripts/**',
          'caches/*/generated-gradle-jars/**',
        ],
      },
      ...overrides,
    ].filter(
      (p, i, all) =>
        !all.slice(i + 1).some((q) => (q as { id: string }).id === (p as { id: string }).id),
    ),
  );
}
export async function writeKotlinWorkspace(
  root: string,
  kind: Exclude<ImmutableWorkspace['kind'], 'groovy'> = 'kotlin-script',
  key = 'a'.repeat(32),
  content = 'compiled',
  empty = false,
) {
  const suffix =
    kind === 'kotlin-script'
      ? 'scripts/' + key
      : 'accessors/' + key + (kind === 'kotlin-plugin-spec-accessors' ? '-PS' : '');
  const relative = 'caches/9.8.1/kotlin-dsl/' + suffix;
  const directories =
    kind === 'kotlin-script'
      ? ['classes', 'instrumented/classes', 'reports/empty']
      : kind === 'kotlin-plugin-spec-accessors' || kind === 'kotlin-accessor-directories'
        ? ['classes', 'sources']
        : [];
  await mkdir(path.join(root, relative), { recursive: true });
  for (const name of directories) await mkdir(path.join(root, relative, name), { recursive: true });
  const files = [
    ['metadata.bin', 'origin-' + content],
    ...(kind === 'kotlin-accessor-jars'
      ? [
          ['classes.jar', content],
          ['sources.jar', 'source-' + content],
        ]
      : !empty
        ? [['classes/Program.class', content]]
        : []),
  ];
  for (const [name, bytes] of files) await writeFile(path.join(root, relative, name!), bytes!);
  return relative;
}
