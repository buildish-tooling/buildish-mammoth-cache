#!/usr/bin/env node

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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const exactSemverPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;

export function parseNpmPackageManager(packageManager) {
  if (typeof packageManager !== 'string' || !packageManager.startsWith('npm@')) {
    throw new Error(
      'packageManager must select npm with an exact version, for example npm@11.16.0.',
    );
  }

  const version = packageManager.slice('npm@'.length);
  if (version.includes('+')) {
    throw new Error(
      'packageManager npm versions with build metadata or Corepack integrity hashes are not supported; select the exact registry version only.',
    );
  }
  if (!exactSemverPattern.test(version)) {
    throw new Error(
      `packageManager must use an exact npm semantic version; received ${JSON.stringify(packageManager)}.`,
    );
  }
  return version;
}

export function parsePackageJsonNpmVersion(packageJsonText) {
  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch (error) {
    throw new Error('Could not parse package.json while resolving the npm version.', {
      cause: error,
    });
  }
  if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
    throw new Error('package.json must contain a JSON object while resolving the npm version.');
  }
  return parseNpmPackageManager(packageJson.packageManager);
}

async function readPackageJsonFile(packageJsonPath) {
  try {
    return await fs.readFile(packageJsonPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read package.json from ${JSON.stringify(packageJsonPath)} while resolving the npm version.`,
      { cause: error },
    );
  }
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    const packageJsonText = await readPackageJsonFile('package.json');
    console.log(parsePackageJsonNpmVersion(packageJsonText));
    return;
  }

  if (argv.length !== 2) {
    throw new Error(
      'Usage: resolve-npm-version.mjs [--package-json <path|-> | --package-manager <npm@version>]',
    );
  }

  const [mode, value] = argv;
  if (mode === '--package-manager') {
    console.log(parseNpmPackageManager(value));
    return;
  }
  if (mode !== '--package-json') {
    throw new Error(`Unknown option ${JSON.stringify(mode)}.`);
  }

  const packageJsonText =
    value === '-' ? await readStandardInput() : await readPackageJsonFile(value);
  console.log(parsePackageJsonNpmVersion(packageJsonText));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
