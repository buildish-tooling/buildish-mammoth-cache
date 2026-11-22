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

import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareStreaming } from '../../../src/cache/streaming/prepare';
import { postStreamingWorker } from '../../../src/cache/streaming/worker-post';
import { OpenedInvocation, invocationAnchor } from '../../../src/cache/streaming/invocation';
import { installFixture } from './install-fixture';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
} from '../../../src/delta/backend';
const [mode, root, sink, point] = process.argv.slice(2),
  f = await installFixture('maven', { root });
let opened;
if (mode === 'start') {
  await prepareStreaming({
    root,
    model: f.model,
    context: f.store.codec.options.context,
    nonce: String(f.bindings[4]),
    budget: f.budget,
    policy: {
      role: 'distributed-worker',
      access: 'writable',
      restoreCleanup: 'none',
      gcAgeMs: null,
      ordinaryPolicy: 'strict',
      ordinaryOrder: [],
    },
    currentRef: 'refs/heads/main',
    captureTempDirectory: null,
    artifactRetentionDays: 7,
    cleanupEnabled: true,
    saveAnchor: () => {},
    provision: async () => {},
    installHooks: async () => {},
    assertCurrent: (): undefined => {},
    cacheBackend: async () => ({
      capabilities: { supportsExplicitSave: true, supportsNewestPrefixRestore: true },
      isFeatureAvailable: () => true,
      restoreCache: async () => undefined,
      saveCache: async () => 1,
      isMissingPathsError: () => false,
    }),
  });
  await f.files('', { 'data/created': 'original', 'state/created': 'snapshot' });
}
opened = await OpenedInvocation.current(root, f.budget);
if (!opened) throw new Error('missing owner');
const backend: WorkflowArtifactBackend = {
  capabilities: {
    ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
    supportsRawWorkerArchives: true,
  },
  deleteArtifact: async () => {},
  listArtifacts: async () => [],
  getArtifact: async () => {
    throw new Error('not uploaded');
  },
  downloadArtifact: async () => {
    throw new Error('not downloaded');
  },
  uploadArtifact: async (name, files) => {
    const bytes = await readFile(files[0]);
    await writeFile(sink, bytes);
    return {
      id: 1,
      name,
      size: bytes.length,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    };
  },
};
await postStreamingWorker({
  anchor: invocationAnchor(
    opened.store.root,
    opened.store.codec.options.context,
    opened.bindings[4],
  ),
  budget: f.budget,
  assertCurrent: (): undefined => {},
  artifactBackend: async () => backend,
  fail: async (name) => {
    if (mode === 'start' && name === point) process.exit(73);
  },
});
if (f.budget.retained) throw new Error('worker child leaked budget');
