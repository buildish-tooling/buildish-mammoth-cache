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

import { describe, expect, it } from 'vitest';

import {
  parseNpmPackageManager,
  parsePackageJsonNpmVersion,
} from '../scripts/resolve-npm-version.mjs';

describe('npm version resolver', () => {
  it('resolves an exact npm version from package.json', () => {
    expect(parsePackageJsonNpmVersion('{"packageManager":"npm@11.16.0"}')).toBe('11.16.0');
  });

  it('accepts exact prerelease semantic versions', () => {
    expect(parseNpmPackageManager('npm@12.0.0-beta.1')).toBe('12.0.0-beta.1');
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
});
