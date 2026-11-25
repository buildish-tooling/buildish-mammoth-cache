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
import {
  appendFile,
  chmod,
  glob,
  mkdir,
  readFile,
  realpath,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { cacheHome, producerEvidence } from '../actions/it-observe/evidence.mjs';
import { assertDependency } from './it-cache-dependencies.mjs';

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

if (operation === 'empty') {
  const home = cacheHome(tool);
  const contents = await readdir(home).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  assert.deepEqual(contents, [], 'Tool home was populated before prepare');
} else if (operation === 'exact') {
  const {
    IT_PRODUCER_ATTEMPT: attempt,
    IT_EXPECTED_RESTORE: expectedRestore,
    IT_EXPECTED_READ_ONLY: expectedReadOnly,
  } = process.env;
  assert(attempt, 'Missing producer attempt');
  const producer = await producerEvidence(tool, worker, attempt);
  const prepare = JSON.parse(process.env.IT_PREPARE);
  assert.equal(prepare['base-cache-restore-status'], expectedRestore);
  assert.equal(prepare['read-only'], expectedReadOnly);
  assert.equal(prepare['job-mode'], 'standalone');
  assert.equal(prepare['dependent-delta-status'], 'not-configured');
  assert.equal(prepare['dependent-delta-artifact-count'], '0');
  assert.equal(prepare['restored-cache-key'], producer.key, 'Restored a different generation');
} else if (operation === 'age-layer') {
  assert.equal(tool, 'gradle');
  let count = 0;
  for await (const member of glob(
    'caches/modules-2/files-2.1/org.apache.commons/commons-lang3/3.20.0/*/*.jar',
    { cwd: root },
  )) {
    const old = new Date(Date.now() - 30 * 86400000);
    await utimes(path.join(root, member), old, old);
    count++;
  }
  assert(count > 0, 'Seed dependency was not resolved');
} else if (operation === 'layer') {
  assert.equal(tool, 'gradle');
  const prepare = JSON.parse(process.env.IT_PREPARE);
  const producer = await producerEvidence(tool, 'layer-seed', process.env.IT_PRODUCER_ATTEMPT);
  assert.equal(prepare['job-mode'], 'distributed-worker');
  assert.equal(prepare['read-only'], 'false');
  assert.equal(prepare['base-cache-restore-status'], 'current-lineage-hit');
  assert.equal(prepare['restored-cache-key'], producer.key, 'Selected the wrong layer generation');
  const seed = prepare['gradle-ro-dep-cache'];
  assert(
    typeof seed === 'string' && path.isAbsolute(seed),
    'Cold/fallback restore did not activate a seed',
  );
  assert.equal(process.env.GRADLE_RO_DEP_CACHE, seed);
  assert.equal(await realpath(seed), seed);
  assert(
    path
      .relative(await realpath(root), seed)
      .split(path.sep)
      .join('/')
      .match(/^\.mammoth\/v1\/[a-f0-9]{64}\/seed\/[a-f0-9-]{36}\/caches$/u),
  );
  await assertDependency(tool, path.dirname(seed), 'standalone');
  for await (const member of glob(
    'caches/modules-2/files-2.1/org.apache.commons/commons-lang3/3.20.0/*/*.jar',
    { cwd: root },
  ))
    assert.fail('Inherited dependency leaked into writable head: ' + member);
  let aged = 0;
  for await (const member of glob(
    'modules-2/files-2.1/org.apache.commons/commons-lang3/3.20.0/*/*.jar',
    { cwd: seed },
  )) {
    assert((await stat(path.join(seed, member))).mtimeMs < Date.now() - 14 * 86400000);
    aged++;
  }
  assert(aged > 0);
} else if (operation === 'standalone') {
  await assertDependency(tool, cacheHome(tool), 'standalone');
} else if (operation === 'change') {
  const file = fileAt('worker_a', '-leading-dash.txt');
  const before = await stat(file);
  await appendFile(file, 'changed\n');
  const time = new Date(before.mtimeMs - 2000);
  await utimes(file, time, time);
  const after = await stat(file);
  assert(
    after.size > before.size && after.mtimeMs !== before.mtimeMs,
    'Invisible fixture mutation',
  );
} else if (operation === 'seed') {
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
      const expected =
        name === 'empty file'
          ? Buffer.alloc(0)
          : Buffer.concat([
              Buffer.from(id + '\n'),
              bytes,
              worker === 'changed' && id === 'worker_a' && name === '-leading-dash.txt'
                ? Buffer.from('changed\n')
                : Buffer.alloc(0),
            ]);
      assert.deepEqual(await readFile(fileAt(id, name)), expected, `${id}/${name}`);
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
    for (const id of workers) await assertDependency(tool, root, id, { central: true });
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
} else {
  throw new Error(`Unknown fixture operation: ${operation}`);
}
