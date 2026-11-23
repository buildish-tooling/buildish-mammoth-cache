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
  'extract.js': 'dcdbac54ad8316508160b677e039da33698e57f5e193558899b8e040bc6325ff',
  'headers.js': 'c357da39df0205ad01b0861af153902586237c4e6e9ab0cddd12336ce4f03e79',
  'index.js': '0db9eceef5224dbc34c224c398b50eef4b99f937c80c81f660928615a248ed4f',
  'constants.js': '6dcd4aa7d4ab7876c54b28bc6bf281e9d6423787b17eae4353a87af34605972e',
  'pack.js': '9885de07c3fc948aeebdec5e113f536c3e540230a3f0a24c82c3e80339bc8235',
  'package.json': '9f0900ab79650f230a8d67da1b4ffa31b8340eb90f3565bdaadfea1ba79ac43d',
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
    if (hash(bytes) !== sha) throw new Error(`tar-stream 3.2.0 source mismatch: ${name}`);
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
