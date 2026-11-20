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

import { expect, it } from 'vitest';
import { collectGitIgnoredFiles } from '../scripts/rat-check.mjs';

it('filters ignored Unicode, whitespace and newline paths without Git quoting or trimming', async () => {
  const ignored = [
    'build/Grüße für Jörg/français été à Noël cœur.txt',
    'build/leading and trailing spaces.txt ',
    'build/new\nline.txt',
  ];
  // Read-only against this checkout; candidate files need not exist.
  expect(await collectGitIgnoredFiles([...ignored, 'src/cache/model.ts'])).toEqual(
    new Set(ignored),
  );
});
it('handles no candidates without invoking Git', async () => {
  expect(await collectGitIgnoredFiles([])).toEqual(new Set());
});
