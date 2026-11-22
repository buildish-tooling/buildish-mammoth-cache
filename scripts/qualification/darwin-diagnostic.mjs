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

// Read-only later classification, never raw process evidence or a publication permission.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import path from 'node:path';
const reasons = new Map([
  ['Oversized process record.', 'oversized-record'],
  ['Invalid process display controls.', 'display-controls'],
  ['Malformed process table record.', 'malformed-record'],
  ['Invalid process identity.', 'invalid-identity'],
  ['Invalid owned process identity.', 'invalid-owned-identity'],
  ['Duplicate observer process record.', 'duplicate-self'],
]);
export function diagnosticFailure(error) {
  return reasons.get(error?.message) ?? 'unclassified-parser-error';
}
export async function diagnoseDarwin() {
  if (process.platform !== 'darwin') return { classification: 'not-darwin' };
  const { DarwinProcessTable, DARWIN_PS_ARGS } = createRequire(import.meta.url)(
      path.resolve('build/q1-darwin-inspection.cjs'),
    ),
    table = new DarwinProcessTable(process.geteuid(), process.pid),
    child = spawn('/bin/ps', [...DARWIN_PS_ARGS], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let stopped = false,
    closed = false,
    hard;
  const stop = () => {
    if (closed || stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    hard = setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, 500);
  };
  const finished = new Promise((resolve) => {
    child.once('error', () => {});
    child.once('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  const timer = setTimeout(stop, 10000);
  let classification = 'completed',
    flags = {};
  try {
    for await (const chunk of child.stdout) table.push(Buffer.from(chunk));
    flags = table.finish();
  } catch (error) {
    classification = diagnosticFailure(error);
    stop();
  }
  const exitCode = await finished;
  clearTimeout(timer);
  clearTimeout(hard);
  if (stopped && classification === 'completed') classification = 'timeout';
  if (exitCode !== 0 && classification === 'completed') classification = 'inspection-failed';
  return {
    classification,
    exitCode,
    completed: closed && !stopped && exitCode === 0,
    ...flags,
    scope:
      'Later read-only snapshot; no raw text retained; not proof of the original failure cause.',
  };
}
