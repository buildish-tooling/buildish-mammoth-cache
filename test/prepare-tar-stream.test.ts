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

import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { patchedTarRoot, upstreamPackagePath } from '../scripts/prepare-tar-stream.mjs';

it('attributes generated patched sources to their pinned upstream package', async () => {
  const result = await build({
    entryPoints: [path.join(patchedTarRoot, 'index.js')],
    bundle: true,
    platform: 'node',
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile!.inputs).map(upstreamPackagePath);
  expect(inputs).toContain('node_modules/tar-stream/extract.js');
  expect(inputs).toContain('node_modules/tar-stream/mammoth.cjs');
  expect(upstreamPackagePath('build\\patched-tar-stream\\headers.js')).toBe(
    'node_modules/tar-stream/headers.js',
  );
  expect(upstreamPackagePath('node_modules/streamx/index.js')).toBe(
    'node_modules/streamx/index.js',
  );
});
describe('reproducible isolated patch preparation', () => {
  it('works without a git checkout, repairs generated output and rejects changed upstream', async () => {
    await mkdir('build', { recursive: true });
    const root = await mkdtemp(path.resolve('build/tar-preparation-'));
    try {
      await mkdir(path.join(root, 'scripts'));
      await copyFile(
        'scripts/prepare-tar-stream.mjs',
        path.join(root, 'scripts/prepare-tar-stream.mjs'),
      );
      await mkdir(path.join(root, 'patches'), { recursive: true });
      await cp('patches/tar-stream', path.join(root, 'patches/tar-stream'), { recursive: true });
      await mkdir(path.join(root, 'node_modules'), { recursive: true });
      await cp('node_modules/tar-stream', path.join(root, 'node_modules/tar-stream'), {
        recursive: true,
      });
      const prepare = () =>
        execFileSync(process.execPath, ['scripts/prepare-tar-stream.mjs'], {
          cwd: root,
          stdio: 'pipe',
        });
      prepare();
      const generated = path.join(root, patchedTarRoot, 'extract.js');
      const expected = await readFile(generated, 'utf8');
      expect(expected).toContain('opts.mammothStrict === true');
      expect(await readFile(path.join(root, patchedTarRoot, 'LICENSE'))).toEqual(
        await readFile('node_modules/tar-stream/LICENSE'),
      );
      prepare();
      expect(await readFile(generated, 'utf8')).toBe(expected);
      await writeFile(generated, 'corrupted generated output');
      prepare();
      expect(await readFile(generated, 'utf8')).toBe(expected);
      await writeFile(path.join(root, 'node_modules/tar-stream/extract.js'), 'wrong upstream');
      expect(prepare).toThrow('source mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
