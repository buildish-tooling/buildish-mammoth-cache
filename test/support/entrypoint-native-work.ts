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

// Test-only aggregate counters on actual delegated NativeRoot operations.
export * from '../../src/cache/streaming/native';
import { NativeRoot } from '../../src/cache/streaming/native';
import { appendFileSync } from 'node:fs';
const roots = new Set<NativeRoot>(),
  bind = NativeRoot.bind;
NativeRoot.bind = async (...args: Parameters<typeof bind>) => {
  const root = await bind(...args);
  roots.add(root);
  return root;
};
process.once('exit', () => {
  if (!roots.size) return;
  const total: Record<string, number> = {};
  for (const root of roots)
    for (const [key, value] of Object.entries(root.work)) total[key] = (total[key] ?? 0) + value;
  appendFileSync(process.env.MAMMOTH_TEST_TRACE!, JSON.stringify(['native-work', total]) + '\n');
});
