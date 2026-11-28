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

import { describe, expect, it } from 'vitest';

import { MATRIX_JOBS_DOCS_URL, releasedDocsUrl } from '../../src/util/docs-links';

describe('released docs links', () => {
  it('links to the released docs of the package version', async () => {
    const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect(releasedDocsUrl('user/')).toBe(
      'https://buildish.org/components/mammoth-cache/releases/' + version + '/user/',
    );
  });

  it('points the matrix-jobs link at an existing docs heading', async () => {
    const guide = await readFile('docs/user/distributed-jobs.md', 'utf8');
    expect(MATRIX_JOBS_DOCS_URL).toMatch(/\/user\/distributed-jobs\/#matrix-jobs$/);
    expect(guide).toMatch(/^## Matrix jobs$/m);
  });
});
