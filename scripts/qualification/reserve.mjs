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
import { randomFillSync } from 'node:crypto';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
const mib = Number(process.argv[2]),
  duration = Number(process.argv[3]);
assert(Number.isInteger(mib) && mib > 0 && mib <= 2048);
assert(Number.isInteger(duration) && duration > 0 && duration <= 3600000);
// Touch every byte and retain the allocation; this is labelled synthetic unrelated load.
globalThis.qualificationReservation = Buffer.allocUnsafe(mib * 1024 ** 2);
// Noncompressible pages avoid turning the macOS reservation into a cheap compressed pattern.
for (let at = 0; at < globalThis.qualificationReservation.length; at += 16 * 1024 ** 2)
  randomFillSync(
    globalThis.qualificationReservation,
    at,
    Math.min(16 * 1024 ** 2, globalThis.qualificationReservation.length - at),
  );
const marker = globalThis.qualificationReservation[0];
process.stdout.write(JSON.stringify({ ready: true, mib }) + '\n');
const timer = setInterval(() => {
  if (globalThis.qualificationReservation[0] !== marker) process.exit(1);
}, 1000);
const done = () => {
  clearInterval(timer);
  process.exit(0);
};
process.once('SIGTERM', done);
setTimeout(() => (process.argv[4] === 'hold' ? process.exit(2) : done()), duration).unref();
