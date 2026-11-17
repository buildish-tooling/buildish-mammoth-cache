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

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

const LEGAL_FILES = ['LICENSE', 'NOTICE', 'legal/github/LICENSE', 'legal/github/NOTICE'];

/** Inspect the supplied tree only; building and legal-content analysis remain separate checks. */
export async function validateDistribution(distributionRoot) {
  const root = await realpath(distributionRoot);
  const files = new Set();
  const entrypoints = new Set();
  const actions = [];

  for (const name of ['gradle', 'maven']) {
    const descriptorPath = `actions/github/${name}/action.yml`;
    const descriptorFile = await requireDistributionFile(root, descriptorPath);
    files.add(descriptorPath);
    const descriptor = parseYaml(await readFile(descriptorFile, 'utf8'));
    if (descriptor?.runs?.using !== 'node24') {
      throw new Error(`${descriptorPath}: expected runs.using to be node24.`);
    }

    const action = { name };
    for (const phase of ['main', 'post']) {
      const declaredPath = descriptor.runs[phase];
      if (
        typeof declaredPath !== 'string' ||
        declaredPath.length === 0 ||
        path.posix.isAbsolute(declaredPath) ||
        path.win32.isAbsolute(declaredPath) ||
        declaredPath.includes('\\')
      ) {
        throw new Error(`${descriptorPath}: runs.${phase} must be a relative bundle path.`);
      }
      const relativePath = path.posix.normalize(
        path.posix.join(path.posix.dirname(descriptorPath), declaredPath),
      );
      if (!relativePath.startsWith('dist/') || !relativePath.endsWith('.cjs')) {
        throw new Error(
          `${descriptorPath}: runs.${phase} must resolve inside dist/ to a .cjs file.`,
        );
      }
      await requireDistributionFile(root, relativePath);
      if (entrypoints.has(relativePath)) {
        throw new Error(`${descriptorPath}: runs.${phase} must name a distinct bundle.`);
      }
      entrypoints.add(relativePath);
      files.add(relativePath);
      action[phase] = relativePath;
    }
    actions.push(action);
  }

  for (const legalFile of LEGAL_FILES) {
    const filePath = await requireDistributionFile(root, legalFile);
    if ((await readFile(filePath, 'utf8')).trim().length === 0) {
      throw new Error(`Distribution legal file is empty: ${legalFile}`);
    }
    files.add(legalFile);
  }

  return { root, files: [...files], actions };
}

async function requireDistributionFile(root, relativePath) {
  const filePath = path.resolve(root, relativePath);
  let resolved;
  let stats;
  try {
    resolved = await realpath(filePath);
    stats = await stat(resolved);
  } catch (error) {
    throw new Error(`Missing distribution file: ${relativePath}`, { cause: error });
  }
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Distribution file resolves outside the supplied tree: ${relativePath}`);
  }
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Distribution file must be a non-empty regular file: ${relativePath}`);
  }
  return filePath;
}
