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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readActionInputs, resolveActionInputsFromConfigFile } from '../../src/config/inputs';

describe('canonical raw action inputs', () => {
  it('returns the original input object without touching the filesystem when config-file is unset', async () => {
    const directInputs = readActionInputs('maven', { getInput: () => '' });
    const resolvedInputs = await resolveActionInputsFromConfigFile('maven', directInputs, {
      workspace: '/workspace-does-not-need-to-exist',
      readFileImpl: async () => {
        throw new Error('must not read');
      },
    });

    expect(resolvedInputs).toBe(directInputs);
  });

  it('loads every config value kind through the canonical Gradle contract', async () => {
    await withConfigFile(
      'cache.json',
      `\uFEFF${JSON.stringify({
        'base-directory': ' project ',
        'cache-enabled': false,
        'cache-gc-older-than-days': 7,
        'dependent-jobs': [' worker-a ', '', 'worker-b'],
        'cache-partitions': [
          { id: 'custom', includes: ['files/**'], excludes: ['files/private/**'] },
        ],
        'process-all-wrapper-files': true,
      })}`,
      async (workspace) => {
        const directInputs = readActionInputs('gradle', {
          getInput(name) {
            if (name === 'config-file') return 'cache.json';
            if (name === 'cache-enabled') return 'true';
            return '';
          },
        });
        const resolvedInputs = await resolveActionInputsFromConfigFile('gradle', directInputs, {
          workspace,
        });

        expect(resolvedInputs).toMatchObject({
          configFile: 'cache.json',
          baseDirectory: 'project',
          cacheEnabled: 'true',
          cacheGcOlderThanDays: '7',
          dependentJobs: 'worker-a\nworker-b',
          cachePartitions: JSON.stringify([
            { id: 'custom', includes: ['files/**'], excludes: ['files/private/**'] },
          ]),
          processAllWrapperFiles: 'true',
        });
      },
    );
  });

  it.each([
    ['duplicate keys', 'cache-enabled: true\ncache-enabled: false\n'],
    [
      'aliases',
      'dependent-jobs: &worker-jobs [worker-a]\nwrapper-properties-files: *worker-jobs\n',
    ],
  ])('rejects YAML %s', async (_scenario, contents) => {
    await withConfigFile('cache.yml', contents, async (workspace) => {
      const directInputs = readActionInputs('gradle', {
        getInput: (name) => (name === 'config-file' ? 'cache.yml' : ''),
      });

      await expect(
        resolveActionInputsFromConfigFile('gradle', directInputs, { workspace }),
      ).rejects.toThrow(/Could not parse config-file/u);
    });
  });
});

async function withConfigFile(
  fileName: string,
  contents: string,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-config-inputs-test-'));
  try {
    await writeFile(path.join(workspace, fileName), contents, 'utf8');
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
