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

// Small filesystem assertions shared by the existing native integration jobs.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { chmod, glob, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const [operation, tool, worker] = process.argv.slice(2);
const root =
  tool === 'gradle'
    ? process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle')
    : process.env.MAVEN_USER_HOME || path.join(os.homedir(), '.m2');
const workers = ['worker_a', 'worker_b', 'worker_c'];
const fixtures = new Map([
  ['nested directory/file with spaces.txt', Buffer.from('spaces\n')],
  ['Grüße für Jörg/français été à Noël cœur.txt', Buffer.from('accents\n')],
  ['資料/cache 🦣.bin', Buffer.from([0, 255, 13, 10, 128, 1])],
  ["punctuation/a & b #1 + 50% = (ok) [x] 'quote' $cash !.txt", Buffer.from('punctuation\n')],
  ['-leading-dash.txt', Buffer.from('leading hyphen\n')],
  ['empty file', Buffer.alloc(0)],
]);
const script = Buffer.from('#!/bin/sh\nprintf "mammoth executable\\n"\n');
const fileAt = (id, name) => path.join(root, 'it-portability', id, name);

if (operation === 'seed') {
  assert(workers.includes(worker));
  for (const [name, bytes] of fixtures) {
    const file = fileAt(worker, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.concat([Buffer.from(worker + '\n'), bytes]));
  }
  // Preserve a genuinely empty file too; the other payloads identify their writer.
  await writeFile(fileAt(worker, 'empty file'), Buffer.alloc(0));
  if (process.platform !== 'win32' && worker !== 'worker_b') {
    await writeFile(fileAt(worker, 'executable script.sh'), script);
    await chmod(fileAt(worker, 'executable script.sh'), 0o755);
    await writeFile(fileAt(worker, 'ordinary file.txt'), 'ordinary\n');
    await chmod(fileAt(worker, 'ordinary file.txt'), 0o644);
  }
} else if (operation === 'assert') {
  for (const id of workers) {
    for (const [name, bytes] of fixtures) {
      assert.deepEqual(
        await readFile(fileAt(id, name)),
        name === 'empty file' ? Buffer.alloc(0) : Buffer.concat([Buffer.from(id + '\n'), bytes]),
        `${id}/${name}`,
      );
    }
    if (id !== 'worker_b') {
      const executable = fileAt(id, 'executable script.sh');
      assert.deepEqual(await readFile(executable), script);
      assert.equal(await readFile(fileAt(id, 'ordinary file.txt'), 'utf8'), 'ordinary\n');
      if (process.platform !== 'win32') {
        assert.equal((await stat(executable)).mode & 0o111, 0o111);
        assert.equal((await stat(fileAt(id, 'ordinary file.txt'))).mode & 0o111, 0);
        assert.equal(execFileSync(executable, { encoding: 'utf8' }), 'mammoth executable\n');
      }
    }
  }
  if (tool === 'maven') {
    for (const [directory, jar] of [
      ['com/google/guava/guava/33.6.0-jre', 'guava-33.6.0-jre.jar'],
      ['commons-io/commons-io/2.22.0', 'commons-io-2.22.0.jar'],
      ['org/apache/commons/commons-collections4/4.5.0', 'commons-collections4-4.5.0.jar'],
    ]) {
      const artifact = path.join(root, 'repository', directory);
      assert((await stat(path.join(artifact, jar))).size > 0);
      assert(
        (await readFile(path.join(artifact, '_remote.repositories'), 'utf8')).includes(
          jar + '>central=',
        ),
      );
    }
  }
} else if (operation === 'groovy') {
  // Inspect restored real workspaces before running Gradle, which could rebuild them.
  let count = 0;
  let empty = 0;
  for await (const metadata of glob('caches/*/groovy-dsl/*/metadata.bin', { cwd: root })) {
    const directory = path.dirname(metadata);
    if (!/^[a-f0-9]{32}$/u.test(path.basename(directory))) continue;
    assert((await readFile(path.join(root, metadata))).length > 0);
    assert((await readFile(path.join(root, directory, 'metadata/metadata.bin'))).length > 0);
    for (const name of ['classes', 'instrumented']) {
      const output = path.join(root, directory, name);
      assert((await stat(output)).isDirectory());
    }
    for await (const output of glob(directory + '/{classes,instrumented}/**', { cwd: root })) {
      const absolute = path.join(root, output);
      if ((await stat(absolute)).isDirectory() && !(await readdir(absolute)).length) empty++;
    }
    count++;
  }
  assert(count > 0, 'No restored Groovy workspaces');
  assert(empty > 0, 'No restored empty Groovy output directories');
  process.stdout.write(
    `Restored ${count} complete Groovy workspaces, ${empty} empty output directories\n`,
  );
} else if (operation === 'launcher') {
  let found = false;
  for await (const name of glob('wrapper/dists/*/*/gradle-*/bin/gradle', { cwd: root })) {
    const launcher = path.join(root, name);
    assert((await stat(launcher)).mode & 0o111, 'Restored distribution launcher is not executable');
    execFileSync(launcher, ['--version'], { stdio: 'inherit' });
    found = true;
  }
  assert(found, 'No restored Gradle distribution launcher');
} else if (operation === 'gradle-log') {
  const log = await readFile(worker, 'utf8');
  for (const jar of [
    'guava-33.6.0-jre.jar',
    'commons-io-2.22.0.jar',
    'commons-collections4-4.5.0.jar',
  ]) {
    assert(log.includes(jar), `Dependency not resolved: ${jar}`);
  }
  assert(log.includes(':portable FROM-CACHE'), 'Portable task output was not restored from cache');
  assert(
    !log.includes('have been modified. These workspace directories'),
    'Groovy workspace invalidation',
  );
  // Compilation may legitimately differ across JVM/OS environments; retain the diagnostics.
  process.stdout.write(
    log
      .split('\n')
      .filter((line) => /Compiling|FROM-CACHE/u.test(line))
      .join('\n') + '\n',
  );
} else if (operation === 'reader') {
  assert.equal(process.env.ACTION_BASE_CACHE_RESTORE_STATUS, 'current-lineage-hit');
  assert.equal(process.env.ACTION_READ_ONLY, 'true');
  assert.equal(process.env.ACTION_JOB_MODE, 'standalone');
} else {
  throw new Error(`Unknown fixture operation: ${operation}`);
}
