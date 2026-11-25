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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseCachePartitionsInput } from '../../src/config/shared';
import { readActionInputs, resolveActionInputsFromConfigFile } from '../../src/config/inputs';
import { normalizeSharedActionConfig } from '../../src/config/normalize';
import { fixtureCi } from '../support/ci-fixture';

describe('canonical raw action inputs', () => {
  it.each(['gradle', 'maven'] as const)(
    'preserves %s worker retention precedence when GitHub supplies metadata defaults',
    async (buildTool) => {
      const descriptor = parseYaml(
        await readFile(`actions/github/${buildTool}/action.yml`, 'utf8'),
      ) as { inputs: Record<string, { default?: string | number | boolean }> };
      await withConfigFile(
        'cache.yml',
        'worker-artifact-retention-days: 1\n',
        async (workspace) => {
          for (const directValue of [undefined, '7']) {
            const workflowInputs: Record<string, string> = { 'config-file': 'cache.yml' };
            if (directValue !== undefined) {
              workflowInputs['worker-artifact-retention-days'] = directValue;
            }
            const direct = readActionInputs(buildTool, {
              getInput: (name) =>
                workflowInputs[name] ?? String(descriptor.inputs[name]?.default ?? ''),
            });
            const resolved = await resolveActionInputsFromConfigFile(buildTool, direct, {
              workspace,
            });
            for (const phase of ['prepare', 'finalize'] as const) {
              const config = normalizeSharedActionConfig(resolved, {
                phase,
                ciContext: fixtureCi(workspace),
              });
              expect(config.workerArtifactRetentionDays).toBe(directValue === undefined ? 1 : 7);
            }
          }
        },
      );
    },
  );

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
            if (name === 'config-file') {
              return 'cache.json';
            }
            if (name === 'cache-enabled') {
              return 'true';
            }
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

  it('preserves nested conflict-handling through repository YAML and direct JSON inputs', async () => {
    const partition = { id: 'repository', 'conflict-handling': 'choose-worker-directory' };
    const expected = [{ id: 'repository', conflictHandling: 'choose-worker-directory' }];
    const direct = readActionInputs('maven', {
      getInput: (name) => (name === 'cache-partitions' ? JSON.stringify([partition]) : ''),
    });
    expect(parseCachePartitionsInput(direct.cachePartitions)).toEqual(expected);
    await withConfigFile(
      'cache.yml',
      'cache-partitions:\n  - id: repository\n    conflict-handling: choose-worker-directory\n',
      async (workspace) => {
        const raw = readActionInputs('maven', {
          getInput: (name) => (name === 'config-file' ? 'cache.yml' : ''),
        });
        const resolved = await resolveActionInputsFromConfigFile('maven', raw, { workspace });
        expect(parseCachePartitionsInput(resolved.cachePartitions)).toEqual(expected);
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

it.each(['gradle', 'maven'] as const)(
  'resolves the %s managed directory limit from public inputs',
  async (tool) => {
    const descriptor = parseYaml(await readFile(`actions/github/${tool}/action.yml`, 'utf8')) as {
      inputs: Record<string, { default?: string | number | boolean }>;
    };
    const key = 'cache-max-directory-entries';
    await withConfigFile('limit.yml', `${key}: 42\n`, async (workspace) => {
      for (const [direct, file, expected] of [
        ['', '', 100_000],
        ['', 'limit.yml', 42],
        ['7', 'limit.yml', 7],
      ] as const) {
        const args: Record<string, string> = {
          'config-file': file,
          ...(direct ? { [key]: direct } : {}),
        };
        const raw = readActionInputs(tool, {
          getInput: (name) => args[name] ?? String(descriptor.inputs[name]?.default ?? ''),
        });
        const inputs = await resolveActionInputsFromConfigFile(tool, raw, { workspace });
        const config = normalizeSharedActionConfig(inputs, {
          phase: 'prepare',
          ciContext: fixtureCi(workspace),
        });
        expect(config.cacheMaxDirectoryEntries).toBe(expected);
      }
      for (const invalid of ['0', '-1', '1.5', '1e2', 'NaN', '9007199254740992']) {
        const raw = readActionInputs(tool, { getInput: (name) => (name === key ? invalid : '') });
        expect(() =>
          normalizeSharedActionConfig(raw, { phase: 'prepare', ciContext: fixtureCi(workspace) }),
        ).toThrow(/cache-max-directory-entries must be a positive safe integer/u);
      }
    });
  },
);

it.each([true, false])(
  'honors file layer policy %s and direct overrides with real Action metadata defaults',
  async (fileValue) => {
    const descriptor = parseYaml(await readFile('actions/github/gradle/action.yml', 'utf8')) as {
      inputs: Record<string, { default?: string | number | boolean }>;
    };
    await withConfigFile(
      'cache.yml',
      `dependency-cache-layer: ${fileValue}\n`,
      async (workspace) => {
        for (const explicit of [undefined, 'false', 'true']) {
          const direct = readActionInputs('gradle', {
            getInput: (name) =>
              name === 'config-file'
                ? 'cache.yml'
                : name === 'dependency-cache-layer' && explicit !== undefined
                  ? explicit
                  : String(descriptor.inputs[name]?.default ?? ''),
          });
          const resolved = await resolveActionInputsFromConfigFile('gradle', direct, { workspace });
          const config = normalizeSharedActionConfig(resolved, {
            phase: 'prepare',
            ciContext: fixtureCi(workspace),
          });
          expect(config.dependencyCacheLayer).toBe(
            explicit === undefined ? fileValue : explicit === 'true',
          );
        }
        const maven = readActionInputs('maven', {
          getInput: (name) => (name === 'config-file' ? 'cache.yml' : ''),
        });
        await expect(
          resolveActionInputsFromConfigFile('maven', maven, { workspace }),
        ).rejects.toThrow(/unsupported key.*dependency-cache-layer/);
      },
    );
  },
);

it('defaults the family layer policy off and validates explicit Action values', () => {
  const raw = readActionInputs('gradle', { getInput: () => '' });
  const options = { phase: 'prepare' as const, ciContext: fixtureCi('/cache') };
  expect(normalizeSharedActionConfig(raw, options).dependencyCacheLayer).toBe(false);
  expect(
    normalizeSharedActionConfig({ ...raw, dependencyCacheLayer: 'true' }, options)
      .dependencyCacheLayer,
  ).toBe(true);
  expect(() =>
    normalizeSharedActionConfig({ ...raw, dependencyCacheLayer: 'yes' }, options),
  ).toThrow('dependency-cache-layer');
});

it.each(['gradle'] as const)(
  'resolves %s layer environment export defaults and explicit file/direct values',
  async (tool) => {
    const descriptor = parseYaml(await readFile(`actions/github/${tool}/action.yml`, 'utf8')) as {
      inputs: Record<string, { default?: string | boolean }>;
    };
    const options = { phase: 'prepare' as const, ciContext: fixtureCi('/cache') };
    const absent = readActionInputs(tool, { getInput: () => '' });
    expect(normalizeSharedActionConfig(absent, options).exportLayerEnvironment).toBe(true);
    for (const fileValue of [false, true]) {
      await withConfigFile(
        'cache.yml',
        `export-layer-environment: ${fileValue}\n`,
        async (workspace) => {
          for (const direct of [undefined, 'true', 'false']) {
            const raw = readActionInputs(tool, {
              getInput: (name) =>
                name === 'config-file'
                  ? 'cache.yml'
                  : name === 'export-layer-environment' && direct !== undefined
                    ? direct
                    : String(descriptor.inputs[name]?.default ?? ''),
            });
            const resolved = await resolveActionInputsFromConfigFile(tool, raw, { workspace });
            expect(normalizeSharedActionConfig(resolved, options).exportLayerEnvironment).toBe(
              direct === undefined ? fileValue : direct === 'true',
            );
          }
        },
      );
    }
    expect(() =>
      normalizeSharedActionConfig({ ...absent, exportLayerEnvironment: 'yes' }, options),
    ).toThrow('export-layer-environment');
  },
);
