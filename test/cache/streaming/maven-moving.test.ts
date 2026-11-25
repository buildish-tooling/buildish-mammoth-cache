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

import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { metadataFixture, h, type MetadataFixture } from './base-publication-fixtures';
import { resolveModel, lineageId } from '../../../src/cache/streaming/model';
import { MetadataPublicationSource } from '../../../src/cache/streaming/metadata-publication-source';
import { publishMetadataBase } from '../../../src/cache/streaming/metadata-publication';
import { MetadataBaseRestore } from '../../../src/cache/streaming/metadata-base-restore';
import { sameNative } from '../../../src/cache/streaming/native';
const fixtures: MetadataFixture[] = [],
  sources: MetadataPublicationSource[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const source of sources.splice(0)) {
    await source.dispose();
  }
  for (const f of fixtures.splice(0)) {
    expect(f.budget.retained).toBe(0);
    await f.close();
  }
});
it.each(['clean', 'excluded', 'mixed-aggregate', 'mixed-snapshot'] as const)(
  'publishes and restores exact native Maven %s ownership without changing original files',
  async (kind) => {
    const hard = ['.mammoth/**', '**/*.lock'],
      mixed = kind.startsWith('mixed'),
      parts: unknown[][] = [
        [
          'data',
          ['repository/**'],
          mixed ? [...hard, 'repository/other/**'] : hard,
          'aggregate',
          null,
          'default',
          0,
        ],
      ];
    if (mixed) {
      parts.push([
        'other',
        ['repository/other/**'],
        hard,
        kind === 'mixed-snapshot' ? 'single-writer' : 'aggregate',
        kind === 'mixed-snapshot' ? 'B' : null,
        'default',
        0,
      ]);
    }
    const model = resolveModel(['model', 1, 'maven', hard, parts], 'maven-native-', 1),
      f = await metadataFixture(model);
    fixtures.push(f);
    const files: Record<string, string> = {
      'repository/org/a/1/a.jar': 'a',
      'repository/org/b/1/b.jar': 'b',
    };
    if (kind === 'excluded') {
      files['repository/keep.lock'] = 'private';
    }
    if (mixed) {
      files['repository/other/c/1/c.jar'] = 'c';
    }
    await f.files(f.root, files);
    const original = new Map(
        await Promise.all(
          Object.keys(files).map(async (p) => [p, (await f.store.root.stat(p))!] as const),
        ),
      ),
      source = await MetadataPublicationSource.capture(f.store, '', { budget: f.budget });
    sources.push(source);
    const rename = vi.spyOn(f.store.root, 'renameAbsent'),
      result = await publishMetadataBase(source, f.api, {
        lineage: lineageId('refs/heads/main'),
        writer: h,
        decision: h,
      });
    expect(result.outcome).toBe('published');
    if (kind === 'clean') {
      expect(rename).toHaveBeenCalledTimes(2);
      expect(rename.mock.calls[0][0]).toBe('repository');
      expect(rename.mock.calls[1][1]).toBe('repository');
    }
    for (const [p, body] of Object.entries(files)) {
      expect(await readFile(f.root + '/' + p, 'utf8')).toBe(body);
      expect(sameNative(original.get(p)!, (await f.store.root.stat(p))!, true)).toBe(true);
    }
    expect(f.store.root.work.bodyHashBytes).toBe(0);
    await source.dispose();
    const restored = await MetadataBaseRestore.acquire(
      f.store,
      f.api,
      { currentRef: 'refs/heads/main' },
      { budget: f.budget },
    );
    try {
      expect(restored.entries.every((e) => e[2] === 'available')).toBe(true);
      for (const input of restored.context!.take()) {
        const body =
          input.partition === 'data' ? 'repository/org/a/1/a.jar' : 'repository/other/c/1/c.jar';
        expect(await readFile(f.store.root.resolve(input.nativeRoot + '/' + body), 'utf8')).toBe(
          files[body],
        );
        if (kind === 'excluded') {
          expect(await f.store.root.stat(input.nativeRoot + '/repository/keep.lock')).toBeNull();
        }
      }
    } finally {
      await restored.dispose();
    }
  },
);
