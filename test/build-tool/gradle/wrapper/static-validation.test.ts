/*
 * Copyright 2026 The Apache Software Foundation
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

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { NormalizedGradleConfig } from '../../../../src/config/types';
import { validateTargetWrapperProperties } from '../../../../src/build-tool/gradle/wrapper/static-validation';

describe('validateTargetWrapperProperties', () => {
  it('validates the default wrapper properties file and normalizes escaped values', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(createConfig(), workspace);

        expect(wrappers).toHaveLength(1);
        expect(wrappers[0]).toMatchObject({
          relativePath: 'gradle/wrapper/gradle-wrapper.properties',
          wrapperJarRelativePath: 'gradle/wrapper/gradle-wrapper.jar',
          distributionUrl: 'https://services.gradle.org/distributions/gradle-8.14-bin.zip',
          distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
        });
      },
    );
  });

  it('discovers and sorts all matching wrapper properties files', async () => {
    await withWorkspace(
      {
        'apps/zulu/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
        'apps/alpha/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'all',
            wrapperPropertiesGlob: 'apps/**/gradle/wrapper/gradle-wrapper.properties',
            defaultWrapperPropertiesFile: 'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
          }),
          workspace,
        );

        expect(wrappers.map((wrapper) => wrapper.relativePath)).toEqual([
          'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
          'apps/zulu/gradle/wrapper/gradle-wrapper.properties',
        ]);
      },
    );
  });

  it('rejects wrapper files that do not enable validateDistributionUrl', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          validateDistributionUrl: 'false',
        }),
      },
      async (workspace) => {
        await expect(validateTargetWrapperProperties(createConfig(), workspace)).rejects.toThrow(
          /validateDistributionUrl.*true/,
        );
      },
    );
  });

  it('rejects unsupported wrapper storage layout values', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          distributionBase: 'PROJECT',
        }),
      },
      async (workspace) => {
        await expect(validateTargetWrapperProperties(createConfig(), workspace)).rejects.toThrow(
          /distributionBase.*GRADLE_USER_HOME/,
        );
      },
    );
  });

  it('rejects explicit wrapper files outside the gradle/wrapper layout', async () => {
    await withWorkspace(
      {
        'custom/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(
            createConfig({
              wrapperSelectionMode: 'explicit',
              wrapperPropertiesFiles: ['custom/gradle-wrapper.properties'],
              defaultWrapperPropertiesFile: 'custom/gradle-wrapper.properties',
            }),
            workspace,
          ),
        ).rejects.toThrow(/ending with 'gradle\/wrapper\/gradle-wrapper\.properties'/);
      },
    );
  });

  // ------------------------------------------------------------------
  // 'explicit' mode — success path and duplicate/escape errors
  // ------------------------------------------------------------------

  it('resolves two explicitly-listed wrapper files', async () => {
    await withWorkspace(
      {
        'apps/alpha/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
        'apps/beta/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'explicit',
            wrapperPropertiesFiles: [
              'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
              'apps/beta/gradle/wrapper/gradle-wrapper.properties',
            ],
          }),
          workspace,
        );
        expect(wrappers.map((w) => w.relativePath)).toEqual([
          'apps/alpha/gradle/wrapper/gradle-wrapper.properties',
          'apps/beta/gradle/wrapper/gradle-wrapper.properties',
        ]);
      },
    );
  });

  it('rejects explicitly-listed wrapper files with the same resolved path', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(
            createConfig({
              wrapperSelectionMode: 'explicit',
              wrapperPropertiesFiles: [
                'gradle/wrapper/gradle-wrapper.properties',
                'gradle/wrapper/gradle-wrapper.properties',
              ],
            }),
            workspace,
          ),
        ).rejects.toThrow(/more than once/u);
      },
    );
  });

  it('rejects an explicitly-listed path that escapes the workspace', async () => {
    await withWorkspace({}, async (workspace) => {
      await expect(
        validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'explicit',
            wrapperPropertiesFiles: ['../escape/gradle/wrapper/gradle-wrapper.properties'],
          }),
          workspace,
        ),
      ).rejects.toThrow(/escapes the workspace/u);
    });
  });

  // ------------------------------------------------------------------
  // 'all' mode edge cases
  // ------------------------------------------------------------------

  it('throws when the wrapper-properties-glob matches no files', async () => {
    await withWorkspace({}, async (workspace) => {
      await expect(
        validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'all',
            wrapperPropertiesGlob: 'nonexistent/**/gradle-wrapper.properties',
          }),
          workspace,
        ),
      ).rejects.toThrow(/did not match any wrapper properties files/u);
    });
  });

  it('skips symbolic links when discovering wrapper files in all mode', async () => {
    await withWorkspace(
      {
        'real/gradle/wrapper/gradle-wrapper.properties': validWrapperProperties(),
      },
      async (workspace) => {
        // Create a top-level symlink entry — the discovery must skip it.
        await symlink(
          path.join(workspace, 'real'),
          path.join(workspace, 'link-to-real'),
        );

        const wrappers = await validateTargetWrapperProperties(
          createConfig({
            wrapperSelectionMode: 'all',
            wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
          }),
          workspace,
        );
        expect(wrappers).toHaveLength(1);
        expect(wrappers[0]?.relativePath).toBe('real/gradle/wrapper/gradle-wrapper.properties');
      },
    );
  });

  // ------------------------------------------------------------------
  // 'default' mode — missing / symlink / directory
  // ------------------------------------------------------------------

  it('rejects when the default wrapper properties file does not exist', async () => {
    await withWorkspace({}, async (workspace) => {
      await expect(
        validateTargetWrapperProperties(createConfig(), workspace),
      ).rejects.toThrow(/does not exist inside the workspace/u);
    });
  });

  it('rejects the default wrapper properties file when it is a symbolic link', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties.real': validWrapperProperties(),
      },
      async (workspace) => {
        const real = path.join(workspace, 'gradle/wrapper/gradle-wrapper.properties.real');
        const link = path.join(workspace, 'gradle/wrapper/gradle-wrapper.properties');
        await symlink(real, link);

        await expect(
          validateTargetWrapperProperties(createConfig(), workspace),
        ).rejects.toThrow(/must not be a symbolic link/u);
      },
    );
  });

  it('rejects when the default wrapper properties file path points to a directory', async () => {
    // Writing a nested file inside the wrapper properties "file" path forces
    // the OS to create it as a directory.
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties/placeholder': '',
      },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(createConfig(), workspace),
        ).rejects.toThrow(/must point to a regular file/u);
      },
    );
  });

  // ------------------------------------------------------------------
  // validateWrapperPropertiesFile — property-level errors
  // ------------------------------------------------------------------

  it('rejects a wrapper properties file with an invalid distributionSha256Sum format', async () => {
    await withWorkspace(
      {
        'gradle/wrapper/gradle-wrapper.properties': validWrapperProperties({
          distributionSha256Sum: 'not-a-valid-sha256',
        }),
      },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(createConfig(), workspace),
        ).rejects.toThrow(/invalid distributionSha256Sum/u);
      },
    );
  });

  it('rejects a wrapper properties file missing distributionUrl', async () => {
    const content = validWrapperProperties()
      .split('\n')
      .filter((line) => !line.startsWith('distributionUrl='))
      .join('\n');

    await withWorkspace(
      { 'gradle/wrapper/gradle-wrapper.properties': content },
      async (workspace) => {
        await expect(
          validateTargetWrapperProperties(createConfig(), workspace),
        ).rejects.toThrow(/must define 'distributionUrl'/u);
      },
    );
  });

  it('accepts a wrapper properties file that omits the optional storage-layout keys', async () => {
    // Only the three mandatory properties are present; all optional ones are absent.
    const minimal = [
      'distributionSha256Sum=61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
      'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
      'validateDistributionUrl=true',
      '',
    ].join('\n');

    await withWorkspace(
      { 'gradle/wrapper/gradle-wrapper.properties': minimal },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(createConfig(), workspace);
        expect(wrappers).toHaveLength(1);
      },
    );
  });

  // ------------------------------------------------------------------
  // parseProperties / unescapePropertyText edge cases
  // ------------------------------------------------------------------

  it('correctly parses Java properties escape sequences including \\t \\r \\n \\f and \\uXXXX', async () => {
    // Extra properties exercise unescapePropertyText escape-sequence branches.
    // The required properties remain valid so that the overall validation passes.
    const extra = [
      '! bang-style comment line (exercises the ! comment branch)',
      '= ignored-zero-length-key',
      'key-only-no-separator',
      'whitespace separated value',
      'spaced-eq=  two-leading-spaces',
      'backslash\\:in\\=key=value',
      'trailing-backslash=value\\',
      'tab-escape=prefix\\tsuffix',
      'cr-escape=prefix\\rsuffix',
      'newline-escape=prefix\\nsuffix',
      'ff-escape=prefix\\fsuffix',
      'unicode-escape=\\u0041BC',
      'bad-unicode=\\uGGGG',
    ].join('\n');

    const content = validWrapperProperties() + extra + '\n';

    await withWorkspace(
      { 'gradle/wrapper/gradle-wrapper.properties': content },
      async (workspace) => {
        const wrappers = await validateTargetWrapperProperties(createConfig(), workspace);
        // Validation succeeds; the extra lines are parsed but ignored.
        expect(wrappers).toHaveLength(1);
      },
    );
  });
});

