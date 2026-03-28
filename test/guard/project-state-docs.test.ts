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
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('project-state documentation', () => {
  it('describes both supported build tools in package and developer metadata', async () => {
    const packageDescriptor = JSON.parse(await readFile('package.json', 'utf8')) as {
      readonly description: string;
    };
    const developerIndex = await readFile('docs/dev/_index.md', 'utf8');
    const maintenance = await readFile('docs/dev/maintenance.md', 'utf8');

    for (const [label, description] of [
      ['package.json', packageDescriptor.description],
      ['docs/dev/_index.md', readFrontMatterDescription(developerIndex)],
      ['docs/dev/maintenance.md', readFrontMatterDescription(maintenance)],
    ] as const) {
      expect(description, `${label} omits Gradle`).toMatch(/Gradle/u);
      expect(description, `${label} omits Maven`).toMatch(/Maven/u);
    }
  });

  it('keeps the documented CodeQL state aligned with the workflow', async () => {
    const workflow = parseYaml(await readFile('.github/workflows/ci.yml', 'utf8')) as {
      readonly jobs?: Readonly<Record<string, { readonly if?: unknown }>>;
    };
    const maintenance = await readFile('docs/dev/maintenance.md', 'utf8');
    const codeQlIsDisabled = workflow.jobs?.codeql?.if === false;

    expect(maintenance.includes('currently disabled with `if: false`')).toBe(codeQlIsDisabled);
    if (codeQlIsDisabled) {
      expect(maintenance).not.toContain('CodeQL analysis runs as');
    }
  });

  it('labels every static-page development link as unreleased development documentation', async () => {
    const pagePaths = (await readdir('site/pages', { recursive: true }))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => path.join('site/pages', entry));

    for (const pagePath of pagePaths) {
      const page = await readFile(pagePath, 'utf8');
      for (const match of page.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)) {
        if (!match[2]!.startsWith('development/')) continue;
        expect(match[1], `${pagePath} has a generically labelled development link`).toMatch(
          /development|unreleased/iu,
        );
      }
      for (const match of page.matchAll(
        /buildish-component-link[^>\r\n]*kind="development"[^>\r\n]*label="([^"]+)"/gu,
      )) {
        expect(match[1], `${pagePath} has a generically labelled development shortcode`).toMatch(
          /development|unreleased/iu,
        );
      }
    }
  });

  it('does not regress to obsolete homepage or TODO claims', async () => {
    const homepage = await readFile('site/pages/_index.md', 'utf8');
    const todo = await readFile('TODO.md', 'utf8');

    expect(homepage).toMatch(/Pre-release status/u);
    expect(homepage).not.toMatch(/Bounded cache growth|Save\\ndelta/u);
    expect(todo).not.toMatch(/Site \+ logo|Create a project-specific logo|Add release workflows/u);
    expect(todo).toMatch(/Adopt the in-development release workflows/u);
  });
});

function readFrontMatterDescription(document: string): string {
  const description = document
    .split('\n')
    .find((line) => line.startsWith('description:'))
    ?.slice('description:'.length)
    .trim();
  if (!description) throw new Error('Document is missing a front-matter description.');
  return description;
}
