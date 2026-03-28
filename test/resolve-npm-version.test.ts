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

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseNpmPackageManager,
  parsePackageJsonNpmVersion,
} from '../scripts/resolve-npm-version.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const resolverScriptPath = fileURLToPath(
  new URL('../scripts/resolve-npm-version.mjs', import.meta.url),
);
const missingPackageJsonPath = path.join(
  os.tmpdir(),
  `buildish-missing-package-json-${process.pid}`,
  'package.json',
);

describe('npm version resolver', () => {
  it('resolves an exact npm version from package.json', () => {
    expect(parsePackageJsonNpmVersion('{"packageManager":"npm@11.16.0"}')).toBe('11.16.0');
  });

  it('accepts exact prerelease semantic versions', () => {
    expect(parseNpmPackageManager('npm@12.0.0-beta.1')).toBe('12.0.0-beta.1');
  });

  it('rejects build metadata and Corepack integrity descriptors explicitly', () => {
    expect(() => parseNpmPackageManager('npm@12.0.1+sha224.deadbeef')).toThrow(
      /build metadata or Corepack integrity hashes are not supported/u,
    );
  });

  it.each(['npm@^11.16.0', 'npm@11', 'pnpm@10.0.0', 'npm@11.016.0'])(
    'rejects a non-exact npm package manager value: %s',
    (packageManager) => {
      expect(() => parseNpmPackageManager(packageManager)).toThrow();
    },
  );

  it('rejects package.json without a packageManager field', () => {
    expect(() => parsePackageJsonNpmVersion('{}')).toThrow(
      'packageManager must select npm with an exact version',
    );
  });

  it.each(['{"packageManager":null}', '{"packageManager":12}'])(
    'rejects a non-string packageManager field: %s',
    (text) => {
      expect(() => parsePackageJsonNpmVersion(text)).toThrow(
        'packageManager must select npm with an exact version',
      );
    },
  );

  it.each(['null', '[]', '"not-an-object"'])(
    'rejects a non-object package.json root: %s',
    (text) => {
      expect(() => parsePackageJsonNpmVersion(text)).toThrow(
        'package.json must contain a JSON object',
      );
    },
  );

  it('reports malformed package.json as a domain error', () => {
    expect(() => parsePackageJsonNpmVersion('{')).toThrow(
      'Could not parse package.json while resolving the npm version',
    );
  });

  it('resolves the repository default package.json through the CLI', () => {
    const result = runResolver([]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('12.0.1');
    expect(result.stderr).toBe('');
  });

  it('resolves a direct package-manager argument through the CLI', () => {
    const result = runResolver(['--package-manager', 'npm@12.0.0-beta.1']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('12.0.0-beta.1');
  });

  it('resolves package.json from standard input through the CLI', () => {
    const result = runResolver(['--package-json', '-'], '{"packageManager":"npm@11.16.0"}\n');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('11.16.0');
  });

  it('resolves an explicitly selected package.json file through the CLI', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'resolve-npm-version-test-'));
    const packageJsonPath = path.join(tempDirectory, 'package.json');
    try {
      await writeFile(packageJsonPath, '{"packageManager":"npm@10.9.4"}\n', 'utf8');

      const result = runResolver(['--package-json', packageJsonPath]);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('10.9.4');
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'missing option value',
      arguments_: ['--package-json'],
      input: undefined,
      errorPattern: /Usage: resolve-npm-version/u,
    },
    {
      name: 'unknown option',
      arguments_: ['--unknown', 'value'],
      input: undefined,
      errorPattern: /Unknown option "--unknown"/u,
    },
    {
      name: 'malformed standard input',
      arguments_: ['--package-json', '-'],
      input: '{',
      errorPattern: /Could not parse package.json/u,
    },
    {
      name: 'missing package.json file',
      arguments_: ['--package-json', missingPackageJsonPath],
      input: undefined,
      errorPattern: /Could not read package.json from/u,
    },
  ])('reports CLI failure for $name', ({ arguments_, input, errorPattern }) => {
    const result = runResolver(arguments_, input);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(errorPattern);
  });
});

function runResolver(arguments_: readonly string[], input?: string) {
  return spawnSync(process.execPath, [resolverScriptPath, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input,
  });
}
