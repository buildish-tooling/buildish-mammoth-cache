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

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface CompositeActionStep {
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface CompositeActionManifest {
  readonly inputs?: Readonly<Record<string, { readonly description?: string }>>;
  readonly runs?: { readonly steps?: readonly CompositeActionStep[] };
}

describe('setup-node-npm composite action', () => {
  it('disables setup-node automatic package-manager caching when cache is blank', async () => {
    const manifest = parseYaml(
      await readFile('.github/actions/setup-node-npm/action.yml', 'utf8'),
    ) as CompositeActionManifest;
    const setupNodeSteps =
      manifest.runs?.steps?.filter((step) => step.uses?.startsWith('actions/setup-node@')) ?? [];

    expect(setupNodeSteps).toHaveLength(2);
    for (const step of setupNodeSteps) {
      expect(step.with).toMatchObject({
        cache: '${{ inputs.cache }}',
        'package-manager-cache': "${{ inputs.cache != '' }}",
      });
    }
    expect(manifest.inputs?.cache?.description).toMatch(/blank.*disable.*automatically inferred/su);
  });
});
