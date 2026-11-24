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

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { open, realpath } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';

export const evidenceLimit = 65536;

export async function readBounded(file, bound = evidenceLimit) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size <= bound, 'Invalid correctness control size');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assert.equal(bytesRead, stat.size, 'Correctness control size changed');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function cacheHome(tool) {
  assert(['gradle', 'maven'].includes(tool), 'Unknown tool');
  const home = process.env[tool === 'gradle' ? 'GRADLE_USER_HOME' : 'MAVEN_USER_HOME'];
  assert(home && path.isAbsolute(home), 'Expected isolated tool home');
  return home;
}

export function execution(tool, job, attempt = process.env.GITHUB_RUN_ATTEMPT) {
  const { GITHUB_SHA: revision, GITHUB_RUN_ID: run, GITHUB_REPOSITORY: repository } = process.env;
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.match(run, /^[1-9][0-9]*$/u);
  assert.match(attempt, /^[1-9][0-9]*$/u);
  assert(Number.isSafeInteger(Number(attempt)));
  assert.match(job, /^[a-z0-9_-]+$/u);
  return { revision, repository, run, attempt: Number(attempt), tool, job };
}

export function evidenceDirectory() {
  return path.join(process.env.RUNNER_TEMP, 'mammoth-it-evidence');
}

export async function producerEvidence(tool, job, attempt) {
  const record = JSON.parse(await readBounded(path.join(evidenceDirectory(), 'evidence.json')));
  assert.equal(record.version, 1);
  assert.deepEqual(record.execution, execution(tool, job, attempt), 'Wrong producer identity');
  assert(
    record.outcome === 'published' ||
      (job === (tool === 'maven' ? 'maven_aggregator' : 'aggregator') &&
        record.execution.attempt > 1 &&
        record.outcome === 'no-change'),
    'Producer did not confirm publication',
  );
  assert.match(record.key, /-g-[a-f0-9]{64}-d-[a-f0-9]{64}$/u);
  assert(record.key.length <= 512);
  return record;
}

export async function completion(home, expected, prepare, inspectBase = false, identity) {
  const root = await realpath(home);
  async function read(relative, bound) {
    const file = path.resolve(root, relative);
    assert.equal(path.relative(root, file).split(path.sep).join('/'), relative);
    assert.equal(await realpath(file), file, 'Expected an invocation-owned record');
    return readBounded(file, bound);
  }

  const locator = JSON.parse(await read('.mammoth/v1/current.json'));
  assert.equal(locator.length, 4);
  assert.deepEqual(locator.slice(0, 2), ['current', 1]);
  assert.match(locator[2], /^[a-f0-9]{64}$/u);
  const owned = '.mammoth/v1/' + locator[2] + '/';
  assert.equal(locator[3], owned + 'state.json');
  const state = JSON.parse(await read(locator[3]));
  assert.equal(state.length, 8);
  assert.deepEqual(state.slice(0, 3), ['local-state', 2, locator[2]]);
  assert.equal(state[4], 'completed');
  async function record(ref, purpose) {
    assert.equal(ref?.length, 5);
    assert.deepEqual(ref.slice(0, 2), ['ref', purpose]);
    assert(ref[2].startsWith(owned));
    return read(ref[2], 1024 * 1024);
  }
  if (identity) {
    const bindings = JSON.parse(await record(state[5], 'bindings'));
    assert.deepEqual(bindings.slice(0, 3), ['bindings', 2, locator[2]]);
    assert.deepEqual(bindings[3], [
      'github',
      identity.repository,
      process.env.GITHUB_WORKFLOW,
      identity.run,
      identity.job,
      identity.attempt,
      identity.revision,
      identity.tool,
    ]);
  }
  const terminal = state[7];
  assert.equal(terminal?.length, 5);
  const [, outcome, key, id, name] = terminal;
  assert.equal(terminal[0], 'outcome');
  assert([expected].flat().includes(outcome), 'Unexpected completion outcome: ' + outcome);
  expected = outcome;
  if (expected === 'worker-uploaded') {
    assert(Number.isSafeInteger(id) && id > 0 && typeof name === 'string' && name.length > 0);
    if (identity)
      assert.match(name, new RegExp('-a' + identity.attempt + '-d[a-f0-9]{64}\\.tar\\.gz$', 'u'));
    return { outcome: expected, receipt: { id, name } };
  }
  if (expected === 'published' || expected === 'no-change') {
    assert(typeof key === 'string' && key.length > 0 && key.length <= 512);
    if (!inspectBase && expected === 'published') return { outcome: expected, key };
  } else {
    assert.equal(expected, 'read-only');
    if (!inspectBase && !prepare) return { outcome: expected };
  }
  const [frame, handoff] = (await record(state[6], 'handoff'))
    .split('\n', 2)
    .map((line) => JSON.parse(line));
  assert.equal(frame.length, 7);
  assert.deepEqual(frame.slice(0, 4), ['local-stream', 1, 'handoff', locator[2]]);
  assert.deepEqual(handoff.slice(0, 2), ['handoff', 3]);
  const restored = handoff[8]?.[0];
  assert(typeof restored === 'string' && restored.length > 0 && restored.length <= 512);
  if (prepare) {
    assert.equal(prepare['base-cache-restore-status'], 'current-lineage-hit');
    assert.equal(restored, prepare['restored-cache-key']);
  }
  if (expected === 'no-change') assert.equal(key, restored);
  const generation = JSON.parse(await record(handoff[8][1], 'generation'));
  assert.equal(generation.length, 12);
  assert.deepEqual(generation.slice(0, 3), ['generation', 2, 'generation-v2']);
  assert.equal(generation[11], restored);
  assert(Array.isArray(generation[8]) && generation[8].length <= 64);
  if (expected === 'published') {
    return { outcome: expected, key, prior: { key: restored, entries: generation[8] } };
  }
  return { outcome: expected, key: restored, entries: generation[8] };
}

export function verifyReuse(initial, warm, published, reader, partition = 'q-proof') {
  assert.equal(warm.key, initial.key, 'Warm generation changed');
  verifyChanged(initial, published, reader, partition);
}

export function verifyChanged(initial, published, reader, partition) {
  assert.notEqual(published.key, initial.key, 'Change did not publish a new generation');
  assert.equal(reader.key, published.key, 'Fresh reader missed the changed generation');
  assert.equal(reader.entries.length, initial.entries.length);
  const old = new Map(initial.entries.map((entry) => [entry[1], entry]));
  const next = new Map(reader.entries.map((entry) => [entry[1], entry]));
  assert(old.size === initial.entries.length && next.size === old.size);
  const changed = old.get(partition),
    replacement = next.get(partition);
  assert(changed?.[0] === 'object' && replacement?.[0] === 'object');
  assert.notDeepEqual(changed[2], replacement[2], 'Changed partition object was reused');
  let reused = 0;
  for (const [id, entry] of old) {
    if (id === partition) continue;
    assert.deepEqual(next.get(id), entry, 'Unchanged partition reference changed');
    if (entry[0] === 'object') reused++;
  }
  assert(reused > 0, 'No non-empty unaffected partition to verify');
}
