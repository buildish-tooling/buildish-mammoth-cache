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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendBundledSections,
  collectPackageInfo,
  detectProvisionalIncompatibility,
  normalizeProjectUrl,
  parseMode,
  renderLicenseReference,
  renderLicenseSection,
  renderNoticeSection,
} from '../scripts/release-legal.mjs';

describe('release-legal helpers', () => {
  it('normalizes git and github repository URLs', () => {
    expect(normalizeProjectUrl('git+https://github.com/actions/toolkit.git')).toBe(
      'https://github.com/actions/toolkit',
    );
    expect(normalizeProjectUrl('github:octokit/core.js')).toBe(
      'https://github.com/octokit/core.js',
    );
  });

  it('detects provisionally incompatible license expressions', () => {
    expect(detectProvisionalIncompatibility('LGPL-3.0+')).toContain('provisionally incompatible');
    expect(detectProvisionalIncompatibility('MIT')).toBe('');
  });

  it('parses the supported CLI modes', () => {
    expect(parseMode(['--check'])).toBe('check');
    expect(parseMode(['--check-incompatible-licenses'])).toBe('check-incompatible-licenses');
    expect(parseMode(['--write'])).toBe('write');
    expect(() => parseMode(['--check', '--write'])).toThrow(
      'Pass exactly one of --check, --check-incompatible-licenses, or --write.',
    );
  });

  it('preserves the base document when nothing must be appended', () => {
    expect(appendBundledSections('Base text\n', [])).toBe('Base text\n');
  });

  it('renders SPDX-backed license references', () => {
    expect(renderLicenseReference('MIT')).toBe('MIT - https://spdx.org/licenses/MIT.html');
    expect(renderLicenseReference('MIT/X11')).toBe('MIT/X11');
  });

  it('renders bundled dependency sections', () => {
    const section = renderLicenseSection({
      attributionText: 'MIT License\n\nCopyright (c) 2020 Example Corp.',
      copyright: 'Copyright (c) 2020 Example Corp.',
      licenseReference: 'MIT - https://spdx.org/licenses/MIT.html',
      packageNames: ['@example/a', 'example-b'],
      projectHomePage: 'https://github.com/example/project',
      specialHandlingText: 'Recovered from upstream provenance evidence.',
    });

    expect(section).toContain(
      'This product bundles packages from the source project at https://github.com/example/project.',
    );
    expect(section).toContain('* npm packages:');
    expect(section).toContain('  * @example/a\n  * example-b');
    expect(section).toContain('Special handling:');
    expect(section).toContain('| Recovered from upstream provenance evidence.');
    expect(section).toContain('| MIT License');
  });

  it('applies the buffers special-case license override', async () => {
    const packageInfo = await collectPackageInfo('node_modules/buffers');

    expect(packageInfo.licenseExpression).toBe('MIT/X11');
    expect(packageInfo.licenseReference).toBe('MIT/X11');
    expect(packageInfo.specialHandlingText).toContain(
      'This package is licensed under the MIT/X11 license, as indicated by the',
    );
    expect(packageInfo.attributionText).toContain('MIT License');
    expect(packageInfo.issues.map((issue) => issue.code)).not.toContain(
      'MISSING_LICENSE_DECLARATION',
    );
  });

  it('keeps legal sections stable across version bumps while preserving legal changes', async () => {
    await mkdir('build', { recursive: true });
    const packageRoot = await mkdtemp(path.join('build', 'release-legal-test-'));
    const metadata = {
      name: '@example/package',
      license: 'MIT',
      homepage: 'https://github.com/example/project',
    };
    const licenseText = 'MIT License\n\nCopyright (c) 2026 Example Corp.\n';
    const collectVersion = async (version: string) => {
      await writeFile(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ ...metadata, version }),
      );
      return collectPackageInfo(packageRoot);
    };
    const renderSections = (info: Awaited<ReturnType<typeof collectPackageInfo>>) => [
      renderLicenseSection({ ...info, packageNames: [info.packageName] }),
      renderNoticeSection({
        ...info,
        packageNames: [info.packageName],
        noticeText: info.noticeTexts.join('\n'),
      }),
    ];

    try {
      await writeFile(path.join(packageRoot, 'LICENSE'), licenseText);
      await writeFile(path.join(packageRoot, 'NOTICE'), 'Example attribution\n');
      const before = await collectVersion('1.0.0');
      const after = await collectVersion('2.0.0');

      expect(before.packageId).toBe('@example/package@1.0.0');
      expect(after.packageId).toBe('@example/package@2.0.0');
      expect(after.packageName).toBe('@example/package');
      expect(renderSections(after)).toEqual(renderSections(before));
      for (const section of renderSections(after)) {
        expect(section).toContain('* @example/package');
        expect(section).not.toContain('@2.0.0');
      }

      await writeFile(path.join(packageRoot, 'LICENSE'), `${licenseText}Additional terms\n`);
      const changedLicense = await collectVersion('2.0.0');
      expect(renderSections(changedLicense)[0]).not.toBe(renderSections(after)[0]);

      await writeFile(path.join(packageRoot, 'NOTICE'), 'Updated attribution\n');
      const changedNotice = await collectVersion('2.0.0');
      expect(renderSections(changedNotice)[1]).not.toBe(renderSections(after)[1]);

      metadata.license = 'GPL-3.0-only';
      const incompatible = await collectVersion('3.0.0');
      expect(incompatible.issues).toContainEqual(
        expect.objectContaining({
          code: 'PROVISIONAL_INCOMPATIBLE_LICENSE',
          packageId: '@example/package@3.0.0',
        }),
      );
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  });
});
