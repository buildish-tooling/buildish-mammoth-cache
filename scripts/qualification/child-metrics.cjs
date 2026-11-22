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

// CI-only preload. The production bundle and SDKs remain unmodified.
const { writeFileSync } = require('node:fs');
const process = require('node:process');
const target = process.env.Q1_NODE_METRICS;
if (target)
  process.once('exit', (exitCode) => {
    try {
      writeFileSync(
        target,
        JSON.stringify({
          exitCode,
          resourceUsage: process.resourceUsage(),
          memoryUsageAtExit: process.memoryUsage(),
          scope:
            'This Node process only; excludes native child CPU; memoryUsage is at exit, not peak; resourceUsage counters retain Node API units.',
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      process.exitCode = exitCode || 1;
    }
  });
