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
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { clearTimeout, setTimeout as timer } from 'node:timers';
import { snapshot } from './observe.mjs';
import { fileURLToPath } from 'node:url';
import { atomic, execute } from './invocation.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
export async function meter(root) {
  await mkdir(root, { recursive: true });
  const control = path.join(root, 'control.json'),
    output = path.join(root, 'metrics.json');
  await atomic(control, { pid: process.pid, phase: 'calibration-idle' });
  const child = spawn(process.execPath, [path.join(directory, 'observe.mjs'), control, output], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Sampler failed: ' + code)),
    );
  });
  // Attach rejection handling immediately, then propagate on close.
  finished.catch(() => {});
  const phase = async (name, pid) => atomic(control, { pid, phase: name });
  const close = async () => {
    await atomic(control, { stop: true });
    await finished;
    return JSON.parse(await readFile(output, 'utf8'));
  };
  try {
    await execute(process.execPath, [path.join(directory, 'reserve.mjs'), '64', '5000'], {
      started: (pid) => phase('calibration-child', pid),
    });
    await phase('calibration-exited', 0);
    await setTimeout(process.platform === 'win32' ? 3000 : 500);
    const current = JSON.parse(await readFile(output, 'utf8'));
    assert(
      current.phases['calibration-child']?.peakRss >= 48 * 1024 ** 2,
      'Sampler missed known child allocation',
    );
    assert(current.phases['calibration-exited']?.samples > 0, 'Sampler missed phase/child exit');
    assert.equal(current.phases['calibration-exited'].peakRss, 0, 'Exited child still counted');
    return { phase, close, output };
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
}
export async function reservation(mib = 2048, duration = 3500000) {
  const memory = await snapshot(),
    bytes = mib * 1024 ** 2;
  const margin = mib === 2048 ? Math.max(1024 ** 3, memory.total * 0.15) : 64 * 1024 ** 2;
  assert(mib !== 2048 || memory.effectiveLimitKnown, 'Effective memory limit is unqualified');
  assert(memory.available >= bytes + margin, 'Insufficient measured headroom for reservation');
  let exited = false,
    closing = false;
  const child = spawn(
    process.execPath,
    [path.join(directory, 'reserve.mjs'), String(mib), String(duration), 'hold'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      exited = true;
      closing && (code === 0 || signal === 'SIGTERM')
        ? resolve()
        : reject(new Error('Reservation exited before owned close: ' + code));
    });
  });
  finished.catch(() => {});
  const assertCurrent = () =>
    assert(
      !closing && !exited && child.exitCode === null && child.signalCode === null,
      'Reservation is not live',
    );
  try {
    await new Promise((resolve, reject) => {
      let text = '';
      const timeout = timer(() => reject(new Error('Reservation readiness timeout')), 15000);
      finished
        .then(() => reject(new Error('Reservation exited before readiness')), reject)
        .finally(() => clearTimeout(timeout));
      child.stdout.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (text.length > 128) {
          clearTimeout(timeout);
          reject(new Error('Invalid reservation acknowledgement'));
          return;
        }
        if (!text.endsWith('\n')) return;
        try {
          assert.deepEqual(JSON.parse(text), { ready: true, mib });
          clearTimeout(timeout);
          resolve();
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });
    });
    assertCurrent();
  } catch (e) {
    closing = true;
    child.kill('SIGTERM');
    await finished.catch(() => {});
    throw e;
  }
  return {
    mib,
    assertCurrent,
    close: async () => {
      assertCurrent();
      closing = true;
      child.kill('SIGTERM');
      await finished;
    },
  };
}
