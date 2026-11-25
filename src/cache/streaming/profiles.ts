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

// Protocol: docs/dev/native-base-protocol.md#model-family-and-key-identities
export const STREAMING_PROFILES = {
  worker: 'worker-tar-v2',
  native: 'native-metadata-v2',
  generation: 'generation-v3',
  local: 'local-v2',
  path: 'path-policy-v1',
  unit: 'unit-policy-v1',
  glob: 'glob-policy-v1',
} as const;

/** Initial qualified Gradle dependency-layer consumer; other versions use ordinary restore. */
export const GRADLE_LAYER_VERSION = '9.6.1';

/** The projection hash is computed by the canonical codec, not by this prefix helper. */
export function streamingFamilyId(buildTool: 'gradle' | 'maven', familySha: string): string {
  if (!/^[a-f0-9]{64}$/.test(familySha)) throw new Error('Invalid streaming family digest.');
  return `mammoth-s1-${buildTool}-${familySha}`;
}
