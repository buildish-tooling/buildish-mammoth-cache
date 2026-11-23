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
import { isBuiltin } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { upstreamPackagePath } from '../../../scripts/prepare-tar-stream.mjs';
import { ends, tarMember } from './tar-fixtures';

it('bundles the adapter and patched parser without a generated runtime path dependency', async () => {
  const result = await build({
    entryPoints: ['src/cache/streaming/worker-transport.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
    write: false,
  });
  const inputs = Object.keys(result.metafile!.inputs).map(upstreamPackagePath);
  expect(inputs).toContain('node_modules/tar-stream/extract.js');
  expect(inputs).toContain('node_modules/tar-stream/mammoth.cjs');
  const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((item) => item.external && isBuiltin(item.path))).toBe(true);
  await mkdir('build', { recursive: true });
  const root = await mkdtemp(path.resolve('build/transport-bundle-'));
  try {
    await writeFile(path.join(root, 'transport.cjs'), result.outputFiles![0].contents);
    const archive = gzipSync(
      Buffer.concat([tarMember('payload/aggregate/f', Buffer.from('abc')), ends]),
    ).toString('hex');
    const script = `const {Readable}=require('node:stream'); const {readWorkerTransport}=require('./transport.cjs'); let body=''; readWorkerTransport(Readable.from([Buffer.from('${archive}','hex')],{objectMode:false,highWaterMark:16384}), async e=>{ for await(const b of e.body) body+=b.toString(); }).then(()=>{if(body!=='abc')process.exitCode=2; else process.stdout.write('bundled transport OK');}).catch(e=>{console.error(e);process.exitCode=1;});`;
    expect(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })).toBe(
      'bundled transport OK',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
