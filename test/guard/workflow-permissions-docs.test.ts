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

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const ACTIONS_WRITE_GRANT_PATTERN = /^\s*actions:\s*write\s*$/mu;

describe('ordinary workflow permission guidance', () => {
  it('does not grant actions: write in user-guide workflow examples', async () => {
    const userGuidePaths = (await readdir('docs/user', { recursive: true }))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => path.join('docs/user', entry));

    for (const userGuidePath of userGuidePaths) {
      const contents = await readFile(userGuidePath, 'utf8');
      expect(contents, `${userGuidePath} contains an actions: write grant`).not.toMatch(
        ACTIONS_WRITE_GRANT_PATTERN,
      );
    }
  });

  it.each(['.github/workflows/it-reusable-gradle.yml', '.github/workflows/it-reusable-maven.yml'])(
    'keeps the hosted writable integration at contents-read permission: %s',
    async (workflow) => {
      const contents = await readFile(workflow, 'utf8');
      const descriptor = parseYaml(contents) as {
        readonly permissions?: Readonly<Record<string, string>>;
      };

      expect(descriptor.permissions).toEqual({ contents: 'read' });
      expect(contents).not.toMatch(ACTIONS_WRITE_GRANT_PATTERN);
    },
  );

  it('documents the runtime-credential and elevated-API boundaries explicitly', async () => {
    const securityGuide = await readFile('docs/user/security.md', 'utf8');

    expect(securityGuide).toMatch(/job-scoped Actions runtime\s+credentials/u);
    expect(securityGuide).toMatch(/cross-run or cross-repository artifact lookup/u);
  });
});
