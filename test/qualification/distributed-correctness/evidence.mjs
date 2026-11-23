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
import path from 'node:path';

export async function completion(home, expected, prepare) {
  const root = await realpath(home);
  async function read(relative, bound = 65536) {
    const file = path.resolve(root, relative);
    assert.equal(path.relative(root, file).split(path.sep).join('/'), relative);
    assert.equal(await realpath(file), file, 'Expected an invocation-owned record');
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
  const terminal = state[7];
  assert.equal(terminal?.length, 5);
  assert.deepEqual(terminal.slice(0, 2), ['outcome', expected]);
  const [, , key, id, name] = terminal;
  if (expected === 'worker-uploaded') {
    assert(Number.isSafeInteger(id) && id > 0 && typeof name === 'string' && name.length > 0);
    return { outcome: expected, receipt: { id, name } };
  }
  if (expected === 'published' || expected === 'no-change') {
    assert(typeof key === 'string' && key.length > 0);
    return { outcome: expected, key };
  }
  assert.equal(expected, 'read-only');
  assert.equal(prepare['base-cache-restore-status'], 'current-lineage-hit');
  const restored = prepare['restored-cache-key'];
  assert(typeof restored === 'string' && restored.length > 0);
  async function record(ref, purpose) {
    assert.equal(ref?.length, 5);
    assert.deepEqual(ref.slice(0, 2), ['ref', purpose]);
    assert(ref[2].startsWith(owned));
    return read(ref[2], 1024 * 1024);
  }
  const [frame, handoff] = (await record(state[6], 'handoff'))
    .split('\n', 2)
    .map((line) => JSON.parse(line));
  assert.equal(frame.length, 7);
  assert.deepEqual(frame.slice(0, 4), ['local-stream', 1, 'handoff', locator[2]]);
  assert.deepEqual(handoff.slice(0, 2), ['handoff', 2]);
  assert.equal(handoff[8]?.[0], restored);
  const generation = JSON.parse(await record(handoff[8][1], 'generation'));
  assert.equal(generation.length, 12);
  assert.deepEqual(generation.slice(0, 3), ['generation', 2, 'generation-v2']);
  assert.equal(generation[11], restored);
  return { outcome: expected, key: restored, entries: generation[8] };
}

export function verifyReuse(initial, warm, published, reader) {
  assert.equal(warm.key, initial.key, 'Warm generation changed');
  assert.notEqual(published.key, initial.key, 'Change did not publish a new generation');
  assert.equal(reader.key, published.key, 'Fresh reader missed the changed generation');
  assert.equal(reader.entries.length, initial.entries.length);
  const old = new Map(initial.entries.map((entry) => [entry[1], entry]));
  const next = new Map(reader.entries.map((entry) => [entry[1], entry]));
  assert(old.size === initial.entries.length && next.size === old.size);
  const changed = old.get('q-proof'),
    replacement = next.get('q-proof');
  assert(changed?.[0] === 'object' && replacement?.[0] === 'object');
  assert.notDeepEqual(changed[2], replacement[2], 'Changed partition object was reused');
  let reused = 0;
  for (const [partition, entry] of old) {
    if (partition === 'q-proof') continue;
    assert.deepEqual(next.get(partition), entry, 'Unchanged partition reference changed');
    if (entry[0] === 'object') reused++;
  }
  assert(reused > 0, 'No non-empty unaffected partition to verify');
}

export const platforms = ['linux', 'windows', 'macos'];

export function admit(env, system) {
  assert.equal(env.GITHUB_REPOSITORY, 'snazy/buildish-mammoth-cache');
  assert.equal(env.GITHUB_REF, 'refs/heads/cache-metadata-redesign');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1', 'Only fresh whole-graph runs are admitted');
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/u);
  assert.equal(env.MAMMOTH_GRAPH_REVISION, env.GITHUB_SHA);
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/u);
  assert(['worker', 'aggregator', 'consumer'].includes(env.INPUT_STAGE));
  assert.equal({ linux: 'linux', win32: 'windows', darwin: 'macos' }[system], env.INPUT_PLATFORM);
  assert(platforms.includes(env.INPUT_PLATFORM));
  return {
    stage: env.INPUT_STAGE,
    platform: env.INPUT_PLATFORM,
    run: env.GITHUB_RUN_ID,
    revision: env.GITHUB_SHA,
  };
}
