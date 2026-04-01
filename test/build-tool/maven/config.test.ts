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
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  normalizeMavenActionConfig,
  readMavenActionInputs,
  resolveMavenActionInputsFromConfigFile,
} from '../../../src/build-tool/maven/config';
import type { InputProvider } from '../../../src/config/types';
import type { CiJobContext } from '../../../src/ci/types';

function makeInputProvider(values: Record<string, string> = {}): InputProvider {
  return {
    getInput(name: string): string {
      return values[name] ?? '';
    },
  };
}

const STUB_CI_CONTEXT: CiJobContext = {
  eventName: 'push',
  resolvedRefName: 'main',
  safeRefName: 'main',
  runnerOs: 'linux',
  runnerArch: 'x64',
  defaultBranch: 'main',
  isPullRequest: false,
  repository: 'apache/repo',
  workflowName: 'CI',
  jobName: 'build',
  runId: 1,
  runAttempt: 1,
  tempDirectory: null,
  workspace: '/workspace',
  actionPath: null,
};

async function withWorkspace(
  files: Record<string, string>,
  testBody: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'buildish-maven-config-test-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(workspace, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents, 'utf8');
    }
    await testBody(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readMavenActionInputs
// ---------------------------------------------------------------------------

describe('readMavenActionInputs', () => {
  it('reads every Maven input through the input provider', () => {
    const provider = makeInputProvider({
      'config-file': '.github/maven-cache.yml',
      'base-directory': 'project',
      'cache-enabled': 'true',
      'read-only': 'false',
      'job-mode': 'standalone',
      'dependent-jobs': '',
      'allow-duplicate-dependent-delta-paths': 'false',
      'cache-key-prefix': 'my-prefix-',
      'cache-key-template': '',
      'cache-partitions': '',
      'cleanup-enabled': 'true',
      'restore-cleanup-mode': 'none',
      'maven-local-repository': '/custom/m2',
      'github-token': 'ghs_token',
    });
    const inputs = readMavenActionInputs(provider);

    expect(inputs.configFile).toBe('.github/maven-cache.yml');
    expect(inputs.baseDirectory).toBe('project');
    expect(inputs.cacheEnabled).toBe('true');
    expect(inputs.readOnly).toBe('false');
    expect(inputs.jobMode).toBe('standalone');
    expect(inputs.cleanupEnabled).toBe('true');
    expect(inputs.restoreCleanupMode).toBe('none');
    expect(inputs.mavenLocalRepository).toBe('/custom/m2');
    expect(inputs.githubToken).toBe('ghs_token');
  });

  it('returns empty strings for absent inputs', () => {
    const inputs = readMavenActionInputs(makeInputProvider());
    expect(inputs.configFile).toBe('');
    expect(inputs.mavenLocalRepository).toBe('');
    expect(inputs.githubToken).toBe('');
  });
});

// ---------------------------------------------------------------------------
// resolveMavenActionInputsFromConfigFile
// ---------------------------------------------------------------------------

describe('resolveMavenActionInputsFromConfigFile', () => {
  it('returns direct inputs unchanged when no config-file is set', async () => {
    const direct = readMavenActionInputs(makeInputProvider({ 'cache-enabled': 'false' }));
    const resolved = await resolveMavenActionInputsFromConfigFile(direct, { workspace: '/tmp' });
    expect(resolved.cacheEnabled).toBe('false');
    expect(resolved.configFile).toBe('');
  });

  it('loads a YAML config file and lets direct inputs override file values', async () => {
    await withWorkspace(
      {
        '.github/maven-cache.yml':
          'cache-enabled: false\nread-only: true\nmaven-local-repository: /from-file/m2\n',
      },
      async (workspace) => {
        const resolved = await resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(
            makeInputProvider({
              'config-file': '.github/maven-cache.yml',
              'read-only': 'false', // direct input overrides file
            }),
          ),
          { workspace },
        );
        expect(resolved.cacheEnabled).toBe('false'); // from file
        expect(resolved.readOnly).toBe('false'); // direct input wins
        expect(resolved.mavenLocalRepository).toBe('/from-file/m2'); // from file
      },
    );
  });

  it('loads a JSON config file', async () => {
    const json = JSON.stringify({ 'cache-enabled': false, 'cleanup-enabled': false });
    await withWorkspace({ 'cache.json': json }, async (workspace) => {
      const resolved = await resolveMavenActionInputsFromConfigFile(
        readMavenActionInputs(makeInputProvider({ 'config-file': 'cache.json' })),
        { workspace },
      );
      expect(resolved.cacheEnabled).toBe('false');
      expect(resolved.cleanupEnabled).toBe('false');
    });
  });

  it('rejects github-token in config files', async () => {
    const json = JSON.stringify({ 'github-token': 'secret' });
    await withWorkspace({ 'cfg.json': json }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          { workspace },
        ),
      ).rejects.toThrow(/github-token/u);
    });
  });

  it('rejects nested config-file entries', async () => {
    const json = JSON.stringify({ 'config-file': 'nested.json' });
    await withWorkspace({ 'cfg.json': json }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          { workspace },
        ),
      ).rejects.toThrow(/nested config-file/u);
    });
  });

  it('rejects config files with Gradle-only keys', async () => {
    const json = JSON.stringify({ 'gradle-user-home': '/some/path' });
    await withWorkspace({ 'cfg.json': json }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          { workspace },
        ),
      ).rejects.toThrow(/unsupported key/u);
    });
  });

  // ------------------------------------------------------------------
  // serializeMavenListLikeValue / serializeMavenStructuredValue paths
  // ------------------------------------------------------------------

  it('reads dependent-jobs as a YAML array and several previously-uncovered string fields', async () => {
    const yaml = [
      'base-directory: src',
      'job-mode: distributed-worker',
      'dependent-jobs:',
      '  - worker-a',
      '  - worker-b',
      'cache-key-prefix: my-maven-prefix-',
      'cache-key-template: "{{hashFiles(\'**/*.xml\')}}"',
      'cache-partitions: "[]"',
      'restore-cleanup-mode: prune-managed',
      '',
    ].join('\n');
    await withWorkspace({ 'cfg.yml': yaml }, async (workspace) => {
      const resolved = await resolveMavenActionInputsFromConfigFile(
        readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.yml' })),
        { workspace },
      );
      expect(resolved.baseDirectory).toBe('src');
      expect(resolved.jobMode).toBe('distributed-worker');
      // YAML array is joined into newline-separated string
      expect(resolved.dependentJobs).toBe('worker-a\nworker-b');
      expect(resolved.cacheKeyPrefix).toBe('my-maven-prefix-');
      expect(resolved.cachePartitions).toBe('[]');
      expect(resolved.restoreCleanupMode).toBe('prune-managed');
    });
  });

  it('reads allow-duplicate-dependent-delta-paths as a quoted-string boolean-like value', async () => {
    const yaml = 'allow-duplicate-dependent-delta-paths: "false"\n';
    await withWorkspace({ 'cfg.yml': yaml }, async (workspace) => {
      const resolved = await resolveMavenActionInputsFromConfigFile(
        readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.yml' })),
        { workspace },
      );
      expect(resolved.allowDuplicateDependentDeltaPaths).toBe('false');
    });
  });

  it('reads cache-partitions as a YAML object (structured value)', async () => {
    const yaml = JSON.stringify({ 'cache-partitions': { id: 'custom', glob: '**' } }) + '\n';
    await withWorkspace({ 'cfg.json': yaml }, async (workspace) => {
      const resolved = await resolveMavenActionInputsFromConfigFile(
        readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
        { workspace },
      );
      expect(resolved.cachePartitions).toContain('"id"');
    });
  });

  // ------------------------------------------------------------------
  // validateMavenRecord throw
  // ------------------------------------------------------------------

  it('rejects a JSON config file whose top-level value is an array', async () => {
    await withWorkspace({ 'cfg.json': JSON.stringify([]) }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          { workspace },
        ),
      ).rejects.toThrow(/must be an object/u);
    });
  });

  // ------------------------------------------------------------------
  // parseMavenConfigFileContents — unsupported extension and YAML error
  // ------------------------------------------------------------------

  it('rejects config files with an unsupported extension', async () => {
    await withWorkspace({ 'cfg.toml': '[section]\nkey = "value"\n' }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.toml' })),
          { workspace },
        ),
      ).rejects.toThrow(/\.json, \.yml, or \.yaml extension/u);
    });
  });

  it('rejects a config file containing invalid YAML', async () => {
    await withWorkspace({ 'cfg.yml': ': invalid: yaml: {\n' }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.yml' })),
          { workspace },
        ),
      ).rejects.toThrow(/Could not parse config-file/u);
    });
  });

  // ------------------------------------------------------------------
  // readMavenConfigFileContents — readFileImpl failure
  // ------------------------------------------------------------------

  it('propagates an error when the config file cannot be read', async () => {
    await withWorkspace({ 'cfg.json': '{}' }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          {
            workspace,
            readFileImpl: async () => {
              throw new Error('disk error');
            },
          },
        ),
      ).rejects.toThrow(/Could not read config-file/u);
    });
  });

  // ------------------------------------------------------------------
  // config-file = '.' throws before the file system is touched
  // ------------------------------------------------------------------

  it('rejects config-file value that normalises to the workspace root', async () => {
    await withWorkspace({}, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': '.' })),
          { workspace },
        ),
      ).rejects.toThrow(/\.json, \.yml, or \.yaml file/u);
    });
  });

  // ------------------------------------------------------------------
  // resolveMavenRealPath — realpathImpl failure
  // ------------------------------------------------------------------

  it('propagates an error when realpath resolution fails', async () => {
    await withWorkspace({ 'cfg.json': '{}' }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          {
            workspace,
            realpathImpl: async () => {
              throw new Error('realpath failed');
            },
          },
        ),
      ).rejects.toThrow(/Could not resolve workspace/u);
    });
  });

  // ------------------------------------------------------------------
  // isMavenPathInside — config file symlink escaping the workspace
  // ------------------------------------------------------------------

  it('rejects a config file that resolves outside the workspace through a symlink', async () => {
    await withWorkspace({ 'cfg.json': '{}' }, async (outsideWorkspace) => {
      await withWorkspace({}, async (workspace) => {
        const outsideFile = path.join(outsideWorkspace, 'cfg.json');
        const linkPath = path.join(workspace, 'link.json');
        await symlink(outsideFile, linkPath);

        await expect(
          resolveMavenActionInputsFromConfigFile(
            readMavenActionInputs(makeInputProvider({ 'config-file': 'link.json' })),
            { workspace },
          ),
        ).rejects.toThrow(/must stay within the repository workspace/u);
      });
    });
  });

  // ------------------------------------------------------------------
  // serializeMavenListLikeValue — error paths
  // ------------------------------------------------------------------

  it('rejects dependent-jobs that is neither a string nor an array', async () => {
    await withWorkspace(
      { 'cfg.json': JSON.stringify({ 'dependent-jobs': 42 }) },
      async (workspace) => {
        await expect(
          resolveMavenActionInputsFromConfigFile(
            readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
            { workspace },
          ),
        ).rejects.toThrow(/must be an array/u);
      },
    );
  });

  it('rejects a dependent-jobs array that contains a non-string entry', async () => {
    await withWorkspace(
      { 'cfg.json': JSON.stringify({ 'dependent-jobs': ['ok', 99] }) },
      async (workspace) => {
        await expect(
          resolveMavenActionInputsFromConfigFile(
            readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
            { workspace },
          ),
        ).rejects.toThrow(/entry 1 must be a string/u);
      },
    );
  });

  // ------------------------------------------------------------------
  // serializeMavenStringValue — error path
  // ------------------------------------------------------------------

  it('rejects a non-string value for a string-typed config field', async () => {
    await withWorkspace({ 'cfg.json': JSON.stringify({ 'job-mode': 42 }) }, async (workspace) => {
      await expect(
        resolveMavenActionInputsFromConfigFile(
          readMavenActionInputs(makeInputProvider({ 'config-file': 'cfg.json' })),
          { workspace },
        ),
      ).rejects.toThrow(/must be a string/u);
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeMavenActionConfig
// ---------------------------------------------------------------------------

describe('normalizeMavenActionConfig', () => {
  it('applies secure defaults for a push event', () => {
    const raw = readMavenActionInputs(makeInputProvider());
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: STUB_CI_CONTEXT,
    });

    expect(config.phase).toBe('prepare');
    expect(config.baseDirectory).toBe('.');
    expect(config.cacheEnabled).toBe(true);
    expect(config.readOnly).toBe(false);
    expect(config.jobMode).toBe('standalone');
    expect(config.dependentJobs).toEqual([]);
    expect(config.cacheKeyPrefix).toBe('buildish-mammoth-maven-cache-');
    expect(config.cacheKeyTemplate).toBeNull();
    expect(config.cachePartitions).toEqual([]);
    expect(config.cacheSchemaVersion).toBe(1);
    expect(config.cleanupEnabled).toBe(true);
    expect(config.restoreCleanupMode).toBe('none');
    expect(config.mavenLocalRepository).toBe(path.join(os.homedir(), '.m2'));
  });

  it('defaults to read-only on pull_request events', () => {
    const raw = readMavenActionInputs(makeInputProvider());
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: { ...STUB_CI_CONTEXT, eventName: 'pull_request', isPullRequest: true },
    });
    expect(config.readOnly).toBe(true);
  });

  it('defaults to read-only on pull_request_target events', () => {
    const raw = readMavenActionInputs(makeInputProvider());
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: { ...STUB_CI_CONTEXT, eventName: 'pull_request_target', isPullRequest: true },
    });
    expect(config.readOnly).toBe(true);
  });

  it('explicit read-only=false on pull_request overrides the default', () => {
    const raw = readMavenActionInputs(makeInputProvider({ 'read-only': 'false' }));
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: { ...STUB_CI_CONTEXT, eventName: 'pull_request', isPullRequest: true },
    });
    expect(config.readOnly).toBe(false);
  });

  it('uses MAVEN_USER_HOME env var as the default local repository', () => {
    const raw = readMavenActionInputs(makeInputProvider());
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: STUB_CI_CONTEXT,
      env: { MAVEN_USER_HOME: '/custom/home/.m2' },
    });
    expect(config.mavenLocalRepository).toBe('/custom/home/.m2');
  });

  it('accepts an explicit absolute maven-local-repository input', () => {
    const absPath = path.join(os.homedir(), 'custom-repo');
    const raw = readMavenActionInputs(makeInputProvider({ 'maven-local-repository': absPath }));
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: STUB_CI_CONTEXT,
    });
    expect(config.mavenLocalRepository).toBe(absPath);
  });

  it('accepts a custom cache-key-prefix', () => {
    const raw = readMavenActionInputs(makeInputProvider({ 'cache-key-prefix': 'my-maven-cache-' }));
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: STUB_CI_CONTEXT,
    });
    expect(config.cacheKeyPrefix).toBe('my-maven-cache-');
  });

  it('rejects dependent-jobs with standalone job-mode', () => {
    const raw = readMavenActionInputs(
      makeInputProvider({ 'dependent-jobs': 'worker-a', 'job-mode': 'standalone' }),
    );
    expect(() =>
      normalizeMavenActionConfig(raw, { phase: 'prepare', ciContext: STUB_CI_CONTEXT }),
    ).toThrow(/dependent-jobs can only be used with distributed job modes/u);
  });

  it('accepts dependent-jobs with distributed-aggregator job-mode', () => {
    const raw = readMavenActionInputs(
      makeInputProvider({
        'dependent-jobs': 'worker-a, worker-b',
        'job-mode': 'distributed-aggregator',
      }),
    );
    const config = normalizeMavenActionConfig(raw, {
      phase: 'finalize',
      ciContext: STUB_CI_CONTEXT,
    });
    expect(config.jobMode).toBe('distributed-aggregator');
    expect(config.dependentJobs).toEqual(['worker-a', 'worker-b']);
  });

  it('parses restore-cleanup-mode', () => {
    const raw = readMavenActionInputs(
      makeInputProvider({ 'restore-cleanup-mode': 'prune-managed' }),
    );
    const config = normalizeMavenActionConfig(raw, {
      phase: 'prepare',
      ciContext: STUB_CI_CONTEXT,
    });
    expect(config.restoreCleanupMode).toBe('prune-managed');
  });

  it('rejects an invalid job-mode value', () => {
    const raw = readMavenActionInputs(makeInputProvider({ 'job-mode': 'invalid-mode' }));
    expect(() =>
      normalizeMavenActionConfig(raw, { phase: 'prepare', ciContext: STUB_CI_CONTEXT }),
    ).toThrow(/job-mode must be one of/u);
  });
});
