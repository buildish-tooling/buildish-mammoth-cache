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

import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const patchedTarRoot = 'build/patched-tar-stream';
const upstream = {
  'extract.js': '4eb36f38fc7d52cb9019ca272fe3c79104a4b36431762f2984a22cdbdc56ed48',
  'headers.js': '68cb61b9c586da6bf7e2a1f00c217d7e7ef2d2a500003627a5b05cbb0c389c5c',
  'index.js': '0db9eceef5224dbc34c224c398b50eef4b99f937c80c81f660928615a248ed4f',
  'constants.js': '6dcd4aa7d4ab7876c54b28bc6bf281e9d6423787b17eae4353a87af34605972e',
  'pack.js': 'a2d3eb7e8431743c08d0ecae8897a677c9cdec0b18f81022659d1ef6c7994687',
  'package.json': 'bcbc78fa5896d664c116de1745b819010cb968ce9d02adcee327af2f4aa1a976',
  LICENSE: '3fe8d55a98dbf260eace67c00cf9bc53edb46234e840098a0b93df3096b97fb6',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Build an isolated, reproducibly patched copy; never edits installed packages. */
export function prepareTarStream() {
  const source = path.join(root, 'node_modules/tar-stream');
  const target = path.join(root, patchedTarRoot);
  const files = new Map();
  for (const [name, sha] of Object.entries(upstream)) {
    const bytes = fs.readFileSync(path.join(source, name));
    if (hash(bytes) !== sha) throw new Error(`tar-stream 3.3.0 source mismatch: ${name}`);
    files.set(name, bytes);
  }
  const patchDir = path.join(root, 'patches/tar-stream');
  const additions = ['mammoth.cjs', 'index.d.ts'];
  // Checkout line endings must not change the reviewed patch or generated sources.
  const authored = (name) =>
    Buffer.from(fs.readFileSync(path.join(patchDir, name), 'utf8').replace(/\r\n/gu, '\n'));
  const patch = authored('extract.patch');
  const fingerprint = hash(Buffer.concat([patch, ...files.values(), ...additions.map(authored)]));
  const stampPath = path.join(target, '.prepared.json');
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (
      stamp.fingerprint === fingerprint &&
      Object.entries(stamp.outputs).every(
        ([name, sha]) => hash(fs.readFileSync(path.join(target, name))) === sha,
      )
    )
      return;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  fs.mkdirSync(target, { recursive: true });
  for (const [name, bytes] of files) fs.writeFileSync(path.join(target, name), bytes);
  for (const name of additions) fs.writeFileSync(path.join(target, name), authored(name));
  // A reviewed unified patch, not runtime monkey-patching or source-string replacement.
  execFileSync('git', ['apply', '--no-index', `--directory=${patchedTarRoot}`, '-'], {
    cwd: root,
    stdio: 'pipe',
    input: patch,
  });
  const outputs = Object.fromEntries(
    [...files.keys(), ...additions].map((name) => [
      name,
      hash(fs.readFileSync(path.join(target, name))),
    ]),
  );
  fs.writeFileSync(stampPath, JSON.stringify({ fingerprint, outputs }) + '\n');
}

/** Preserve upstream attribution for esbuild inputs in the generated source copy. */
export function upstreamPackagePath(inputPath) {
  const normalized = inputPath.replace(/\\/g, '/');
  return normalized.startsWith(patchedTarRoot + '/')
    ? 'node_modules/tar-stream/' + normalized.slice(patchedTarRoot.length + 1)
    : normalized;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  prepareTarStream();
