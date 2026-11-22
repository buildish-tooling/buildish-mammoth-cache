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

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, vi } from 'vitest';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
  type WorkflowArtifactDescriptor,
} from '../../../src/delta/backend';
export function memoryArtifacts() {
  const objects = new Map<number, { artifact: WorkflowArtifactDescriptor; bytes: Buffer }>();
  let id = 0;
  const upload = vi.fn(
    async (
      ...[_name, files, _root, options]: Parameters<WorkflowArtifactBackend['uploadArtifact']>
    ) => {
      expect(files).toHaveLength(1);
      expect(options?.skipArchive).toBe(true);
      const bytes = await readFile(files[0]),
        artifact = {
          id: ++id,
          name: path.basename(files[0]),
          size: bytes.length,
          digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        };
      objects.set(id, { artifact, bytes });
      return artifact;
    },
  );
  const list = vi.fn(async () => [...objects.values()].map((x) => x.artifact));
  const get = vi.fn(async (name: string) => {
    const value = [...objects.values()].find((x) => x.artifact.name === name);
    if (!value) throw new Error('missing');
    return value.artifact;
  });
  const download = vi.fn(
    async (...[artifactId, options]: Parameters<WorkflowArtifactBackend['downloadArtifact']>) => {
      expect(options?.skipDecompress).toBe(true);
      const value = objects.get(artifactId);
      if (!value || !options?.path) throw new Error('missing');
      await writeFile(path.join(options.path, 'opaque-response-name.data'), value.bytes);
      return { downloadPath: options.path, digestMismatch: false };
    },
  );
  const api: WorkflowArtifactBackend = {
    capabilities: {
      ...STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
      supportsRawWorkerArchives: true,
    },
    uploadArtifact: upload,
    listArtifacts: list,
    getArtifact: get,
    downloadArtifact: download,
    deleteArtifact: vi.fn(async () => {}),
  };
  return { api, upload, list, get, download, objects };
}