function createConfig(overrides: Partial<NormalizedGradleConfig> = {}): NormalizedGradleConfig {
  return {
    phase: 'prepare',
    baseDirectory: '.',
    cacheEnabled: true,
    readOnly: false,
    jobMode: 'standalone',
    dependentJobs: [],
    allowDuplicateDependentDeltaPaths: false,
    cacheKeyPrefix: 'buildish-mammoth-gradle-cache-',
    cacheKeyTemplate: null,
    cachePartitions: [],
    cacheSchemaVersion: 1,
    wrapperSelectionMode: 'default',
    wrapperPropertiesGlob: '**/gradle/wrapper/gradle-wrapper.properties',
    defaultWrapperPropertiesFile: 'gradle/wrapper/gradle-wrapper.properties',
    wrapperPropertiesFiles: [],
    cleanupEnabled: true,
    restoreCleanupMode: 'none',
    gradleUserHome: '/home/runner/.gradle',
    ...overrides,
  };
}

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-mammoth-cache-wrapper-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(workspace, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }

  return workspace;
}

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await createWorkspace(files);

  try {
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function validWrapperProperties(overrides: Record<string, string> = {}): string {
  const properties = {
    distributionBase: 'GRADLE_USER_HOME',
    distributionPath: 'wrapper/dists',
    distributionSha256Sum: '61ad310d3c7d3e5da131b76bbf22b5a4c0786e9d892dae8c1658d4b484de3caa',
    distributionUrl: 'https\\://services.gradle.org/distributions/gradle-8.14-bin.zip',
    validateDistributionUrl: 'true',
    zipStoreBase: 'GRADLE_USER_HOME',
    zipStorePath: 'wrapper/dists',
    ...overrides,
  };

  return `${Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}
