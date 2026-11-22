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
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function gate(file, output) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert(typeof config.enabled === 'boolean');
  assert(config.maximumQualificationJobs === 15 && config.maximumAllocatedJobMinutes === 430);
  await appendFile(output, 'enabled=' + String(config.enabled) + '\n');
  return config.enabled;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await gate('.github/q1-campaign.json', process.env.GITHUB_OUTPUT);
