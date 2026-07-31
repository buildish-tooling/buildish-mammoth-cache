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
  defaultReadOnlyForEvent,
  normalizeRelativePath,
  parseCachePartitionsInput,
  validateCacheKeyPrefix,
} from '../../src/config/shared';

describe('validateCacheKeyPrefix', () => {
  it('accepts valid prefixes starting with an alphanumeric character', () => {
    expect(validateCacheKeyPrefix('buildish')).toBe('buildish');
    expect(validateCacheKeyPrefix('my-cache.v1')).toBe('my-cache.v1');
    expect(validateCacheKeyPrefix('  trimmed  ')).toBe('trimmed');
    expect(validateCacheKeyPrefix('a')).toBe('a');
    expect(validateCacheKeyPrefix('a'.repeat(100))).toBe('a'.repeat(100));
  });

  it('rejects prefixes that start with a non-alphanumeric character', () => {
    expect(() => validateCacheKeyPrefix('-invalid')).toThrow(/must start with an alphanumeric/u);
    expect(() => validateCacheKeyPrefix('.invalid')).toThrow(/must start with an alphanumeric/u);
    expect(() => validateCacheKeyPrefix('_invalid')).toThrow(/must start with an alphanumeric/u);
  });

  it('rejects prefixes that contain unsupported characters', () => {
    expect(() => validateCacheKeyPrefix('has space')).toThrow(/must start with an alphanumeric/u);
    expect(() => validateCacheKeyPrefix('has/slash')).toThrow(/must start with an alphanumeric/u);
    expect(() => validateCacheKeyPrefix('a'.repeat(101))).toThrow(
      /must start with an alphanumeric/u,
    );
  });
});

describe('parseCachePartitionsInput', () => {
  it('returns an empty array for an empty or whitespace-only input', () => {
    expect(parseCachePartitionsInput('')).toEqual([]);
    expect(parseCachePartitionsInput('   ')).toEqual([]);
  });

  it('parses a valid partition array with includes and excludes', () => {
    const result = parseCachePartitionsInput(
      JSON.stringify([{ id: 'custom', includes: ['some/path/**'], excludes: [] }]),
    );
    expect(result).toEqual([{ id: 'custom', includes: ['some/path/**'], excludes: [] }]);
  });

  it('rejects duplicate partition ids', () => {
    expect(() =>
      parseCachePartitionsInput(
        JSON.stringify([
          { id: 'dup', includes: ['a/**'], excludes: [] },
          { id: 'dup', includes: ['b/**'], excludes: [] },
        ]),
      ),
    ).toThrow(/duplicate partition id/u);
  });

  it('rejects include globs that do not end with /**', () => {
    expect(() =>
      parseCachePartitionsInput(
        JSON.stringify([{ id: 'p', includes: ['some/path'], excludes: [] }]),
      ),
    ).toThrow(/must end with '\/\*\*'/u);
  });

  it('rejects include globs with path traversal segments', () => {
    expect(() =>
      parseCachePartitionsInput(
        JSON.stringify([{ id: 'p', includes: ['../escape/**'], excludes: [] }]),
      ),
    ).toThrow(/must not use '\.\.'/u);
  });

  it('rejects globs that use unsupported glob syntax characters', () => {
    expect(() =>
      parseCachePartitionsInput(
        JSON.stringify([{ id: 'p', includes: ['path?/**'], excludes: [] }]),
      ),
    ).toThrow(/unsupported glob syntax/u);
  });
});

describe('normalizeRelativePath', () => {
  it('normalizes valid relative paths to POSIX form', () => {
    expect(normalizeRelativePath('tools/app', 'path')).toBe('tools/app');
    expect(normalizeRelativePath('tools\\app', 'path')).toBe('tools/app');
    expect(normalizeRelativePath('  tools/app  ', 'path')).toBe('tools/app');
  });

  it('rejects empty paths', () => {
    expect(() => normalizeRelativePath('', 'path')).toThrow(/must not be empty/u);
    expect(() => normalizeRelativePath('  ', 'path')).toThrow(/must not be empty/u);
  });

  it('rejects paths that start with a tilde', () => {
    expect(() => normalizeRelativePath('~/home', 'path')).toThrow(
      /must not use home-directory expansion/u,
    );
  });

  it('rejects paths that escape the workspace', () => {
    expect(() => normalizeRelativePath('../escape', 'path')).toThrow(
      /must stay within the repository workspace/u,
    );
    expect(() => normalizeRelativePath('C:\\absolute', 'path')).toThrow(/must be a relative path/u);
  });
});

describe('defaultReadOnlyForEvent', () => {
  it('returns true for pull-request events', () => {
    expect(defaultReadOnlyForEvent('pull_request')).toBe(true);
    expect(defaultReadOnlyForEvent('pull_request_target')).toBe(true);
  });

  it('returns false for non-pull-request events', () => {
    expect(defaultReadOnlyForEvent('push')).toBe(false);
    expect(defaultReadOnlyForEvent('schedule')).toBe(false);
    expect(defaultReadOnlyForEvent('workflow_dispatch')).toBe(false);
    expect(defaultReadOnlyForEvent('workflow_call')).toBe(false);
  });
});
