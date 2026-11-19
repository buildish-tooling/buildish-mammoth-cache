#!/usr/bin/env node

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

// CI-only provisioning into the disposable runner temp directory.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

const version = '3.10.0';
const sha512 =
  '908b1501bfb420bf7c8affb855534a9c407fd6099367bfb9f2f2dcb8e9799102bffb84518cde74c679bd76870247c6528683abdd620581bffa90f95d92d175aa';
const root = path.join(process.env.RUNNER_TEMP, 'mammoth-maven-tool');
await mkdir(root, { recursive: true });
let bytes;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const response = await globalThis.fetch(
      `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${version}/apache-maven-${version}-bin.tar.gz`,
      { signal: globalThis.AbortSignal.timeout(60_000) },
    );
    assert(response.ok, `Maven download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    break;
  } catch (error) {
    if (attempt === 3) throw error;
    process.stderr.write(`Maven download attempt ${attempt} failed: ${error}. Retrying in 2s.\n`);
    await setTimeout(2_000);
  }
}
assert.equal(createHash('sha512').update(bytes).digest('hex'), sha512);
const archive = path.join(root, 'maven.tar.gz');
await writeFile(archive, bytes);
execFileSync('tar', ['-xzf', 'maven.tar.gz'], { cwd: root, stdio: 'inherit' });
await appendFile(process.env.GITHUB_PATH, path.join(root, `apache-maven-${version}`, 'bin') + '\n');
