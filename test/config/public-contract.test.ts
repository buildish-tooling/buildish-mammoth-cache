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

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  getPublicActionInputs,
  PUBLIC_ACTION_OUTPUTS,
  renderPublicActionContractReference,
  type ActionBuildTool,
} from '../../src/config/public-contract';
import { readGradleActionInputs } from '../../src/build-tool/gradle/config';
import { readMavenActionInputs } from '../../src/build-tool/maven/config';
import { readGitHubPlatformActionInputs } from '../../src/ci/github/action-inputs';

interface ActionDescriptor {
  readonly inputs: Record<
    string,
    { readonly description: string; readonly required: boolean; readonly default?: string }
  >;
  readonly outputs: Record<string, { readonly description: string }>;
}

describe('canonical public action contract', () => {
  for (const buildTool of ['gradle', 'maven'] as const) {
    it(`matches the ${buildTool} action metadata exactly`, async () => {
      const descriptor = await readActionDescriptor(buildTool);
      const expectedInputs = Object.fromEntries(
        getPublicActionInputs(buildTool).map((input) => [
          input.name,
          {
            description: input.description,
            required: false,
            ...(input.default === undefined ? {} : { default: input.default }),
          },
        ]),
      );
      const expectedOutputs = Object.fromEntries(
        PUBLIC_ACTION_OUTPUTS.map((output) => [output.name, { description: output.description }]),
      );

      expect(descriptor.inputs).toEqual(expectedInputs);
      expect(descriptor.outputs).toEqual(expectedOutputs);
    });
  }

  it('keeps the generated configuration reference in sync', async () => {
    const documentation = await readFile('docs/user/configuration.md', 'utf8');
    const generatedBlock = documentation.match(
      /<!-- BEGIN GENERATED PUBLIC ACTION CONTRACT -->[\s\S]*?<!-- END GENERATED PUBLIC ACTION CONTRACT -->/u,
    )?.[0];
    expect(generatedBlock).toBeDefined();
    expect(normalizeMarkdownTableSpacing(generatedBlock!)).toBe(
      normalizeMarkdownTableSpacing(renderPublicActionContractReference()),
    );
  });

  it('rejects hosted workflows that consume undeclared action outputs', async () => {
    const outputNames = new Set<string>(PUBLIC_ACTION_OUTPUTS.map((output) => output.name));
    for (const workflow of [
      '.github/workflows/it-reusable-gradle.yml',
      '.github/workflows/it-reusable-maven.yml',
    ]) {
      const contents = await readFile(workflow, 'utf8');
      const referencedOutputs = [
        ...contents.matchAll(/steps\.prepare\.outputs\.([a-z0-9-]+)/gu),
      ].map((match) => match[1]!);
      expect(
        referencedOutputs.filter((name) => !outputNames.has(name)),
        `${workflow} contains undeclared prepare outputs`,
      ).toEqual([]);
    }
  });

  for (const buildTool of ['gradle', 'maven'] as const) {
    it(`reads exactly the ${buildTool} contract inputs`, () => {
      const readNames: string[] = [];
      const inputProvider = {
        getInput(name: string): string {
          readNames.push(name);
          return '';
        },
      };

      if (buildTool === 'gradle') {
        readGradleActionInputs(inputProvider);
      } else {
        readMavenActionInputs(inputProvider);
      }
      readGitHubPlatformActionInputs(inputProvider, buildTool);

      expect(readNames.sort()).toEqual(
        getPublicActionInputs(buildTool)
          .map((input) => input.name)
          .sort(),
      );
    });

    it(`maps every ${buildTool} raw property exactly once`, () => {
      const contractProperties = getPublicActionInputs(buildTool).flatMap((input) =>
        input.property === null ? [] : [input.property],
      );
      const rawInputs =
        buildTool === 'gradle'
          ? readGradleActionInputs({ getInput: () => '' })
          : readMavenActionInputs({ getInput: () => '' });

      expect(new Set(contractProperties).size).toBe(contractProperties.length);
      expect(Object.keys(rawInputs).sort()).toEqual([...contractProperties].sort());
    });
  }
});

function normalizeMarkdownTableSpacing(value: string): string {
  return value
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line;
      return line
        .split('|')
        .map((cell) => {
          const trimmed = cell.trim();
          return /^:?-+:?$/u.test(trimmed) ? '---' : trimmed;
        })
        .join('|');
    })
    .join('\n');
}

async function readActionDescriptor(buildTool: ActionBuildTool): Promise<ActionDescriptor> {
  const contents = await readFile(`actions/github/${buildTool}/action.yml`, 'utf8');
  const descriptor = parseYaml(contents) as ActionDescriptor;
  return {
    inputs: Object.fromEntries(
      Object.entries(descriptor.inputs).map(([name, input]) => [
        name,
        {
          description: input.description,
          required: input.required,
          ...(input.default === undefined ? {} : { default: String(input.default) }),
        },
      ]),
    ),
    outputs: descriptor.outputs,
  };
}
