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
import { resolveModel } from '../../../src/cache/streaming/model';
import {
  PartitionMetadataSummary,
  metadataSummaryProfile,
  nativeMetadataRowSchema,
  type NativeMetadataRow,
} from '../../../src/cache/streaming/partition-metadata';
import type { NativeIdentity } from '../../../src/cache/streaming/native';
import { WorkingBudget } from '../../../src/cache/streaming/tree-state';
const model = resolveModel(
  [
    'model',
    1,
    'gradle',
    ['.mammoth/**'],
    [['data', ['**'], ['.mammoth/**'], 'aggregate', null, 'default', 0]],
  ],
  'metadata-',
  1,
);
function n(kind: 'file' | 'directory', length = '3'): NativeIdentity {
  return [
    'native',
    1,
    kind,
    '1',
    '2',
    length,
    kind === 'file' ? 0o100644 : 0o40755,
    '100',
    '200',
    '300',
    null,
  ];
}
function rows(): NativeMetadataRow[] {
  return [
    ['dir-open', '', n('directory')],
    ['dir-open', 'data', n('directory')],
    ['file', 'data/a', n('file')],
    ['dir-close', 'data', n('directory')],
    ['dir-close', '', n('directory')],
  ];
}
function summarize(input = rows(), platform: NodeJS.Platform = 'linux') {
  const budget = new WorkingBudget(),
    summary = new PartitionMetadataSummary(model, 'data', budget, metadataSummaryProfile(platform));
  try {
    for (const row of input) summary.accept(row);
    return summary.finish();
  } finally {
    summary.dispose();
    expect(budget.retained).toBe(0);
  }
}
it('normalizes only path/kind, file length/mtime and supported native permissions', () => {
  const baseline = summarize(),
    input = rows();
  for (const row of input) {
    row[2][3] = '999';
    row[2][4] = '999';
    row[2][7] = '999';
    row[2][9] = '999';
    row[2][10] = '999';
    if (row[0] !== 'file') {
      row[2][5] = '999';
      row[2][8] = '999';
    }
  }
  expect(summarize(input)).toEqual(baseline);
  expect(baseline.slice(3)).toEqual([1, 1, 3]);
});
it.each([
  'path',
  'size',
  'mtime',
  'file-mode',
  'directory-mode',
  'addition',
  'deletion',
  'type',
  'empty',
])('detects metadata %s', (kind) => {
  const input = rows(),
    baseline = summarize();
  if (kind === 'path') input[2][1] = 'data/b';
  if (kind === 'size') input[2][2][5] = '4';
  if (kind === 'mtime') input[2][2][8] = '201';
  if (kind === 'file-mode') input[2][2][6] |= 0o111;
  if (kind === 'directory-mode') input[1][2][6] = 0o40700;
  if (kind === 'addition') input.splice(3, 0, ['file', 'data/b', n('file')]);
  if (kind === 'deletion') input.splice(2, 1);
  if (kind === 'type')
    input.splice(
      2,
      1,
      ['dir-open', 'data/a', n('directory')],
      ['dir-close', 'data/a', n('directory')],
    );
  if (kind === 'empty')
    input.splice(
      3,
      0,
      ['dir-open', 'data/empty', n('directory')],
      ['dir-close', 'data/empty', n('directory')],
    );
  expect(summarize(input)).not.toEqual(baseline);
});
it('compares Windows writable state without reconstructing Unix execute/read bits', () => {
  const input = rows(),
    original = summarize(input, 'win32');
  input[2][2][6] = 0o100711;
  input[1][2][6] = 0o40700;
  expect(summarize(input, 'win32')).toEqual(original);
  input[2][2][6] &= ~0o200;
  expect(summarize(input, 'win32')).not.toEqual(original);
  expect(summarize(rows(), 'linux')).not.toEqual(original);
});
it('rejects hash-bearing local rows and incomplete/unsafe stream structure', () => {
  expect(nativeMetadataRowSchema.safeParse([...rows()[2], 'a'.repeat(64)]).success).toBe(false);
  expect(() => summarize(rows().slice(0, -1))).toThrow('Incomplete');
  const input = rows();
  input[2][1] = '../a';
  expect(() => summarize(input)).toThrow();
  const duplicate = rows();
  duplicate.splice(3, 0, structuredClone(duplicate[2]));
  expect(() => summarize(duplicate)).toThrow();
});
it('does not retain a caller-mutable normalization profile', () => {
  const budget = new WorkingBudget(),
    profile = metadataSummaryProfile('linux');
  const summary = new PartitionMetadataSummary(model, 'data', budget, profile);
  profile[2] = 'windows-owner-writable';
  for (const row of rows()) summary.accept(row);
  expect(summary.finish()).toEqual(summarize());
  summary.dispose();
  expect(budget.retained).toBe(0);
});
