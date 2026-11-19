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

import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES,
  type WorkflowArtifactBackend,
  type WorkflowArtifactDescriptor,
} from '../../src/delta/backend';
/** Byte-copy envelope backend; real ZIP behavior is covered separately. */
export class CutoffArtifacts implements WorkflowArtifactBackend {
  readonly capabilities = STANDARD_WORKFLOW_ARTIFACT_BACKEND_CAPABILITIES;
  readonly artifacts: WorkflowArtifactDescriptor[] = [];
  readonly downloads: string[] = [];
  constructor(readonly storage: string) {}
  async uploadArtifact(
    name: string,
    _files: readonly string[],
    root: string,
    options?: { retentionDays?: number; compressionLevel?: number },
  ) {
    if (!options?.retentionDays) throw new Error('Expected explicit retention.');
    if (this.artifacts.some((a) => a.name === name)) throw new Error('Artifact already exists.');
    const id = this.artifacts.length + 1;
    await mkdir(this.storage, { recursive: true });
    await cp(root, path.join(this.storage, String(id)), { recursive: true });
    const descriptor = { id, name, size: 128, digest: null };
    this.artifacts.push(descriptor);
    return descriptor;
  }
  async listArtifacts() {
    return this.artifacts;
  }
  async getArtifact(name: string) {
    const a = this.artifacts.find((a) => a.name === name);
    if (!a) throw new Error('missing');
    return a;
  }
  async downloadArtifact(id: number, options?: { path?: string; expectedHash?: string }) {
    if (!options?.path) throw new Error('Expected owned download path.');
    await cp(path.join(this.storage, String(id)), options.path, { recursive: true });
    this.downloads.push(options.path);
    return { downloadPath: options.path, digestMismatch: false };
  }
  async deleteArtifact() {
    throw new Error('Worker envelopes must be retained.');
  }
}
